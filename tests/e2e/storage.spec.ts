/** E2E: 保存・自動保存・ファイルを開く・最近開いたファイル */
import { test, expect, type Page } from '@playwright/test';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { watchGlErrors, boot, weightSum, dragOnStage, autosaveOp, nextFrames } from './helpers';

watchGlErrors();

test('保存して開き直すと同じ状態に戻る', async ({ page }) => {
  await boot(page);
  const result = await page.evaluate(async () => {
    const a = (window as any).popstage;
    a.addLayer();
    a.store.patchLayer(a.activeLayerId, { pop: 1234, name: '二枚目' });
    a.activeLayer.weights.data.fill(33);
    a.store.patchProject({ background: '#336699' });
    const before = JSON.stringify(a.doc.layers.map((l: any) => [l.name, l.pop, l.physics, l.weights.data.reduce((s: number, v: number) => s + v, 0)]));
    const bytes = a.serialize(await a.thumbnail());
    await a.loadSample();
    await a.openProjectBytes(bytes, 'test.popstage', null);
    const after = JSON.stringify(a.doc.layers.map((l: any) => [l.name, l.pop, l.physics, l.weights.data.reduce((s: number, v: number) => s + v, 0)]));
    return { before, after, bg: a.project.background, size: bytes.length };
  });
  expect(result.after).toBe(result.before);
  expect(result.bg).toBe('#336699');
  expect(result.size).toBeGreaterThan(1000);
});

test('自動保存の復元に失敗したらサンプルで始め、自動保存を残すか消すかを選べる', async ({ page }) => {
  await page.goto('/?e2e');
  await autosaveOp(page, 'put', { name: 'broken.popstage', bytes: [1, 2, 3] });
  const answer = async (yes: boolean) => {
    await expect(page.locator('#askDialog')).toBeVisible();
    await page.locator(yes ? '#askYes' : '#askNo').click();
  };
  const restoreAndFail = async () => {
    await page.goto('/?e2e&restore');
    await expect(page.locator('#askTitle')).toHaveText('前回の作業を復元しますか?');
    await answer(true);
    await expect(page.locator('#askTitle')).toHaveText('前回の作業を復元できませんでした');
  };

  // 残しておく → サンプルが開き、自動保存は残る
  await restoreAndFail();
  await answer(false);
  await page.waitForFunction(() => (window as any).popstage?.doc && (window as any).popstage.stage.hasDocument);
  expect(await autosaveOp(page, 'get')).toBe('broken.popstage');

  // 削除する → 自動保存が消える
  await restoreAndFail();
  await answer(true);
  await page.waitForFunction(() => (window as any).popstage?.doc && (window as any).popstage.stage.hasDocument);
  expect(await autosaveOp(page, 'get')).toBeNull();
});

test('自動保存から復元すると、塗った内容と設定が戻る', async ({ page }) => {
  await boot(page);
  await dragOnStage(page, [0.45, 0.45], [0.6, 0.55]);
  const before = await page.evaluate(() => {
    const a = (window as any).popstage;
    a.store.patchProject({ background: '#224466' });
    return a.doc.layers.map((l: any) => l.weights.data.reduce((s: number, v: number) => s + v, 0));
  });
  expect(before[0]).toBeGreaterThan(0);
  // 自動保存が書き込まれるまで待つ
  await expect.poll(async () => (await autosaveOp(page, 'list') as string[]).length, { timeout: 10000 }).toBe(1);
  await page.waitForTimeout(1500);
  await page.goto('/?e2e&restore');
  await expect(page.locator('#askTitle')).toHaveText('前回の作業を復元しますか?');
  await page.locator('#askYes').click();
  await page.waitForFunction(() => (window as any).popstage?.doc && (window as any).popstage.stage.hasDocument);
  const after = await page.evaluate(() => {
    const a = (window as any).popstage;
    return { sums: a.doc.layers.map((l: any) => l.weights.data.reduce((s: number, v: number) => s + v, 0)), bg: a.project.background, dirty: a.dirty };
  });
  expect(after.sums).toEqual(before);
  expect(after.bg).toBe('#224466');
  expect(after.dirty).toBe(true);
});

test('自動保存は塗った内容を反映し、失敗したらステータスバーで知らせる', async ({ page }) => {
  await boot(page);
  const autosavedSum = () => page.evaluate(async () => {
    const db: IDBDatabase = await new Promise(res => {
      const r = indexedDB.open('popstage', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('autosave');
      r.onsuccess = () => res(r.result);
    });
    const req = db.transaction('autosave', 'readonly').objectStore('autosave').get((window as any).popstage.activeTab.id);
    const v: any = await new Promise(res => { req.onsuccess = () => res(req.result); });
    db.close();
    if (!v) return -1;
    const mod = '/src/storage/popstage.ts';
    const { deserializeProject } = await import(/* @vite-ignore */ mod);
    // 自動保存は Blob で入る(古い版は Uint8Array)
    const bytes = v.bytes instanceof Blob ? new Uint8Array(await v.bytes.arrayBuffer()) : v.bytes;
    const { project } = await deserializeProject(bytes);
    return project.documents[0].layers[0].weights.data.reduce((s: number, x: number) => s + x, 0) as number;
  });
  // 1回目: 塗って自動保存させる
  await page.evaluate(() => (window as any).popstage.setTool('brush'));
  await dragOnStage(page, [0.45, 0.5], [0.55, 0.5]);
  const s1 = await weightSum(page);
  await expect.poll(autosavedSum, { timeout: 10000 }).toBe(s1);
  // 2回目: さらに塗ると、使い回していた PNG ではなく新しい内容が保存される
  await dragOnStage(page, [0.3, 0.3], [0.4, 0.4]);
  const s2 = await weightSum(page);
  expect(s2).not.toBe(s1);
  await expect.poll(autosavedSum, { timeout: 10000 }).toBe(s2);

  // 保存先が壊れていると、ステータスバーに失敗が出る
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new DOMException('容量が足りません', 'QuotaExceededError'); };
  });
  await page.evaluate(() => (window as any).popstage.store.patchLayer((window as any).popstage.activeLayerId, { pop: 33 }));
  await expect(page.locator('#sSave')).toContainText('自動保存に失敗しました', { timeout: 10000 });
  // 容量不足は、ブラウザの文言ではなく分かる言葉で出る
  await expect(page.locator('#sSave')).toContainText('ブラウザの保存領域が足りません。ファイルに保存してください。');
  await expect(page.locator('#sSave')).not.toContainText('容量が足りません');
  // ファイルへ保存できたら、失敗の案内は消える
  await page.evaluate(async () => {
    const a = (window as any).popstage;
    a.fileHandle = { name: 'x.popstage', createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
    await a.save();
  });
  await expect(page.locator('#sSave')).not.toContainText('自動保存に失敗しました');
});

test('画像を開くときのデコードは1回だけ。巨大な寸法の画像はデコードする前に断る', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const a = (window as any).popstage;
    let calls = 0;
    const orig = window.createImageBitmap;
    (window as any).createImageBitmap = (...args: any[]) => { calls++; return (orig as any)(...args); };
    const c = document.createElement('canvas'); c.width = 120; c.height = 80;
    c.getContext('2d')!.fillRect(10, 10, 50, 30);
    const blob = (type: string): Promise<Blob> => new Promise(r => c.toBlob(b => r(b!), type, 0.9));
    const mod = '/src/ui/imageio.ts';
    const { imageHeaderSize } = await import(/* @vite-ignore */ mod);
    const sizes: Record<string, unknown> = {};
    for (const t of ['image/png', 'image/jpeg', 'image/webp']) sizes[t] = imageHeaderSize(new Uint8Array(await (await blob(t)).arrayBuffer()));

    calls = 0;
    await a.openFile(new File([await blob('image/png')], 'once.png', { type: 'image/png' }));
    const openCalls = calls, name = a.doc.name;

    // IHDR だけの PNG で 20000×20000 を名乗る
    const png = new Uint8Array(33);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(png.buffer).setUint32(16, 20000); new DataView(png.buffer).setUint32(20, 20000);
    calls = 0;
    await a.openFile(new File([png], 'huge.png', { type: 'image/png' }));
    // 拡張子は .png でも中身が GIF のもの(ヘッダから大きさを確かめられない)
    await a.openFile(new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x3b])], 'fake.png', { type: 'image/png' }));
    window.createImageBitmap = orig;
    return { sizes, openCalls, name, hugeCalls: calls, after: a.doc.name };
  });
  for (const t of ['image/png', 'image/jpeg', 'image/webp']) expect(r.sizes[t], t).toEqual({ width: 120, height: 80 });
  expect(r.openCalls).toBe(1);
  expect(r.name).toBe('once.png');
  expect(r.hugeCalls).toBe(0);
  expect(r.after).toBe('once.png');
  await expect(page.locator('#toasts')).toContainText('画像が大きすぎます');
  await expect(page.locator('#toasts')).toContainText('PNG / JPEG / WebP ではありません');
});

test('ドロップで画像を開ける。ダイアログ表示中・書き出し中は開かない', async ({ page }) => {
  await boot(page);
  const drop = () => page.evaluate(async () => {
    const a = (window as any).popstage;
    const c = document.createElement('canvas'); c.width = 40; c.height = 30;
    c.getContext('2d')!.fillRect(0, 0, 40, 30);
    const blob: Blob = await new Promise(r => c.toBlob(b => r(b!), 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'dropped.png', { type: 'image/png' }));
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 300));
    return a.doc.name as string;
  });
  const name0 = await page.evaluate(() => (window as any).popstage.doc.name);

  // ダイアログの表示中
  await page.evaluate(() => (document.getElementById('helpDialog') as HTMLDialogElement).showModal());
  expect(await drop()).toBe(name0);
  await expect(page.locator('#toasts')).toContainText('ダイアログを閉じてから');
  await page.evaluate(() => (document.getElementById('helpDialog') as HTMLDialogElement).close());

  // 書き出しの最中
  await page.evaluate(() => { (window as any).popstage.exporting = true; });
  expect(await drop()).toBe(name0);
  await expect(page.locator('#toasts')).toContainText('いまはファイルを開けません');
  await page.evaluate(() => { (window as any).popstage.exporting = false; });

  // ふだんは開ける
  expect(await drop()).toBe('dropped.png');
});

test('上書き保存の最中に変更すると、保存後も「未保存」のまま残る', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const a = (window as any).popstage;
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    let written = false;
    // 書き込みに時間がかかる保存先(上書き保存のハンドル)の代わり
    a.fileHandle = { name: 'slow.popstage', createWritable: async () => ({ write: async () => { written = true; await gate; }, close: async () => {} }) };
    const clean = async () => { const p = a.save(); await new Promise(r => setTimeout(r, 0)); release(); return p; };

    // 変更しないで保存すると「保存済み」になる
    a.store.patchLayer(a.activeLayerId, { pop: 10 });
    const ok1 = await clean();
    const dirty1 = a.dirty;

    // 書き込みを待っている間に変更すると「未保存」のまま
    let release2!: () => void, writing!: () => void;
    const gate2 = new Promise<void>(res => { release2 = res; });
    const started = new Promise<void>(res => { writing = res; });
    a.fileHandle = { name: 'slow.popstage', createWritable: async () => ({ write: async () => { writing(); await gate2; }, close: async () => {} }) };
    a.store.patchLayer(a.activeLayerId, { pop: 20 });
    const p = a.save();
    await started; // 直列化が済み、書き込みを待っているところ
    a.store.patchLayer(a.activeLayerId, { pop: 30 });
    release2();
    const ok2 = await p;
    return { ok1, dirty1, written, ok2, dirty2: a.dirty };
  });
  expect(r).toEqual({ ok1: true, dirty1: false, written: true, ok2: true, dirty2: true });
});

test('中の画像が壊れた .popstage を開いても、今の状態は何も変わらない', async ({ page }) => {
  await boot(page);
  const good = await page.evaluate(async () => Array.from((window as any).popstage.serialize() as Uint8Array));
  // 画像だけでたらめなバイト列に差し替え、名前とレイヤーの寸法も変えておく
  const files = unzipSync(new Uint8Array(good));
  const json = JSON.parse(strFromU8(files['project.json']));
  json.documents[0].name = 'BROKEN';
  json.documents[0].image.width = 300; json.documents[0].image.height = 200;
  const imagePath: string = json.documents[0].image.path;
  files['project.json'] = strToU8(JSON.stringify(json));
  files[imagePath] = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
  const broken = Array.from(zipSync(files));

  const r = await page.evaluate(async (bytes) => {
    const a = (window as any).popstage;
    const snap = () => ({ name: a.doc.name, file: a.fileName, undo: a.history.canUndo, image: a.stage.imageSize.w, weightTex: a.stage.weightSize.w, layerW: a.doc.layers[0].weights.width });
    a.weightOp('反転', (wm: any) => wm.invert()); // 元に戻せる操作を1つ積んでおく
    const before = snap();
    await a.openProjectBytes(new Uint8Array(bytes), 'broken.popstage', null);
    return { before, after: snap() };
  }, broken);
  expect(r.before.undo).toBe(true);
  expect(r.after).toEqual(r.before);
  await expect(page.locator('#toasts')).toContainText('画像を読み込めませんでした');
});

/* ---------- 最近開いたファイル ---------- */

/** 最近開いたファイルの記録(IndexedDB)を読む。記録は開く処理を待たずに進むので、件数が揃うまで待つのに使う */
const recentStored = (page: Page) => page.evaluate(async () => {
  const mod = '/src/storage/recent.ts';
  const { recent } = await import(/* @vite-ignore */ mod);
  return (await recent.list()).map((e: any) => ({ name: e.name, handle: !!e.handle, blob: e.bytes instanceof Blob }));
});

const waitRecent = (page: Page, n: number) => expect.poll(async () => (await recentStored(page)).length).toBe(n);

async function openRecentDialog(page: Page): Promise<void> {
  await page.locator('#menubar [role=button]', { hasText: 'ファイル' }).click();
  await page.locator('#menubar button[data-cmd=recent]').click();
  await expect(page.locator('#recentDialog')).toHaveAttribute('open', '');
}

/** 塗りつぶした PNG を作る(ブラウザ内で) */
const makePng = (page: Page, name: string, color: string) => page.evaluate(async ([name, color]) => {
  const c = document.createElement('canvas'); c.width = 160; c.height = 120;
  const g = c.getContext('2d')!; g.fillStyle = color; g.fillRect(0, 0, 160, 120);
  const b: Blob = await new Promise(r => c.toBlob(x => r(x!), 'image/png'));
  (window as any).__png = new File([b], name, { type: 'image/png' });
}, [name, color]);

test('最近開いたファイル: 開いた画像が縮小画像付きで並び、そこから開き直せる(場所を覚えられないときはコピー)', async ({ page }) => {
  await boot(page);
  await openRecentDialog(page);
  await expect(page.locator('#recentEmpty')).toBeVisible();
  await expect(page.locator('#recentClear')).toBeDisabled();
  await page.keyboard.press('Escape');

  await makePng(page, 'red.png', '#e33');
  await page.evaluate(async () => { const a = (window as any).popstage; await a.openFile((window as any).__png); });
  await makePng(page, 'blue.png', '#33e');
  await page.evaluate(async () => { const a = (window as any).popstage; await a.openFile((window as any).__png); await a.loadSample(); });
  await waitRecent(page, 2);
  // コピーは Blob で持つ(一覧を読むだけでは中身がメモリに載らない)
  expect(await recentStored(page)).toEqual([{ name: 'blue.png', handle: false, blob: true }, { name: 'red.png', handle: false, blob: true }]);

  await openRecentDialog(page);
  const cards = page.locator('#recentList li');
  await expect(cards).toHaveCount(2);
  await expect(cards.locator('.recent-name')).toHaveText(['blue.png', 'red.png']); // 新しい順
  await expect(cards.first()).toContainText('コピー');
  const thumbOk = await cards.first().locator('img').evaluate((img: HTMLImageElement) => img.decode().then(() => img.naturalWidth > 0));
  expect(thumbOk).toBe(true);
  // 最初の項目にフォーカスがある
  await expect(cards.first().locator('button.recent-open')).toBeFocused();
  await cards.nth(1).locator('button.recent-open').click();
  await expect(page.locator('#recentDialog')).not.toHaveAttribute('open', '');
  await expect.poll(() => page.evaluate(() => (window as any).popstage.doc.name)).toBe('red.png');
  // 開き直すと先頭へ移り、重複しない
  await expect.poll(async () => (await recentStored(page)).map((e: { name: string }) => e.name)).toEqual(['red.png', 'blue.png']);
  await openRecentDialog(page);
  await expect(cards.locator('.recent-name')).toHaveText(['red.png', 'blue.png']);
});

test('最近開いたファイル: 一覧から外す・消去する(ファイル自体はそのまま)', async ({ page }) => {
  await boot(page);
  for (const [n, c] of [['a.png', '#e33'], ['b.png', '#3e3'], ['c.png', '#33e']]) {
    await makePng(page, n, c);
    await page.evaluate(async () => { await (window as any).popstage.openFile((window as any).__png); });
  }
  await waitRecent(page, 3);
  await openRecentDialog(page);
  const names = page.locator('#recentList .recent-name');
  await expect(names).toHaveText(['c.png', 'b.png', 'a.png']);
  await page.locator('#recentList li').first().locator('.recent-remove').click();
  await expect(names).toHaveText(['b.png', 'a.png']);
  // Delete キーでも外せて、フォーカスは次の項目へ
  await page.locator('#recentList button.recent-open').first().focus();
  await page.keyboard.press('Delete');
  await expect(names).toHaveText(['a.png']);
  await expect(page.locator('#recentList button.recent-open').first()).toBeFocused();
  // 消去は確認してから
  await page.locator('#recentClear').click();
  await page.locator('#askNo').click();
  await expect(names).toHaveText(['a.png']);
  await page.locator('#recentClear').click();
  await page.locator('#askYes').click();
  await expect(page.locator('#recentEmpty')).toBeVisible();
  await expect(page.locator('#recentDialog')).toHaveAttribute('open', '');
  expect(await recentStored(page)).toEqual([]);
});

test('最近開いたファイル: 保存していない作業があっても新しいタブで開く。記録に失敗しても開ける', async ({ page }) => {
  await boot(page);
  await makePng(page, 'keep.png', '#e33');
  await page.evaluate(async () => { const a = (window as any).popstage; await a.openFile((window as any).__png); await a.loadSample(); a.addLayer(); });
  await waitRecent(page, 1);
  expect(await page.evaluate(() => (window as any).popstage.dirty)).toBe(true);
  expect(await page.evaluate(() => (window as any).popstage.tabs.length)).toBe(2);
  await openRecentDialog(page);
  // ダブルクリックしても開くのは1回だけ。破棄の確認は出ない
  await page.locator('#recentList button.recent-open').first().dblclick();
  await expect.poll(() => page.evaluate(() => (window as any).popstage.doc.name)).toBe('keep.png');
  expect(await page.evaluate(() => (window as any).popstage.tabs.length)).toBe(3);
  await expect(page.locator('#askDialog')).not.toHaveAttribute('open', '');
  await expect(page.locator('#toasts')).not.toContainText('いまはファイルを開けません');

  // IndexedDB が開けなくても、画像は開ける(一覧に入らないだけ)
  await makePng(page, 'nodb.png', '#3e3');
  await page.evaluate(() => { indexedDB.open = () => { throw new Error('IndexedDB は使えません'); }; });
  await page.evaluate(async () => { await (window as any).popstage.openFile((window as any).__png); });
  expect(await page.evaluate(() => (window as any).popstage.doc.name)).toBe('nodb.png');
  await makePng(page, 'next.png', '#33e');
  await page.evaluate(async () => { await (window as any).popstage.openFile((window as any).__png); });
  expect(await page.evaluate(() => (window as any).popstage.doc.name)).toBe('next.png');
});

// @local: クラウド環境の Chrome for Testing では、IndexedDB にファイルハンドルを入れるとブラウザごと落ちる(アプリと関係なく再現する)ので流さない
test('最近開いたファイル: ファイルの場所を覚えて開き直し、保存も元のファイルへ。消えたファイルは一覧から外せる', { tag: '@local' }, async ({ page }) => {
  await boot(page);
  // ブラウザ内のファイルシステム(OPFS)で、本物のファイルハンドルを作る
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const c = document.createElement('canvas'); c.width = 100; c.height = 100; c.getContext('2d')!.fillRect(0, 0, 50, 50);
    const b: Blob = await new Promise(r => c.toBlob(x => r(x!), 'image/png'));
    const h = await root.getFileHandle('photo.png', { create: true });
    const w = await h.createWritable(); await w.write(b); await w.close();
    const a = (window as any).popstage;
    await a.openFile(await h.getFile(), h);
    // プロジェクトとして保存する(保存先も場所として覚える)
    a.fileHandle = await root.getFileHandle('work.popstage', { create: true });
    await a.save();
    await a.loadSample();
  });
  await waitRecent(page, 2);
  await openRecentDialog(page);
  const cards = page.locator('#recentList li');
  await expect(cards.locator('.recent-name')).toHaveText(['work.popstage', 'photo.png']);
  await expect(cards.first()).toContainText('プロジェクト');
  await expect(page.locator('#recentList')).not.toContainText('コピー');
  expect(await recentStored(page)).toEqual([{ name: 'work.popstage', handle: true, blob: false }, { name: 'photo.png', handle: true, blob: false }]);

  // プロジェクトを開き直すと、上書き保存の先も元のファイルになる
  await cards.first().locator('button.recent-open').click();
  await expect.poll(() => page.evaluate(() => (window as any).popstage.fileName)).toBe('work.popstage');
  expect(await page.evaluate(async () => {
    const a = (window as any).popstage, root = await navigator.storage.getDirectory();
    return a.fileHandle.isSameEntry(await root.getFileHandle('work.popstage'));
  })).toBe(true);

  // ファイルが消えていたら、一覧から外すか聞く
  await page.evaluate(async () => { await (await navigator.storage.getDirectory()).removeEntry('photo.png'); });
  await openRecentDialog(page);
  await cards.nth(1).locator('button.recent-open').click();
  await expect(page.locator('#askTitle')).toHaveText('「photo.png」が見つかりません');
  await page.locator('#askYes').click();
  await expect(cards.locator('.recent-name')).toHaveText(['work.popstage']);
  expect(await page.evaluate(() => (window as any).popstage.fileName)).toBe('work.popstage');
});

test('最近開いたファイル: 一覧を開いている間の知らせも、一覧の幕の裏に隠れず手前に出る', async ({ page }) => {
  await boot(page);
  await openRecentDialog(page);
  await page.evaluate(async () => { const mod = '/src/ui/dom.ts'; const { toast } = await import(/* @vite-ignore */ mod); toast('テストの知らせ', 'warning', 10000); });
  await expect(page.locator('#toasts')).toContainText('テストの知らせ');
  // popover で最前面(top layer)に出す。開いているダイアログより後に出すので、その上に積まれる
  expect(await page.locator('#toasts').evaluate(el => el.matches(':popover-open'))).toBe(true);
  // 消えたら閉じる(ダイアログの操作を邪魔しない)
  await page.evaluate(async () => { document.querySelector('#toasts')!.replaceChildren(); });
  await page.keyboard.press('Escape');
  await expect(page.locator('#recentDialog')).not.toHaveAttribute('open', '');
});

// @local: 上と同じ(IndexedDB にファイルハンドルを入れるとクラウドの Chrome が落ちる)
test('最近開いたファイル: 場所から読む許可の返事が来なくても止まらず、選び直す画面を出せる', { tag: '@local' }, async ({ page }) => {
  await boot(page);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const c = document.createElement('canvas'); c.width = 100; c.height = 100; c.getContext('2d')!.fillRect(0, 0, 50, 50);
    const b: Blob = await new Promise(r => c.toBlob(x => r(x!), 'image/png'));
    const h = await root.getFileHandle('stuck.png', { create: true });
    const w = await h.createWritable(); await w.write(b); await w.close();
    const a = (window as any).popstage;
    await a.openFile(await h.getFile(), h);
    await a.loadSample();
  });
  await waitRecent(page, 1);
  // 許可を確かめると「聞く」になり、聞いても返事が来ない(スマホの Chrome で止まったときの再現)。待つ長さは短くする
  await page.evaluate(async () => {
    const mod = '/src/storage/recent.ts';
    const { READ_WAIT } = await import(/* @vite-ignore */ mod);
    READ_WAIT.ask = 300;
    const p = FileSystemHandle.prototype as any;
    p.queryPermission = async () => 'prompt';
    p.requestPermission = () => new Promise(() => {});
    // 選び直す画面は、同じファイルを選んだことにする
    (window as any).showOpenFilePicker = async () => [await (await navigator.storage.getDirectory()).getFileHandle('stuck.png')];
  });
  await openRecentDialog(page);
  await page.locator('#recentList button.recent-open').first().click();
  await expect(page.locator('#askTitle')).toHaveText('「stuck.png」を開けませんでした');
  await expect(page.locator('#askBody')).toContainText('ブラウザから返事がありません');
  await page.locator('#askYes').click();
  await expect.poll(() => page.evaluate(() => (window as any).popstage.doc.name)).toBe('stuck.png');
  // 同じファイルなので、一覧は1件のまま
  await expect.poll(async () => (await recentStored(page)).map((e: { name: string }) => e.name)).toEqual(['stuck.png']);
});

test('保存領域の永続化は、最初の自動保存のあとに1回だけ頼む(起動直後は頼まない)', async ({ page }) => {
  // persist は通る(true)・persisted は false のまま。通っても印が消えないので、2回目を止めるのは「ページを開いている間に1回だけ」の判定だけになる
  await page.addInitScript(() => {
    const w = window as any;
    w.__persistCalls = 0;
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persist: async () => { w.__persistCalls++; return true; }, persisted: async () => false, estimate: async () => ({ usage: 1e6, quota: 1e9 }) },
    });
  });
  await boot(page);
  const calls = () => page.evaluate(() => (window as any).__persistCalls as number);
  // 起動直後は頼まない
  await nextFrames(page);
  expect(await calls()).toBe(0);
  // 塗って自動保存が通ると、1回だけ頼む
  await page.evaluate(() => (window as any).popstage.setTool('brush'));
  await dragOnStage(page, [0.45, 0.5], [0.55, 0.5]);
  await expect.poll(async () => (await autosaveOp(page, 'list') as string[]).length, { timeout: 10000 }).toBe(1);
  await expect.poll(calls, { timeout: 10000 }).toBe(1);
  // さらに自動保存とファイルの保存をしても、頼み直さない
  await dragOnStage(page, [0.3, 0.3], [0.4, 0.4]);
  await page.evaluate(async () => {
    const a = (window as any).popstage;
    a.fileHandle = { name: 'x.popstage', createWritable: async () => ({ write: async () => {}, close: async () => {} }) };
    await a.save();
  });
  await nextFrames(page);
  expect(await calls()).toBe(1);
});

test('永続化を断られたら、その日時を覚える', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persist: async () => false, persisted: async () => false, estimate: async () => ({ usage: 1e6, quota: 1e9 }) },
    });
  });
  await boot(page);
  await page.evaluate(() => (window as any).popstage.setTool('brush'));
  await dragOnStage(page, [0.45, 0.5], [0.55, 0.5]);
  await expect.poll(async () => (await autosaveOp(page, 'list') as string[]).length, { timeout: 10000 }).toBe(1);
  await expect.poll(() => page.evaluate(() => typeof JSON.parse(localStorage.getItem('popstage.prefs.v1') ?? '{}').storagePersistDeniedAt), { timeout: 5000 }).toBe('number');
});

test('保存領域がすでに永続化されていれば、頼まない', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.__persistCalls = 0;
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persist: async () => { w.__persistCalls++; return true; }, persisted: async () => true, estimate: async () => ({ usage: 1e6, quota: 1e9 }) },
    });
  });
  await boot(page);
  await page.evaluate(() => (window as any).popstage.setTool('brush'));
  await dragOnStage(page, [0.45, 0.5], [0.55, 0.5]);
  await expect.poll(async () => (await autosaveOp(page, 'list') as string[]).length, { timeout: 10000 }).toBe(1);
  await nextFrames(page);
  expect(await page.evaluate(() => (window as any).__persistCalls)).toBe(0);
});
