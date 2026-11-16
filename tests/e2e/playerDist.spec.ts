/**
 * E2E: ライブラリとしてビルドした Player(dist-player/pukupop-player.js、Issue #127)が、ブラウザで実際に動くこと。
 * 確認用のページ player.html に ?dist を付けて開き、ソースではなくビルドした1本を import() で読む。
 * ビルドは、このファイルのテストの始めに流す(npm run build:player。1〜2 秒。いつも今のソースから作り直す)。
 * 確かめるのは最小限(読み込み → 絵が出る → 操作 → dispose()、PlayerError の code、キャンバスの外に触らない)。
 * 細かい動きはソースを読む tests/e2e/player.spec.ts が見る。
 */
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { watchGlErrors, listenGlErrors } from './helpers';

watchGlErrors();

test.beforeAll(() => {
  execSync('npm run build:player', { encoding: 'utf8', stdio: 'pipe', cwd: fileURLToPath(new URL('../..', import.meta.url)) });
});

/** ページを読む前に仕掛ける見張り: window・document に付いた受け口(付けた所のスタックも)と、保存領域を触った回数 */
function spies(): void {
  const w = window as any;
  const spy = w.__spy = { winDoc: [] as string[], storage: 0, idb: 0 };
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, ...a: any[]) {
    if (this === window || this === document) spy.winDoc.push(`${a[0]}\n${new Error().stack}`);
    return (add as any).apply(this, a);
  };
  for (const k of ['getItem', 'setItem', 'removeItem', 'clear', 'key'] as const) {
    const f = Storage.prototype[k] as any;
    (Storage.prototype as any)[k] = function (...a: any[]) { spy.storage++; return f.apply(this, a); };
  }
  const idb = indexedDB as any, open = idb.open;
  idb.open = function (...a: any[]) { spy.idb++; return open.apply(this, a); };
}

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  listenGlErrors(page);
  await page.addInitScript(spies);
  await page.goto('/player.html?preserve&e2e&dist');
  await page.waitForFunction(() => (window as any).playerDemo);
  return errors;
}

/** キャンバスを小さく写した画素に、透けていない所があるか(絵が出ているか) */
const drawn = (page: Page) => page.evaluate(() => {
  const c = document.getElementById('c') as HTMLCanvasElement, t = document.createElement('canvas');
  t.width = 96; t.height = 72;
  const g = t.getContext('2d')!;
  g.drawImage(c, 0, 0, 96, 72);
  return Array.from(g.getImageData(0, 0, 96, 72).data).some((v, i) => i % 4 === 3 && v > 0);
});

test('ビルドした1本を読み込むと、絵が出て、止める・お気に入り・dispose() ができ、キャンバスの外に触らない', async ({ page }) => {
  const errors = await open(page);
  const before = await page.evaluate(() => ({
    keys: Object.getOwnPropertyNames(window),
    handlers: [window, document, document.body].map(o => { const out: string[] = []; for (const k in o) if (k.startsWith('on') && (o as any)[k] != null) out.push(k); return out.sort(); }),
  }));
  const r = await page.evaluate(async () => {
    const w = window as any, d = w.playerDemo, m = await d.load();
    w.player = await m.createPlayer(d.canvas(), await d.sample({ autoSwing: true, take: true, favorites: true, background: '#202020' }));
    return {
      exports: Object.keys(m).sort(),
      // ソースの Player(src/player/player.ts)は読んでおらず、ビルドした1本を読んだ
      resources: performance.getEntriesByType('resource').map(e => new URL(e.name).pathname).filter(p => /dist-player|src\/player\/(player|index)\.ts/.test(p)),
      info: w.player.info,
      playing: w.player.playing,
    };
  });
  expect(r.exports).toEqual(['PlayerError', 'createPlayer']);
  expect(r.resources).toEqual(['/dist-player/pukupop-player.js']);
  expect(r.info).toMatchObject({ width: 1024, height: 768, takeSeconds: 2 });
  expect(r.info.favorites.map((f: { name: string }) => f.name)).toEqual(['大きく', '静か']);
  expect(r.playing).toBe(true);
  await expect.poll(() => drawn(page)).toBe(true);
  // 回す(interaction: 'view' の既定)・止める・お気に入り・大きさを測り直す・続ける
  const box = (await page.locator('#c').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  const after = await page.evaluate(() => {
    const p = (window as any).player;
    p.pause();
    const paused = p.playing;
    const fav = p.setFavorite(p.info.favorites[1].id), unknown = p.setFavorite('no-such-id');
    p.resize(); p.play();
    const playing = p.playing;
    p.dispose(); p.dispose();
    return { paused, fav, unknown, playing, disposed: p.playing, frozen: Object.isFrozen(p), keys: Object.keys(p).sort() };
  });
  expect(after).toEqual({
    paused: false, fav: true, unknown: false, playing: true, disposed: false, frozen: true,
    keys: ['dispose', 'info', 'pause', 'play', 'playing', 'resize', 'setFavorite'],
  });
  // キャンバスの外に触らない: window・document の受け口(ビルドした1本から付けたもの)、on* プロパティ、保存領域、head の CSS、親要素。
  // window に足されたものは、同梱した three.js が読み込んだときに書く版(__THREE__)だけ
  const look = await page.evaluate(() => {
    const w = window as any, box = document.getElementById('box')!;
    return {
      listeners: w.__spy.winDoc.filter((s: string) => s.includes('/dist-player/')),
      storage: w.__spy.storage, idb: w.__spy.idb,
      handlers: [window, document, document.body].map(o => { const out: string[] = []; for (const k in o) if (k.startsWith('on') && (o as any)[k] != null) out.push(k); return out.sort(); }),
      keys: Object.getOwnPropertyNames(window),
      head: document.head.querySelectorAll('style, link').length,
      parent: [box.className, box.getAttribute('style')],
    };
  });
  expect(look.listeners).toEqual([]);
  expect([look.storage, look.idb]).toEqual([0, 0]);
  expect(look.handlers).toEqual(before.handlers);
  expect(look.keys.filter(k => !before.keys.includes(k) && !['player', '__THREE__'].includes(k))).toEqual([]);
  expect(look.head).toBe(1); // 確認用のページの <style> だけ
  expect(look.parent).toEqual(['', null]);
  expect(errors).toEqual([]);
});

test('ビルドした1本でも、失敗は code 付きの PlayerError(name で見分けられる)。dispose() したキャンバスは canvas-unusable', async ({ page }) => {
  const errors = await open(page);
  const r = await page.evaluate(async () => {
    const d = (window as any).playerDemo, m = await d.load(), good = await d.sample({});
    const reason = (p: Promise<{ dispose(): void }>) => p.then(
      x => { x.dispose(); return 'ok'; },
      (e: any) => [e.name, e.code, e instanceof m.PlayerError, e instanceof Error, e.message],
    );
    const c = d.canvas(), ac = new AbortController();
    ac.abort();
    const out = {
      broken: await reason(m.createPlayer(c, new Uint8Array([1, 2, 3]))),
      newer: await reason(m.createPlayer(c, d.withFormatVersion(good, 99))),
      aborted: await reason(m.createPlayer(c, good, { signal: ac.signal })),
      // 読み込みの失敗・取り消しのあとは、同じキャンバスで作れる
      ok: await reason(m.createPlayer(c, good, { autoplay: false, interaction: 'none' })),
      // 上で dispose() したキャンバスは使い回せない
      spent: await reason(m.createPlayer(c, good)),
    };
    return out;
  });
  expect(r.broken).toEqual(['PlayerError', 'invalid-file', true, true, 'プロジェクトファイルを展開できませんでした(壊れているか、形式が違います)']);
  expect(r.newer.slice(0, 4)).toEqual(['PlayerError', 'unsupported-version', true, true]);
  expect(r.newer[4]).toContain('このファイルは新しい版(99)で保存されています。');
  expect(r.aborted).toEqual(['PlayerError', 'aborted', true, true, '読み込みを取り消しました']);
  expect(r.ok).toBe('ok');
  expect(r.spent).toEqual(['PlayerError', 'canvas-unusable', true, true, 'このキャンバスはもう使えません。新しい canvas を渡してください。']);
  expect(errors).toEqual([]);
});
