import { test, expect, type Page } from '@playwright/test';
import { boot, watchGlErrors } from './helpers';

watchGlErrors();

const openSettings = (page: Page) => page.locator('#toolOptions [data-cmd=settings]').click();
const box = (page: Page, id: string) => page.locator(`#setToolbarList input[data-nav="${id}"]`);
const nav = (page: Page, id: string) => page.locator(`#toolNav [data-nav="${id}"]`);
/** 見えている区切りが、ツールバーの端や続けて並んでいないか */
const dividersOk = (page: Page) => page.locator('#toolNav').evaluate(n => {
  const shown = [...n.children].filter(el => getComputedStyle(el).display !== 'none');
  return shown.every((el, i) => !el.classList.contains('divider') || (i > 0 && i < shown.length - 1 && !shown[i + 1].classList.contains('divider')));
});

test('左のツールバーの「最近」で、最近開いたファイルの一覧が開く', async ({ page }) => {
  await boot(page);
  const recent = nav(page, 'recent');
  await expect(recent).toHaveAccessibleName('最近開いたファイル');
  await recent.click();
  await expect(page.locator('#recentDialog')).toBeVisible();
});

test('設定でツールバーのボタンを1つずつ隠せる。隠してもキーで使え、ブラウザに覚える', async ({ page }) => {
  await boot(page);
  await openSettings(page);
  await expect(page.locator('#settingsDialog')).toBeVisible();
  // 初めは、開く・保存・書き出し・ポップOFF・揺れ停止のほかを全部出す
  await expect(page.locator('#setToolbarList input:not(:checked)')).toHaveCount(5);
  for (const id of ['brush', 'view', 'pan', 'smoothAll', 'normalize', 'invert']) await box(page, id).uncheck();
  for (const id of ['brush', 'view', 'pan', 'smoothAll']) await expect(nav(page, id)).toBeHidden();
  await expect(nav(page, 'erase')).toBeVisible();
  // 中が全部隠れたまとまりは枠ごと隠し、区切りは続けて出さない
  await expect(page.locator('#toolNav .nav-group[aria-label="選んでいるレイヤーに効く操作"]')).toBeHidden();
  expect(await dividersOk(page)).toBe(true);
  await page.keyboard.press('Escape');

  // 隠したツールもキーで選べる
  await page.locator('#view').focus();
  await page.keyboard.press('g');
  await page.keyboard.press('b');
  expect(await page.evaluate(() => (window as any).popstage.tool)).toBe('brush');

  // 開き直しても覚えている
  await page.waitForTimeout(400);
  await page.goto('/?e2e');
  await page.waitForFunction(() => (window as any).popstage?.doc);
  await expect(nav(page, 'brush')).toBeHidden();
  await expect(nav(page, 'normalize')).toBeHidden();
  await openSettings(page);
  await expect(box(page, 'brush')).not.toBeChecked();
  await expect(box(page, 'erase')).toBeChecked();

  // すべて出すで元に戻る
  await page.locator('#setToolbarReset').click();
  await expect(page.locator('#setToolbarList input:not(:checked)')).toHaveCount(0);
  await expect(nav(page, 'brush')).toBeVisible();
  await expect(page.locator('#toolNav .nav-group[aria-label="選んでいるレイヤーに効く操作"]')).toBeVisible();
  expect(await dividersOk(page)).toBe(true);
});

test('開く・保存・書き出しは、既定では隠し、設定で出せる。出したことをブラウザに覚える', async ({ page }) => {
  await boot(page);
  for (const id of ['open', 'save', 'export']) await expect(nav(page, id)).toBeHidden();
  await openSettings(page);
  for (const id of ['open', 'save', 'export']) await expect(box(page, id)).not.toBeChecked();
  await box(page, 'open').check();
  await box(page, 'export').check();
  await page.keyboard.press('Escape');
  // ファイルのまとまりの先頭に出る
  await expect(page.locator('#toolNav .nav-group[aria-label=ファイルの操作] [data-nav]:visible').first()).toHaveAttribute('data-nav', 'open');
  await expect(nav(page, 'open')).toHaveAccessibleName(/開く/);
  await expect(nav(page, 'open')).toHaveAttribute('title', /Ctrl\+O/);
  await page.waitForTimeout(400);
  await page.goto('/?e2e');
  await page.waitForFunction(() => (window as any).popstage?.doc);
  await expect(nav(page, 'open')).toBeVisible();
  await expect(nav(page, 'export')).toBeVisible();
  await expect(nav(page, 'save')).toBeHidden();
  // 押すと書き出しのダイアログが開く
  await nav(page, 'export').click();
  await expect(page.locator('#exportDialog')).toBeVisible();
});

test('前の版で隠したボタンを覚えている人にも、開く・保存・書き出しはいきなり出さない', async ({ page }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('popstage.prefs.v1', JSON.stringify({ toolbarHidden: ['brush'] })); } });
  await boot(page);
  await expect(nav(page, 'brush')).toBeHidden();
  for (const id of ['open', 'save', 'export']) await expect(nav(page, id)).toBeHidden();
  await expect(nav(page, 'recent')).toBeVisible();
});

test('ファイルの操作とツールを全部隠しても、区切りが端に残らない', async ({ page }) => {
  await boot(page);
  await openSettings(page);
  const ids = await page.locator('#setToolbarList input').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.nav!));
  const tools = await page.locator('#toolNav > .tool').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.nav!));
  for (const id of ['recent', ...tools]) await box(page, id).uncheck();
  expect(ids.length).toBeGreaterThan(tools.length);
  expect(await dividersOk(page)).toBe(true);
  await expect(page.locator('#toolNav [data-cmd=toggleMulti]')).toBeVisible();
  // 全部隠すと、空の列も残さない
  for (const id of ids) await box(page, id).uncheck();
  await expect(page.locator('#toolNav')).toBeHidden();
  await page.locator('#setToolbarReset').click();
  await expect(page.locator('#toolNav')).toBeVisible();
});

test('ポップOFF・揺れ停止は、既定では隠し、設定で出せる。押すと切り替わり、入・切を aria-pressed に映す', async ({ page }) => {
  await boot(page);
  const app = <T>(fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);
  for (const id of ['toggleFlat', 'togglePause']) await expect(nav(page, id)).toBeHidden();
  await openSettings(page);
  for (const id of ['toggleFlat', 'togglePause']) { await expect(box(page, id)).not.toBeChecked(); await box(page, id).check(); }
  await page.keyboard.press('Escape');
  // 表示のまとまりの、画像を薄くの次に並ぶ
  const shown = await page.locator('#toolNav .nav-group[aria-label=表示に効く操作] [data-nav]:visible').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.nav));
  expect(shown.slice(1, 4)).toEqual(['toggleFade', 'toggleFlat', 'togglePause']);
  const flat = nav(page, 'toggleFlat'), pause = nav(page, 'togglePause');
  await expect(flat).toHaveAccessibleName('ポップを一時OFF');
  await expect(flat).toHaveAttribute('title', /\(F\)/);
  await expect(flat).toHaveAttribute('aria-pressed', 'false');
  await flat.click();
  await expect(flat).toHaveAttribute('aria-pressed', 'true');
  expect(await app(a => a.view.flat)).toBe(true);
  // E2E では揺れを一時停止した状態で始まる
  const paused = await app(a => a.paused);
  await expect(pause).toHaveAttribute('aria-pressed', String(paused));
  await pause.click();
  await expect(pause).toHaveAttribute('aria-pressed', String(!paused));
  expect(await app(a => a.paused)).toBe(!paused);
  // キーで切り替えてもボタンに映る
  await page.locator('#view').focus();
  await page.keyboard.press('p');
  await expect(pause).toHaveAttribute('aria-pressed', String(paused));
  await page.keyboard.press('f');
  await expect(flat).toHaveAttribute('aria-pressed', 'false');
});
