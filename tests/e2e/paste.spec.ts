import { test, expect, type Page } from '@playwright/test';
import { boot, watchGlErrors } from './helpers';

watchGlErrors();

/** ページの中で画像のファイルを作り、paste イベントを送る(送った先の要素は target)。defaultPrevented を返す */
const paste = (page: Page, target: string) => page.evaluate(async sel => {
  const c = document.createElement('canvas'); c.width = 8; c.height = 6;
  c.getContext('2d')!.fillRect(0, 0, 8, 6);
  const blob: Blob = await new Promise(r => c.toBlob(b => r(b!), 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
  const el = document.querySelector(sel) as HTMLElement;
  el.focus();
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}, target);

const tabCount = (page: Page) => page.evaluate(() => (window as any).popstage.tabs.length);

const activeName = (page: Page) => page.evaluate(() => { const a = (window as any).popstage; return a.tabName(a.activeTab) as string | null; });

test('コピーした画像を貼り付けると開く。変更済みなら新しいタブになる。ヘルプにキーが出る', async ({ page }) => {
  await boot(page);
  const before = await tabCount(page);
  // 起動直後のサンプルは未変更なので置き換わる。2回目は先のタブが残り、新しいタブで開く
  expect(await paste(page, 'body')).toBe(true);
  await expect.poll(() => activeName(page)).toBe('貼り付けた画像.png');
  await expect.poll(() => tabCount(page)).toBe(before);
  expect(await paste(page, 'body')).toBe(true);
  await expect.poll(() => tabCount(page)).toBe(before + 1);
  await expect(page.locator('#helpKeys .mh[title="Ctrl+V"]')).toHaveCount(1);
  await expect(page.locator('#helpKeys')).toContainText('貼り付けて開く');
});

test('文字を打つ欄への貼り付けでは開かず、貼り付けも止めない', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => { const i = document.createElement('input'); i.id = 'pasteField'; i.type = 'text'; document.body.append(i); });
  const name = await activeName(page);
  expect(await paste(page, '#pasteField')).toBe(false);
  // 比較のため、欄の外では開くことを続けて確かめる(欄で開く処理が走っていれば、先に名前が変わっている)
  expect(await paste(page, 'body')).toBe(true);
  await expect.poll(() => activeName(page)).toBe('貼り付けた画像.png');
  expect(name).not.toBe('貼り付けた画像.png');
});
