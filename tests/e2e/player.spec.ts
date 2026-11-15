/**
 * E2E: 埋め込み用の再生専用の部品(Player、Issue #127)。確認用のページ player.html で動かす。
 * 画素を読むため ?preserve を付けて開く(preserveDrawingBuffer を入れるのは確認用のページで、Player は関わらない)。
 * 中の状態(視点・物理・ループ再生)は、確かめるために Player の中身(player.project など)を直接読む。
 */
import { test, expect, type Page } from '@playwright/test';
import { watchGlErrors, listenGlErrors } from './helpers';

watchGlErrors();

/**
 * ページを読む前に仕掛ける見張り。window・document に付いた受け口(付けた所のスタックも)、localStorage・sessionStorage・
 * IndexedDB・service worker を触った回数、requestAnimationFrame を呼んだ回数を数える
 */
function spies(): void {
  const w = window as any;
  const spy = w.__spy = { winDoc: [] as string[], storage: 0, idb: 0, sw: 0, raf: 0 };
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, ...a: any[]) {
    if (this === window || this === document) spy.winDoc.push(`${a[0]}\n${new Error().stack}`);
    return (add as any).apply(this, a);
  };
  for (const k of ['getItem', 'setItem', 'removeItem', 'clear', 'key'] as const) {
    const f = Storage.prototype[k] as any;
    (Storage.prototype as any)[k] = function (...a: any[]) { spy.storage++; return f.apply(this, a); };
  }
  const idb = indexedDB as any;
  for (const k of ['open', 'deleteDatabase', 'databases']) {
    const f = idb[k];
    if (f) idb[k] = function (...a: any[]) { spy.idb++; return f.apply(this, a); };
  }
  const sw = navigator.serviceWorker as any;
  if (sw?.register) { const f = sw.register; sw.register = function (...a: any[]) { spy.sw++; return f.apply(this, a); }; }
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb: FrameRequestCallback) { spy.raf++; return raf.call(window, cb); };
}

const pageErrors = new WeakMap<Page, string[]>();

async function open(page: Page): Promise<void> {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', e => errors.push(e.message));
  listenGlErrors(page);
  await page.addInitScript(spies);
  await page.goto('/player.html?preserve');
  await page.waitForFunction(() => (window as any).playerDemo);
}

test.afterEach(({ page }) => { expect(pageErrors.get(page) ?? [], 'ページの例外').toEqual([]); });

interface SampleOptions { autoSwing?: boolean; take?: boolean; favorites?: boolean; background?: string | null }
interface PlayerOptions { autoplay?: boolean; interaction?: 'none' | 'view' }

/** サンプルのファイルを作り、確認用のページのキャンバスに Player を作る(window.player) */
async function create(page: Page, sample: SampleOptions = {}, options: PlayerOptions = {}): Promise<void> {
  await page.evaluate(async ([sample, options]) => {
    const d = (window as any).playerDemo, m = await d.load();
    (window as any).player = await m.createPlayer(d.canvas(), await d.sample(sample), options);
  }, [sample, options] as const);
}

/** キャンバスを小さく写した画素(RGBA) */
const snap = (page: Page) => page.evaluate(() => {
  const c = (window as any).playerDemo.canvas() as HTMLCanvasElement, t = document.createElement('canvas');
  t.width = 96; t.height = 72;
  const g = t.getContext('2d')!;
  g.drawImage(c, 0, 0, 96, 72);
  return Array.from(g.getImageData(0, 0, 96, 72).data);
});
/** 絵が出ているか(透けていない画素がある) */
const drawn = (px: number[]) => px.some((v, i) => i % 4 === 3 && v > 0);
/** 2枚の違い(画素の値の差の平均) */
const diff = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

const read = <T>(page: Page, f: string) => page.evaluate(f) as Promise<T>;
const frames = (page: Page, n = 3) => page.evaluate(n => new Promise<void>(r => {
  const step = (k: number) => (k ? requestAnimationFrame(() => step(k - 1)) : r());
  step(n);
}), n);

test('読み込むと絵が出て、自動で揺らすファイルは揺れている。止めるとその姿のまま止まり、続きから動く', async ({ page }) => {
  await open(page);
  await create(page, { autoSwing: true });
  expect(await read<boolean>(page, 'player.playing')).toBe(true);
  await expect.poll(async () => drawn(await snap(page))).toBe(true);
  const info = await read<{ width: number; height: number; takeSeconds: number; favorites: unknown[] }>(page, 'player.info');
  expect(info).toEqual({ width: 1024, height: 768, takeSeconds: 0, favorites: [] });
  // 揺れている: 絵が変わり続ける
  const a = await snap(page);
  await expect.poll(async () => diff(a, await snap(page))).toBeGreaterThan(0.5);
  // 止める: 揺れの途中の形のまま、絵も物理も進まず、requestAnimationFrame も回らない
  await page.evaluate(() => (window as any).player.pause());
  expect(await read<boolean>(page, 'player.playing')).toBe(false);
  const at = await page.evaluate(() => {
    const p = (window as any).player;
    return { time: p.world.time, s: p.world.displacement(p.doc.layers[0].id).y, raf: (window as any).__spy.raf };
  });
  expect(Math.abs(at.s)).toBeGreaterThan(0); // 平らに戻していない
  const still = await snap(page);
  await page.waitForTimeout(600); // 何も起きないことを確かめるので、時間で待つ
  const later = await page.evaluate(() => {
    const p = (window as any).player;
    return { time: p.world.time, s: p.world.displacement(p.doc.layers[0].id).y, raf: (window as any).__spy.raf };
  });
  expect(later).toEqual(at);
  expect(diff(still, await snap(page))).toBe(0);
  // 続ける: 止めた所から進む(初めからやり直さない)
  await page.evaluate(() => (window as any).player.play());
  expect(await read<boolean>(page, 'player.playing')).toBe(true);
  const first = await read<number>(page, 'player.world.time');
  expect(first).toBeGreaterThanOrEqual(at.time);
  await expect.poll(() => read<number>(page, 'player.world.time')).toBeGreaterThan(at.time + 0.1);
  await expect.poll(async () => diff(still, await snap(page))).toBeGreaterThan(0.5);
});

test('autoplay: false なら最初の1フレームを描いて止まった状態で始まり、play() で動き出す', async ({ page }) => {
  await open(page);
  await create(page, { autoSwing: true }, { autoplay: false });
  expect(await read<boolean>(page, 'player.playing')).toBe(false);
  expect(drawn(await snap(page))).toBe(true);
  const raf = await read<number>(page, '__spy.raf');
  await page.waitForTimeout(300);
  expect(await read<number>(page, '__spy.raf')).toBe(raf);
  expect(await read<number>(page, 'player.world.time')).toBe(0);
  await page.evaluate(() => (window as any).player.play());
  await expect.poll(() => read<number>(page, 'player.world.time')).toBeGreaterThan(0.1);
});

test('自動で揺らすが切れていて記録も無いファイルは、再生しても止まった絵のまま', async ({ page }) => {
  await open(page);
  await create(page, { autoSwing: false });
  // 重さでわずかに沈むので、揺れが落ち着いたあとは動かないことを見る
  const at = () => page.evaluate(() => { const p = (window as any).player, s = p.world.displacement(p.doc.layers[0].id); return { t: p.world.time, s: [s.x, s.y, s.z] }; });
  await expect.poll(() => read<number>(page, 'player.world.time')).toBeGreaterThan(2);
  const a = await at();
  await expect.poll(() => read<number>(page, 'player.world.time')).toBeGreaterThan(a.t + 1);
  const b = await at();
  for (let i = 0; i < 3; i++) expect(Math.abs(b.s[i] - a.s[i])).toBeLessThan(1e-4);
  expect(await read<boolean>(page, 'player.project.autoSwing.enabled')).toBe(false);
});

test('記録のあるファイルはループ再生し、お気に入りで揺れと動きを切り替えられる', async ({ page }) => {
  await open(page);
  await create(page, { autoSwing: false, take: true, favorites: true });
  const info = await read<{ takeSeconds: number; favorites: { id: string; name: string }[] }>(page, 'player.info');
  expect(info.takeSeconds).toBeGreaterThan(1);
  expect(info.favorites.map(f => f.name)).toEqual(['大きく', '静か']);
  // ループ再生: 記録の位置が進み、1周すると戻る
  expect(await read<boolean>(page, 'player.loop.playing')).toBe(true);
  await expect.poll(() => read<number>(page, 'player.loop.position')).toBeGreaterThan(0.3);
  // 知らない id は何もしない
  expect(await page.evaluate(() => (window as any).player.setFavorite('nope'))).toBe(false);
  // 「静か」: 自動揺らしを切り、記録無し、視点を右へ
  const [big, calm] = info.favorites;
  expect(await page.evaluate(id => (window as any).player.setFavorite(id), calm.id)).toBe(true);
  expect(await page.evaluate(() => {
    const p = (window as any).player;
    return { loop: p.loop.playing, auto: p.project.autoSwing.enabled, yaw: p.project.camera.yaw, take: p.info.takeSeconds };
  })).toEqual({ loop: false, auto: false, yaw: 0.7, take: 0 });
  // 「大きく」: ポップ量・自動揺らしが変わり、記録を再生していたのでループ再生を始める
  expect(await page.evaluate(id => (window as any).player.setFavorite(id), big.id)).toBe(true);
  expect(await page.evaluate(() => {
    const p = (window as any).player;
    return { loop: p.loop.playing, pop: p.doc.layers[0].pop, period: p.project.autoSwing.period, take: p.info.takeSeconds > 1 };
  })).toEqual({ loop: true, pop: 600, period: 0.8, take: true });
  await expect.poll(() => read<number>(page, 'player.loop.position')).toBeGreaterThan(0.3);
  // 止めている間に当てても、止めたまま(描き直しはする)
  await page.evaluate(() => (window as any).player.pause());
  expect(await page.evaluate(id => (window as any).player.setFavorite(id), calm.id)).toBe(true);
  expect(await read<boolean>(page, 'player.playing')).toBe(false);
  await frames(page);
  expect(drawn(await snap(page))).toBe(true);
});

test('interaction: view: ドラッグで回り、ただのホイールはページのスクロールに任せ、Ctrl+ホイールでズームする', async ({ page }) => {
  await open(page);
  await create(page, { autoSwing: false });
  const box = (await page.locator('#c').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  expect(await page.locator('#c').evaluate(c => (c as HTMLCanvasElement).style.touchAction)).toBe('none');
  const yaw = () => read<number>(page, 'player.project.camera.yaw');
  // 左ドラッグ: キャンバスの外まで引いても追う
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 40, cy + i * 5);
  await page.mouse.up();
  const y1 = await yaw();
  expect(y1).toBeLessThan(-0.5); // 右へ引くと yaw が減る(編集アプリと同じ向き)
  expect(await read<number>(page, 'player.project.camera.pitch')).toBeGreaterThan(0);
  // 右ドラッグでも回る(メニューは出さない)
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 5; i++) await page.mouse.move(cx - i * 20, cy);
  await page.mouse.up({ button: 'right' });
  expect(await yaw()).toBeGreaterThan(y1);
  // ホイールの扱いを、ページ側(window)で見る
  await page.evaluate(() => {
    const w = window as any;
    w.__wheel = [];
    window.addEventListener('wheel', e => w.__wheel.push(e.defaultPrevented));
  });
  const zoom = () => read<number>(page, 'player.project.camera.zoom');
  const z0 = await zoom();
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => read<number>(page, 'scrollY')).toBeGreaterThan(0);
  expect(await read<boolean[]>(page, '__wheel')).toEqual([false]);
  expect(await zoom()).toBe(z0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => read<number>(page, 'scrollY')).toBe(0);
  const b2 = (await page.locator('#c').boundingBox())!;
  await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  await expect.poll(zoom).toBeLessThan(z0 * 0.8); // 近づく
  expect((await read<boolean[]>(page, '__wheel')).at(-1)).toBe(true);
  expect(await read<number>(page, 'scrollY')).toBe(0);
  // 止めている間に回しても描き直す(物理は進めない)
  await page.evaluate(() => (window as any).player.pause());
  const t = await read<number>(page, 'player.world.time'), before = await snap(page);
  await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(b2.x + b2.width / 2 - i * 30, b2.y + b2.height / 2);
  await page.mouse.up();
  await expect.poll(async () => diff(before, await snap(page))).toBeGreaterThan(0.5);
  expect(await read<number>(page, 'player.world.time')).toBe(t);
});

test('interaction: view: 視点を回した勢いで揺れる(編集アプリと同じ物理)', async ({ page }) => {
  await open(page);
  await create(page, { autoSwing: false });
  const box = (await page.locator('#c').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.evaluate(() => {
    const w = window as any, p = w.player;
    w.__maxSwing = 0;
    const tick = () => {
      const s = p.world.displacement(p.doc.layers[0].id);
      w.__maxSwing = Math.max(w.__maxSwing, Math.hypot(s.x, s.y, s.z));
      requestAnimationFrame(tick);
    };
    tick();
  });
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(cx + i * 30, cy);
  await page.mouse.up();
  await expect.poll(() => read<number>(page, '__maxSwing')).toBeGreaterThan(0.001);
});

test.describe('指の操作', () => {
  test.use({ hasTouch: true });

  test('1本指のドラッグで回り、2本指のピンチでズームする', async ({ page }) => {
    await open(page);
    await create(page, { autoSwing: false });
    const box = (await page.locator('#c').boundingBox())!;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: [number, number][]) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: points.map(([x, y], id) => ({ x, y, id })),
    });
    const yaw0 = await read<number>(page, 'player.project.camera.yaw');
    await touch('touchStart', [[cx, cy]]);
    for (let i = 1; i <= 6; i++) await touch('touchMove', [[cx + i * 20, cy]]);
    await touch('touchEnd', []);
    await expect.poll(() => read<number>(page, 'player.project.camera.yaw')).toBeLessThan(yaw0 - 0.3);
    const z0 = await read<number>(page, 'player.project.camera.zoom');
    await touch('touchStart', [[cx - 40, cy], [cx + 40, cy]]);
    for (let i = 1; i <= 6; i++) await touch('touchMove', [[cx - 40 - i * 15, cy], [cx + 40 + i * 15, cy]]);
    await touch('touchEnd', []);
    await expect.poll(() => read<number>(page, 'player.project.camera.zoom')).toBeLessThan(z0 * 0.6);
  });
});

test('interaction: none なら、ドラッグもホイールも受けない', async ({ page }) => {
  await open(page);
  await create(page, { autoSwing: false }, { interaction: 'none' });
  expect(await page.locator('#c').evaluate(c => (c as HTMLCanvasElement).style.touchAction)).toBe('');
  const box = (await page.locator('#c').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const cam = () => page.evaluate(() => { const c = (window as any).player.project.camera; return [c.yaw, c.pitch, c.zoom]; });
  const c0 = await cam();
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(cx + i * 30, cy + i * 10);
  await page.mouse.up();
  await page.evaluate(() => {
    const w = window as any;
    w.__wheel = [];
    window.addEventListener('wheel', e => w.__wheel.push(e.defaultPrevented));
  });
  await page.mouse.move(cx, cy);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  await expect.poll(() => read<number>(page, '__wheel.length')).toBe(1);
  await frames(page);
  expect(await read<boolean[]>(page, '__wheel')).toEqual([false]);
  expect(await cam()).toEqual(c0);
});

test('resize: 大きさを渡すとキャンバスをその大きさにし、止めているときも描き直す', async ({ page }) => {
  await open(page);
  await create(page, { autoSwing: true, background: '#336699' });
  await page.evaluate(() => (window as any).player.pause());
  await page.evaluate(() => (window as any).player.resize(300, 200));
  const size = await page.locator('#c').evaluate(c => {
    const e = c as HTMLCanvasElement;
    return { css: [e.style.width, e.style.height], w: e.width / devicePixelRatio, h: e.height / devicePixelRatio };
  });
  expect(size).toEqual({ css: ['300px', '200px'], w: 300, h: 200 });
  // 背景色は WebGL の消去の色で塗る(角は画像の外なので背景色)
  await expect.poll(async () => (await snap(page)).slice(0, 4)).toEqual([0x33, 0x66, 0x99, 255]);
  // 引数なしなら今の大きさを読み直す
  await page.locator('#c').evaluate(c => { (c as HTMLCanvasElement).style.width = '200px'; });
  await page.evaluate(() => (window as any).player.resize());
  expect(await page.locator('#c').evaluate(c => (c as HTMLCanvasElement).width / devicePixelRatio)).toBe(200);
  await expect.poll(async () => drawn(await snap(page))).toBe(true);
});

test('読み込み → 再生 → dispose を新しいキャンバスで・同じキャンバスで 20 回ずつくり返しても、コンテキストが尽きない', async ({ page }) => {
  test.setTimeout(180_000);
  const warnings: string[] = [];
  page.on('console', m => { if (/Too many active WebGL contexts/i.test(m.text())) warnings.push(m.text()); });
  await open(page);
  const result = await page.evaluate(async () => {
    const d = (window as any).playerDemo, m = await d.load(), bytes = await d.sample({ autoSwing: true });
    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const box = document.getElementById('box')!;
    // 新しいキャンバスで(埋め込み先が送るたびにキャンバスを作り直す)
    for (let i = 0; i < 20; i++) {
      const c = document.createElement('canvas');
      c.style.cssText = 'width:160px;height:120px';
      box.append(c);
      const p = await m.createPlayer(c, bytes);
      await frame();
      p.dispose();
      p.dispose(); // 2回呼んでも何もしない
      p.play(); p.pause(); p.resize(10, 10); // dispose のあとは何もしない
      if (p.setFavorite('x') !== false) throw new Error('dispose のあとの setFavorite');
      c.remove();
    }
    // 同じキャンバスで(埋め込み先がキャンバスを使い回す)
    const c = d.canvas();
    for (let i = 0; i < 20; i++) {
      const p = await m.createPlayer(c, bytes);
      await frame();
      p.dispose();
    }
    (window as any).player = await m.createPlayer(c, bytes);
    await frame();
    return true;
  });
  expect(result).toBe(true);
  await expect.poll(async () => drawn(await snap(page))).toBe(true);
  expect(await read<boolean>(page, 'player.stage.renderer.getContext().isContextLost()')).toBe(false);
  expect(warnings).toEqual([]);
});

test('壊れたファイル・新しい版のファイル・画像が壊れたファイルは、理由付きで失敗し、同じキャンバスで作り直せる', async ({ page }) => {
  await open(page);
  const errors = await page.evaluate(async () => {
    const d = (window as any).playerDemo, m = await d.load(), c = d.canvas(), good = await d.sample({});
    const reason = (p: Promise<unknown>) => p.then(() => 'ok', (e: Error) => e.message);
    return [
      await reason(m.createPlayer(c, new Uint8Array([1, 2, 3]))),
      await reason(m.createPlayer(c, d.withFormatVersion(good, 99).buffer)),
      await reason(m.createPlayer(c, d.withBrokenImage(good))),
    ];
  });
  expect(errors[0]).toBe('プロジェクトファイルを展開できませんでした(壊れているか、形式が違います)');
  expect(errors[1]).toContain('このファイルは新しい版(99)で保存されています。');
  expect(errors[2]).toContain('画像を読み込めませんでした');
  await create(page, {});
  await expect.poll(async () => drawn(await snap(page))).toBe(true);
});

test('キャンバスの外に触らない(window・document の受け口、head の CSS、保存領域、親要素)', async ({ page }) => {
  await open(page);
  const look = () => page.evaluate(() => {
    const w = window as any, box = document.getElementById('box')!;
    return {
      // Vite の開発用のサーバーが付けるものは数えず、アプリのコード(/src/)と依存(/node_modules/)が付けたものだけを見る
      listeners: w.__spy.winDoc.filter((s: string) => /\/src\/|\/node_modules\//.test(s)),
      head: document.head.querySelectorAll('style, link').length,
      storage: w.__spy.storage, idb: w.__spy.idb, sw: w.__spy.sw,
      parent: [box.className, box.getAttribute('style')],
      html: [document.documentElement.getAttribute('class'), document.documentElement.getAttribute('style'), document.body.getAttribute('class'), document.body.getAttribute('style')],
    };
  });
  const before = await look();
  // 読み込み・作る・回す・ズーム・止める・大きさ・お気に入り・解放まで一通り
  await create(page, { autoSwing: true, take: true, favorites: true, background: '#202020' });
  const box = (await page.locator('#c').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) await page.mouse.move(cx + i * 30, cy);
  await page.mouse.up();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await page.evaluate(() => {
    const p = (window as any).player;
    p.pause(); p.resize(400, 300); p.setFavorite(p.info.favorites[1].id); p.play();
  });
  await frames(page);
  expect(await look()).toEqual(before);
  await page.evaluate(() => (window as any).player.dispose());
  expect(await look()).toEqual(before);
  // 外した受け口は、キャンバスの上の操作に反応しない(dispose のあとに回しても視点は動かない)
  const yaw = await read<number>(page, 'player.project.camera.yaw');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy);
  await page.mouse.up();
  expect(await read<number>(page, 'player.project.camera.yaw')).toBe(yaw);
  expect(await page.locator('#c').evaluate(c => (c as HTMLCanvasElement).style.touchAction)).toBe('');
  expect(before.listeners).toEqual([]);
});
