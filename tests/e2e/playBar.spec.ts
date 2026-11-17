import { test, expect, type Page } from '@playwright/test';
import { boot, openTab, watchGlErrors } from './helpers';

watchGlErrors();

const app = <T>(page: Page, fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);

const setCam = (page: Page, c: { zoom?: number; x?: number }) => page.evaluate(c => {
  const cam = (window as any).popstage.project.camera;
  cam.yaw = 0; cam.pitch = 0; cam.zoom = c.zoom ?? 1.5; cam.target = { x: c.x ?? 0, y: 0, z: 0 };
}, c);

/** キーフレーム3つ(2番は弾む)で動きを作って再生する */
async function playKeys(page: Page): Promise<void> {
  await openTab(page, 'anim');
  await setCam(page, {});
  await page.locator('#keyAdd').click();
  await setCam(page, { x: 300 });
  await page.locator('#keyAdd').click();
  await setCam(page, { x: -300 });
  await page.locator('#keyAdd').click();
  await page.locator('#keyList .key-row[data-key="1"] [data-act=mode]').selectOption('bounce');
  await page.locator('#keyMake').click();
  expect(await app(page, a => a.takeState)).toBe('playing');
}

test('再生の進み具合: 再生中だけ主ビューの下に出て、キーの番号・時間・一時停止・シーク・停止ができる', async ({ page }) => {
  await boot(page);
  const bar = page.locator('#playBar');
  await expect(bar).toBeHidden();
  await playKeys(page);
  await expect(bar).toBeVisible();
  // 主ビューの下端に置く(上半分には出さない)
  const [b, v] = await Promise.all([bar.boundingBox(), page.locator('#stageWrap').boundingBox()]);
  expect(b!.y + b!.height).toBeGreaterThan(v!.y + v!.height - 40);
  expect(b!.y + b!.height).toBeLessThanOrEqual(v!.y + v!.height);
  // キーの番号は形で通り方を見分ける
  const keys = page.locator('#playKeys .play-key');
  await expect(keys).toHaveText(['1', '2', '3']);
  await expect(keys.nth(1)).toHaveAttribute('data-mode', 'bounce');
  await expect(page.locator('#playTime')).toContainText('/ 3.0秒');
  await expect(page.locator('#playCam')).toBeEnabled();

  // 一時停止すると位置が進まない。続けると進む
  await page.locator('#playPause').click();
  await expect(page.locator('#playPause')).toHaveAttribute('aria-pressed', 'true');
  const held = await app(page, a => a.takePosition);
  await page.waitForTimeout(300);
  expect(await app(page, a => a.takePosition)).toBe(held);

  // 番号を押すと、そのフレームの時刻へ移る(一時停止のまま)
  await keys.nth(1).click();
  expect(await app(page, a => [a.takeState, a.playPaused])).toEqual(['playing', true]);
  expect(await app(page, a => a.takePosition)).toBeCloseTo(1, 1);
  await expect.poll(() => app(page, a => a.playView.target.x)).toBeCloseTo(300, 0);

  // トラックをドラッグすると位置が動き、離すと元の状態(一時停止)に戻る
  const t = (await page.locator('#playTrack').boundingBox())!;
  await page.mouse.move(t.x + t.width * 0.1, t.y + t.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width * 0.75, t.y + t.height / 2, { steps: 5 });
  expect(await app(page, a => a.takePosition)).toBeCloseTo(2.25, 1);
  await page.mouse.up();
  expect(await app(page, a => [a.takeState, a.playPaused])).toEqual(['playing', true]);

  // キーで動かす(Home は視点のリセットに渡さない)
  await page.locator('#playTrack').focus();
  await page.keyboard.press('Home');
  expect(await app(page, a => a.takePosition)).toBe(0);
  await page.keyboard.press('ArrowRight');
  expect(await app(page, a => a.takePosition)).toBeCloseTo(0.5, 2);
  // PageDown・PageUp は次・前の番号の時刻へ
  await page.keyboard.press('PageDown');
  expect(await app(page, a => a.takePosition)).toBeCloseTo(1, 1);
  await page.keyboard.press('PageDown');
  expect(await app(page, a => a.takePosition)).toBeCloseTo(2, 1);
  await page.keyboard.press('PageUp');
  expect(await app(page, a => a.takePosition)).toBeCloseTo(1, 1);
  // 修飾キー付きはショートカットに渡す(Shift+Home はカメラを戻す。位置は変えない)
  await app(page, a => { a.project.camera.yaw = 0.7; });
  await page.keyboard.press('Shift+Home');
  expect(await app(page, a => a.project.camera.yaw)).toBe(0);
  expect(await app(page, a => a.takePosition)).toBeCloseTo(1, 1);

  // Shift+L でも一時停止を切り替えられる
  await page.keyboard.press('Shift+L');
  await expect(page.locator('#playPause')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Shift+L');
  await expect(page.locator('#playPause')).toHaveAttribute('aria-pressed', 'true');

  await page.locator('#playPause').click();
  await expect.poll(() => app(page, a => a.takePosition)).not.toBeCloseTo(1, 1);

  await page.locator('#playStop').click();
  expect(await app(page, a => [a.takeState, a.playPaused])).toEqual(['idle', false]);
  // キーフレームが2つ以上でアニメーションタブを開いているので、止めてもバーは残る(0秒、▶ だけ)
  await expect(bar).toBeVisible();
  await expect(bar).toHaveClass(/idle/);
  await expect(page.locator('#playTime')).toHaveText('0.0 / 3.0秒');
  await expect(page.locator('#playStart')).toBeVisible();
  await expect(page.locator('#playStop')).toBeHidden();
});

test('再生の進み具合: 止まっている間は、キーフレームが2つ以上でアニメーションタブを開いているときだけ出し、押すとその時刻から一時停止で始まる', async ({ page }) => {
  await boot(page);
  const bar = page.locator('#playBar');
  await openTab(page, 'anim');
  await setCam(page, {});
  await page.locator('#keyAdd').click();
  // 1つだけでは出さない
  await expect(bar).toBeHidden();
  await setCam(page, { x: 300 });
  await page.locator('#keyAdd').click();
  await expect(bar).toBeVisible();
  await expect(page.locator('#playTime')).toHaveText('0.0 / 2.0秒');
  await expect(page.locator('#playKeys .play-key')).toHaveText(['1', '2']);
  // 別のタブを開いている間・「シークバー」をオフにしたときは出さない
  await openTab(page, 'layer');
  await expect(bar).toBeHidden();
  await openTab(page, 'anim');
  await expect(bar).toBeVisible();
  await page.locator('#playBarShow').uncheck();
  await expect(bar).toBeHidden();
  await page.locator('#playBarShow').check();
  await expect(bar).toBeVisible();

  // 2番を押すと、作ってから2番の時刻で一時停止した状態から始まる(離しても一時停止のまま)
  await page.locator('#playKeys .play-key').nth(1).click();
  expect(await app(page, a => [a.takeState, a.playPaused, !!a.project.take?.keys])).toEqual(['playing', true, true]);
  expect(await app(page, a => a.takePosition)).toBeCloseTo(1, 1);
  await expect.poll(() => app(page, a => a.playView.target.x)).toBeCloseTo(300, 0);
  await app(page, a => { a.__take = a.project.take; });
  // 止めて ▶ を押すと、一覧が同じなので作り直さずに初めから流れる
  await page.locator('#playStop').click();
  await page.locator('#playStart').click();
  expect(await app(page, a => [a.takeState, a.playPaused])).toEqual(['playing', false]);
  expect(await app(page, a => a.project.take === a.__take)).toBe(true);
  await page.locator('#playStop').click();
  // 一覧を変えてから押すと、作り直して始まる
  await page.locator('#keyList .key-row[data-key="1"] [data-act=mode]').selectOption('bounce');
  await page.locator('#playTrack').click();
  expect(await app(page, a => [a.takeState, a.project.take === a.__take, a.project.take.keys[1].mode])).toEqual(['playing', false, 'bounce']);
  // キーでも動かせる。止まっているときは、0秒で一時停止した状態から始まる
  await page.locator('#playStop').focus();
  await page.keyboard.press('Enter');
  expect(await app(page, a => a.takeState)).toBe('idle');
  // 消えた ■ のフォーカスは ▶ へ移る
  await expect(page.locator('#playStart')).toBeFocused();
  await page.locator('#playTrack').focus();
  await page.keyboard.press('PageDown');
  expect(await app(page, a => [a.takeState, a.playPaused])).toEqual(['playing', true]);
  expect(await app(page, a => a.takePosition)).toBeCloseTo(1, 1);
  // 再生中はタブを替えても出したまま
  await openTab(page, 'layer');
  await expect(bar).toBeVisible();
  await expect(page.locator('#playStop')).toBeVisible();

  // 手で記録した操作があるときは、止まっている間は出さない(押すとキーフレームの動きに入れ替わってしまうため)
  await page.locator('#playStop').click();
  await openTab(page, 'anim');
  await expect(bar).toBeVisible();
  await app(page, a => {
    a.setPaused(false);
    a.startRecording();
    a.world.grab = { x: 0.2, y: 0, z: 0 }; a.world.grabGains.set(a.doc.layers[0].id, 1);
    for (let i = 0; i < 60; i++) a.frame(1 / 60);
    a.world.grab = null; a.world.grabGains.clear();
    a.stopRecording();
  });
  expect(await app(page, a => !!a.project.take && !a.project.take.keys)).toBe(true);
  await expect(bar).toBeHidden();
});

test('再生の進み具合: 記録中は赤いバーで最長までの進みを出し、■ で止める。3面図が出ているときはその左まで', async ({ page }) => {
  await boot(page);
  await app(page, a => a.setPaused(false));
  await app(page, a => a.startRecording());
  const bar = page.locator('#playBar');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveClass(/recording/);
  await expect(page.locator('#playTime')).toContainText('/ 60.0秒');
  await expect(page.locator('#playPause')).toBeHidden();
  await expect(page.locator('#playCam')).toBeHidden();
  await expect(page.locator('#playKeys .play-key')).toHaveCount(0);
  // 何もしていない所は詰められるので、つかんで引っぱってから止める
  await app(page, a => {
    a.world.grab = { x: 0.2, y: 0, z: 0 }; a.world.grabGains.set(a.doc.layers[0].id, 1);
    for (let i = 0; i < 40; i++) a.frame(1 / 60);
    a.world.grab = null; a.world.grabGains.clear();
    for (let i = 0; i < 60; i++) { a.project.camera.yaw += 0.01; a.frame(1 / 60); }
  });
  await page.locator('#playStop').click();
  expect(await app(page, a => [a.takeState, !!a.project.take])).toEqual(['idle', true]);
  await expect(bar).toBeHidden();

  // 3面図を出すと、バーはその左までになる
  await app(page, a => { a.view.multi = true; a.syncView(); a.playTake(); });
  await expect(bar).toBeVisible();
  const [b, m] = await Promise.all([bar.boundingBox(), page.locator('#multiView').boundingBox()]);
  expect(b!.x + b!.width).toBeLessThanOrEqual(m!.x);
  // 記録した操作(キーフレームでない)には番号を出さない
  await expect(page.locator('#playKeys .play-key')).toHaveCount(0);
});
