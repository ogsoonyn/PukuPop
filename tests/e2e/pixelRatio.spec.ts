/** E2E: 描画の倍率(devicePixelRatio)を読み直す */
import { test, expect } from '@playwright/test';
import { watchGlErrors, boot } from './helpers';

watchGlErrors();

test('Stage.resize は、変わった devicePixelRatio を読み直す(上限は 2)', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(() => {
    const s = (window as any).popstage.stage;
    const setDpr = (v: number) => Object.defineProperty(window, 'devicePixelRatio', { value: v, configurable: true });
    const out: number[] = [];
    for (const v of [1.5, 3, 1]) { setDpr(v); s.resize(); out.push(s.renderer.getPixelRatio()); }
    return out;
  });
  expect(r).toEqual([1.5, 2, 1]);
});
