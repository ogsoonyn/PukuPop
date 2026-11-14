/** E2E: 画面の操作(レイヤー一覧・スライダー・ショートカット・メニュー・パネル・設定を覚える) */
import { test, expect } from '@playwright/test';
import { watchGlErrors, boot, openTab, dragOnStage } from './helpers';

watchGlErrors();

test('レイヤー一覧はキーボードで選択・名前の変更ができる', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { const a = (window as any).popstage; a.addLayer(); a.addLayer(); });
  const active = () => page.evaluate(() => (window as any).popstage.activeLayer.name as string);
  const selected = page.locator('#layerList li[aria-selected=true]');
  // Tab で止まるのは選択中の1項目だけ
  await expect(page.locator('#layerList li[tabindex="0"]')).toHaveCount(1);
  await selected.focus();
  const top = await active();
  await page.keyboard.press('ArrowDown');
  expect(await active()).not.toBe(top);
  await expect(selected).toBeFocused();
  await page.keyboard.press('End');
  expect(await active()).toBe('プリン');
  await page.keyboard.press('Home');
  expect(await active()).toBe(top);
  // F2 で名前を変え、Enter で確定するとフォーカスが項目に戻る
  await page.keyboard.press('F2');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('かお');
  await page.keyboard.press('Enter');
  expect(await active()).toBe('かお');
  await expect(selected).toBeFocused();
  // 視点リセット(Home)などのショートカットに取られない
  await page.evaluate(() => { (window as any).popstage.project.camera.yaw = 1.23; });
  await page.keyboard.press('Home');
  expect(await page.evaluate(() => (window as any).popstage.project.camera.yaw)).toBe(1.23);
});

test('レイヤーの追加・複製・削除・名前の変更', async ({ page }) => {
  await boot(page);
  await page.locator('aside button[data-cmd=addLayer]').click();
  await page.locator('aside button[data-cmd=duplicateLayer]').click();
  await expect(page.locator('#layerList li')).toHaveCount(3);
  await expect(page.locator('#layerCount')).toHaveText('3 / 8');
  await page.locator('#layerList li[aria-selected=true] span.truncate').dblclick();
  await page.locator('#layerList input.input').fill('顔');
  await page.keyboard.press('Enter');
  await expect(page.locator('#layerList li[aria-selected=true]')).toContainText('顔');
  await page.locator('aside button[data-cmd=deleteLayer]').click();
  await expect(page.locator('#layerList li')).toHaveCount(2);
  for (let i = 0; i < 4; i++) await page.keyboard.press('Control+z');
  await expect(page.locator('#layerList li')).toHaveCount(1);
});

test('レイヤー名の変更中、日本語の変換を確定する Enter・取り消す Esc では欄を抜けない', async ({ page }) => {
  await boot(page);
  await page.locator('#layerList li[aria-selected=true] span.truncate').dblclick();
  const input = page.locator('#layerList input.input');
  await input.fill('かお');
  // 変換中のキー(isComposing)は、Enter でも Esc でも欄を残す
  for (const key of ['Enter', 'Escape']) {
    await input.dispatchEvent('keydown', { key, isComposing: true, bubbles: true });
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('かお');
  }
  // Safari は確定後に isComposing を外し、keyCode 229 で送る
  await input.evaluate(el => {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(ev, 'keyCode', { get: () => 229 });
    el.dispatchEvent(ev);
  });
  await expect(input).toBeVisible();
  // 変換を終えた後の Enter で確定する
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).popstage.activeLayer.name)).toBe('かお');
});

test('スライダーの変更は1手として元に戻せる', async ({ page }) => {
  await boot(page);
  const pop0 = await page.evaluate(() => (window as any).popstage.activeLayer.pop);
  const slider = page.locator('#pPop');
  await slider.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  const pop1 = await page.evaluate(() => (window as any).popstage.activeLayer.pop);
  expect(pop1).toBe(pop0 + 5);
  await page.locator('#view').focus();
  // キー操作は1回ごとに change が出るので5手。すべて戻すと元の値
  for (let i = 0; i < 5; i++) await page.keyboard.press('Control+z');
  expect(await page.evaluate(() => (window as any).popstage.activeLayer.pop)).toBe(pop0);

});

test('パフォーマンスのデバッグ表示は ?debug かショートカットで出し、止まった所を記録して書き出せる', async ({ page }) => {
  await boot(page);
  // ふだんは計測しない
  expect(await page.evaluate(() => (window as any).popstage.perf)).toBeNull();
  await expect(page.locator('#perfOverlay')).toHaveCount(0);
  await page.locator('#view').focus();
  await page.keyboard.press('Control+Shift+Alt+KeyP');
  await expect(page.locator('#perfOverlay')).toBeVisible();
  await page.keyboard.press('Control+Shift+Alt+KeyP');
  await expect(page.locator('#perfOverlay')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).popstage.perf)).toBeNull();

  await page.goto('/?e2e&debug');
  await page.waitForFunction(() => { const a = (window as any).popstage; return a?.doc && a.stage.hasDocument && a.perf; });
  await expect(page.locator('#perfOverlay')).toContainText('fps');
  expect(await page.evaluate(() => (window as any).popstage.loops)).toBe(1);
  // メインスレッドを 400ms 止めると、「このページの処理」で止まったと記録される
  await page.evaluate(() => new Promise<void>(res => requestAnimationFrame(() => { const t = performance.now(); while (performance.now() - t < 400) { /* 止める */ } res(); })));
  await expect(page.locator('#perfOverlay')).toContainText('止まる → このページの処理', { timeout: 5000 });
  // 描画が遅いと、ここまでに記録したフレームが少ない。書き出すフレームの確かめのため、溜まるまで待つ
  await expect.poll(() => page.evaluate(() => (window as any).popstage.perf.frames().length)).toBeGreaterThan(10);
  // 「記録を保存」で書き出す JSON を横取りして確かめる
  await page.evaluate(() => {
    const orig = URL.createObjectURL;
    URL.createObjectURL = (b: Blob | MediaSource) => { (window as any).__saved = (b as Blob).text(); return orig(b); };
  });
  await page.locator('#perfOverlay [data-act=save]').click();
  const data = JSON.parse(await page.evaluate(() => (window as any).__saved));
  expect(data.freezes.length).toBeGreaterThan(0);
  // 起動直後の読み込みや、CPU が混んだときの描画でも止まることがあるので、止めた 400ms がどこかに「このページ」で残っていればよい
  expect(data.freezes.some((f: any) => f.gap > 350 && f.verdict === 'page')).toBe(true);
  expect(data.frames.length).toBeGreaterThan(10);
  expect(data.document.layers).toBe(1);
});

/* ---------- ショートカットと細かな表示 ---------- */

test('ショートカット: 一覧のキーがすべて期待どおりに効く', async ({ page }) => {
  await boot(page);
  const app = <T>(fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);
  await page.locator('#view').focus();

  // ツール(ボタンにもキーを出す)
  for (const [key, tool] of [['b', 'brush'], ['e', 'erase'], ['s', 'smooth'], ['i', 'inflate'], ['g', 'grab'], ['y', 'shake'], ['v', 'view'], ['h', 'pan'], ['b', 'brush']]) {
    await page.keyboard.press(key);
    expect(await app(a => a.tool), key).toBe(tool);
    await expect(page.locator(`.tool[data-tool=${tool}]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(`.tool[data-tool=${tool}] .tool-key`)).toHaveText(key.toUpperCase());
  }
  // 表示の切り替え(押すたびに入れ替わる)
  const view = () => app(a => ({ ...a.view, paused: a.paused }));
  // W は重ね表示を OFF → 選択中 → 全レイヤー → OFF と回す
  await app(a => a.setOverlayMode('off'));
  for (const mode of ['selected', 'all', 'off']) {
    await page.keyboard.press('w');
    await expect.poll(() => app(a => a.overlayMode), 'w').toBe(mode);
  }
  for (const [key, prop] of [['Shift+W', 'fade'], ['Shift+G', 'grid'], ['f', 'flat'], ['p', 'paused'], ['m', 'multi']] as const) {
    const before = (await view())[prop];
    await page.keyboard.press(key);
    await expect.poll(async () => (await view())[prop], key).toBe(!before);
    await page.keyboard.press(key);
    await expect.poll(async () => (await view())[prop], key).toBe(before);
  }
  // Home で正面へ
  await app(a => { a.project.camera.yaw = 1; a.project.camera.pitch = 0.5; });
  await page.keyboard.press('Home');
  expect(await app(a => [a.project.camera.yaw, a.project.camera.pitch])).toEqual([0, 0]);
  // [ と ] でブラシの大きさ
  const size0 = await app(a => a.brush.size);
  await page.keyboard.press(']');
  expect(await app(a => a.brush.size)).toBeGreaterThan(size0);
  await page.keyboard.press('[');
  await page.keyboard.press('[');
  expect(await app(a => a.brush.size)).toBeLessThan(size0);
  // 元に戻す / やり直す
  await app(a => a.weightOp('全消去', (wm: any) => wm.clear()));
  const sum = () => app(a => a.activeLayer.weights.data.reduce((s: number, v: number) => s + v, 0) as number);
  expect(await sum()).toBe(0);
  await page.keyboard.press('Control+z');
  expect(await sum()).toBeGreaterThan(0);
  await page.keyboard.press('Control+Shift+z');
  expect(await sum()).toBe(0);
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+y');
  expect(await sum()).toBe(0);
  // 保存(Ctrl+S は今のファイルへ、Ctrl+Shift+S は保存先を選ぶ)・開く(Ctrl+O / Ctrl+Shift+O)は、ファイルの選択画面を横取りして確かめる
  await app(a => {
    const w = window as any;
    w.__calls = [];
    w.showSaveFilePicker = async () => { w.__calls.push('saveAs'); throw new DOMException('x', 'AbortError'); };
    w.showOpenFilePicker = async (o: any) => { w.__calls.push('open:' + Object.keys(o.types[0].accept).join(',')); throw new DOMException('x', 'AbortError'); };
    a.fileHandle = { name: 'k.popstage', createWritable: async () => { w.__calls.push('save'); return { write: async () => {}, close: async () => {} }; } };
  });
  const calls = () => page.evaluate(() => (window as any).__calls as string[]);
  await page.keyboard.press('Control+s');
  await expect.poll(calls).toEqual(['save']);
  await page.keyboard.press('Control+Shift+s');
  await expect.poll(calls).toEqual(['save', 'saveAs']);
  await page.keyboard.press('Control+o');
  await expect.poll(calls).toEqual(['save', 'saveAs', 'open:application/zip,image/*']);
  await page.keyboard.press('Control+Shift+o');
  // Ctrl+Shift+O(前の「画像を開く」)も、プロジェクトと画像の両方を開ける「開く」になる
  await expect.poll(calls).toEqual(['save', 'saveAs', 'open:application/zip,image/*', 'open:application/zip,image/*']);
  // 書き出し
  await page.keyboard.press('Control+e');
  await expect(page.locator('#exportDialog')).toHaveAttribute('open', '');
  // 画面を覆うダイアログの表示中は、ほかのショートカットは効かない
  await page.keyboard.press('g');
  expect(await app(a => a.tool)).toBe('brush');
  await page.keyboard.press('Escape');
  await expect(page.locator('#exportDialog')).not.toHaveAttribute('open', '');
  // パフォーマンスのデバッグ表示
  await page.keyboard.press('Control+Shift+Alt+KeyP');
  await expect(page.locator('#perfOverlay')).toBeVisible();
  await page.keyboard.press('Control+Shift+Alt+KeyP');
  await expect(page.locator('#perfOverlay')).toHaveCount(0);
  // 日本語入力がオンのとき(key が Process)も、キーの位置で効く
  await page.evaluate(() => document.getElementById('view')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', code: 'KeyG', bubbles: true })));
  expect(await app(a => a.tool)).toBe('grab');
  // 選択欄にフォーカスがあるときは、文字キーを選択欄に任せる
  await page.locator('#pBlend').focus();
  await page.keyboard.press('b');
  expect(await app(a => a.tool)).toBe('grab');
  await page.locator('#view').focus();

  // 膨らませるのパネル(画面を覆わない)を開いている間も、表示の切り替えは効く。ツールの切り替えや元に戻すは効かない
  await page.keyboard.press('i');
  await dragOnStage(page, [0.4, 0.35], [0.6, 0.65]);
  await expect(page.locator('#inflateDialog')).toHaveJSProperty('open', true);
  await page.locator('#view').focus();
  const mode = await app(a => a.overlayMode);
  await page.keyboard.press('w');
  await expect.poll(() => app(a => a.overlayMode)).not.toBe(mode);
  await page.keyboard.press('b');
  expect(await app(a => a.tool)).toBe('inflate');
  const undo0 = await app(a => a.history.size);
  await page.keyboard.press('Control+z');
  expect(await app(a => [a.previewingInflate, a.history.size])).toEqual([true, undo0]);
});

test('設定はブラウザに覚え、読み込み直しても戻る(ファイルには書かない)', async ({ page }) => {
  await boot(page);
  await openTab(page, 'view');
  await page.locator('#view').focus();
  // ブラシ・表示・ツール・背景を変える
  await page.locator('#brushSize').fill('150');
  // 筆圧は設定の画面にある
  await page.locator('#toolOptions [data-cmd=settings]').click();
  await page.locator('#brushPressure').selectOption('size');
  await page.keyboard.press('Escape');
  await page.locator('#vGrid').check();
  await page.locator('#vMulti').check();
  await page.locator('#view').focus();
  await page.keyboard.press('g');
  await page.evaluate(() => { const a = (window as any).popstage; a.store.patchProject({ background: '#123456', autoSwing: { ...a.project.autoSwing, period: 2.5 } }); });
  // 書き出しの設定
  await page.keyboard.press('Control+e');
  await page.locator('#exW').fill('640');
  await page.locator('#exW').dispatchEvent('change');
  await page.locator('input[name=exFps][value="30"]').check();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  await page.goto('/?e2e');
  await page.waitForFunction(() => (window as any).popstage?.doc && (window as any).popstage.stage.hasDocument);
  const s = await page.evaluate(() => { const a = (window as any).popstage; return { brush: a.brush, view: a.view, tool: a.tool, bg: a.project.background }; });
  expect(s.brush.size).toBe(150);
  expect(s.brush.pressure).toBe('size');
  expect(s.view.grid).toBe(true);
  expect(s.view.multi).toBe(true);
  expect(s.tool).toBe('grab');
  await expect(page.locator('#brushSizeO')).toHaveText('150px');
  await expect(page.locator('#vGrid')).toBeChecked();
  // サンプルの背景は変えない。新しい画像を開くと、覚えた背景・周期になる
  expect(s.bg).not.toBe('#123456');
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 64; c.height = 48;
    const b: Blob = await new Promise(r => c.toBlob(x => r(x!), 'image/png'));
    await (window as any).popstage.openFile(new File([b], 'n.png', { type: 'image/png' }));
  });
  expect(await page.evaluate(() => { const a = (window as any).popstage; return [a.project.background, a.project.autoSwing.period]; })).toEqual(['#123456', 2.5]);
  await page.locator('#view').focus();
  await page.keyboard.press('Control+e');
  await expect(page.locator('#exW')).toHaveValue('640');
  await expect(page.locator('input[name=exFps][value="30"]')).toBeChecked();
});

test('表示の切り替えはキーで変えても覚える。ファイルの選択画面を断られたらボタンで開き直す', async ({ page }) => {
  await boot(page);
  await openTab(page, 'view');
  await page.locator('#view').focus();
  await page.keyboard.press('m');
  await page.keyboard.press('Shift+W'); // 画像を薄く(重ね表示も入る)
  await page.keyboard.press('w');       // 重ね表示を全レイヤーに
  await page.keyboard.press('w');       // 重ね表示だけ外す
  await page.waitForTimeout(400);
  await page.goto('/?e2e');
  await page.waitForFunction(() => (window as any).popstage?.doc && (window as any).popstage.stage.hasDocument);
  expect(await page.evaluate(() => { const v = (window as any).popstage.view; return [v.multi, v.fade, v.overlay]; })).toEqual([true, true, false]);
  await expect(page.locator('#vMulti')).toBeChecked();
  await page.locator('#view').focus();
  await page.keyboard.press('m');
  await page.waitForTimeout(400);
  await page.goto('/?e2e');
  await page.waitForFunction(() => (window as any).popstage?.doc && (window as any).popstage.stage.hasDocument);
  expect(await page.evaluate(() => (window as any).popstage.view.multi)).toBe(false);

  // 1回目は「操作の直後ではない」と断られ、ボタンを押すと開き直す
  await page.evaluate(() => {
    const w = window as any;
    w.__calls = 0;
    w.showOpenFilePicker = async () => { w.__calls++; if (w.__calls === 1) throw new DOMException('Must be handling a user gesture', 'SecurityError'); throw new DOMException('x', 'AbortError'); };
  });
  await page.locator('#view').focus();
  await page.keyboard.press('Control+o');
  await expect(page.locator('#askYes')).toHaveText('ファイルを選ぶ…');
  await page.locator('#askYes').click();
  await expect.poll(() => page.evaluate(() => (window as any).__calls)).toBe(2);
  await expect(page.locator('#toasts')).not.toContainText('SecurityError');
  // 保存先の選択も同じ。断られてもダウンロードに切り替えず、ボタンで開き直す
  await page.evaluate(() => {
    const w = window as any;
    w.__save = 0; w.__downloads = 0;
    w.showSaveFilePicker = async () => { w.__save++; if (w.__save === 1) throw new DOMException('Must be handling a user gesture', 'SecurityError'); throw new DOMException('x', 'AbortError'); };
    const orig = URL.createObjectURL; URL.createObjectURL = (b: any) => { w.__downloads++; return orig(b); };
  });
  await page.keyboard.press('Control+Shift+s');
  await expect(page.locator('#askYes')).toHaveText('保存先を選ぶ…');
  await page.locator('#askYes').click();
  await expect.poll(() => page.evaluate(() => (window as any).__save)).toBe(2);
  expect(await page.evaluate(() => (window as any).__downloads)).toBe(0);
});

test('塗るツールを選ぶと重ね表示を自動でONにし、離れると自動で入れた分だけOFFにする。設定で切れて、ブラウザに覚える', async ({ page }) => {
  await boot(page);
  const app = <T>(fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);
  const overlay = () => app(a => a.view.overlay as boolean);
  /** W は OFF → 選択中 → 全レイヤーと回るので、OFF になるまで押す */
  const overlayOff = async () => { for (let i = 0; i < 3 && await overlay(); i++) await page.keyboard.press('w'); };
  const reboot = async () => {
    await page.waitForTimeout(400);
    await page.goto('/?e2e');
    await page.waitForFunction(() => (window as any).popstage?.doc && (window as any).popstage.stage.hasDocument);
  };
  // 設定は右上の歯車から開く
  const openSettings = () => page.locator('#toolOptions [data-cmd=settings]').click();
  await openSettings();
  await expect(page.locator('#vAutoOverlay')).toBeChecked();
  await page.keyboard.press('Escape');
  await page.locator('#view').focus();

  // 塗るツールに切り替えるとONになる
  for (const key of ['b', 'e', 's', 'i']) {
    await page.keyboard.press('g');
    await overlayOff();
    expect(await overlay()).toBe(false);
    await page.keyboard.press(key);
    expect(await overlay(), key).toBe(true);
    await expect(page.locator('#vOverlaySel')).toBeChecked();
  }
  // 自動で入れた表示は、塗るツールから離れると切る(塗るツールどうしの切り替えでは切らない)
  await page.keyboard.press('e');
  expect(await overlay()).toBe(true);
  await page.keyboard.press('g');
  expect(await overlay()).toBe(false);
  await expect(page.locator('#vOverlayOff')).toBeChecked();
  // 自動で入れたまま開き直しても、離れたら切る
  await page.keyboard.press('b');
  await reboot();
  await page.locator('#view').focus();
  expect(await app(a => [a.tool, a.view.overlay])).toEqual(['brush', true]);
  await page.keyboard.press('g');
  expect(await overlay()).toBe(false);
  // 塗るツールの間に手で切り替えた表示は、離れても残す
  await page.keyboard.press('b');
  await page.keyboard.press('w'); // 選択中 → 全レイヤー
  await page.keyboard.press('g');
  expect(await app(a => a.overlayMode)).toBe('all');
  // 手で入れてから塗るツールにしたときも残す
  await overlayOff();
  await page.keyboard.press('w');
  await page.keyboard.press('b');
  await page.keyboard.press('g');
  expect(await app(a => a.overlayMode)).toBe('selected');
  // 塗るツールのままOFFにしたら、そのまま
  await page.keyboard.press('b');
  await overlayOff();
  expect(await overlay()).toBe(false);
  await page.keyboard.press('b'); // 選び直しでは入れない
  expect(await overlay()).toBe(false);
  // 「全体をぼかす」を開いてもONになり、塗るツール以外で開いたときは閉じると切る
  const blurOnce = async () => {
    await page.evaluate(() => (document.querySelector('[data-cmd=smoothAll]') as HTMLButtonElement).click());
    await expect(page.locator('#blurDialog')).toBeVisible();
    expect(await overlay()).toBe(true);
    await page.locator('#blurCancel').click();
    await page.locator('#view').focus();
  };
  await blurOnce();
  expect(await overlay()).toBe(true); // ブラシのままなので残す
  await page.keyboard.press('g');
  expect(await overlay()).toBe(false);
  await blurOnce();
  expect(await overlay()).toBe(false);
  // 自動でOFFの設定を切ると、離れても残す。切ったことは覚える
  await openSettings();
  await page.locator('#vAutoOverlayOff').uncheck();
  await page.keyboard.press('Escape');
  await page.locator('#view').focus();
  await page.keyboard.press('b');
  await page.keyboard.press('g');
  expect(await overlay()).toBe(true);
  await reboot();
  expect(await app(a => a.autoOverlayOff)).toBe(false);
  await openSettings();
  await expect(page.locator('#vAutoOverlayOff')).not.toBeChecked();
  await page.locator('#vAutoOverlayOff').check();
  await page.keyboard.press('Escape');
  await page.locator('#view').focus();
  await page.keyboard.press('b');

  // 起動して前回の塗るツールを戻すだけでは入れない
  await page.locator('#view').focus();
  await overlayOff();
  expect(await overlay()).toBe(false);
  await reboot();
  expect(await app(a => [a.tool, a.view.overlay, a.autoOverlay])).toEqual(['brush', false, true]);

  // 設定を切ると入らない。切ったことは覚える
  await openSettings();
  await page.locator('#vAutoOverlay').uncheck();
  await page.keyboard.press('Escape');
  await page.locator('#view').focus();
  await page.keyboard.press('g');
  await page.keyboard.press('b');
  expect(await overlay()).toBe(false);
  await reboot();
  expect(await app(a => a.autoOverlay)).toBe(false);
  await openSettings();
  await expect(page.locator('#vAutoOverlay')).not.toBeChecked();
  await expect(page.locator('#vAutoOverlayOff')).toBeDisabled(); // 自動でONにしないなら、OFFの設定は効かない
});

test('左のメニュー: 表示クリアで編集用の表示をまとめて切る。レイヤー向けの操作と、一覧の揺れのアイコン・自動揺れ', async ({ page }) => {
  await boot(page);
  await openTab(page, 'layer');
  const app = <T>(fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);
  const state = () => app(a => ({ overlay: a.view.overlay, fade: a.view.fade, flat: a.view.flat, grid: a.view.grid, multi: a.view.multi, paused: a.paused }));
  await app(a => { Object.assign(a.view, { overlay: true, fade: true, flat: true, grid: true, multi: true }); a.syncView(); a.setPaused(true); });
  await page.locator('nav button[data-cmd=cleanView]').click();
  expect(await state()).toEqual({ overlay: false, fade: false, flat: false, grid: false, multi: true, paused: false });
  // C キーでも同じ。押すだけで、元には戻さない
  await app(a => { a.view.grid = true; a.syncView(); });
  await page.locator('#view').focus();
  await page.keyboard.press('c');
  expect((await state()).grid).toBe(false);
  await page.keyboard.press('c');
  expect((await state()).grid).toBe(false);
  await expect(page.locator('nav button[data-cmd=cleanView] .tool-key')).toHaveText('C');

  // レイヤー向けの操作は左のメニューにまとまっている(右のパネルからは外した)
  for (const c of ['smoothAll', 'normalize', 'invert']) {
    await expect(page.locator(`nav [role=group] button[data-cmd=${c}]`)).toBeVisible();
    await expect(page.locator(`#props button[data-cmd=${c}]`)).toHaveCount(0);
  }
  const sum = () => app(a => a.activeLayer.weights.data.reduce((s: number, v: number) => s + v, 0) as number);
  const s0 = await sum();
  await page.locator('nav button[data-cmd=invert]').click();
  expect(await sum()).not.toBe(s0);
  await page.keyboard.press('Control+z');

  // 一覧の行の揺れのアイコンと、左のツールバーの「自動揺れ」は、右のパネルと連動する
  const swing = () => app(a => [a.activeLayer.physics.enabled, a.project.autoSwing.enabled]);
  const [sw0, au0] = await swing();
  const rowSwing = (i = 0) => page.locator('#layerList li .swing-btn').nth(i);
  const autoBtn = page.locator('nav button[data-cmd=toggleAutoSwing]');
  await expect(rowSwing()).toHaveAttribute('aria-pressed', String(sw0));
  await expect(autoBtn).toHaveAttribute('aria-pressed', String(au0));
  await rowSwing().click();
  await autoBtn.click();
  expect(await swing()).toEqual([!sw0, !au0]);
  await expect(page.locator('#pSwing')).toBeChecked({ checked: !sw0 });
  await expect(page.locator('#pAuto')).toBeChecked({ checked: !au0 });
  await expect(rowSwing()).toHaveAttribute('aria-pressed', String(!sw0));
  await expect(autoBtn).toHaveAttribute('aria-pressed', String(!au0));
  await expect(page.locator('#menubar [data-check=autoSwing]')).toHaveText(au0 ? '' : '✓');
  await page.locator('#pSwing').click();
  await expect(rowSwing()).toHaveAttribute('aria-pressed', String(sw0));
  // 1手ずつ元に戻せ、アイコンも戻る
  await page.keyboard.press('Control+z');
  expect(await swing()).toEqual([!sw0, !au0]);
  await expect(rowSwing()).toHaveAttribute('aria-pressed', String(!sw0));
  // 行のアイコンは、選んでいなくても押した行だけに効く
  await app(a => a.addLayer());
  const both = () => app(a => a.doc.layers.map((l: any) => l.physics.enabled) as boolean[]);
  const [b0, b1] = await both();
  const active = await app(a => a.activeLayer.id);
  await rowSwing(1).click(); // 一覧は上ほど手前なので、2行目は下のレイヤー(layers[0])
  expect(await both()).toEqual([!b0, b1]);
  expect(await app(a => a.activeLayer.id)).toBe(active);
  await page.keyboard.press('Control+z');
  expect(await both()).toEqual([b0, b1]);
  // 複数を選んでまとめて切り替えると(右パネルと同じ経路)、選んだ行のアイコンがどれも変わる
  await app(a => { a.selectAllLayers(); a.setLayerSwing(false); });
  for (const i of [0, 1]) await expect(rowSwing(i)).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Control+z');
  expect(await both()).toEqual([b0, b1]);

  // 膨らませるのプレビュー中も C は効く
  await page.locator('#view').focus();
  await page.keyboard.press('i');
  await dragOnStage(page, [0.4, 0.35], [0.6, 0.65]);
  await app(a => { a.view.grid = true; a.syncView(); });
  await page.locator('#view').focus();
  await page.keyboard.press('c');
  expect(await app(a => [a.previewingInflate, a.view.grid])).toEqual([true, false]);
  // 自動で揺らすは、右パネルと同じくプレビュー中も左のツールバーから切り替えられる
  await expect(autoBtn).toBeEnabled();
  await page.locator('#inflCancel').click();
});

test('左のメニュー: 低い画面でもすべてのボタンに届く', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 620 });
  await boot(page);
  for (const sel of ['[data-tool=brush]', '[data-tool=view]', '[data-cmd=toggleMulti]', '[data-cmd=toggleFade]', '[data-cmd=cleanView]', '[data-cmd=invert]']) {
    const el = page.locator(`#toolNav ${sel}`);
    await el.scrollIntoViewIfNeeded();
    await expect(el).toBeInViewport();
  }
  // ステータスバーに重ならない
  const nav = (await page.locator('#toolNav').boundingBox())!, status = (await page.locator('#sSave').boundingBox())!;
  expect(nav.y + nav.height).toBeLessThanOrEqual(status.y + 1);
  // 詰めた表示では、⇧W のような2文字のキー表記は名前と重なるので隠す(1文字のものは出す)
  await expect(page.locator('#toolNav [data-cmd=toggleFade] .tool-key')).toBeHidden();
  await expect(page.locator('#toolNav [data-cmd=toggleMulti] .tool-key')).toBeVisible();
});

test('左のメニュー: よくある高さ(864px)なら、スクロールせずに最後のボタンまで見える', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 864 });
  await boot(page);
  await expect(page.locator('#toolNav [data-cmd=invert]')).toBeInViewport({ ratio: 1 });
  expect(await page.locator('#toolNav').evaluate(n => n.scrollHeight <= n.clientHeight)).toBe(true);
  // ツールのアイコンは残し、その場で効く操作のアイコンだけを隠す
  await expect(page.locator('#toolNav [data-tool=brush] svg')).toBeVisible();
  await expect(page.locator('#toolNav [data-cmd=toggleMulti] svg')).toBeHidden();
  // アイコンが無いと名前がキーの表記と同じ高さに来るので、2文字の表記は隠す
  await expect(page.locator('#toolNav [data-cmd=toggleFade] .tool-key')).toBeHidden();
  await expect(page.locator('#toolNav [data-cmd=toggleMulti] .tool-key')).toBeVisible();
});

test('コマンドの表から、メニューのキー表記・ボタンのツールチップ・ヘルプのキー一覧を作る。記録・再生はメニューからも使える', async ({ page }) => {
  await boot(page);
  const app = <T>(fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);
  // メニューのキー表記(表の最初のキー)と aria-keyshortcuts
  await expect(page.locator('#menubar button[data-cmd=undo] kbd')).toHaveText('Ctrl+Z');
  await expect(page.locator('#menubar button[data-cmd=redo]')).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+Z Control+Y');
  await expect(page.locator('#menubar button[data-cmd=toggleGrid] kbd')).toHaveText('Shift+G');
  await expect(page.locator('#menubar button[data-cmd=toggleRecording] kbd')).toHaveText('R');
  // ボタンのツールチップ(名前・キー・説明)
  await expect(page.locator('#toolOptions button[data-cmd=undo]')).toHaveAttribute('title', '元に戻す (Ctrl+Z)');
  await expect(page.locator('#takeRec')).toHaveAttribute('title', /^操作の記録 \(R\): /);
  await expect(page.locator('.tool[data-tool=erase]')).toHaveAttribute('title', '消しゴム (E、ブラシ中は Alt)');
  // ヘルプのキー一覧
  const keys = page.locator('#helpKeys');
  await expect(keys).toContainText('やり直す');
  // キーはマウスの操作と同じキーの札で出す(1つのキーごとに札を並べる)
  await expect(keys.locator('.mh[title="Ctrl+Shift+Z"] kbd')).toHaveText(['Ctrl', 'Shift', 'Z']);
  await expect(keys.locator('.mh[title="Ctrl+Y"]')).toHaveCount(1);
  // ツールのキーはツールのボタンに書いてあるので、一覧には出さない
  for (const k of ['B', 'E', 'S', 'I', 'G', 'Y', 'V', 'H']) await expect(keys.locator(`.mh[title="${k}"]`)).toHaveCount(0);
  await expect(page.locator('#helpOps')).not.toContainText('浮いているパネル');
  await expect(page.locator('#helpOps')).toContainText('3面図の視点を戻す');
  await expect(page.locator('#helpOps')).not.toContainText('3面図の自由角度');
  // ヘルプには、カッコの補足を書かない。マウスの操作は絵で出す
  expect(await page.locator('#helpDialog').evaluate(d => /[()()]/.test(d.textContent!))).toBe(false);
  await expect(page.locator('#helpOps .mh-mouse[aria-label=右ドラッグ]').first()).toBeAttached();
  await expect(keys.locator('.mh[title="Ctrl+Shift+Alt+P"]')).toHaveCount(0); // デバッグ用は出さない

  // アニメーションのメニューから記録を始めて止め、再生する。記録中は再生と消すを押せない
  await app(a => a.setPaused(false));
  const menu = page.locator('#menubar .dropdown', { hasText: 'アニメーション' });
  await menu.locator('[role=button]').click();
  await expect(menu.locator('button[data-cmd=togglePlay]')).toBeDisabled();
  await menu.locator('button[data-cmd=toggleRecording]').click();
  expect(await app(a => a.takeState)).toBe('recording');
  await expect(page.locator('#takePlay')).toBeDisabled();
  await expect(page.locator('#takeClear')).toBeDisabled();
  await dragOnStage(page, [0.5, 0.5], [0.6, 0.55], 'right');
  await page.waitForTimeout(1100);
  await page.locator('#playStop').click();
  await expect.poll(() => app(a => !!a.project.take)).toBe(true);
  await menu.locator('[role=button]').click();
  await menu.locator('button[data-cmd=togglePlay]').click();
  expect(await app(a => a.takeState)).toBe('playing');
  await page.locator('#playStop').click();
  expect(await app(a => a.takeState)).toBe('idle');
  // メニューの外のボタンは、キーボードで押してもフォーカスを残す(続けて押せる)
  await openTab(page, 'anim');
  await page.locator('#takeRec').focus();
  await page.keyboard.press('Enter');
  expect(await app(a => a.takeState)).toBe('recording');
  await expect(page.locator('#takeRec')).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await app(a => a.takeState)).toBe('idle');
});

test('右パネルのタブは効く範囲で分ける。説明は「?」で開き、左のツールバーはツールと操作を見分けられる', async ({ page }) => {
  // 前の版で「編集」タブを選んでいた人は「レイヤー」タブで始まる
  await page.addInitScript(() => { if (!localStorage.getItem('popstage.prefs.v1')) localStorage.setItem('popstage.prefs.v1', JSON.stringify({ panelTab: 'edit' })); });
  await boot(page);
  await expect(page.locator('#pTabs [data-ptab=layer]')).toHaveAttribute('aria-selected', 'true');
  // レイヤー: 選択中のレイヤーの設定(ポップ量・重ね方・揺れ・プリセット)
  for (const id of ['#pPop', '#pBlend', '#pSwing', '#pPreset']) await expect(page.locator(id)).toBeVisible();
  await expect(page.locator('#activeLayerName')).not.toHaveText('-');
  // アニメーション: 自動揺らし・記録・キーフレーム
  await openTab(page, 'anim');
  for (const id of ['#pAuto', '#takeRec', '#keyAdd']) await expect(page.locator(id)).toBeVisible();
  await expect(page.locator('#pPop')).toBeHidden();
  // 画像と表示: メッシュ密度・不透明度・表示の切り替え・画角
  await openTab(page, 'view');
  for (const id of ['#pDensity', '#pOpacity', '#vGrid', '#pFov']) await expect(page.locator(id)).toBeVisible();

  // 説明は最初は隠れていて、「?」で開閉する。中身は選んだ値に合わせて変わる
  await openTab(page, 'layer');
  // 読み上げでは「○○の説明」と読み、入力欄からも説明をたどれる
  await expect(page.locator('button.help-btn[data-help=pPopHelp]')).toHaveAttribute('aria-label', 'ポップ量の説明');
  await expect(page.locator('#pPop')).toHaveAttribute('aria-describedby', 'pPopHelp');
  await expect(page.locator('#pBlend')).toHaveAttribute('aria-describedby', 'pBlendDesc');
  await expect(page.locator('button.help-btn[data-help=inflSoftHelp]')).toHaveAttribute('aria-label', '縁のなだらかさの説明');
  const help = page.locator('button.help-btn[data-help=pBlendDesc]'), desc = page.locator('#pBlendDesc');
  await expect(desc).toBeHidden();
  await expect(help).toHaveAttribute('aria-expanded', 'false');
  await help.click();
  await expect(desc).toBeVisible();
  await expect(help).toHaveAttribute('aria-expanded', 'true');
  const text = await desc.textContent();
  await page.locator('#pBlend').selectOption(await page.evaluate(() => (window as any).popstage.activeLayer.blend === 'max' ? 'add' : 'max'));
  await expect(desc).not.toHaveText(text!);
  await help.click();
  await expect(desc).toBeHidden();
  // 揺らし方の固有設定の補足も「?」で開く(ツールチップにはしない)
  await page.locator('#physDetails summary').click();
  const mpHelp = page.locator('#motionParams .help-btn').first();
  await mpHelp.click();
  await expect(page.locator('#motionParams .help-text').first()).toBeVisible();
  await expect(page.locator('#motionParams .prop[title]')).toHaveCount(0);
  // 表示の切り替えの「?」を押しても、切り替えは変わらない
  await openTab(page, 'view');
  const fade = await page.evaluate(() => (window as any).popstage.view.fade);
  await page.locator('button.help-btn[data-help=vFadeHelp]').click();
  await expect(page.locator('#vFadeHelp')).toBeVisible();
  expect(await page.evaluate(() => (window as any).popstage.view.fade)).toBe(fade);

  // 左のツールバー: ツールは押すと選んだ状態になる。その場で効く操作は、見出し付きのまとまりの中に置き、選んだ状態にならない
  await expect(page.locator('#toolNav > .tool')).toHaveCount(8);
  await expect(page.locator('#toolNav .tool svg')).toHaveCount(8);
  const acts = page.locator('#toolNav [role=group] .nav-act');
  await expect(acts).toHaveCount(20); // 開く・保存・書き出しは既定では隠しているが、DOM にはある
  await expect(page.locator('#toolNav [role=group] .nav-act svg')).toHaveCount(20);
  await expect(page.locator('#toolNav [role=group] .tool')).toHaveCount(0);
  // ツールをいちばん上に置き、まとまりは上のメニューと同じ順に並べる
  await expect(page.locator('#toolNav > *').first()).toHaveAttribute('data-tool', 'brush');
  await expect(page.locator('#toolNav [role=group] .nav-group-label')).toHaveText(['ファイル', '編集', '表示', 'アニメ']);
  await page.locator('#toolNav [data-cmd=cleanView]').click();
  await expect(page.locator('#toolNav [data-cmd=cleanView]')).not.toHaveAttribute('aria-pressed', /.*/);

});

test('左のツールバー: 表示の切り替えは、入・切を aria-pressed とメニューの ✓ に映す', async ({ page }) => {
  await boot(page);
  const app = <T>(fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);
  const allOff = () => app(a => { Object.assign(a.view, { overlay: false, fade: false, grid: false, multi: false }); a.syncView(); });
  const btn = (cmd: string) => page.locator(`#toolNav [data-cmd=${cmd}]`);
  // 1つずつ、すべて切った状態から押す(画像を薄くは重ね表示も入れるので、順番に頼らない)
  const toggles = [['toggleMulti', 'multi', 'M'], ['toggleFade', 'fade', '⇧W'], ['toggleGrid', 'grid', '⇧G']] as const;
  for (const [cmd, key, label] of toggles) {
    await allOff();
    const b = btn(cmd);
    await expect(b.locator('.tool-key')).toHaveText(label);
    await expect(b).toHaveAttribute('aria-pressed', 'false');
    await b.click();
    expect((await app(a => ({ ...a.view })))[key]).toBe(true);
    await expect(b).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(`#menubar [data-check=${key}]`)).toHaveText('✓');
    await b.click();
    await expect(b).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator(`#menubar [data-check=${key}]`)).toHaveText('');
  }
  // ウェイトは押すたびに OFF → 選択中 → 全レイヤー → OFF。全レイヤーのときは「全」の印を付ける(メニューには状態を出さない)
  await allOff();
  const ov = btn('toggleOverlay');
  await expect(ov.locator('.tool-key')).toHaveText('W');
  await expect(page.locator('#menubar [data-check=overlay]')).toHaveCount(0);
  for (const [pressed, badge] of [['true', false], ['true', true], ['false', false]] as const) {
    await ov.click();
    await expect(ov).toHaveAttribute('aria-pressed', pressed);
    await expect(ov.locator('.nav-badge')).toBeVisible({ visible: badge });
  }
  // 画像を薄くを入れると、重ね表示も入るので、ウェイトのボタンも入になる
  await allOff();
  await btn('toggleFade').click();
  await expect(btn('toggleOverlay')).toHaveAttribute('aria-pressed', 'true');
  // 読み上げでは、縮めた文言でなく元の名前で呼ぶ
  await expect(btn('toggleOverlay')).toHaveAccessibleName('ウェイトの重ね表示');
  // キーで変えても映る
  await allOff();
  await page.locator('#view').focus();
  await page.keyboard.press('Shift+G');
  expect(await app(a => a.view.grid)).toBe(true);
  await expect(btn('toggleGrid')).toHaveAttribute('aria-pressed', 'true');
  // 表示クリアで切れたものは、ボタンも切に戻る(3面図は切らない)
  await app(a => { Object.assign(a.view, { overlay: true, fade: true, grid: true, multi: true }); a.syncView(); });
  await btn('cleanView').click();
  await expect(page.locator('#toolNav .nav-group[aria-label=表示に効く操作] .nav-act[aria-pressed=true]')).toHaveText([/3面図/, /透過/]); // 背景の透過は編集用の表示ではないので切らない
});

test('左のツールバー: 背景を透過は、入・切をボタン・メニュー・右パネルに映し、切ると背景色(既定は白)で塗る', async ({ page }) => {
  await boot(page);
  const app = <T>(fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);
  const btn = page.locator('#toolNav [data-cmd=toggleTransparent]');
  // 既定は透過
  expect(await app(a => a.project.background)).toBeNull();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(btn).toHaveAccessibleName('背景を透過');
  await expect(page.locator('#menubar [data-check=transparent]')).toHaveText('✓');
  await expect(page.locator('#stage')).not.toHaveClass(/solid/);
  // 切ると白で塗る
  await btn.click();
  expect(await app(a => a.project.background)).toBe('#ffffff');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#menubar [data-check=transparent]')).toHaveText('');
  await expect(page.locator('#stage')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await openTab(page, 'view');
  await expect(page.locator('#pBgTransparent')).not.toBeChecked();
  // 右パネルで色を変えてから透過にし、また切ると、その色に戻る
  await page.locator('#pBgColor').evaluate((el: HTMLInputElement) => { el.value = '#336699'; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
  expect(await app(a => a.project.background)).toBe('#336699');
  await page.locator('#pBgTransparent').check();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#pBgColor')).toHaveValue('#336699');
  await btn.click();
  expect(await app(a => a.project.background)).toBe('#336699');
  // 1手として元に戻せる
  await app(a => a.history.undo());
  expect(await app(a => a.project.background)).toBeNull();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await app(a => a.history.redo());
  expect(await app(a => a.project.background)).toBe('#336699');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  // 透過にしても色は覚えておき、開き直したあとも、切るとその色で塗る(色の値は確かめてから使う)
  await btn.click();
  await page.reload();
  await page.waitForFunction(() => (window as any).popstage?.doc);
  expect(await app(a => [a.project.background, a.bgColor])).toEqual([null, '#336699']);
  await page.waitForTimeout(400); // 設定の書き込みは間引かれるので、済んでから書き換える
  await page.evaluate(() => { const k = 'popstage.prefs.v1', p = JSON.parse(localStorage.getItem(k)!); p.newImage = { background: null, bgColor: 'red' }; localStorage.setItem(k, JSON.stringify(p)); });
  await page.reload();
  await page.waitForFunction(() => (window as any).popstage?.doc);
  expect(await app(a => a.bgColor)).toBe('#ffffff');
  // bgColor を覚える前の版の設定(透過でない背景色だけ)からも引き継ぐ
  await page.waitForTimeout(400); // 設定の書き込みは間引かれるので、済んでから書き換える
  await page.evaluate(() => { const k = 'popstage.prefs.v1', p = JSON.parse(localStorage.getItem(k)!); p.newImage = { background: '#224466' }; localStorage.setItem(k, JSON.stringify(p)); });
  await page.reload();
  await page.waitForFunction(() => (window as any).popstage?.doc);
  expect(await app(a => a.bgColor)).toBe('#224466');
});

test('ツールオプションの欄は選択中のツールの設定だけを出す。膨らみは描く前に形や断面を選べる', async ({ page }) => {
  await boot(page);
  const app = <T>(fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);
  await page.locator('#view').focus();
  // ブラシ: ブラシの設定だけ
  await page.keyboard.press('b');
  await expect(page.locator('#brushSize')).toBeVisible();
  await expect(page.locator('#tInflProfile')).toBeHidden();
  // つかむ: 設定は無く、ヒントだけ
  await page.keyboard.press('g');
  await expect(page.locator('#brushSize')).toBeHidden();
  await expect(page.locator('#tInflProfile')).toBeHidden();
  await expect(page.locator('#toolHint')).toContainText('引っ張って');
  await expect(page.locator('#toolHint .mh-mouse[aria-label=左ドラッグ]')).toHaveCount(1);
  // 膨らみ: 次に描くときの設定を選び、描くとその設定で始まる
  await page.keyboard.press('i');
  await expect(page.locator('#tInflProfile')).toBeVisible();
  await page.locator('#tInflProfile').selectOption('cushion');
  await page.locator('#tInflKind').selectOption('rect');
  await page.locator('#view').focus();
  await dragOnStage(page, [0.4, 0.4], [0.6, 0.6]);
  expect(await app(a => [a.inflateState.settings.profile, a.inflateState.settings.shape])).toEqual(['cushion', 'rect']);
  await expect(page.locator('input[name=inflProfile][value=cushion]')).toBeChecked();
  // プレビュー中に上の欄を変えると、下のパネルにも映る
  await page.locator('#tInflBlend').selectOption('add');
  await expect(page.locator('#inflBlend')).toHaveValue('add');
  await page.locator('#inflCancel').click();
});

test('プリセットで自動揺らしの周期を変えるのは、揺れているレイヤーがそのレイヤーだけのとき', async ({ page }) => {
  await boot(page);
  const app = <T>(fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);
  await openTab(page, 'layer');
  // 揺れているレイヤーが1枚: 周期もおすすめの値(ばいんばいん 1.8 秒)になる
  await page.locator('#pPreset').selectOption('bain');
  expect(await app(a => a.project.autoSwing.period)).toBe(1.8);
  // 何も塗っていないレイヤーは、揺れているとは数えない
  await app(a => { a.addLayer(); a.setActiveLayer(a.doc.layers[0].id); });
  await page.locator('#pPreset').selectOption('zun');
  expect(await app(a => a.project.autoSwing.period)).toBe(1.2);
  // 塗ってあるレイヤー(複製)がもう1枚揺れていると、周期は変えずに知らせる
  await app(a => a.duplicateLayer());
  await page.locator('#pPreset').selectOption('bain');
  expect(await app(a => [a.activeLayer.physics.preset, a.project.autoSwing.period])).toEqual(['bain', 1.2]);
  await expect(page.locator('#toasts')).toContainText('周期は変えていません');
  // ほかのレイヤーの揺れを切ると、また周期も変える
  await app(a => { const o = a.doc.layers[0]; a.store.patchLayer(o.id, { physics: { ...o.physics, enabled: false } }); });
  await page.locator('#pPreset').selectOption('zun');
  expect(await app(a => a.project.autoSwing.period)).toBe(1.2);
  await page.locator('#pPreset').selectOption('bain');
  expect(await app(a => a.project.autoSwing.period)).toBe(1.8);
});
test('fps・頂点数は ?debug のときだけ出す。キーフレームの上書きは行の末尾のアイコン。メニューは矢印キーでたどれる', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#sFps')).toBeHidden();
  await expect(page.locator('#sVerts')).toBeHidden();
  await expect(page.locator('#sZoom')).toBeVisible();
  // キーフレームの行: 並べ替えのつまみ・番号・通り方・上書き・削除の順(次までの秒数は行の間)
  await openTab(page, 'anim');
  await page.locator('#keyAdd').click();
  const acts = await page.locator('#keyList > li.key-row:not(.key-back)').first().locator('[data-act]').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.act));
  expect(acts).toEqual(['drag', 'go', 'mode', 'set', 'del']);
  await expect(page.locator('#keyList [data-act=set]').first()).toHaveAttribute('aria-label', '今の視点で上書き');
  // メニュー: ↓ で最初の項目へ、↓↑ で前後へ、→ で隣のメニューへ、Esc で閉じる
  const file = page.locator('#menubar .dropdown').first();
  await file.locator('[role=button]').focus();
  await page.keyboard.press('ArrowDown');
  await expect(file.locator('[role=menuitem]').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(file.locator('[role=menuitem]').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await expect(file.locator('[role=menuitem]:not(:disabled)').last()).toBeFocused(); // 端から反対の端へ
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#menubar .dropdown').nth(1).locator('[role=menuitem]:not(:disabled)').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#menubar .dropdown').nth(1).locator('ul.menu')).toBeHidden();
  // メニューの中の Home はショートカット(視点リセット)にしない
  const yaw = await page.evaluate(() => { const a = (window as any).popstage; a.project.camera.yaw = 1; return 1; });
  await file.locator('[role=button]').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  expect(await page.evaluate(() => (window as any).popstage.project.camera.yaw)).toBe(yaw);
  await expect(file.locator('[role=menuitem]').first()).toBeFocused();
});

test('膨らみの既定値は覚える。プレビュー中に変えてキャンセルした値は覚えず、適用した値は覚える', async ({ page }) => {
  await boot(page);
  const profile = () => page.evaluate(() => (window as any).popstage.inflateSettings.profile);
  await page.locator('#view').focus();
  await page.keyboard.press('i');
  await page.locator('#tInflProfile').selectOption('cushion');
  await page.waitForTimeout(400); // 書き込みは間引いている
  await page.reload();
  await page.waitForFunction(() => (window as any).popstage?.doc);
  expect(await profile()).toBe('cushion');
  // プレビュー中に変えてキャンセル: 覚えない
  await page.locator('#view').focus();
  await page.keyboard.press('i');
  await dragOnStage(page, [0.4, 0.4], [0.6, 0.6]);
  await page.locator('input[name=inflProfile][value=cone]').check();
  await page.locator('#inflCancel').click();
  expect(await profile()).toBe('cushion');
  await expect(page.locator('#tInflProfile')).toHaveValue('cushion');
  // プレビュー中に変えて適用: 覚える
  await page.locator('#view').focus();
  await dragOnStage(page, [0.4, 0.4], [0.6, 0.6]);
  await page.locator('input[name=inflProfile][value=cone]').check();
  await page.locator('#inflApply').click();
  await page.waitForTimeout(400);
  await page.reload();
  await page.waitForFunction(() => (window as any).popstage?.doc);
  expect(await profile()).toBe('cone');
});

test('膨らませる・ぼかすのパネルは右下に出て、見出しをつかんで動かせる。位置は覚え、ダブルクリックで右下に戻る', async ({ page }) => {
  await boot(page);
  const dlg = page.locator('#blurDialog');
  const title = page.locator('#blurTitle');
  const box = async () => (await dlg.boundingBox())!;
  const vp = page.viewportSize()!;
  await page.locator('nav button[data-cmd=smoothAll]').click();
  await expect(dlg).toHaveJSProperty('open', true);
  // 最初は画面の右下(右パネルにかぶってよい)
  let b = await box();
  expect(vp.width - (b.x + b.width)).toBeLessThan(40);
  expect(vp.height - (b.y + b.height)).toBeLessThan(80);

  // 見出しをつかんで左上へ動かす
  const t = (await title.boundingBox())!;
  await page.mouse.move(t.x + 40, t.y + t.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x - 500, t.y - 300, { steps: 5 });
  await page.mouse.up();
  b = await box();
  expect(b.x).toBeLessThan(t.x - 400);
  expect(b.y).toBeLessThan(t.y - 200);
  const moved = { x: Math.round(b.x), y: Math.round(b.y) };

  // 閉じて開き直しても、動かした位置に出る
  await page.locator('#blurCancel').click();
  await expect(dlg).toHaveJSProperty('open', false);
  await page.locator('nav button[data-cmd=smoothAll]').click();
  await expect(dlg).toHaveJSProperty('open', true);
  b = await box();
  expect(Math.abs(b.x - moved.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(b.y - moved.y)).toBeLessThanOrEqual(1);

  // 画面の外へは出ない
  const t2 = (await title.boundingBox())!;
  await page.mouse.move(t2.x + 40, t2.y + t2.height / 2);
  await page.mouse.down();
  await page.mouse.move(-500, -500, { steps: 5 });
  await page.mouse.up();
  b = await box();
  expect(b.x).toBeGreaterThanOrEqual(0);
  expect(b.y).toBeGreaterThanOrEqual(0);

  // 位置は膨らませるのパネルと共通。下の端に寄せておき、開いたあと高さが伸びても(説明を開くなど)画面の下へ出ない
  const t3 = (await title.boundingBox())!;
  await page.mouse.move(t3.x + 40, t3.y + t3.height / 2);
  await page.mouse.down();
  await page.mouse.move(t3.x + 40 - 200, vp.height, { steps: 5 });
  await page.mouse.up();
  const blurBox = await box();
  await page.locator('#blurCancel').click();
  await page.keyboard.press('i');
  await dragOnStage(page, [0.6, 0.3], [0.8, 0.5]);
  const infl = page.locator('#inflateDialog');
  await expect(infl).toHaveJSProperty('open', true);
  let ib = (await infl.boundingBox())!;
  expect(Math.abs(ib.x + ib.width - (blurBox.x + blurBox.width))).toBeLessThanOrEqual(1);
  expect(Math.abs(ib.y + ib.height - (blurBox.y + blurBox.height))).toBeLessThanOrEqual(1);
  await infl.locator('[data-help=inflAngleHelp]').click();
  await expect(page.locator('#inflAngleHelp')).toBeVisible();
  ib = (await infl.boundingBox())!;
  expect(ib.y + ib.height).toBeLessThanOrEqual(vp.height);
  await expect(page.locator('#inflApply')).toBeInViewport();

  // ダブルクリックで右下に戻る
  await page.locator('#inflTitle').dblclick();
  ib = (await infl.boundingBox())!;
  expect(vp.width - (ib.x + ib.width)).toBeLessThan(40);
  expect(vp.height - (ib.y + ib.height)).toBeLessThan(80);
  await page.locator('#inflCancel').click();
});

test('ポップ量のスライダーの最大値は設定で変えられ(既定 500px)、数値の欄にはそれを超えて打てる。設定は覚える', async ({ page }) => {
  await boot(page);
  await openTab(page, 'layer');
  const pop = () => page.evaluate(() => (window as any).popstage.activeLayer.pop as number);
  // 既定では右端が 500px
  await expect(page.locator('#pPop')).toHaveAttribute('max', '500');
  await page.locator('#pPop').fill('500');
  expect(await pop()).toBe(500);
  // 数値の欄は 1500px まで打て、スライダーは右端に止まる
  await page.locator('#pPopN').fill('900');
  await page.locator('#pPopN').press('Enter');
  expect(await pop()).toBe(900);
  await expect(page.locator('#pPop')).toHaveValue('500');
  // 設定で 1200px にすると、右端が 1200px になる(1000px を超えるので後半は粗い目盛り)
  await page.locator('#toolOptions [data-cmd=settings]').click();
  await expect(page.locator('#setPopMax')).toHaveValue('500');
  await page.locator('#setPopMax').fill('1200');
  await page.locator('#setPopMax').press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.locator('#pPop')).toHaveAttribute('max', '1000');
  await page.locator('#pPop').fill('1000');
  expect(await pop()).toBe(1200);
  // 範囲の外の値は 100〜1500px に収める。設定は開き直しても覚えている
  await page.locator('#toolOptions [data-cmd=settings]').click();
  await page.locator('#setPopMax').fill('5000');
  await page.locator('#setPopMax').press('Enter');
  await expect(page.locator('#setPopMax')).toHaveValue('1500');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.goto('/?e2e');
  await page.waitForFunction(() => (window as any).popstage?.doc && (window as any).popstage.stage.hasDocument);
  expect(await page.evaluate(() => (window as any).popstage.popMax)).toBe(1500);
});

test('右パネルは3Dビューの右上のボタン・Shift+P・表示メニューで開閉でき、開閉を覚える', async ({ page }) => {
  await boot(page);
  const aside = page.locator('#sidePanel'), tab = page.locator('#panelToggle');
  // ボタンは3Dビューの右上(開いても閉じても同じ所)
  const corner = async () => {
    const [b, v] = await Promise.all([tab.boundingBox(), page.locator('#stageWrap').boundingBox()]);
    return Math.abs(b!.y - v!.y) < 20 && Math.abs(b!.x + b!.width - (v!.x + v!.width)) < 20;
  };
  await expect.poll(corner).toBe(true);
  const canvasWidth = () => page.locator('#view').evaluate(el => el.getBoundingClientRect().width);
  await expect(aside).toBeVisible();
  await expect(tab).toHaveAttribute('aria-expanded', 'true');
  const w0 = await canvasWidth();
  await tab.click();
  await expect(aside).toBeHidden();
  await expect(tab).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(canvasWidth).toBeGreaterThan(w0 + 200); // 3Dビューが広がる
  await expect(page.locator('#menubar [data-check=panel]')).toHaveText('');
  await expect.poll(corner).toBe(true);
  // 開き直しても閉じたまま
  await page.waitForTimeout(300);
  await page.goto('/?e2e');
  await page.waitForFunction(() => (window as any).popstage?.doc && (window as any).popstage.stage.hasDocument);
  await expect(aside).toBeHidden();
  // Shift+P で開く
  await page.locator('#view').focus();
  await page.keyboard.press('Shift+P');
  await expect(aside).toBeVisible();
  await expect(page.locator('#menubar [data-check=panel]')).toHaveText('✓');
  // UIを隠すと開閉のボタンも隠れる
  await page.evaluate(() => (window as any).popstage.setUiHidden(true));
  await expect(tab).toBeHidden();
});
