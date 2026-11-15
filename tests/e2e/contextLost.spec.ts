/** E2E: WebGL のコンテキストが失われたとき・戻ったとき(Issue #113) */
import { test, expect, type Page } from '@playwright/test';
import { watchGlErrors, boot, dragOnStage, nextFrames, weightSum } from './helpers';

// 失わせる操作で Chrome が出す「CONTEXT_LOST_WEBGL」の警告は、見張りの対象(GL_INVALID など)に入らないので、そのまま見張る
watchGlErrors();

/**
 * WEBGL_lose_context の拡張。失われている間は getExtension が null を返すので、失わせる前に取って控えておく
 */
const loseExt = (page: Page) => page.evaluate(() => {
  const w = window as any;
  w.__loseExt ??= w.popstage.stage.renderer.getContext().getExtension('WEBGL_lose_context');
});

/** WEBGL_lose_context でコンテキストを失わせ、アプリが受け取るまで待つ */
async function lose(page: Page): Promise<void> {
  await loseExt(page);
  await page.evaluate(() => (window as any).__loseExt.loseContext());
  await expect.poll(() => page.evaluate(() => (window as any).popstage.stage.contextLost)).toBe(true);
}

/** 失わせたコンテキストを戻し、アプリが受け取るまで待つ */
async function restore(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__loseExt.restoreContext());
  await expect.poll(() => page.evaluate(() => (window as any).popstage.stage.contextLost)).toBe(false);
  await nextFrames(page);
}

/** 書き出しと同じ描き方で、小さく描いた画像(背景は透過) */
const frame = (page: Page) => page.evaluate(() => {
  const a = (window as any).popstage;
  return Array.from(a.stage.renderFrame(64, 48, a.project.camera, null) as Uint8ClampedArray);
});

test('失われると知らせ、戻ると前と同じ絵が出て、背景色も塗れる', async ({ page }) => {
  await boot(page);
  // 背景色は three.js が作り直さない分なので、単色にしておいて戻ることを確かめる
  await page.evaluate(() => (window as any).popstage.setBackgroundTransparent(false));
  await nextFrames(page);
  const stage = page.locator('#stage');
  // 右上のパネルの開閉ボタンは半透明で3Dビューに重なり、重ね方しだいで色がわずかに変わる。3Dビューの絵だけを比べるので隠す
  await page.locator('#panelToggleWrap').evaluate(e => { e.style.visibility = 'hidden'; });
  await nextFrames(page);
  const shot0 = await stage.screenshot(), frame0 = await frame(page);

  await lose(page);
  await expect(page.locator('#toasts')).toContainText('3Dビューの描画が止まりました');
  // 失われている間は空の絵を返さず、失敗にする
  const err = await page.evaluate(() => {
    const a = (window as any).popstage;
    try { a.stage.renderFrame(64, 48, a.project.camera, null); return null; } catch (e) { return (e as Error).name; }
  });
  expect(err).toBe('ContextLostError');

  await restore(page);
  await expect(page.locator('#toasts')).toContainText('3Dビューの描画が戻りました');
  // 知らせは3Dビューの上に重なるので、画面を比べる前に隠す
  await page.locator('#toasts').evaluate(e => { e.style.visibility = 'hidden'; });
  // 画像・ウェイト・メッシュ・背景色が送り直され、失う前と同じ画面になる
  await expect.poll(async () => (await stage.screenshot()).equals(shot0)).toBe(true);
  expect(await frame(page)).toEqual(frame0);
  // 3Dビューの後ろの CSS も同じ色なので、画面だけでは分からない。消去の色を直接見る
  expect(await page.evaluate(() => (window as any).popstage.stage.renderer.getClearAlpha())).toBe(1);
});

test('失われている間に塗った分も、戻ると画面に出て、そのあとも塗れる', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => (window as any).popstage.weightOp('全消去', (wm: any) => wm.clear()));
  await page.evaluate(() => (window as any).popstage.setTool('brush'));
  // 知らせは3Dビューの上に重なるので、画面を比べられるよう隠す
  await page.locator('#toasts').evaluate(e => { e.style.visibility = 'hidden'; });
  await nextFrames(page);
  const stage = page.locator('#stage');
  const shotClear = await stage.screenshot();

  // 部分転送の成否をまだ確かめていない状態(まだ塗っていない起動直後と同じ)で失わせる
  await page.evaluate(() => { (window as any).popstage.stage.partialChecked = false; });
  await lose(page);
  await dragOnStage(page, [0.3, 0.4], [0.6, 0.5]);
  // 失われている間は描画のフレームでは送らないが、自動保存のサムネイルなどは描画の外から送る
  await page.evaluate(() => (window as any).popstage.flushWeights());
  const painted = await weightSum(page);
  expect(painted).toBeGreaterThan(0);
  // 失われている間の転送で、部分転送が使えないと誤って決めない
  expect(await page.evaluate(() => (window as any).popstage.stage.partialBroken)).toBe(false);

  await restore(page);
  await expect.poll(async () => (await stage.screenshot()).equals(shotClear)).toBe(false);
  // GPU のウェイトが CPU 側と同じか: 全レイヤーを送り直したときの絵と比べる
  const restored = await frame(page);
  await page.evaluate(() => { const a = (window as any).popstage; a.stage.setLayers(a.doc.layers); });
  expect(await frame(page)).toEqual(restored);

  // 戻ったあとも塗れ、部分転送も使える(古いテクスチャを指さない)
  const partialBefore = await page.evaluate(() => (window as any).popstage.stage.partialUploads);
  const shotPainted = await stage.screenshot();
  await dragOnStage(page, [0.3, 0.6], [0.6, 0.7]);
  await nextFrames(page);
  expect(await weightSum(page)).toBeGreaterThan(painted);
  await expect.poll(async () => (await stage.screenshot()).equals(shotPainted)).toBe(false);
  expect(await page.evaluate(() => (window as any).popstage.stage.partialUploads)).toBeGreaterThan(partialBefore);
  const afterPaint = await frame(page);
  await page.evaluate(() => { const a = (window as any).popstage; a.stage.setLayers(a.doc.layers); });
  expect(await frame(page)).toEqual(afterPaint);
});

test('書き出しは、失われている間も途中で失われても、理由を伝えて失敗で終わる', async ({ page }) => {
  await boot(page);
  const settings = { format: 'png', width: 64, height: 48, fps: 30, duration: 1, background: null, motion: 'auto' };

  await lose(page);
  const before = await page.evaluate(s => (window as any).popstage.exportMedia(s, () => {}, new AbortController().signal)
    .then(() => 'ok', (e: Error) => e.message), settings);
  expect(before).toContain('描画が止まった');
  await restore(page);

  // 3 コマ目を描いた所で失わせる
  const during = await page.evaluate(s => {
    const w = window as any;
    return w.popstage.exportMedia(s, (done: number) => { if (done === 3) w.__loseExt.loseContext(); }, new AbortController().signal)
      .then(() => 'ok', (e: Error) => e.message);
  }, settings);
  expect(during).toContain('描画が止まった');
  expect(await page.evaluate(() => (window as any).popstage.exporting)).toBe(false);

  // 戻れば書き出せる
  await expect.poll(() => page.evaluate(() => (window as any).popstage.stage.contextLost)).toBe(true);
  await restore(page);
  const res = await page.evaluate(s => (window as any).popstage.exportMedia(s, () => {}, new AbortController().signal)
    .then((r: any) => r.frames), settings);
  expect(res).toBe(30);
});
