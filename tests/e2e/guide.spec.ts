import { test, expect } from '@playwright/test';
import { boot, watchGlErrors } from './helpers';

watchGlErrors();

test('ヘルプから揺らし方図鑑へリンクし、図鑑はどの揺らし方もエラーなく動かして見せる', async ({ page, context }) => {
  await boot(page);
  await page.evaluate(() => (document.getElementById('helpDialog') as HTMLDialogElement).showModal());
  const link = page.locator('#helpGuide a');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('target', '_blank');

  const [guide] = await Promise.all([context.waitForEvent('page'), link.click()]);
  const errors: string[] = [];
  guide.on('pageerror', e => errors.push(e.message));
  guide.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await guide.waitForLoadState();
  await expect(guide).toHaveTitle('PukuPop 揺らし方図鑑');
  await expect.poll(() => guide.evaluate(() => (window as any).pukupopGuide?.motions.length ?? 0)).toBe(15);

  // 本体の揺らし方の一覧と同じものを並べ(「なし」を除く)、どれを選んでも描ける
  const motions: string[] = await guide.evaluate(() => (window as any).pukupopGuide.motions);
  const appMotions: string[] = await page.evaluate(() => [...document.querySelectorAll<HTMLOptionElement>('#pMotion option')].map(o => o.value).filter(v => v !== 'none'));
  if (appMotions.length) expect([...motions].sort()).toEqual([...appMotions].sort());
  for (const m of motions) {
    await guide.evaluate(m => (window as any).pukupopGuide.setMotion(m), m);
    await expect.poll(() => guide.evaluate(() => (window as any).pukupopGuide.current())).toBe(m);
  }
  // PC の幅でもスマホの幅でも横にはみ出さない
  const overflow = () => guide.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await guide.setViewportSize({ width: 390, height: 844 });
  await expect.poll(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('埋め込みモードでは図鑑へのリンクを出さない', async ({ page }) => {
  await page.goto('/?e2e&embed');
  await page.evaluate(() => (document.getElementById('helpDialog') as HTMLDialogElement).showModal());
  await expect(page.locator('#helpGuide')).toBeHidden();
});
