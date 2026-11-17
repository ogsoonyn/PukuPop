import { test, expect, devices, type Page, type CDPSession } from '@playwright/test';

// スマホ(Android の Chrome 相当)の画面と指の操作。指は CDP でタッチを送って再現する
const { defaultBrowserType: _, ...pixel } = devices['Pixel 7'];
test.use({ ...pixel, deviceScaleFactor: 1 });

async function boot(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/?e2e');
  await page.waitForFunction(() => {
    const a = (window as any).popstage;
    return a?.doc && a.stage.hasDocument && a.paused;
  });
  expect(errors).toEqual([]);
}

type Pt = [number, number];
async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', pts: Pt[]): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
}
/** 指を置いて、from から to へ steps 回に分けて動かして離す。from と to は指ごとの位置 */
async function swipe(cdp: CDPSession, from: Pt[], to: Pt[], steps = 8): Promise<void> {
  await touch(cdp, 'touchStart', from);
  for (let i = 1; i <= steps; i++) await touch(cdp, 'touchMove', from.map((p, j) => [p[0] + (to[j][0] - p[0]) * i / steps, p[1] + (to[j][1] - p[1]) * i / steps]));
  await touch(cdp, 'touchEnd', []);
}
async function viewCenter(page: Page): Promise<Pt> {
  const b = (await page.locator('#view').boundingBox())!;
  return [b.x + b.width / 2, b.y + b.height / 2];
}
const weightSum = (page: Page) => page.evaluate(() => (window as any).popstage.activeLayer.weights.data.reduce((s: number, v: number) => s + v, 0));

test('スマホ幅では3Dビューが全面に出て、PC のパネルは隠れる', async ({ page }) => {
  await boot(page);
  await expect(page.locator('html')).toHaveClass(/mobile/);
  await expect(page.locator('#toolNav')).toBeHidden();
  await expect(page.locator('#menubar')).toBeHidden();
  await expect(page.locator('#mTools')).toBeVisible();
  const view = (await page.locator('#view').boundingBox())!;
  expect(view.width).toBeGreaterThan(400);
  // 最初は移動のツール(塗りのツールは「塗って直す」の奥にある)
  await expect(page.locator('#mTools [data-mtool="pan"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mTools [data-mtool="brush"]')).toBeHidden();
  await expect(page.locator('#mTools [data-mtool="inflate"]')).toBeHidden();
  await expect(page.locator('#mTools [data-mtool="pan"]')).toBeVisible();
});

test('「移動」では1本指で画像を動かし、画像の上でも外でも回転しない', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  await page.locator('#mTools [data-mtool="pan"]').click();
  const cam = () => page.evaluate(() => { const c = (window as any).popstage.project.camera; return { x: c.target.x, y: c.target.y, z: c.target.z, yaw: c.yaw, pitch: c.pitch }; });
  const before = await weightSum(page), c0 = await cam();
  const [cx, cy] = await viewCenter(page);
  await swipe(cdp, [[cx, cy]], [[cx + 80, cy + 40]]);
  const c1 = await cam();
  expect(Math.hypot(c1.x - c0.x, c1.y - c0.y, c1.z - c0.z)).toBeGreaterThan(0);
  expect([c1.yaw, c1.pitch]).toEqual([c0.yaw, c0.pitch]);
  // 画像の外(上の端)から始めても回転せず、動かす
  const b = (await page.locator('#view').boundingBox())!;
  await swipe(cdp, [[cx, b.y + 12]], [[cx - 60, b.y + 40]]);
  const c2 = await cam();
  expect(Math.hypot(c2.x - c1.x, c2.y - c1.y, c2.z - c1.z)).toBeGreaterThan(0);
  expect([c2.yaw, c2.pitch]).toEqual([c0.yaw, c0.pitch]);
  expect(await weightSum(page)).toBe(before);
  // 「移動」でも、画像の外のダブルタップで視点を戻す
  for (let i = 0; i < 2; i++) { await touch(cdp, 'touchStart', [[cx, b.y + 12]]); await touch(cdp, 'touchEnd', []); await page.waitForTimeout(60); }
  const c3 = await cam();
  expect(Math.hypot(c3.x - c0.x, c3.y - c0.y, c3.z - c0.z)).toBeLessThan(1e-6);
});

test('シートを開くと3Dビューはシートの上に縮み、シートの中身は下のバーに隠れない', async ({ page }) => {
  await boot(page);
  const closed = (await page.locator('#view').boundingBox())!.height;
  await page.locator('[data-mtab="layer"]').click();
  await page.waitForTimeout(400);
  await expect(page.locator('#mSheet #pPop')).toBeVisible();
  expect((await page.locator('#view').boundingBox())!.height).toBeLessThan(closed - 100);
  const sheet = (await page.locator('#mSheet').boundingBox())!, bar = (await page.locator('#mTools').boundingBox())!;
  expect(sheet.y + sheet.height).toBeLessThanOrEqual(bar.y + 1);
  // 「アニメ」タブには自動揺らし・記録・キーフレームが入る。いちばん下まで送ると、最後の項目がシートの中に見える
  await page.locator('[data-mtab="anim"]').click();
  await expect(page.locator('#mSheet #pAuto')).toBeVisible();
  await page.locator('#mPanes').evaluate(el => { el.scrollTop = el.scrollHeight; });
  const last = (await page.locator('#keyMake').boundingBox())!;
  expect(last.y + last.height).toBeLessThanOrEqual(bar.y);
  // つまみを押すたびに 半分 → 全部 → 閉じる
  await page.locator('#mGrip').click(); await page.waitForTimeout(400);
  await expect(page.locator('#mSheet')).toHaveAttribute('data-state', 'full');
  await page.locator('#mGrip').click(); await page.waitForTimeout(400);
  await expect(page.locator('#mSheet')).toHaveAttribute('data-state', 'closed');
});

test('シートの一番上に左のツールバーの操作が横に並び、プリセットはレイヤーのタブで選べる', async ({ page }) => {
  await boot(page);
  // 左のツールバーの、その場で効く操作(ツールと3面図は出さない。既定で隠すものは PC と同じく隠す)
  const nav = page.locator('#mNav');
  await expect(nav).toBeVisible();
  for (const cmd of ['recent', 'smoothAll', 'toggleOverlay', 'resetView', 'toggleAutoSwing', 'toggleKeyPlay', 'addFavorite']) await expect(nav.locator(`[data-cmd=${cmd}]`)).toBeVisible();
  for (const cmd of ['open', 'save', 'export']) await expect(nav.locator(`[data-cmd=${cmd}]`)).toBeHidden();
  await expect(nav.locator('[data-cmd=toggleMulti]')).toHaveCount(0);
  await expect(nav.locator('[data-tool]')).toHaveCount(0);
  // 横に送れる(画面より長い)
  expect(await nav.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  // 押すとコマンドが動き、入・切はモデルから映す
  const grid = () => page.evaluate(() => (window as any).popstage.view.grid);
  const g0 = await grid();
  await nav.locator('[data-cmd=toggleGrid]').click();
  expect(await grid()).toBe(!g0);
  await expect(nav.locator('[data-cmd=toggleGrid]')).toHaveAttribute('aria-pressed', String(!g0));
  // プリセットはレイヤーのタブの「揺れ」にある、PC と同じ選択欄
  await page.locator('[data-mtab="layer"]').click();
  const sel = page.locator('#mPanes #pPreset');
  await sel.scrollIntoViewIfNeeded();
  await expect(sel).toBeVisible();
  const value = await sel.locator('option').nth(1).getAttribute('value');
  await sel.selectOption(value!);
  expect(await page.evaluate(() => (window as any).popstage.activeLayer.physics.preset)).toBe(value);
  // 上のバーの「自動で揺らす」もモデルを切り替え、表示が付いてくる
  const auto = () => page.evaluate(() => (window as any).popstage.project.autoSwing.enabled);
  const before = await auto();
  await page.locator('#mAuto').click();
  expect(await auto()).toBe(!before);
  await expect(page.locator('#mAuto')).toHaveAttribute('aria-pressed', String(!before));
  // スマホの上のメニューには、PC のキー表記を付けない
  await expect(page.locator('#mTop .menu kbd')).toHaveCount(0);
});

test('上のバーの再生ボタンで、キーフレームの動きを再生・停止できる', async ({ page }) => {
  await boot(page);
  const play = page.locator('#mPlay');
  // フレームが2つ未満のうちは押せない
  await expect(play).toBeDisabled();
  await page.evaluate(() => {
    const a = (window as any).popstage;
    a.keyDraft = [0, 0.6].map(yaw => ({ view: { yaw, pitch: 0, zoom: 1, target: { x: 0, y: 0, z: 0 } }, seconds: 1, mode: 'smooth' }));
    a.emit('take', a.takeState);
  });
  await expect(play).toBeEnabled();
  await play.click();
  expect(await page.evaluate(() => (window as any).popstage.takeState)).toBe('playing');
  await expect(play).toHaveAttribute('aria-label', '再生を止める');
  // シートの一番上の同じボタンも停止に変わる
  await expect(page.locator('#mNav [data-cmd=toggleKeyPlay] .nav-label')).toHaveText('停止');
  await play.click();
  expect(await page.evaluate(() => (window as any).popstage.takeState)).toBe('idle');
  await expect(play).toHaveAttribute('aria-label', 'アニメーションを再生');
});

test('シートのスライダーは横に引くと動き、縦に動かす・触るだけでは値が変わらない', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  await page.locator('[data-mtab="layer"]').click();
  await page.locator('#mGrip').click(); await page.waitForTimeout(400);
  const range = page.locator('#mPanes #pPop');
  await range.scrollIntoViewIfNeeded();
  const pop = () => page.evaluate(() => (window as any).popstage.activeLayer.pop);
  const v0 = await pop();
  let b = (await range.boundingBox())!;
  const y = b.y + b.height / 2;
  // 触るだけ(つまみと離れた所)では跳ばない
  await touch(cdp, 'touchStart', [[b.x + b.width * 0.95, y]]);
  await touch(cdp, 'touchEnd', []);
  expect(await pop()).toBe(v0);
  // 縦に動かすとスクロールになり、値は変わらない
  await swipe(cdp, [[b.x + b.width * 0.9, y]], [[b.x + b.width * 0.85, y - 120]], 10);
  expect(await pop()).toBe(v0);
  // 横に引くと、引いた分だけ今の値から動く
  await range.scrollIntoViewIfNeeded();
  b = (await range.boundingBox())!;
  await swipe(cdp, [[b.x + b.width * 0.2, b.y + b.height / 2]], [[b.x + b.width * 0.5, b.y + b.height / 2]], 10);
  expect(await pop()).toBeGreaterThan(v0);
  // 1回のドラッグは1手で戻る
  await page.evaluate(() => (window as any).popstage.history.undo());
  expect(await pop()).toBe(v0);
  // 引いてから元の所まで戻して離しても、次のドラッグは今のレイヤーに効き、1手で戻る
  const x0 = b.x + b.width * 0.2, yy = b.y + b.height / 2;
  await touch(cdp, 'touchStart', [[x0, yy]]);
  for (let i = 1; i <= 6; i++) await touch(cdp, 'touchMove', [[x0 + i * 15, yy]]);
  for (let i = 5; i >= 0; i--) await touch(cdp, 'touchMove', [[x0 + i * 15 + 10, yy]]);
  await touch(cdp, 'touchEnd', []);
  await swipe(cdp, [[x0, yy]], [[x0 + b.width * 0.2, yy]], 10);
  expect(await pop()).toBeGreaterThan(v0);
  await page.evaluate(() => (window as any).popstage.history.undo());
  expect(await pop()).toBeLessThanOrEqual(v0 + 1);
});

test('上のメニューから設定を開ける。シートの一番上に出すボタンを、PC の左のツールバーと同じ設定で選べる', async ({ page }) => {
  await boot(page);
  await page.locator('#mTop [aria-label=メニュー]').click();
  await page.locator('#mTop [data-cmd=settings]').click();
  await expect(page.locator('#settingsDialog')).toBeVisible();
  await expect(page.locator('#vAutoOverlay')).toBeVisible();
  const list = page.locator('#setToolbarList');
  await expect(list).toBeVisible();
  await expect(page.locator('#setToolbarLabel .m-only')).toBeVisible();
  await expect(page.locator('#setToolbarLabel .d-only')).toBeHidden();
  // ツールと3面図はスマホでは出さないので、選ぶ欄にも出さない
  await expect(list.locator('input[data-nav=brush]')).toBeHidden();
  await expect(list.locator('input[data-nav=toggleMulti]')).toBeHidden();
  // 隠すとシートから消え、まとまりが空になったら区切りも消える(端に残らず、続けて並ばない)
  const nav = page.locator('#mNav');
  /** 見えている並び(区切りは '|') */
  const shown = () => nav.evaluate(el => [...el.children].filter(c => getComputedStyle(c).display !== 'none').map(c => (c as HTMLElement).dataset.nav ?? '|'));
  const sepsOk = (v: string[]) => v[0] !== '|' && v.at(-1) !== '|' && !v.some((x, i) => x === '|' && v[i + 1] === '|');
  await expect(nav.locator('[data-nav=normalize]')).toBeVisible();
  for (const id of ['recent', 'smoothAll', 'normalize', 'invert']) await list.locator(`input[data-nav=${id}]`).uncheck();
  await expect(nav.locator('[data-nav=normalize]')).toBeHidden();
  let v = await shown();
  expect(v[0]).toBe('toggleOverlay');
  expect(sepsOk(v)).toBe(true);
  for (const id of ['toggleAutoSwing', 'toggleKeyPlay', 'toggleKeyPath', 'toggleKeyGhost', 'addFavorite']) await list.locator(`input[data-nav=${id}]`).uncheck();
  v = await shown();
  expect(v.at(-1)).toBe('resetRotation');
  expect(sepsOk(v)).toBe(true);
  // 全部隠すと帯ごと消え、閉じたシートの高さも縮む。1つ出すと戻る
  const sheetH = () => page.locator('#mSheet').evaluate(el => el.getBoundingClientRect().height);
  const h0 = await sheetH();
  for (const cb of await list.locator('input:visible').all()) await cb.uncheck();
  await expect(nav).toBeHidden();
  await expect.poll(sheetH).toBeLessThan(h0);
  await list.locator('input[data-nav=resetView]').check();
  await expect(nav).toBeVisible();
  await expect.poll(sheetH).toBe(h0);
  // 既定で隠す開く・保存・書き出しも出せる
  await expect(nav.locator('[data-nav=save]')).toBeHidden();
  await list.locator('input[data-nav=save]').check();
  await page.locator('#settingsDialog .modal-action button').click();
  await expect(nav.locator('[data-nav=save]')).toBeVisible();
  // 選んだことは覚える(PC の左のツールバーと同じ設定)
  await boot(page);
  await expect(page.locator('#mNav [data-nav=save]')).toBeVisible();
  await expect(page.locator('#mNav [data-nav=normalize]')).toBeHidden();
  // PC の幅で隠したツールは、スマホの「すべて出す」では戻さない
  await page.evaluate(async () => {
    const mod = '/src/storage/prefs.ts';
    const { prefs } = await import(/* @vite-ignore */ mod);
    prefs.set('toolbarHidden', ['brush', 'normalize']);
  });
  await boot(page);
  await expect(page.locator('#mNav [data-nav=normalize]')).toBeHidden();
  await page.locator('#mTop [aria-label=メニュー]').click();
  await page.locator('#mTop [data-cmd=settings]').click();
  await page.locator('#setToolbarReset').click();
  await expect(page.locator('#mNav [data-nav=normalize]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('popstage.prefs.v1')!).toolbarHidden)).toEqual(['brush']);
});

test('2本指で平行移動とピンチズームができ、画像の外をなぞると回転する', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  const cam = () => page.evaluate(() => { const c = (window as any).popstage.project.camera; return { zoom: c.zoom, x: c.target.x, yaw: c.yaw }; });
  const [cx, cy] = await viewCenter(page);
  // 移動のツールは画像の外でも平行移動するので、つかむにする
  await page.locator('#mTools [data-mtool="grab"]').click();
  const before = await cam();
  // 画像の外(上の端)を1本指でなぞると回転
  const top = (await page.locator('#view').boundingBox())!.y + 20;
  await swipe(cdp, [[cx - 60, top]], [[cx + 60, top]]);
  expect((await cam()).yaw).not.toBeCloseTo(before.yaw, 3);
  // 指を広げると近づく
  await swipe(cdp, [[cx - 40, cy], [cx + 40, cy]], [[cx - 120, cy], [cx + 120, cy]]);
  const pinched = await cam();
  expect(pinched.zoom).toBeLessThan(before.zoom * 0.6);
  // 2本指をそろえて動かすと平行移動
  await swipe(cdp, [[cx - 40, cy], [cx + 40, cy]], [[cx + 20, cy], [cx + 100, cy]]);
  expect((await cam()).x).not.toBeCloseTo(pinched.x, 5);
});

test('2本指でひねると傾く。少しひねっただけでは傾かず、0° の近くでは 0° に吸い付く', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  const roll = () => page.evaluate(() => (window as any).popstage.project.camera.roll as number);
  const [cx, cy] = await viewCenter(page), r = 60, D = Math.PI / 180;
  /** 中心のまわりに置いた2本の指を、a0° から a1° までひねる(指は離さない) */
  const at = (deg: number): Pt[] => [[cx - r * Math.cos(deg * D), cy - r * Math.sin(deg * D)], [cx + r * Math.cos(deg * D), cy + r * Math.sin(deg * D)]];
  const twist = async (a0: number, a1: number) => { for (let i = 1; i <= 12; i++) await touch(cdp, 'touchMove', at(a0 + (a1 - a0) * i / 12)); };
  await touch(cdp, 'touchStart', at(0));
  // 10° ではまだ傾かない
  await twist(0, 10);
  expect(await roll()).toBe(0);
  // 60° ひねると、15° を越えた分の 45° 傾く(時計回り)
  // 指の動きはフレームに合わせて届くので、届き終わるのを待つ
  await twist(10, 60);
  await expect.poll(roll).toBeCloseTo(45 * D, 1);
  // 戻して 0° の近く(2°)では 0° に吸い付く
  await twist(60, 17);
  await expect.poll(roll).toBe(0);
  await touch(cdp, 'touchEnd', []);
});

test('2本指タップで戻し、3本指タップでやり直す', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => (window as any).popstage.addLayer());
  const layers = () => page.evaluate(() => (window as any).popstage.doc.layers.length);
  expect(await layers()).toBe(2);
  const [cx, cy] = await viewCenter(page);
  // タップは 300ms 以内に離したものだけなので、起動直後の重い描画が落ち着いてから送る
  await page.waitForTimeout(1000);
  // 指が少し震えても(それぞれの指が置いた所からわずかに動いても)タップとみなす
  await touch(cdp, 'touchStart', [[cx - 60, cy], [cx + 60, cy]]);
  await touch(cdp, 'touchMove', [[cx - 58, cy + 2], [cx + 62, cy - 2]]);
  await touch(cdp, 'touchEnd', []);
  expect(await layers()).toBe(1);
  await touch(cdp, 'touchStart', [[cx - 40, cy], [cx, cy], [cx + 40, cy]]); await touch(cdp, 'touchEnd', []);
  expect(await layers()).toBe(2);
});

test('「塗って直す」の膨らみで範囲を描くと「ツール」タブで決めて適用できる', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  await page.locator('[data-mtab="layer"]').click();
  await page.locator('#mPaintMode').click();
  await page.locator('#mTools [data-mtool="inflate"]').click();
  // 描く前の欄は、ウェイトの重ね方だけ(範囲ごとの項目は描くまで押せないので出さない)。パネルをたたむボタンも出さない
  const shown = (sel: string) => page.locator(sel).evaluate(el => getComputedStyle(el.closest('[data-inflate-opt]') ?? el).display !== 'none');
  expect(await shown('#tInflBlend')).toBe(true);
  expect(await shown('#tInflLayerBlend')).toBe(false);
  expect(await shown('#tInflCorner')).toBe(false);
  expect(await shown('#inflCompact')).toBe(false);
  const before = await weightSum(page);
  const [cx, cy] = await viewCenter(page);
  await swipe(cdp, [[cx - 60, cy - 40]], [[cx + 60, cy + 40]]);
  expect(await page.evaluate(() => (window as any).popstage.previewingInflate)).toBe(true);
  await expect(page.locator('[data-mtab="tool"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#inflApply')).toBeVisible();
  await page.locator('#inflApply').click();
  expect(await page.evaluate(() => (window as any).popstage.previewingInflate)).toBe(false);
  expect(await weightSum(page)).toBeGreaterThan(before);
  await expect(page.locator('#mSheet')).toHaveAttribute('data-state', 'closed');
});

test('膨らみの範囲は指で枠の辺を動かして直せ、2本目の指を置くと直す前に戻る', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  await page.locator('[data-mtab="layer"]').click();
  await page.locator('#mPaintMode').click();
  await page.locator('#mTools [data-mtool="inflate"]').click();
  const [cx, cy] = await viewCenter(page);
  await swipe(cdp, [[cx - 60, cy - 40]], [[cx + 60, cy + 40]]);
  const area = () => page.evaluate(() => ({ ...(window as any).popstage.inflateState.area }));
  const a0 = await area();
  // 右の辺の中点(画面上)。指は当たりが大きいので、少しずれていても掴める
  const right = await page.evaluate(() => {
    const a = (window as any).popstage, r = a.inflateState.area, p = a.stage.imageToMainScreen(r.x + r.w / 2, r.y);
    const box = document.getElementById('view')!.getBoundingClientRect(), m = a.stage.mainView();
    return [box.left + m.x + p.x, box.top + m.y + p.y] as Pt;
  });
  await swipe(cdp, [[right[0] + 8, right[1] + 6]], [[right[0] + 48, right[1] + 6]]);
  const a1 = await area();
  expect(a1.w).toBeGreaterThan(a0.w + 10);
  expect(a1.h).toBeCloseTo(a0.h, 3);
  expect(a1.x - a1.w / 2).toBeCloseTo(a0.x - a0.w / 2, 0);
  // 動かしている途中で2本目の指を置くと、動かす前の範囲に戻る
  const r2 = await page.evaluate(() => {
    const a = (window as any).popstage, r = a.inflateState.area, p = a.stage.imageToMainScreen(r.x + r.w / 2, r.y);
    const box = document.getElementById('view')!.getBoundingClientRect(), m = a.stage.mainView();
    return [box.left + m.x + p.x, box.top + m.y + p.y] as Pt;
  });
  await touch(cdp, 'touchStart', [r2]);
  for (let i = 1; i <= 4; i++) await touch(cdp, 'touchMove', [[r2[0] + i * 10, r2[1]]]);
  expect((await area()).w).toBeGreaterThan(a1.w);
  await touch(cdp, 'touchStart', [[r2[0] + 40, r2[1]], [cx - 100, cy - 100]]);
  await touch(cdp, 'touchEnd', []);
  expect(await area()).toEqual(a1);
  await page.locator('#inflCancel').click();
});

test('「塗って直す」で塗れ、2本目の指を置くと塗りは取り消される', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  await page.locator('[data-mtab="layer"]').click();
  await page.locator('#mPaintMode').click();
  await expect(page.locator('#mTools [data-mtool="brush"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#mModeBar')).toBeVisible();
  const [cx, cy] = await viewCenter(page);
  const before = await weightSum(page), dirty0 = await page.evaluate(() => (window as any).popstage.dirty);
  // 1本指で塗りかけてから2本目を置く → 塗った分は消え、アンドゥにも残らない
  await touch(cdp, 'touchStart', [[cx - 80, cy + 60]]);
  for (let i = 1; i <= 6; i++) await touch(cdp, 'touchMove', [[cx - 80 + i * 15, cy + 60]]);
  expect(await weightSum(page)).not.toBe(before);
  await touch(cdp, 'touchStart', [[cx - 80 + 90, cy + 60], [cx + 60, cy - 60]]);
  await touch(cdp, 'touchEnd', []);
  expect(await weightSum(page)).toBe(before);
  expect(await page.evaluate(() => (window as any).popstage.history.canUndo)).toBe(false);
  // 取り消した塗りでは「未保存」にならない
  expect(await page.evaluate(() => (window as any).popstage.dirty)).toBe(dirty0);
  // 1本指で塗ると残る
  await swipe(cdp, [[cx - 80, cy + 60]], [[cx + 20, cy + 60]]);
  expect(await weightSum(page)).not.toBe(before);
  await page.locator('#mPaintDone').click();
  await expect(page.locator('#mTools [data-mtool="pan"]')).toHaveAttribute('aria-pressed', 'true');
});

test('幅を広げると PC の配置に戻る', async ({ page }) => {
  await boot(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(page.locator('html')).not.toHaveClass(/mobile/);
  await expect(page.locator('#toolNav')).toBeVisible();
  await expect(page.locator('#mTools')).toBeHidden();
  // 移していた部品は右のパネルへ戻る
  expect(await page.locator('#pPop').evaluate(el => !!el.closest('aside'))).toBe(true);
  expect(await page.locator('#layerList').evaluate(el => !!el.closest('aside'))).toBe(true);
  expect(await page.locator('#inflateDialog').evaluate(el => el.parentElement === document.body)).toBe(true);
});

test('PC の幅で自動で入れた重ね表示は、スマホの幅を行き来しても消えない', async ({ page }) => {
  await boot(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(page.locator('html')).not.toHaveClass(/mobile/);
  const state = () => page.evaluate(() => { const a = (window as any).popstage; return [a.tool, a.view.overlay]; });
  await page.evaluate(() => { const a = (window as any).popstage; a.setTool('grab'); a.setOverlayMode('off'); a.setTool('brush'); });
  expect(await state()).toEqual(['brush', true]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('html')).toHaveClass(/mobile/);
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(page.locator('html')).not.toHaveClass(/mobile/);
  expect(await state()).toEqual(['brush', true]);
  // 戻った後も、塗るツールから離れれば切る
  await page.evaluate(() => (window as any).popstage.setTool('grab'));
  expect(await state()).toEqual(['grab', false]);
});

test("シートのタブは PC の右パネルと同じ分け方で、下のバーのアイコンは PC と同じ表から作る", async ({ page }) => {
  await boot(page);
  // 「レイヤー」: レイヤー一覧・ポップ量・揺れ(選択中のレイヤーの設定)
  await page.locator('[data-mtab="layer"]').click();
  for (const id of ["#layerList", "#pPop", "#pBlend", "#pSwing"]) await expect(page.locator(`#mPanes ${id}`)).toBeVisible();
  // 「アニメ」: 自動揺らし・記録・キーフレーム
  await page.locator('[data-mtab="anim"]').click();
  for (const id of ["#pAuto", "#takeRec", "#keyAdd"]) await expect(page.locator(`#mPanes ${id}`)).toBeVisible();
  // 「表示」: メッシュ密度・表示の切り替え・画角
  await page.locator('[data-mtab="view"]').click();
  for (const id of ["#pDensity", "#vGrid", "#pFov"]) await expect(page.locator(`#mPanes ${id}`)).toBeVisible();
  await expect(page.locator("#mPanes #vMulti")).toBeHidden();
  // 下のバー
  await expect(page.locator("#mTools [data-mtool=grab] svg")).toHaveCount(1);
  await expect(page.locator("#mTools [data-mtool=grab] span")).toHaveText("つかむ");
});

test('全体ぼかしのプレビュー中は、2本指タップで元に戻さない', async ({ page }) => {
  await boot(page);
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => (window as any).popstage.addLayer());
  const state = () => page.evaluate(() => { const a = (window as any).popstage; return [a.doc.layers.length, a.previewingBlur]; });
  // シートの「レイヤー」から全体ぼかしを開く(ほかの操作を止めないパネル)
  await page.locator('[data-mtab="layer"]').click();
  await page.locator('#mPanes [data-cmd=smoothAll]').click();
  await expect(page.locator('#blurDialog')).toHaveJSProperty('open', true);
  expect(await state()).toEqual([2, true]);
  await page.waitForTimeout(1000);
  const [cx, cy] = await viewCenter(page);
  await touch(cdp, 'touchStart', [[cx - 60, cy], [cx + 60, cy]]);
  await touch(cdp, 'touchEnd', []);
  expect(await state()).toEqual([2, true]);
  await page.locator('#blurCancel').click();
  expect(await state()).toEqual([2, false]);
});

test('キーフレームはシートの中で指でつまみをドラッグして並べ替えられる', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const a = (window as any).popstage;
    a.keyDraft = [0.1, 0.2, 0.3].map(yaw => ({ view: { yaw, pitch: 0, zoom: 1.5, target: { x: 0, y: 0, z: 0 } }, seconds: 1, mode: 'smooth' }));
    a.emit('take', a.takeState);
  });
  await page.locator('[data-mtab="anim"]').click();
  await page.locator('#mGrip').click(); await page.waitForTimeout(400);
  const rows = page.locator('#keyList > li.key-row:not(.key-back)');
  await rows.nth(2).scrollIntoViewIfNeeded();
  const g = (await rows.nth(0).locator('[data-act=drag]').boundingBox())!, last = (await rows.nth(2).boundingBox())!;
  const scroll = () => page.locator('#mPanes').evaluate(el => el.scrollTop);
  const before = await scroll();
  const cdp = await page.context().newCDPSession(page);
  // 行の下端まで行くとシートの下の端に近く、並べ替えの自動スクロールが効くので、行の下寄りで止める
  await swipe(cdp, [[g.x + g.width / 2, g.y + g.height / 2]], [[g.x + g.width / 2, last.y + last.height * 0.7]], 10);
  expect(await page.evaluate(() => (window as any).popstage.keyDraft.map((k: any) => k.view.yaw))).toEqual([0.2, 0.3, 0.1]);
  // つまみを動かしてもシートは流れない
  expect(await scroll()).toBe(before);
});

test.describe('PC の配置', () => {
  test.use({ viewport: { width: 1400, height: 900 }, isMobile: false, hasTouch: true, deviceScaleFactor: 1 });

  test('指で触ったスライダーは横に引いたときだけ動き、マウスではブラウザのスライダーのまま', async ({ page }) => {
    await boot(page);
    await expect(page.locator('html')).not.toHaveClass(/mobile/);
    const cdp = await page.context().newCDPSession(page);
    await page.locator('#pTabs [data-ptab=layer]').click();
    const range = page.locator('#pPop');
    const pop = () => page.evaluate(() => (window as any).popstage.activeLayer.pop);
    const v0 = await pop();
    const b = (await range.boundingBox())!, y = b.y + b.height / 2;
    // 触って縦に動かして離しても、値は変わらない
    await swipe(cdp, [[b.x + b.width * 0.9, y]], [[b.x + b.width * 0.9, y + 80]], 10);
    expect(await pop()).toBe(v0);
    await expect(page.locator('html')).toHaveClass(/touch-sliders/);
    // 横に引くと、引いた分だけ動く
    await swipe(cdp, [[b.x + b.width * 0.2, y]], [[b.x + b.width * 0.4, y]], 10);
    expect(await pop()).toBeGreaterThan(v0);
    // 指を離した直後でも、キーボードで動かした分は効く
    const vk = await pop();
    await range.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(pop).not.toBe(vk);
    const v1 = await pop();
    // マウスを動かすとブラウザのスライダーに戻り、押した所へ値が移る
    await page.mouse.move(b.x + b.width * 0.5, y - 40);
    await expect(page.locator('html')).not.toHaveClass(/touch-sliders/);
    await page.mouse.click(b.x + b.width * 0.95, y);
    expect(await pop()).not.toBe(v1);
  });
});
