import { test, expect, devices } from '@playwright/test';
import { boot, dragOnStage, watchGlErrors, weightSum } from './helpers';

watchGlErrors();

const PC_PARTS = ['#menubar', '#toolOptions', '#toolNav', 'body > main > aside', 'body > footer'];
const viewSize = (page: import('@playwright/test').Page) => page.locator('#view').evaluate(c => [c.clientWidth, c.clientHeight]);

test('Tab で UI を隠して3Dビューを画面いっぱいにし、もう一度 Tab・Esc・戻すボタンで戻す', async ({ page }) => {
  await boot(page);
  const before = await viewSize(page);
  await page.keyboard.press('Tab');
  await expect(page.locator('html')).toHaveClass(/ui-hidden/);
  for (const s of PC_PARTS) await expect(page.locator(s)).toBeHidden();
  await expect.poll(() => viewSize(page)).toEqual([1400, 900]);
  expect(before[0]).toBeLessThan(1400);
  await page.keyboard.press('Tab');
  await expect(page.locator('html')).not.toHaveClass(/ui-hidden/);
  for (const s of PC_PARTS) await expect(page.locator(s)).toBeVisible();
  await expect.poll(() => viewSize(page)).toEqual(before);

  // Esc でも戻る
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).not.toHaveClass(/ui-hidden/);

  // ツールオプションの欄の右端のボタンで隠し、マウスを動かすと出る右上のバーの「UIを戻す」で戻す
  await page.locator('#toolOptions [data-cmd=toggleUi]').click();
  await expect(page.locator('html')).toHaveClass(/ui-hidden/);
  const restore = page.locator('#uiRestore');
  await page.mouse.move(700, 450);
  await page.mouse.move(710, 460);
  await expect(page.locator('#viewBar')).toHaveCSS('opacity', '1');
  await restore.click();
  await expect(page.locator('html')).not.toHaveClass(/ui-hidden/);
  await expect(restore).toBeHidden();
});

test('マウスを止めると右上のバー(戻すボタン)は消え、隠している間も3面図は出さない', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('M');
  await expect(page.locator('#multiView')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.locator('#multiView')).toBeHidden();
  await page.mouse.move(600, 400);
  await page.mouse.move(610, 410);
  await expect(page.locator('#viewBar')).toHaveCSS('opacity', '1');
  await expect(page.locator('#viewBar')).toHaveCSS('opacity', '0', { timeout: 5000 });
  // ショートカットはそのまま効く
  await page.keyboard.press('Shift+G');
  expect(await page.evaluate(() => (window as any).popstage.view.grid)).toBe(true);
  await page.keyboard.press('Tab');
  // 戻すと3面図も戻る
  await expect(page.locator('#multiView')).toBeVisible();
});

test('隠している間は見るだけ: ブラシでも左ドラッグは平行移動で塗らず、右ドラッグで回し、ダブルクリックで視点を戻す。戻すとツールが効く', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('B');
  const cam = () => page.evaluate(() => { const c = (window as any).popstage.project.camera; return { yaw: c.yaw, pitch: c.pitch, zoom: c.zoom, target: { ...c.target } }; });
  const w0 = await weightSum(page), c0 = await cam();
  await page.keyboard.press('Tab');
  await expect(page.locator('html')).toHaveClass(/ui-hidden/);
  // 左ドラッグ: 平行移動(右へ引くと注視点は左へ)。塗らない
  await dragOnStage(page, [0.45, 0.5], [0.6, 0.5]);
  const c1 = await cam();
  expect(c1.target.x).toBeLessThan(c0.target.x - 10);
  expect(c1.yaw).toBe(c0.yaw);
  expect(await weightSum(page)).toBe(w0);
  // 右ドラッグ: 回す
  await dragOnStage(page, [0.45, 0.5], [0.6, 0.5], 'right');
  expect((await cam()).yaw).toBeLessThan(c1.yaw - 0.3);
  // ダブルクリック: 正面の視点に戻す(Home と同じ)
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(cam).toEqual({ yaw: 0, pitch: 0, zoom: 1, target: { x: 0, y: 0, z: 0 } });
  // 戻すとブラシで塗れる
  await page.keyboard.press('Tab');
  await expect(page.locator('html')).not.toHaveClass(/ui-hidden/);
  await dragOnStage(page, [0.45, 0.5], [0.55, 0.5]);
  expect(await weightSum(page)).toBeGreaterThan(w0);
});

test('右上のバーで、アニメーションの再生・停止、自動で揺らす、お気に入りの切り替えができる', async ({ page }) => {
  await boot(page);
  const bar = page.locator('#viewBar');
  const peek = async () => { await page.mouse.move(700, 450); await page.mouse.move(710, 460); await expect(bar).toHaveCSS('opacity', '1'); };
  // キーフレームが無く記録も無いと再生できない。お気に入りが無いと選ぶ欄を出さない
  await page.keyboard.press('Tab');
  await peek();
  await expect(bar.locator('[data-cmd=toggleAnimation]')).toBeDisabled();
  await expect(page.locator('#viewFav')).toBeHidden();
  await page.keyboard.press('Tab');

  await page.evaluate(() => {
    const a = (window as any).popstage;
    a.keyDraft = [0, 0.6].map(yaw => ({ view: { yaw, pitch: 0, zoom: 1, target: { x: 0, y: 0, z: 0 } }, seconds: 1, mode: 'smooth' }));
    a.emit('take', a.takeState);
    a.store.patchLayer(a.doc.layers[0].id, { pop: 321 });
    a.addFavorite();
    a.renameFavorite(a.project.favorites[0].id, 'ふわっと');
    a.store.patchLayer(a.doc.layers[0].id, { pop: 100 });
  });
  await page.keyboard.press('Tab');
  await peek();
  // 再生・停止(キーフレームの動きをループ再生する)
  const play = bar.locator('[data-cmd=toggleAnimation]');
  await expect(play).toHaveAttribute('aria-label', 'アニメーションを再生');
  await play.click();
  await expect.poll(() => page.evaluate(() => (window as any).popstage.takeState)).toBe('playing');
  await expect(play).toHaveAttribute('aria-label', '再生を止める');
  await peek();
  await play.click();
  await expect.poll(() => page.evaluate(() => (window as any).popstage.takeState)).toBe('idle');
  // 記録(キーフレームから作った)があれば、キーフレームを消しても再生できる
  await page.evaluate(() => { const a = (window as any).popstage; a.keyDraft = []; a.emit('take', a.takeState); });
  await peek();
  await play.click();
  await expect.poll(() => page.evaluate(() => (window as any).popstage.takeState)).toBe('playing');
  await peek();
  await play.click();
  // 自動で揺らす
  const auto = bar.locator('[data-cmd=toggleAutoSwing]');
  const autoOn = () => page.evaluate(() => (window as any).popstage.project.autoSwing.enabled);
  const was = await autoOn();
  await expect(auto).toHaveAttribute('aria-pressed', String(was));
  await peek();
  await auto.click();
  expect(await autoOn()).toBe(!was);
  await expect(auto).toHaveAttribute('aria-pressed', String(!was));
  // お気に入り: 選ぶと当て、欄は「お気に入り」の見出しに戻る
  const fav = page.locator('#viewFav');
  await expect(fav).toBeVisible();
  await peek();
  await fav.selectOption({ label: 'ふわっと' });
  expect(await page.evaluate(() => (window as any).popstage.doc.layers[0].pop)).toBe(321);
  await expect(fav).toHaveValue('');
  expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('viewFav');
  // 戻すとバーは消える
  await page.keyboard.press('Tab');
  await expect(bar).toBeHidden();

  // 欄を選ばずに閉じてフォーカスが残っても、Esc・(マウスで触ったなら)Tab で戻せる
  for (const key of ['Escape', 'Tab']) {
    await page.keyboard.press('Tab');
    await expect(page.locator('html')).toHaveClass(/ui-hidden/);
    await peek();
    await fav.dispatchEvent('pointerdown');
    await fav.focus();
    await page.keyboard.press(key);
    await expect(page.locator('html')).not.toHaveClass(/ui-hidden/);
    expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('viewFav');
  }
});

test('見ている間は、戻る・進むのボタンでループ再生を止めない', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const a = (window as any).popstage;
    a.keyDraft = [0, 0.6].map(yaw => ({ view: { yaw, pitch: 0, zoom: 1, target: { x: 0, y: 0, z: 0 } }, seconds: 1, mode: 'smooth' }));
    a.emit('take', a.takeState);
    a.playKeys();
  });
  await expect.poll(() => page.evaluate(() => (window as any).popstage.takeState)).toBe('playing');
  await page.keyboard.press('Tab');
  // Playwright のマウスは戻る・進むのボタンを押せないので、キャンバスに直に送る
  await page.locator('#view').evaluate(c => {
    for (const button of [3, 4]) {
      c.dispatchEvent(new PointerEvent('pointerdown', { button, buttons: 8, pointerId: 1, pointerType: 'mouse', clientX: 700, clientY: 450, bubbles: true }));
      c.dispatchEvent(new PointerEvent('pointerup', { button, buttons: 0, pointerId: 1, pointerType: 'mouse', clientX: 700, clientY: 450, bubbles: true }));
    }
  });
  expect(await page.evaluate(() => (window as any).popstage.takeState)).toBe('playing');
});

test('入力欄やキーボードで移ってきたボタンでは、Tab はふつうにフォーカスを移す', async ({ page }) => {
  await boot(page);
  await page.locator('#pTabs [data-ptab=layer]').click();
  await page.locator('#pPopN').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('html')).not.toHaveClass(/ui-hidden/);
  // キーボードで移った先(:focus-visible)でも、続けて Tab で移れる
  await page.keyboard.press('Tab');
  await expect(page.locator('html')).not.toHaveClass(/ui-hidden/);
});

test('キーを押してから3Dビューやスライダーをマウスで触っても、Tab で隠せる', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('V');
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.click(box.x + 20, box.y + 20);
  await page.keyboard.press('Tab');
  await expect(page.locator('html')).toHaveClass(/ui-hidden/);
  await page.keyboard.press('Tab');
  await expect(page.locator('html')).not.toHaveClass(/ui-hidden/);
  await page.keyboard.press('B');
  await page.locator('#brushSize').click();
  await page.keyboard.press('Tab');
  await expect(page.locator('html')).toHaveClass(/ui-hidden/);
});

test.describe('スマホ', () => {
  const { defaultBrowserType: _, ...pixel } = devices['Pixel 7'];
  test.use({ ...pixel, deviceScaleFactor: 1 });

  test('「…」メニューから隠すと上下のバーとシートが消え、右上の「UIを戻す」で戻る', async ({ page }) => {
    await boot(page);
    await page.locator('#mTop [aria-label=メニュー]').click();
    await page.locator('#mTop [data-cmd=toggleUi]').click();
    await expect(page.locator('html')).toHaveClass(/ui-hidden/);
    for (const s of ['#mTop', '#mTools', '#mSheet', '#mFine']) await expect(page.locator(s)).toBeHidden();
    const vp = page.viewportSize()!;
    await expect.poll(() => viewSize(page)).toEqual([vp.width, vp.height]);
    await expect(page.locator('#uiRestore')).toBeVisible();
    await page.locator('#uiRestore').click();
    await expect(page.locator('html')).not.toHaveClass(/ui-hidden/);
    await expect(page.locator('#mTools')).toBeVisible();
  });
});
