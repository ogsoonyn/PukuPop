/**
 * E2E: 埋め込み用にビルドした編集画面(dist-editor/app/、Issue #146)を、ほかのアプリのサブパス(/archive/pukupop/)に置いて動くこと。
 * ビルドは、このファイルのテストの始めに流す(npm run build:editor。いつも今のソースから作り直す)。
 * サーバーは立てず、別のポートのオリジン(どこも listen していない)への読み込みを page.route で全部受ける:
 * /archive/pukupop/ の下は dist-editor/app/ のファイル、/files/ の下はファイルを返す・書き戻す作り物。
 * ?embed を付けなくても埋め込みモードになること(ビルドで有効になる)も見る。細かい動きは embed.spec.ts が見る。
 * boot() を使わない例外: 自前の open と listenGlErrors() で GL のエラーを見張る
 */
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { watchGlErrors, listenGlErrors, nextFrames } from './helpers';

watchGlErrors();

const root = fileURLToPath(new URL('../..', import.meta.url));
const appDir = fileURLToPath(new URL('../../dist-editor/app/', import.meta.url));
/** どこも listen していないポート(読み込みは全部 page.route で受けるので、サーバーは立てない。エージェントの Vite が使う 5175〜5179 は避ける) */
const ORIGIN = 'http://localhost:5199';
const APP = `${ORIGIN}/archive/pukupop/`;

test.beforeAll(() => {
  test.setTimeout(240_000);
  execSync('npm run build:editor', { encoding: 'utf8', stdio: 'pipe', cwd: root });
});

const TYPES: Record<string, string> = {
  html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', webmanifest: 'application/manifest+json', json: 'application/json',
};

/** サブパスの下に dist-editor/app/ を置き、/files/ の下にファイルを返す・書き戻す口を置く。知らないパスへの読み込みは控える */
async function host(page: Page, png: Uint8Array) {
  const files = new Map<string, { body: Uint8Array; etag: number }>([['/files/cat.png', { body: png, etag: 1 }]]);
  const writes: string[] = [], unknown: string[] = [];
  await page.route(`${ORIGIN}/**`, async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path.startsWith('/archive/pukupop/')) {
      const rel = decodeURIComponent(path.slice('/archive/pukupop/'.length)) || 'index.html';
      const file = appDir + rel;
      if (rel.includes('..') || !existsSync(file)) { unknown.push(path); return route.fulfill({ status: 404 }); }
      return route.fulfill({ status: 200, body: Buffer.from(readFileSync(file)), contentType: TYPES[rel.split('.').pop()!] ?? 'application/octet-stream' });
    }
    if (path === '/archive/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<p>一覧</p>' });
    if (path.startsWith('/files/')) {
      const f = files.get(path);
      writes.push(`${req.method()} ${path}`);
      if (req.method() === 'GET') return f ? route.fulfill({ status: 200, body: Buffer.from(f.body), headers: { ETag: `"v${f.etag}"` } }) : route.fulfill({ status: 404 });
      if (req.method() === 'POST' && path === '/files/') {
        files.set('/files/cat.pukupop', { body: req.postDataBuffer()!, etag: 1 });
        return route.fulfill({ status: 201, headers: { Location: '/files/cat.pukupop', ETag: '"v1"' } });
      }
      if (req.method() === 'PUT' && f) {
        if (req.headers()['if-match'] !== `"v${f.etag}"`) return route.fulfill({ status: 412 });
        f.body = req.postDataBuffer()!; f.etag++;
        return route.fulfill({ status: 204, headers: { ETag: `"v${f.etag}"` } });
      }
      return route.fulfill({ status: 405 });
    }
    unknown.push(path);
    return route.fulfill({ status: 404 });
  });
  return { files, writes, unknown };
}

async function open(page: Page, query: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  listenGlErrors(page);
  await page.goto(`${APP}?e2e&${query}`);
  await page.waitForFunction(() => { const a = (window as any).popstage; return a?.doc && a.stage.hasDocument && a.paused; });
  return errors;
}

/** テスト用の PNG(赤い 160×120) */
async function makePng(page: Page): Promise<Uint8Array> {
  await page.route(`${ORIGIN}/blank`, r => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>blank</p>' }));
  await page.goto(`${ORIGIN}/blank`);
  return new Uint8Array(await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 160; c.height = 120;
    const g = c.getContext('2d')!; g.fillStyle = '#e33'; g.fillRect(0, 0, 160, 120);
    const b: Blob = await new Promise(r => c.toBlob(x => r(x!), 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }));
}

test('サブパスに置いたビルドで、画像から作って POST し、開き直して PUT で上書きできる(?embed なしで埋め込みモード)', async ({ page }) => {
  const png = await makePng(page);
  const srv = await host(page, png);
  const errors = await open(page, `${new URLSearchParams({ image: '/files/cat.png', create: '/files/', back: '/archive/' })}`);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => (window as any).popstage.embedded)).toBe(true);
  await expect(page.locator('#embedBack')).toBeVisible();
  // 埋め込みモードで使わない操作は隠す
  await expect(page.locator('#toolNav [data-cmd="recent"]')).toBeHidden();
  // 揺らし方図鑑は埋め込み用の配布物に入れないので、ヘルプのリンクもビルドで外す
  await expect(page.locator('#helpGuide')).toHaveCount(0);

  await page.evaluate(() => (window as any).popstage.weightOp('反転', (wm: any) => wm.invert()));
  await nextFrames(page);
  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => (window as any).popstage.dirty)).toBe(false);
  expect(srv.files.get('/files/cat.pukupop')).toBeTruthy();

  // ページの URL は作ったファイルを開く形に置き換わる(Issue #150)。読み直すと、そのファイルを開いて上書きする
  await expect.poll(() => new URL(page.url()).searchParams.get('src')).toBe('/files/cat.pukupop');
  expect(new URL(page.url()).pathname).toBe(new URL(APP).pathname);
  await page.reload();
  await page.waitForFunction(() => { const a = (window as any).popstage; return a?.doc && a.stage.hasDocument && a.paused; });
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => (window as any).popstage.tabName((window as any).popstage.activeTab))).toBe('cat.pukupop');
  await expect(page.locator('#embedBack')).toBeVisible();
  await page.evaluate(() => (window as any).popstage.weightOp('反転', (wm: any) => wm.invert()));
  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => (window as any).popstage.dirty)).toBe(false);
  expect(srv.writes).toEqual(['GET /files/cat.png', 'POST /files/', 'GET /files/cat.pukupop', 'PUT /files/cat.pukupop']);

  // サブパスの外(/assets/ など)を読みに行っていない。service worker は登録しない
  expect(srv.unknown).toEqual([]);
  expect(await page.evaluate(async () => (await navigator.serviceWorker?.getRegistrations())?.length ?? 0)).toBe(0);
});
