import { test, expect } from '@playwright/test';
import { boot, openTab, watchGlErrors } from './helpers';

watchGlErrors();

test('膨らんだ瞬間のエフェクト: 押し出す揺らし方でだけ使え、自動で揺らすと出て、1手で戻せる', async ({ page }) => {
  await boot(page);
  await openTab(page, 'layer');
  // ずんずん(ピストン)では出ないので、欄ごと止まっている
  await page.selectOption('#pPreset', 'zun');
  await expect(page.locator('#pFx')).toBeDisabled();
  await expect(page.locator('#pFxNote')).toBeVisible();
  await expect(page.locator('#pFxBody')).toBeHidden();

  await page.selectOption('#pPreset', 'pon'); // 一瞬膨らむ
  await expect(page.locator('#pFx')).toBeEnabled();
  await expect(page.locator('#pFxNote')).toBeHidden();
  await page.locator('#pFx').check();
  await expect(page.locator('#pFxBody')).toBeVisible();
  await page.locator('#pFxRing').check();
  await page.selectOption('#pFxBlend', 'add');
  const fx = () => page.evaluate(() => (window as any).popstage.activeLayer.effect);
  expect(await fx()).toMatchObject({ enabled: true, ring: true, blend: 'add' });

  // 塗って自動で揺らすと、エフェクトが出て消える
  await page.evaluate(() => {
    const a = (window as any).popstage;
    a.weightOp('全塗り', (wm: any) => wm.data.fill(255));
    a.setPaused(false);
  });
  await expect.poll(() => page.evaluate(() => (window as any).popstage.stage.effectCount), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => (window as any).popstage.stage.effectCount), { timeout: 20_000 }).toBe(0);

  // ポップを一時OFF にしている間は出さない(物理では出ていても描かない)
  await page.evaluate(() => (window as any).popstage.setViewOption('flat', true));
  const shown = await page.evaluate(async () => {
    const a = (window as any).popstage;
    let n = 0;
    for (let i = 0; i < 90; i++) { await new Promise(r => requestAnimationFrame(r)); n = Math.max(n, a.stage.effectCount); }
    return n;
  });
  expect(shown).toBe(0);

  // 3つの変更は1手ずつ戻せる
  await page.locator('#view').focus();
  await page.keyboard.press('Control+z'); // 全塗り
  await page.keyboard.press('Control+z'); // 重ね方
  await page.keyboard.press('Control+z'); // 波紋
  await page.keyboard.press('Control+z'); // エフェクト
  expect(await fx()).toMatchObject({ enabled: false, ring: false, blend: 'normal' });
});

test('膨らんだ瞬間のエフェクト: 複数のレイヤーで値が違うと「混在」を出し、指定の色を選ぶと「指定の色」になる', async ({ page }) => {
  await boot(page);
  await openTab(page, 'layer');
  await page.selectOption('#pPreset', 'doki'); // 鼓動
  await page.locator('#pFx').check();
  await page.locator('#pFxCustom').evaluate((el: HTMLInputElement) => { el.value = '#00ff00'; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
  expect(await page.evaluate(() => (window as any).popstage.activeLayer.effect)).toMatchObject({ color: 'custom', customColor: '#00ff00' });
  await expect(page.locator('#pFxColor')).toHaveValue('custom');
  // 2枚目のレイヤーを足して両方を選ぶ
  await page.evaluate(() => { const a = (window as any).popstage; a.addLayer(); a.selectAllLayers(); });
  await expect(page.locator('#pFx')).toHaveJSProperty('indeterminate', true);
  await expect(page.locator('#pFxColor option:checked')).toHaveText('混在');
});

test('左右・上下の揺れのエフェクト(実験): 切り返しで広がり、残像も出せる', async ({ page }) => {
  await boot(page);
  await openTab(page, 'layer');
  await page.selectOption('#pPreset', 'furi'); // ふりふり(左右に素早く振る)
  await page.locator('#pFx').check();
  await expect(page.locator('#pFxNote')).toBeHidden();
  await page.evaluate(() => {
    const a = (window as any).popstage;
    a.weightOp('全塗り', (wm: any) => wm.data.fill(255));
    a.setPaused(false);
  });
  await expect.poll(() => page.evaluate(() => (window as any).popstage.stage.effectCount), { timeout: 20_000 }).toBeGreaterThan(0);
  await page.selectOption('#pFxStyle', 'trail');
  expect(await page.evaluate(() => (window as any).popstage.activeLayer.effect.style)).toBe('trail');
  await expect.poll(() => page.evaluate(() => (window as any).popstage.stage.effectCount), { timeout: 20_000 }).toBeGreaterThan(1);
  // 揺らし方が「どきどき」だと残像は出ない(注意書き)
  await page.selectOption('#pPreset', 'doki');
  await expect(page.locator('#pFxNote')).toBeVisible();
});
