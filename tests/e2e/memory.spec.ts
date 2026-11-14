import { test, expect } from '@playwright/test';
import { boot, watchGlErrors, dragOnStage } from './helpers';

watchGlErrors();

test('ステータスバーにメモリの見積もりを出し、押すと内訳を出す', async ({ page }) => {
  await boot(page);
  const mem = page.locator('#sMem');
  await expect(mem).toHaveText(/^メモリ 約 [\d.]+(KB|MB|GB)$/);
  const before = await page.evaluate(() => (window as any).popstage.memoryUsage());
  expect(before.data).toBeGreaterThan(0);
  expect(before.render).toBeGreaterThan(0);
  expect(before.history).toBe(0);
  // Chrome では JS のヒープも取れる
  expect(before.heap?.used).toBeGreaterThan(0);

  // 塗るとアンドゥの分が増える
  await page.keyboard.press('b');
  await dragOnStage(page, [0.4, 0.5], [0.6, 0.5]);
  await expect.poll(() => page.evaluate(() => (window as any).popstage.memoryUsage().history)).toBeGreaterThan(0);

  await mem.click();
  const detail = page.locator('#sMemDetail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('合計 約');
  await expect(detail).toContainText('アンドゥ');
  await expect(detail).toContainText('JS のヒープ');
  // Esc で閉じる
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
});
