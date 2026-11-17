/**
 * E2E: 埋め込みモード(Issue #146)。開発用のサーバーでは ?embed で試せる(埋め込み用のビルドは embedDist.spec.ts)。
 * ファイルを返す・書き戻すサーバーは page.route の作り物(同じオリジンの /files/ の下)で受ける。
 * boot() を使わない例外: クエリでファイルを渡して開くので、自前の open で起動し、listenGlErrors() で GL のエラーを見張る
 */
import { test, expect, type Page, type Request } from '@playwright/test';
import { watchGlErrors, listenGlErrors, boot, dragOnStage } from './helpers';

watchGlErrors();

/** 開くのに使う .pukupop(サンプルを保存したもの)と PNG。ふつうの起動で一度だけ作る */
let projectBytes: Buffer, pngBytes: Buffer;
test.beforeAll(async ({ browser }, info) => {
  const page = await browser.newPage({ baseURL: info.project.use.baseURL });
  await boot(page);
  const [p, i] = await page.evaluate(async () => {
    const a = (window as any).popstage;
    const c = document.createElement('canvas'); c.width = 160; c.height = 120;
    const g = c.getContext('2d')!; g.fillStyle = '#e33'; g.fillRect(0, 0, 160, 120);
    const b: Blob = await new Promise(r => c.toBlob(x => r(x!), 'image/png'));
    return [Array.from(a.serialize() as Uint8Array), Array.from(new Uint8Array(await b.arrayBuffer()))];
  });
  projectBytes = Buffer.from(p); pngBytes = Buffer.from(i);
  await page.close();
});

interface Stored { body: Buffer; etag: number; type: string }
/**
 * 作り物のサーバー。/files/<名前> の GET・PUT(If-Match が今の ETag と違えば 412)と、/files/ への POST(201 と Location)を受ける。
 * 受けたリクエストは reqs に控える
 */
async function fakeServer(page: Page, opts: { weakEtag?: boolean; hold?: boolean } = {}) {
  const files = new Map<string, Stored>([
    ['/files/cat.pukupop', { body: projectBytes, etag: 1, type: 'application/zip' }],
    ['/files/cat.png', { body: pngBytes, etag: 1, type: 'image/png' }],
  ]);
  const reqs: { method: string; path: string; ifMatch: string | undefined }[] = [];
  const tag = (s: Stored) => `${opts.weakEtag ? 'W/' : ''}"v${s.etag}"`;
  let seq = 0;
  // hold なら、書き込み(PUT・POST)の応答を release() まで返さない(遅いサーバー)
  let release = () => {};
  const held = opts.hold ? new Promise<void>(r => { release = r; }) : null;
  await page.route('**/files/**', async route => {
    const req: Request = route.request(), path = new URL(req.url()).pathname;
    const ifMatch = req.headers()['if-match'];
    reqs.push({ method: req.method(), path, ifMatch });
    if (held && req.method() !== 'GET') await held;
    const f = files.get(path);
    if (req.method() === 'GET') {
      if (!f) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ status: 200, body: f.body, headers: { 'Content-Type': f.type, ETag: tag(f) } });
    }
    if (req.method() === 'PUT') {
      if (!f) return route.fulfill({ status: 404 });
      if (ifMatch && ifMatch !== tag(f)) return route.fulfill({ status: 412 });
      f.body = req.postDataBuffer()!; f.etag++;
      return route.fulfill({ status: 204, headers: { ETag: tag(f) } });
    }
    if (req.method() === 'POST' && path === '/files/') {
      const name = `/files/new-${++seq}.pukupop`, s: Stored = { body: req.postDataBuffer()!, etag: 1, type: 'application/zip' };
      files.set(name, s);
      return route.fulfill({ status: 201, headers: { Location: name.slice('/files/'.length), ETag: tag(s) } });
    }
    return route.fulfill({ status: 405 });
  });
  return {
    reqs, files, release: () => release(),
    /** 別の人が上書きしたことにする(ETag が変わる) */
    touch: (path: string) => { files.get(path)!.etag++; },
    writes: () => reqs.filter(r => r.method !== 'GET'),
  };
}

/** 埋め込みモードで開く(query は src などのクエリ)。開いて揺れを止めるまで待つ */
async function open(page: Page, query: Record<string, string>): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  listenGlErrors(page);
  await page.goto(`/?e2e&embed&${new URLSearchParams(query)}`);
  await page.waitForFunction(() => { const a = (window as any).popstage; return a?.doc && a.stage.hasDocument && a.paused; });
  expect(errors).toEqual([]);
}

const state = (page: Page) => page.evaluate(() => {
  const a = (window as any).popstage;
  return { tabs: a.tabs.length as number, name: a.tabName(a.activeTab) as string, dirty: a.dirty as boolean, target: a.saveTarget?.location as string | null | undefined };
});
const paint = (page: Page) => dragOnStage(page, [0.45, 0.5], [0.55, 0.5]);
const save = (page: Page) => page.keyboard.press('Control+s');

test('既存の .pukupop を開いて、保存でサーバーへ上書きする(If-Match に ETag を付け、応答の ETag を次に使う)', async ({ page, browser }, info) => {
  const srv = await fakeServer(page);
  await open(page, { src: '/files/cat.pukupop', back: '/files/' });
  expect(await state(page)).toMatchObject({ tabs: 1, name: 'cat.pukupop', dirty: false, target: expect.stringMatching(/\/files\/cat\.pukupop$/) });
  await expect(page).toHaveTitle(/cat\.pukupop/);

  await page.locator('[data-tool="brush"]').click();
  await paint(page);
  expect((await state(page)).dirty).toBe(true);
  await save(page);
  await expect.poll(async () => (await state(page)).dirty).toBe(false);
  await expect(page.locator('#toasts')).toContainText('「cat.pukupop」に保存しました');
  await paint(page);
  await save(page);
  await expect.poll(async () => (await state(page)).dirty).toBe(false);
  expect(srv.writes()).toEqual([
    { method: 'PUT', path: '/files/cat.pukupop', ifMatch: '"v1"' },
    { method: 'PUT', path: '/files/cat.pukupop', ifMatch: '"v2"' },
  ]);
  // 書き戻した中身は .pukupop で、塗った分が入っている(埋め込みモードはほかのファイルを開かないので、ふつうの画面で開き直す)
  const saved = srv.files.get('/files/cat.pukupop')!.body;
  expect(saved.equals(projectBytes)).toBe(false);
  const painted = await page.evaluate(() => (window as any).popstage.doc.layers.reduce((t: number, l: any) => t + l.weights.data.reduce((s: number, v: number) => s + v, 0), 0));
  const other = await browser.newPage({ baseURL: info.project.use.baseURL });
  await boot(other);
  expect(await other.evaluate(async b => {
    const a = (window as any).popstage;
    if (!(await a.openProjectBytes(new Uint8Array(b), 'x.pukupop', null))) return -1;
    return a.doc.layers.reduce((t: number, l: any) => t + l.weights.data.reduce((s: number, v: number) => s + v, 0), 0);
  }, Array.from(saved))).toBeCloseTo(painted, 0);
  await other.close();
});

test('開いたあとに別の所で上書きされていたら、上書きするかやめるかを選ぶ(412)', async ({ page }) => {
  const srv = await fakeServer(page);
  await open(page, { src: '/files/cat.pukupop' });
  await page.locator('[data-tool="brush"]').click();
  await paint(page);
  srv.touch('/files/cat.pukupop');

  await save(page);
  const dlg = page.locator('#askDialog');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('別の所で上書きされています');
  await page.locator('#askNo').click();
  await expect(dlg).toBeHidden();
  expect((await state(page)).dirty).toBe(true);
  expect(srv.files.get('/files/cat.pukupop')!.body.equals(projectBytes)).toBe(true);

  await save(page);
  await expect(dlg).toBeVisible();
  await page.locator('#askYes').click();
  await expect.poll(async () => (await state(page)).dirty).toBe(false);
  // 上書きするときは If-Match を付けない。その応答の ETag を次に使う
  await paint(page);
  await save(page);
  await expect.poll(async () => (await state(page)).dirty).toBe(false);
  expect(srv.writes().map(r => r.ifMatch)).toEqual(['"v1"', '"v1"', undefined, '"v3"']);
});

test('弱い ETag は確かめに使わない(毎回 412 にしない)', async ({ page }) => {
  const srv = await fakeServer(page, { weakEtag: true });
  await open(page, { src: '/files/cat.pukupop' });
  await page.locator('[data-tool="brush"]').click();
  await paint(page);
  await save(page);
  await expect.poll(async () => (await state(page)).dirty).toBe(false);
  expect(srv.writes()).toEqual([{ method: 'PUT', path: '/files/cat.pukupop', ifMatch: undefined }]);
});

test('画像から新しく作る: 最初の保存は POST し、応答の Location へ以後 PUT する', async ({ page }) => {
  const srv = await fakeServer(page);
  await open(page, { image: '/files/cat.png', create: '/files/' });
  expect(await state(page)).toMatchObject({ tabs: 1, name: 'cat.png', dirty: false, target: null });
  await expect(page.locator('#toasts')).toContainText('「cat.png」を開きました');
  await paint(page); // 画像を開くとブラシになる
  await save(page);
  await expect.poll(async () => (await state(page)).dirty).toBe(false);
  expect(await state(page)).toMatchObject({ name: 'cat.pukupop', target: expect.stringMatching(/\/files\/new-1\.pukupop$/) });
  await paint(page);
  await save(page);
  await expect.poll(async () => (await state(page)).dirty).toBe(false);
  expect(srv.writes()).toEqual([
    { method: 'POST', path: '/files/', ifMatch: undefined },
    { method: 'PUT', path: '/files/new-1.pukupop', ifMatch: '"v1"' },
  ]);
});

test('保存の最中にもう一度押しても、二重に書かない(新規が2つできない)', async ({ page }) => {
  const srv = await fakeServer(page, { hold: true });
  await open(page, { image: '/files/cat.png', create: '/files/' });
  await paint(page);
  await save(page);
  await expect.poll(() => srv.writes().length).toBe(1);
  await save(page);
  await expect(page.locator('#toasts')).toContainText('保存しています');
  srv.release();
  await expect.poll(async () => (await state(page)).dirty).toBe(false);
  await paint(page);
  await save(page);
  await expect.poll(async () => (await state(page)).dirty).toBe(false);
  expect(srv.writes().map(r => `${r.method} ${r.path}`)).toEqual(['POST /files/', 'PUT /files/new-1.pukupop']);
});

test('保存していない変更があるままページを閉じるときは、ブラウザの確認を出す', async ({ page }) => {
  await fakeServer(page);
  await open(page, { src: '/files/cat.pukupop', back: '/files/' });
  await page.locator('[data-tool="brush"]').click();
  await paint(page);
  let seen = '';
  page.on('dialog', d => { seen = d.type(); void d.accept(); });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => seen).toBe('beforeunload');
});

test('ほかのファイルを開く・タブ・名前を付けて保存・サンプルの操作は隠し、自動保存もしない', async ({ page }) => {
  await fakeServer(page);
  await open(page, { src: '/files/cat.pukupop' });
  await page.locator('#menubar .dropdown').first().locator('[role="button"]').click();
  const menu = page.locator('#menubar .dropdown').first().locator('.dropdown-content');
  await expect(menu.locator('[data-cmd="save"]')).toBeVisible();
  await expect(menu.locator('[data-cmd="export"]')).toBeVisible();
  for (const cmd of ['open', 'recent', 'saveAs', 'closeTab', 'sample']) await expect(menu.locator(`[data-cmd="${cmd}"]`)).toBeHidden();
  // 中身が無くなった見出し(メニューの「その他」)・左のツールバーのまとまりの枠も出さない
  await expect(menu.locator('.menu-title', { hasText: 'その他' })).toBeHidden();
  await expect(page.locator('#toolNav [data-cmd="recent"]')).toBeHidden();
  await expect(page.locator('#toolNav .nav-group[aria-label="ファイルの操作"]')).toBeHidden();
  await expect(page.locator('.doc-tab-close')).toBeHidden();
  // 戻り先を渡していないので、戻るボタンは出さない
  await expect(page.locator('#embedBack')).toBeHidden();
  // キーでも開かない・名前を付けて保存しない
  await page.keyboard.press('Escape');
  let picked = 0;
  await page.exposeFunction('__picked', () => { picked++; });
  await page.evaluate(() => {
    const w = window as any;
    w.showOpenFilePicker = async () => { w.__picked(); return []; };
    w.showSaveFilePicker = async () => { w.__picked(); throw new DOMException('x', 'AbortError'); };
  });
  for (const k of ['Control+o', 'Control+Shift+o', 'Control+Shift+s', 'Alt+w']) await page.keyboard.press(k);
  await expect(page.locator('#recentDialog')).toBeHidden();
  expect(picked).toBe(0);
  expect((await state(page)).tabs).toBe(1);
  // 変更しても、自動保存(IndexedDB)に書かない
  await page.locator('[data-tool="brush"]').click();
  await paint(page);
  await page.waitForTimeout(2600); // 自動保存は変更の 2 秒後
  expect(await page.evaluate(async () => (await indexedDB.databases()).map(d => d.name))).not.toContain('popstage');
});

test('戻るボタン: 保存していない変更があれば確かめ、戻ると決めたらページを閉じるときの確認を出さずに戻る', async ({ page }) => {
  await fakeServer(page);
  await page.route('**/archive/list', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>一覧</title><p>一覧</p>' }));
  await open(page, { src: '/files/cat.pukupop', back: '/archive/list' });
  const back = page.locator('#embedBack');
  await expect(back).toBeVisible();
  await page.locator('[data-tool="brush"]').click();
  await paint(page);

  await back.click();
  const dlg = page.locator('#askDialog');
  await expect(dlg).toContainText('保存していない変更があります');
  await page.locator('#askNo').click();
  await expect(dlg).toBeHidden();
  expect(page.url()).toContain('embed');

  // ページを閉じるときの確認(beforeunload)が出ると、Playwright はそれを閉じて(= 留まって)しまうので、着けば出ていない
  let unloadDialog = false;
  page.on('dialog', d => { if (d.type() === 'beforeunload') unloadDialog = true; void d.dismiss(); });
  await back.click();
  await page.locator('#askYes').click();
  await page.waitForURL('**/archive/list');
  expect(unloadDialog).toBe(false);
});

test('同じオリジンでない URL は開かずにエラーを出し、戻り先があれば戻れる', async ({ page }) => {
  const outside: string[] = [];
  await page.route('https://evil.example/**', route => { outside.push(route.request().url()); return route.fulfill({ status: 200, body: '' }); });
  await page.route('**/archive/list', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>一覧</p>' }));
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  listenGlErrors(page);
  await page.goto(`/?e2e&embed&${new URLSearchParams({ src: '/files/cat.pukupop', save: 'https://evil.example/upload', back: '/archive/list' })}`);
  const dlg = page.locator('#askDialog');
  await expect(dlg).toContainText('ファイルを開けませんでした');
  await expect(dlg).toContainText('同じオリジン');
  // 開いていない(サンプルも読み込まない)
  expect(await page.evaluate(() => !!(window as any).popstage.doc)).toBe(false);
  await page.locator('#askYes').click();
  await page.waitForURL('**/archive/list');
  expect(outside).toEqual([]);
  expect(errors).toEqual([]);
});

test('ファイルが取れなければ、状態のコードを出す', async ({ page }) => {
  await fakeServer(page);
  listenGlErrors(page);
  await page.goto(`/?e2e&embed&${new URLSearchParams({ src: '/files/none.pukupop' })}`);
  const dlg = page.locator('#askDialog');
  await expect(dlg).toContainText('HTTP 404');
  // 戻り先が無いので「OK」で閉じるだけ
  await expect(page.locator('#askYes')).toHaveText('OK');
});

test('スマホ(ファイルの保存先を選べないブラウザ)でも、保存はダウンロードでなくサーバーへの上書き', async ({ browser }, info) => {
  const page = await browser.newPage({ baseURL: info.project.use.baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await page.addInitScript(() => { delete (window as any).showSaveFilePicker; delete (window as any).showOpenFilePicker; });
  const srv = await fakeServer(page);
  await open(page, { src: '/files/cat.pukupop', back: '/files/' });
  await expect(page.locator('#mBack')).toBeVisible();
  await page.evaluate(() => { const a = (window as any).popstage; a.weightOp('反転', (wm: any) => wm.invert()); });
  expect((await state(page)).dirty).toBe(true);
  let downloaded = false;
  page.on('download', () => { downloaded = true; });
  // 上の「…」メニューから保存する
  await page.locator('#mTop .dropdown [role="button"]').click();
  await expect(page.locator('#mTop [data-cmd="open"]')).toBeHidden();
  await page.locator('#mTop [data-cmd="save"]').click();
  await expect.poll(async () => (await state(page)).dirty).toBe(false);
  expect(srv.writes()).toEqual([{ method: 'PUT', path: '/files/cat.pukupop', ifMatch: '"v1"' }]);
  expect(downloaded).toBe(false);
  await page.close();
});
