import { test, expect } from '@playwright/test';
import { boot, watchGlErrors, nextFrames } from './helpers';

watchGlErrors();

const D = Math.PI / 180;
const roll = (page: import('@playwright/test').Page) => page.evaluate(() => (window as any).popstage.project.camera.roll as number);

test('← / → で 15°、Shift で 1° ずつなめらかに傾き、ステータスバーの角度を押すと 0° に戻る', async ({ page }) => {
  await boot(page);
  await page.locator('#view').focus();
  await expect(page.locator('#sRoll')).toBeHidden();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => roll(page)).toBeCloseTo(15 * D, 4);
  await page.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => roll(page)).toBeCloseTo(14 * D, 4);
  await expect(page.locator('#sRoll')).toHaveText('↻ 14°');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => roll(page)).toBeCloseTo(-16 * D, 4);
  await expect(page.locator('#sRoll')).toHaveText('↻ -16°');
  await page.locator('#sRoll').click();
  expect(await roll(page)).toBe(0);
  await expect(page.locator('#sRoll')).toBeHidden();
});

test('Alt+右ドラッグで画面の中央のまわりに傾ける(右ドラッグだけなら回転)', async ({ page }) => {
  await boot(page);
  const box = (await page.locator('#view').boundingBox())!;
  const m = await page.evaluate(() => (window as any).popstage.stage.mainView());
  const cx = box.x + m.x + m.w / 2, cy = box.y + m.y + m.h / 2, r = Math.min(m.w, m.h) * 0.3;
  const yaw0 = await page.evaluate(() => (window as any).popstage.project.camera.yaw);
  await page.keyboard.down('Alt');
  await page.mouse.move(cx + r, cy);
  await page.mouse.down({ button: 'right' });
  // 時計回りに 90° 円を描く(画面の y は下向き)
  for (let i = 1; i <= 18; i++) await page.mouse.move(cx + r * Math.cos(i * 5 * D), cy + r * Math.sin(i * 5 * D));
  await page.mouse.up({ button: 'right' });
  await page.keyboard.up('Alt');
  expect(await roll(page)).toBeCloseTo(90 * D, 2);
  expect(await page.evaluate(() => (window as any).popstage.project.camera.yaw)).toBe(yaw0);
});

test('回転だけリセット(Ctrl+Home)と正面(Home)で傾きも 0° に戻る', async ({ page }) => {
  await boot(page);
  const set = () => page.evaluate(() => { const a = (window as any).popstage; a.project.camera = { ...a.project.camera, roll: 0.7, zoom: 2 }; });
  await set();
  await page.locator('#view').focus();
  await page.keyboard.press('Control+Home');
  expect(await page.evaluate(() => (window as any).popstage.project.camera)).toMatchObject({ roll: 0, zoom: 2 });
  await set();
  await page.keyboard.press('Home');
  expect(await page.evaluate(() => (window as any).popstage.project.camera)).toMatchObject({ roll: 0, zoom: 1 });
});

test('キーフレームに傾きが入り、そのフレームへ動かすと傾く', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { const a = (window as any).popstage; a.project.camera.roll = 0.4; a.addKey(); a.project.camera.roll = -0.4; a.addKey(); });
  const keys = await page.evaluate(() => (window as any).popstage.keyDraft.map((k: any) => k.view.roll));
  expect(keys[0]).toBeCloseTo(0.4); expect(keys[1]).toBeCloseTo(-0.4);
  await page.evaluate(() => { const a = (window as any).popstage; a.gotoKey(0); });
  expect(await roll(page)).toBeCloseTo(0.4);
  await nextFrames(page);
});

test('矢印キーは、スライダーにフォーカスがあるときはスライダーに使う', async ({ page }) => {
  await boot(page);
  const slider = page.locator('input[type=range]:visible').first();
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await nextFrames(page, 20);
  expect(await roll(page)).toBe(0);
});
