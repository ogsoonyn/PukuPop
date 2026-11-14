/** E2E: 複数の作業をタブで開いて切り替える(開く・切り替え・閉じる・上限・自動保存と復元・スマホの一覧) */
import { test, expect, devices, type Page } from '@playwright/test';
import { watchGlErrors, boot, weightSum, dragOnStage, autosaveOp } from './helpers';

watchGlErrors();

/** 単色の PNG を作って開く(新しいタブ、または変更していないサンプルを置き換える) */
const openPng = (page: Page, name: string, color = '#e33') => page.evaluate(async ([name, color]) => {
  const c = document.createElement('canvas'); c.width = 160; c.height = 120;
  const g = c.getContext('2d')!; g.fillStyle = color; g.fillRect(0, 0, 160, 120);
  const b: Blob = await new Promise(r => c.toBlob(x => r(x!), 'image/png'));
  await (window as any).popstage.openFile(new File([b], name, { type: 'image/png' }));
}, [name, color]);

const state = (page: Page) => page.evaluate(() => {
  const a = (window as any).popstage;
  return { tabs: a.tabs.map((t: any) => a.tabName(t)) as string[], name: a.doc.name as string, dirty: a.dirty as boolean, undo: a.history.size as number, redo: a.history.canRedo as boolean };
});
const tabButton = (page: Page, name: string) => page.locator('#docTabs .doc-tab-name', { hasText: name });

test('開くと新しいタブになり、切り替えても塗り・元に戻す履歴・未保存の印がタブごとに残る', async ({ page }) => {
  await boot(page);
  // 変更していないサンプルは置き換える
  await openPng(page, 'a.png');
  expect((await state(page)).tabs).toEqual(['a.png']);
  await dragOnStage(page, [0.45, 0.5], [0.55, 0.5]);
  const painted = await weightSum(page);
  expect(painted).toBeGreaterThan(0);

  await openPng(page, 'b.png', '#3e3');
  expect(await state(page)).toMatchObject({ tabs: ['a.png', 'b.png'], name: 'b.png', dirty: false, undo: 0 });
  expect(await weightSum(page)).toBe(0);
  await expect(page.locator('#docTabs .doc-tab')).toHaveCount(2);
  await expect(page.locator('#docTabs [data-active="true"]')).toContainText('b.png');
  // 裏のタブにも未保存の印が出る
  await expect(page.locator('#docTabs .doc-tab').first().locator('.doc-tab-dirty')).toBeVisible();

  await tabButton(page, 'a.png').click();
  await expect.poll(async () => (await state(page)).name).toBe('a.png');
  expect(await state(page)).toMatchObject({ dirty: true, undo: 1 });
  expect(await weightSum(page)).toBe(painted);
  await expect(page).toHaveTitle(/^\* a\.png - PukuPop$/);
  // 元に戻してから別のタブを挟んで戻っても、やり直せる
  await page.keyboard.press('Control+z');
  expect(await weightSum(page)).toBe(0);
  await page.keyboard.press('Alt+PageDown');
  await expect.poll(async () => (await state(page)).name).toBe('b.png');
  await page.keyboard.press('Alt+PageUp');
  await expect.poll(async () => (await state(page)).name).toBe('a.png');
  expect((await state(page)).redo).toBe(true);
  await page.keyboard.press('Control+Shift+z');
  expect(await weightSum(page)).toBe(painted);
});

test(`タブは5枚まで。閉じるときは保存していない変更を確かめ、最後の1枚はサンプルに戻る`, async ({ page }) => {
  await boot(page);
  for (const n of ['1.png', '2.png', '3.png', '4.png', '5.png']) await openPng(page, n);
  await openPng(page, '6.png');
  await expect(page.locator('#toasts')).toContainText('タブは 5 枚まで');
  expect((await state(page)).tabs).toEqual(['1.png', '2.png', '3.png', '4.png', '5.png']);
  // 5枚のときは、開く系のメニューとボタンを使えなくし、理由を出す(ファイルを選んでから断らない)
  await page.locator('#menubar .dropdown', { hasText: 'ファイル' }).locator('[role=button]').click();
  const fileMenu = page.locator('#menubar .dropdown', { hasText: 'ファイル' }).locator('ul.menu');
  for (const cmd of ['open', 'recent', 'sample']) await expect(fileMenu.locator(`[data-cmd=${cmd}]`)).toBeDisabled();
  await expect(fileMenu.locator('[data-blocked=open]')).toBeVisible();
  await expect(fileMenu.locator('[data-blocked=open]')).toContainText('タブは 5 枚までです');
  await expect(page.locator('#toolNav [data-cmd=recent]')).toBeDisabled();
  await expect(page.locator('#toolNav [data-cmd=recent]')).toHaveAttribute('title', /タブは 5 枚までです/);
  await page.keyboard.press('Escape');
  // ショートカットで押したときは、ファイルを選ぶ画面を出さずに理由を知らせる
  await page.evaluate(() => { (window as any).__picked = false; (window as any).showOpenFilePicker = async () => { (window as any).__picked = true; throw new DOMException('', 'AbortError'); }; document.querySelector<HTMLElement>('#toasts')!.replaceChildren(); });
  await page.locator('#view').focus();
  await page.keyboard.press('Control+o');
  await expect(page.locator('#toasts')).toContainText('タブは 5 枚までです');
  expect(await page.evaluate(() => (window as any).__picked)).toBe(false);

  // 保存していないタブを閉じるときは確かめる。やめたら残る
  await tabButton(page, '3.png').click();
  await expect.poll(async () => (await state(page)).name).toBe('3.png');
  await page.evaluate(() => (window as any).popstage.addLayer());
  await page.locator('#docTabs .doc-tab', { hasText: '3.png' }).locator('.doc-tab-close').click();
  await expect(page.locator('#askTitle')).toHaveText('「3.png」は保存されていません');
  await page.locator('#askNo').click();
  expect((await state(page)).tabs).toHaveLength(5);
  // 閉じると右隣のタブが出る
  await page.keyboard.press('Alt+w');
  await page.locator('#askYes').click();
  await expect.poll(async () => (await state(page)).tabs).toEqual(['1.png', '2.png', '4.png', '5.png']);
  expect((await state(page)).name).toBe('4.png');
  // 4枚に減ったら、また開ける
  await expect(page.locator('#toolNav [data-cmd=recent]')).toBeEnabled();
  await expect(page.locator('[data-blocked=open]').first()).toBeHidden();
  // 裏のタブは確かめずに閉じる(保存していない変更が無いので)
  await page.locator('#docTabs .doc-tab', { hasText: '1.png' }).locator('.doc-tab-close').click();
  await expect.poll(async () => (await state(page)).tabs).toEqual(['2.png', '4.png', '5.png']);
  expect((await state(page)).name).toBe('4.png');
  for (let i = 0; i < 3; i++) await page.evaluate(() => (window as any).popstage.closeTab());
  await expect.poll(async () => (await state(page)).tabs).toEqual(['プリン(サンプル)']);
});

test('自動保存はタブごとに残り、開き直すと全部のタブを戻す。閉じたタブの分は消える', async ({ page }) => {
  await boot(page);
  await openPng(page, 'a.png');
  await dragOnStage(page, [0.45, 0.5], [0.55, 0.5]);
  const a = await weightSum(page);
  await openPng(page, 'b.png', '#3e3');
  await dragOnStage(page, [0.3, 0.3], [0.4, 0.4]);
  const b = await weightSum(page);
  await openPng(page, 'c.png', '#33e');
  await page.evaluate(() => (window as any).popstage.addLayer());
  await expect.poll(() => autosaveOp(page, 'list'), { timeout: 15000 }).toEqual(['a.pukupop', 'b.pukupop', 'c.pukupop']);
  // 閉じたタブの自動保存は消える
  await page.keyboard.press('Alt+w');
  await page.locator('#askYes').click();
  await expect.poll(() => autosaveOp(page, 'list')).toEqual(['a.pukupop', 'b.pukupop']);

  await page.goto('/?e2e&restore');
  await expect(page.locator('#askTitle')).toHaveText('前回の作業を復元しますか?');
  await expect(page.locator('#askBody')).toContainText('2 件の作業');
  await page.locator('#askYes').click();
  await page.waitForFunction(() => (window as any).popstage?.tabs.length === 2 && (window as any).popstage.stage.hasDocument);
  expect((await state(page)).tabs).toEqual(['a.pukupop', 'b.pukupop']);
  expect((await state(page)).dirty).toBe(true);
  expect(await weightSum(page)).toBe(b);
  await tabButton(page, 'a.pukupop').click();
  await expect.poll(async () => (await state(page)).name).toBe('a.png');
  expect(await weightSum(page)).toBe(a);
  // 戻したタブはその自動保存を使い続ける(増えない)
  await page.evaluate(() => (window as any).popstage.addLayer());
  await page.waitForTimeout(3000);
  expect(await autosaveOp(page, 'list')).toEqual(['a.pukupop', 'b.pukupop']);
});

test('ループ再生中に切り替えても、そのタブは「未保存」にならない', async ({ page }) => {
  await boot(page);
  await openPng(page, 'a.png');
  await page.evaluate(() => {
    const a = (window as any).popstage;
    a.addKey(); a.project.camera.yaw = 0.4; a.addKey();
    a.makeKeyTake();
    a.dirty = false; // 動きを作った分の「未保存」は、保存したことにする
  });
  expect(await page.evaluate(() => (window as any).popstage.takeState)).toBe('playing');
  await openPng(page, 'b.png');
  await expect.poll(async () => (await state(page)).name).toBe('b.png');
  expect(await page.evaluate(() => (window as any).popstage.tabs[0].dirty)).toBe(false);
});

test('タブに分ける前の版の自動保存も戻せる', async ({ page }) => {
  await boot(page);
  const bytes = await page.evaluate(() => Array.from((window as any).popstage.serialize() as Uint8Array));
  await autosaveOp(page, 'put', { name: 'old.pukupop', bytes });
  await page.goto('/?e2e&restore');
  await expect(page.locator('#askBody')).toContainText('「old.pukupop」');
  await page.locator('#askYes').click();
  await page.waitForFunction(() => (window as any).popstage?.doc && (window as any).popstage.stage.hasDocument);
  expect((await state(page)).tabs).toEqual(['old.pukupop']);
});

test.describe('スマホ', () => {
  const { defaultBrowserType: _, ...pixel } = devices['Pixel 7'];
  test.use({ ...pixel, deviceScaleFactor: 1 });

  test('上の見出しに何枚目かが出て、押すと一覧から切り替え・閉じるができる', async ({ page }) => {
    await boot(page);
    await openPng(page, 'a.png');
    await openPng(page, 'b.png');
    await expect(page.locator('#mTitle')).toContainText('b.png');
    await expect(page.locator('#mTitle .m-title-count')).toHaveText('2/2');
    await page.locator('#mTitle').tap();
    await expect(page.locator('#tabDialog')).toBeVisible();
    await expect(page.locator('#tabList .tab-item')).toHaveText(['a.png', 'b.png']);
    await page.locator('#tabList .tab-item', { hasText: 'a.png' }).tap();
    await expect(page.locator('#tabDialog')).toBeHidden();
    await expect(page.locator('#mTitle .m-title-name')).toHaveText('a.png');
    await page.locator('#mTitle').tap();
    await page.locator('#tabList li', { hasText: 'b.png' }).locator('.tab-item-close').tap();
    await expect(page.locator('#tabList .tab-item')).toHaveText(['a.png']);
    await expect(page.locator('#mTitle .m-title-count')).toHaveText('');
  });
});
