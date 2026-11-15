/**
 * E2E: 埋め込み用の再生専用の部品(Player、Issue #127)。確認用のページ player.html で動かす。
 * ?e2e を付けて開き、確認用のページが自動でサンプルを読み込まないようにする(テストが自分で作る)。
 * 画素を読むため ?preserve も付ける(preserveDrawingBuffer を入れるのは確認用のページで、Player は関わらない)。
 * 中の状態(視点・物理・ループ再生)は、確認用のページの口(playerDemo.inspect。Player の入口からは出さない)で読む(window.inner)。
 */
import { test, expect, type Page } from '@playwright/test';
import { watchGlErrors, listenGlErrors } from './helpers';

watchGlErrors();

/**
 * ページを読む前に仕掛ける見張り。window・document に付いた受け口(付けた所のスタックも)、localStorage・sessionStorage・
 * IndexedDB・service worker を触った回数、requestAnimationFrame を呼んだ回数、ResizeObserver が見た要素を控える
 */
function spies(): void {
  const w = window as any;
  const spy = w.__spy = { winDoc: [] as string[], storage: 0, idb: 0, sw: 0, raf: 0, observed: [] as Element[] };
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
  const observe = ResizeObserver.prototype.observe;
  ResizeObserver.prototype.observe = function (this: ResizeObserver, target: Element, o?: ResizeObserverOptions) {
    spy.observed.push(target);
    return observe.call(this, target, o);
  };
}

const pageErrors = new WeakMap<Page, string[]>();

async function open(page: Page): Promise<void> {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', e => errors.push(e.message));
  listenGlErrors(page);
  await page.addInitScript(spies);
  await page.goto('/player.html?preserve&e2e');
  await page.waitForFunction(() => (window as any).playerDemo);
}

test.afterEach(({ page }) => { expect(pageErrors.get(page) ?? [], 'ページの例外').toEqual([]); });

interface SampleOptions { autoSwing?: boolean; take?: boolean; favorites?: boolean; background?: string | null }
interface PlayerOptions { autoplay?: boolean; interaction?: 'none' | 'view'; autoResize?: boolean }

/** サンプルのファイルを作り、確認用のページのキャンバスに Player を作る(window.player、中身は window.inner) */
async function create(page: Page, sample: SampleOptions = {}, options: PlayerOptions = {}): Promise<void> {
  await page.evaluate(async ([sample, options]) => {
    const w = window as any, d = w.playerDemo, m = await d.load();
    w.player = await m.createPlayer(d.canvas(), await d.sample(sample), options);
    w.inner = d.inspect(w.player);
  }, [sample, options] as const);
}

/** キャンバス(省くと確認用のページの #c)を小さく写した画素(RGBA) */
const snap = (page: Page, id = 'c') => page.evaluate(id => {
  const c = document.getElementById(id) as HTMLCanvasElement, t = document.createElement('canvas');
  t.width = 96; t.height = 72;
  const g = t.getContext('2d')!;
  g.drawImage(c, 0, 0, 96, 72);
  return Array.from(g.getImageData(0, 0, 96, 72).data);
}, id);
/** 絵が出ているか(透けていない画素がある) */
const drawn = (px: number[]) => px.some((v, i) => i % 4 === 3 && v > 0);
/** 2枚の違い(画素の値の差の平均) */
const diff = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

const read = <T>(page: Page, f: string) => page.evaluate(f) as Promise<T>;
const frames = (page: Page, n = 3) => page.evaluate(n => new Promise<void>(r => {
  const step = (k: number) => (k ? requestAnimationFrame(() => step(k - 1)) : r());
  step(n);
}), n);
/** 失敗した理由([code, message])。成功したら 'ok' */
type Outcome = 'ok' | [string, string];

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
  const state = () => page.evaluate(() => {
    const p = (window as any).inner, s = p.world.displacement(p.doc.layers[0].id);
    return { time: p.world.time, s: [s.x, s.y, s.z], raf: (window as any).__spy.raf };
  });
  const at = await state();
  expect(Math.hypot(...at.s)).toBeGreaterThan(1e-4); // 平らに戻していない
  const still = await snap(page);
  await page.waitForTimeout(600); // 何も起きないことを確かめるので、時間で待つ
  expect(await state()).toEqual(at);
  expect(diff(still, await snap(page))).toBe(0);
  // 続ける: 止めた所から進む(初めからやり直さず、揺れを平らに戻さない)。
  // play() の直後のフレームは止めていた間の時間を進めない(dt = 0)ので、揺れは止めたときの値のまま
  const first = await page.evaluate(() => new Promise<{ time: number; s: number[] }>(r => {
    const p = (window as any).inner;
    (window as any).player.play();
    // Player の最初のフレームの後に呼ばれる(同じフレームで先に予約されている)
    requestAnimationFrame(() => {
      const s = p.world.displacement(p.doc.layers[0].id);
      r({ time: p.world.time, s: [s.x, s.y, s.z] });
    });
  }));
  expect(await read<boolean>(page, 'player.playing')).toBe(true);
  expect(first.time).toBe(at.time);
  for (let i = 0; i < 3; i++) expect(first.s[i]).toBeCloseTo(at.s[i], 6);
  await expect.poll(() => read<number>(page, 'inner.world.time')).toBeGreaterThan(at.time + 0.1);
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
  expect(await read<number>(page, 'inner.world.time')).toBe(0);
  await page.evaluate(() => (window as any).player.play());
  await expect.poll(() => read<number>(page, 'inner.world.time')).toBeGreaterThan(0.1);
});

test('自動で揺らすが切れていて記録も無いファイルは、再生しても止まった絵のまま(playing は true のまま)', async ({ page }) => {
  await open(page);
  await create(page, { autoSwing: false });
  // 重さでわずかに沈むので、揺れが落ち着いたあとは動かないことを見る
  const at = () => page.evaluate(() => { const p = (window as any).inner, s = p.world.displacement(p.doc.layers[0].id); return { t: p.world.time, s: [s.x, s.y, s.z] }; });
  await expect.poll(() => read<number>(page, 'inner.world.time')).toBeGreaterThan(2);
  const a = await at();
  await expect.poll(() => read<number>(page, 'inner.world.time')).toBeGreaterThan(a.t + 1);
  const b = await at();
  for (let i = 0; i < 3; i++) expect(Math.abs(b.s[i] - a.s[i])).toBeLessThan(1e-4);
  expect(await read<boolean>(page, 'inner.project.autoSwing.enabled')).toBe(false);
  expect(await read<boolean>(page, 'player.playing')).toBe(true);
});

test('返すオブジェクトは API だけで、中身に触れない。info は変わるまで同じ凍結したオブジェクト', async ({ page }) => {
  await open(page);
  await create(page, { take: true, favorites: true });
  const r = await page.evaluate(() => {
    const p = (window as any).player, i1 = p.info, i2 = p.info;
    const keys = Object.keys(p).sort();
    const names = Object.getOwnPropertyNames(p).sort();
    const frozen = [Object.isFrozen(p), Object.isFrozen(i1), Object.isFrozen(i1.favorites), Object.isFrozen(i1.favorites[0])];
    p.setFavorite(i1.favorites[1].id);
    const i3 = p.info;
    return { keys, names, same: i1 === i2, frozen, changed: i3 !== i1, sameAfter: i3 === p.info, take: [i1.takeSeconds > 1, i3.takeSeconds] };
  });
  const api = ['dispose', 'info', 'pause', 'play', 'playing', 'resize', 'setFavorite'];
  expect(r.keys).toEqual(api);
  expect(r.names).toEqual(api);
  expect(r).toMatchObject({ same: true, frozen: [true, true, true, true], changed: true, sameAfter: true, take: [true, 0] });
});

test('記録のあるファイルはループ再生し、お気に入りで揺れと動きを切り替えられる', async ({ page }) => {
  await open(page);
  await create(page, { autoSwing: false, take: true, favorites: true });
  const info = await read<{ takeSeconds: number; favorites: { id: string; name: string }[] }>(page, 'player.info');
  expect(info.takeSeconds).toBeGreaterThan(1);
  expect(info.favorites.map(f => f.name)).toEqual(['大きく', '静か']);
  // ループ再生: 記録の位置が進む
  expect(await read<boolean>(page, 'inner.loop.playing')).toBe(true);
  await expect.poll(() => read<number>(page, 'inner.loop.position')).toBeGreaterThan(0.3);
  // 知らない id は何もしない
  expect(await page.evaluate(() => (window as any).player.setFavorite('nope'))).toBe(false);
  // 「静か」: 自動揺らしを切り、記録無し、視点を右へ
  const [big, calm] = info.favorites;
  expect(await page.evaluate(id => (window as any).player.setFavorite(id), calm.id)).toBe(true);
  expect(await page.evaluate(() => {
    const w = window as any, p = w.inner;
    return { loop: p.loop.playing, auto: p.project.autoSwing.enabled, yaw: p.project.camera.yaw, take: w.player.info.takeSeconds };
  })).toEqual({ loop: false, auto: false, yaw: 0.7, take: 0 });
  // 「大きく」: ポップ量・自動揺らしが変わり、記録を再生していたのでループ再生を始める
  expect(await page.evaluate(id => (window as any).player.setFavorite(id), big.id)).toBe(true);
  expect(await page.evaluate(() => {
    const w = window as any, p = w.inner;
    return { loop: p.loop.playing, pop: p.doc.layers[0].pop, period: p.project.autoSwing.period, take: w.player.info.takeSeconds > 1 };
  })).toEqual({ loop: true, pop: 600, period: 0.8, take: true });
  await expect.poll(() => read<number>(page, 'inner.loop.position')).toBeGreaterThan(0.3);
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
  const yaw = () => read<number>(page, 'inner.project.camera.yaw');
  // 左ドラッグ: キャンバスの外まで引いても追う
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 40, cy + i * 5);
  await page.mouse.up();
  const y1 = await yaw();
  expect(y1).toBeLessThan(-0.5); // 右へ引くと yaw が減る(編集アプリと同じ向き)
  expect(await read<number>(page, 'inner.project.camera.pitch')).toBeGreaterThan(0);
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
  const zoom = () => read<number>(page, 'inner.project.camera.zoom');
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
  // その場で変わる(なめらかに寄せない)
  await expect.poll(() => read<number>(page, '__wheel.length')).toBe(2);
  expect(await zoom()).toBeCloseTo(z0 * Math.exp(-300 * 0.0012), 6);
  expect((await read<boolean[]>(page, '__wheel')).at(-1)).toBe(true);
  expect(await read<number>(page, 'scrollY')).toBe(0);
  // 止めている間に回しても描き直す(物理は進めない)
  await page.evaluate(() => (window as any).player.pause());
  const t = await read<number>(page, 'inner.world.time'), before = await snap(page);
  await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(b2.x + b2.width / 2 - i * 30, b2.y + b2.height / 2);
  await page.mouse.up();
  await expect.poll(async () => diff(before, await snap(page))).toBeGreaterThan(0.5);
  expect(await read<number>(page, 'inner.world.time')).toBe(t);
});

test('interaction: view: 視点を回した勢いで揺れる(編集アプリと同じ物理)', async ({ page }) => {
  await open(page);
  await create(page, { autoSwing: false });
  const box = (await page.locator('#c').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.evaluate(() => {
    const w = window as any, p = w.inner;
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
    const yaw0 = await read<number>(page, 'inner.project.camera.yaw');
    await touch('touchStart', [[cx, cy]]);
    for (let i = 1; i <= 6; i++) await touch('touchMove', [[cx + i * 20, cy]]);
    await touch('touchEnd', []);
    await expect.poll(() => read<number>(page, 'inner.project.camera.yaw')).toBeLessThan(yaw0 - 0.3);
    const z0 = await read<number>(page, 'inner.project.camera.zoom');
    await touch('touchStart', [[cx - 40, cy], [cx + 40, cy]]);
    for (let i = 1; i <= 6; i++) await touch('touchMove', [[cx - 40 - i * 15, cy], [cx + 40 + i * 15, cy]]);
    await touch('touchEnd', []);
    await expect.poll(() => read<number>(page, 'inner.project.camera.zoom')).toBeLessThan(z0 * 0.6);
  });
});

test('interaction: none なら、ドラッグもホイールも受けない', async ({ page }) => {
  await open(page);
  await create(page, { autoSwing: false }, { interaction: 'none' });
  expect(await page.locator('#c').evaluate(c => (c as HTMLCanvasElement).style.touchAction)).toBe('');
  const box = (await page.locator('#c').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const cam = () => page.evaluate(() => { const c = (window as any).inner.project.camera; return [c.yaw, c.pitch, c.zoom]; });
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

/** キャンバスの CSS の大きさ・描画バッファの大きさ・倍率・style 属性 */
const sizeOf = (page: Page, id = 'c') => page.evaluate(id => {
  const c = document.getElementById(id) as HTMLCanvasElement;
  return { css: [c.clientWidth, c.clientHeight], buf: [c.width, c.height], dpr: Math.min(devicePixelRatio, 2), style: [c.style.width, c.style.height] };
}, id);
const bufferFits = (s: Awaited<ReturnType<typeof sizeOf>>) => s.buf[0] === Math.floor(s.css[0] * s.dpr) && s.buf[1] === Math.floor(s.css[1] * s.dpr);

test('大きさは自動で追い、止めているときも描き直す。CSS の大きさは書かない', async ({ page }) => {
  await open(page);
  await create(page, { autoSwing: true, background: '#336699' });
  await page.evaluate(() => (window as any).player.pause());
  expect(bufferFits(await sizeOf(page))).toBe(true);
  // 背景色は WebGL の消去の色で塗る(角は画像の外なので背景色)
  await expect.poll(async () => (await snap(page)).slice(0, 4)).toEqual([0x33, 0x66, 0x99, 255]);
  await page.locator('#c').evaluate(c => { (c as HTMLCanvasElement).style.width = '300px'; });
  await expect.poll(async () => { const s = await sizeOf(page); return [s.css[0], bufferFits(s)]; }).toEqual([300, true]);
  // 止めていても1回描き直す(大きさを変えると描画バッファが消えるので、描き直さなければ透けたままになる)
  await expect.poll(async () => drawn(await snap(page))).toBe(true);
  // CSS の大きさは書かない(埋め込み先が書いた style のまま)
  expect((await sizeOf(page)).style).toEqual(['300px', '']);
  // resize() は測り直すだけ(引数を取らない)
  await page.evaluate(() => (window as any).player.resize());
  expect((await sizeOf(page)).style).toEqual(['300px', '']);
});

/** 確認用のページの #box の外(#box の canvas に付く CSS が効かない所)にキャンバスを作り、Player を作る */
const createOutside = (page: Page, id: string, css: string, wrap = false) => page.evaluate(async ([id, css, wrap]) => {
  const w = window as any, d = w.playerDemo, m = await d.load();
  const c = document.createElement('canvas');
  c.id = id;
  if (css) c.style.cssText = css;
  if (wrap) {
    const div = document.createElement('div');
    div.id = id + '-wrap';
    div.append(c);
    document.getElementById('box')!.after(div);
  } else document.getElementById('box')!.after(c);
  w.player = await m.createPlayer(c, await d.sample({ autoSwing: true }));
  w.inner = d.inspect(w.player);
}, [id, css, wrap] as const);

for (const [scale, css, label] of [[2, '', 'CSS を何も書かない'], [0.9, 'max-width:100%', 'max-width だけの']] as const) {
  test.describe(`画面の倍率が ${scale}`, () => {
    test.use({ deviceScaleFactor: scale });

    test(`${label}キャンバス(大きさが属性で決まる)でも、大きさが変わり続けない(高精細では描かない)`, async ({ page }) => {
      await open(page);
      await createOutside(page, 'attr', css);
      expect(await read<number>(page, 'devicePixelRatio')).toBeCloseTo(scale, 5);
      // 何回か通知とフレームが回っても、CSS の大きさは属性の既定(300×150)のまま、描画バッファも同じ大きさで止まる
      for (let i = 0; i < 4; i++) {
        await frames(page, 4);
        expect(await sizeOf(page, 'attr')).toMatchObject({ css: [300, 150], buf: [300, 150], style: ['', ''] });
      }
      // 測り直しても変わらない
      await page.evaluate(() => (window as any).player.resize());
      await frames(page, 4);
      expect((await sizeOf(page, 'attr')).buf).toEqual([300, 150]);
      await expect.poll(async () => drawn(await snap(page, 'attr'))).toBe(true);
    });
  });
}

test.describe('画面の倍率が 2(CSS で大きさを決めたキャンバス)', () => {
  test.use({ deviceScaleFactor: 2 });

  test('幅と aspect-ratio を CSS で決めたキャンバスは、倍率を掛けた高精細で描く', async ({ page }) => {
    await open(page);
    await create(page, { autoSwing: true });
    await expect.poll(async () => { const s = await sizeOf(page); return [s.dpr, bufferFits(s), s.buf[0] > s.css[0]]; }).toEqual([2, true, true]);
  });

  test('幅だけ CSS で決めたキャンバスも、倍率を掛けて描き、大きさは変わり続けない', async ({ page }) => {
    await open(page);
    await createOutside(page, 'wonly', 'width:100%;display:block', true);
    await page.locator('#wonly-wrap').evaluate(d => { (d as HTMLElement).style.width = '400px'; });
    await expect.poll(async () => { const s = await sizeOf(page, 'wonly'); return [s.css[0], s.buf[0]]; }).toEqual([400, 800]);
    const s = await sizeOf(page, 'wonly');
    expect(Math.abs(s.css[1] - 200)).toBeLessThanOrEqual(1);
    await frames(page, 8);
    expect(await sizeOf(page, 'wonly')).toEqual(s);
  });
});

test('幅だけ CSS で決め高さを属性に任せたキャンバスで幅を変えても、window に ResizeObserver のエラーを出さない', async ({ page }) => {
  await open(page);
  // 控えるのはテストのページの側(Player は window に受け口を付けない)
  await page.evaluate(() => {
    const w = window as any;
    w.__winErrors = [];
    window.addEventListener('error', e => w.__winErrors.push(e.message));
  });
  await createOutside(page, 'wonly', 'width:100%;display:block', true);
  for (const width of ['333px', '517.3px', '401.7px', '250.5px', '612px']) {
    await page.locator('#wonly-wrap').evaluate((d, width) => { (d as HTMLElement).style.width = width; }, width);
    await frames(page, 4);
  }
  await expect.poll(async () => { const s = await sizeOf(page, 'wonly'); return [s.css[0], bufferFits(s)]; }).toEqual([612, true]);
  expect(await read<string[]>(page, '__winErrors')).toEqual([]);
  await expect.poll(async () => drawn(await snap(page, 'wonly'))).toBe(true);
});

test('autoResize: false なら追わず、resize() で測り直す', async ({ page }) => {
  await open(page);
  await create(page, { autoSwing: false }, { autoResize: false });
  expect(await read<number>(page, '__spy.observed.length')).toBe(0);
  const s0 = await sizeOf(page);
  await page.locator('#c').evaluate(c => { (c as HTMLCanvasElement).style.width = '200px'; });
  await frames(page, 5);
  expect((await sizeOf(page)).buf).toEqual(s0.buf);
  await page.evaluate(() => (window as any).player.resize());
  const s1 = await sizeOf(page);
  expect([s1.css[0], bufferFits(s1)]).toEqual([200, true]);
  await expect.poll(async () => drawn(await snap(page))).toBe(true);
});

test('大きさ 0(display: none)で作っても、あとから大きさが付くと正しい大きさで絵が出る', async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    const w = window as any, d = w.playerDemo, m = await d.load();
    const c = document.createElement('canvas');
    c.id = 'zero';
    c.style.cssText = 'display:none;width:320px;height:180px';
    document.getElementById('box')!.append(c);
    w.player = await m.createPlayer(c, await d.sample({ autoSwing: true }));
    w.inner = d.inspect(w.player);
  });
  expect((await sizeOf(page, 'zero')).css).toEqual([0, 0]);
  await frames(page);
  await page.locator('#zero').evaluate(c => { (c as HTMLCanvasElement).style.display = 'block'; });
  await expect.poll(async () => { const s = await sizeOf(page, 'zero'); return [s.css, bufferFits(s)]; }).toEqual([[320, 180], true]);
  await expect.poll(async () => drawn(await snap(page, 'zero'))).toBe(true);
});

test('新しいキャンバスなら、読み込み → 再生 → dispose を 20 回くり返してもコンテキストが尽きない', async ({ page }) => {
  test.setTimeout(180_000);
  const warnings: string[] = [];
  page.on('console', m => { if (/Too many active WebGL contexts/i.test(m.text())) warnings.push(m.text()); });
  await open(page);
  const result = await page.evaluate(async () => {
    const w = window as any, d = w.playerDemo, m = await d.load(), bytes = await d.sample({ autoSwing: true });
    const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const box = document.getElementById('box')!;
    // 埋め込み先が送るたびにキャンバスを作り直す
    for (let i = 0; i < 20; i++) {
      const c = document.createElement('canvas');
      c.style.cssText = 'width:160px;height:120px';
      box.append(c);
      const p = await m.createPlayer(c, bytes);
      await frame();
      p.dispose();
      p.dispose(); // 2回呼んでも何もしない
      p.play(); p.pause(); p.resize(); // dispose のあとは何もしない
      if (p.setFavorite('x') !== false) throw new Error('dispose のあとの setFavorite');
      if (p.playing !== false) throw new Error('dispose のあとの playing');
      c.remove();
    }
    w.player = await m.createPlayer(d.canvas(), bytes);
    w.inner = d.inspect(w.player);
    await frame();
    return true;
  });
  expect(result).toBe(true);
  await expect.poll(async () => drawn(await snap(page))).toBe(true);
  expect(await read<boolean>(page, 'inner.stage.renderer.getContext().isContextLost()')).toBe(false);
  expect(warnings).toEqual([]);
});

test('dispose() したキャンバスで作ると、canvas-unusable で断られる(新しいキャンバスなら作れる)', async ({ page }) => {
  await open(page);
  const r = await page.evaluate(async () => {
    const d = (window as any).playerDemo, m = await d.load(), bytes = await d.sample({}), c = d.canvas();
    const outcome = (p: Promise<{ dispose(): void }>) => p.then(x => { x.dispose(); return 'ok'; }, (e: any) => [e instanceof m.PlayerError, e.code, e.message]);
    const p = await m.createPlayer(c, bytes);
    p.dispose();
    const again = await outcome(m.createPlayer(c, bytes));
    const twice = await outcome(m.createPlayer(c, bytes)); // 断ったあとも印は残らない(理由は同じ)
    const fresh = document.createElement('canvas');
    fresh.style.cssText = 'width:160px;height:120px';
    document.body.append(fresh);
    return { again, twice, fresh: await outcome(m.createPlayer(fresh, bytes)) };
  });
  const lost = [true, 'canvas-unusable', 'このキャンバスはもう使えません。新しい canvas を渡してください。'];
  expect(r).toEqual({ again: lost, twice: lost, fresh: 'ok' });
});

test('同じキャンバスで2つ同時に createPlayer を呼ぶと、2つ目は canvas-unusable で断られ、1つ目はふつうに絵が出る', async ({ page }) => {
  await open(page);
  const second = await page.evaluate(async () => {
    const w = window as any, d = w.playerDemo, m = await d.load(), bytes = await d.sample({ autoSwing: true }), c = d.canvas();
    const a = m.createPlayer(c, bytes), b = m.createPlayer(c, bytes);
    const r = await b.then(() => 'ok', (e: any) => [e.code, e.message]);
    w.player = await a;
    w.inner = d.inspect(w.player);
    // 生きている間に呼んでも断る
    const live = await m.createPlayer(c, bytes).then(() => 'ok', (e: any) => e.code);
    return [r, live];
  });
  expect(second).toEqual([['canvas-unusable', 'このキャンバスはほかの Player が使っています。先に dispose() するか、新しい canvas を渡してください。'], 'canvas-unusable']);
  await expect.poll(async () => drawn(await snap(page))).toBe(true);
  const a = await snap(page);
  await expect.poll(async () => diff(a, await snap(page))).toBeGreaterThan(0.5); // 動き続けている
  expect(await read<boolean>(page, 'inner.stage.renderer.getContext().isContextLost()')).toBe(false);
});

test('React の StrictMode の手順(作る → すぐ取り消す → 同じキャンバスで作る)で、1つ目は aborted、2つ目は絵が出る', async ({ page }) => {
  await open(page);
  const first = await page.evaluate(async () => {
    const w = window as any, d = w.playerDemo, m = await d.load(), bytes = await d.sample({ autoSwing: true }), c = d.canvas();
    const ac = new AbortController();
    const a = m.createPlayer(c, bytes, { signal: ac.signal });
    ac.abort();
    const b = m.createPlayer(c, bytes);
    const r = await a.then(() => 'ok', (e: any) => [e instanceof m.PlayerError, e.code]);
    w.player = await b;
    w.inner = d.inspect(w.player);
    return r;
  });
  expect(first).toEqual([true, 'aborted']);
  await expect.poll(async () => drawn(await snap(page))).toBe(true);
  expect(await read<boolean>(page, 'player.playing')).toBe(true);
});

test('失敗は code 付き: 壊れたファイル・新しい版・画像が壊れたファイル・取り消し・WebGL2 が無い・2D で使われたキャンバス。読み込みの失敗ではキャンバスは使えるまま', async ({ page }) => {
  await open(page);
  const result = await page.evaluate(async () => {
    const d = (window as any).playerDemo, m = await d.load(), c = d.canvas(), good = await d.sample({});
    const reason = (p: Promise<{ dispose(): void }>) => p.then(x => { x.dispose(); return 'ok'; }, (e: any) => (e instanceof m.PlayerError ? [e.code, e.message] : ['?', String(e)]));
    const ac = new AbortController(), during = m.createPlayer(c, good, { signal: ac.signal });
    await Promise.resolve();
    ac.abort();
    const before = new AbortController();
    before.abort();
    // WebGL2 を作れない環境の代わり。プロトタイプで差し替えるので、Player が確かめに作る使い捨ての canvas でも null になる
    // (読み込み・デコードが済んで Stage を作る所でだけ差し替え、すぐ戻す)
    const noGl = async () => {
      const proto = HTMLCanvasElement.prototype as any, get = proto.getContext, probes: string[] = [];
      proto.getContext = function (this: HTMLCanvasElement, type: string, ...a: unknown[]) {
        if (type === 'webgl2') { probes.push(this.isConnected ? 'canvas' : 'probe'); return null; }
        return get.call(this, type, ...a);
      };
      const fresh = document.createElement('canvas');
      fresh.style.cssText = 'width:160px;height:120px';
      document.body.append(fresh);
      try { return [await reason(m.createPlayer(fresh, good)), probes] as const; } finally { proto.getContext = get; fresh.remove(); }
    };
    // 2D の描画で使われているキャンバス(getContext('webgl2') は例外を投げずに null を返す)
    const used2d = document.createElement('canvas');
    used2d.style.cssText = 'width:160px;height:120px';
    document.body.append(used2d);
    used2d.getContext('2d');
    const r = [
      await reason(m.createPlayer(c, new Uint8Array([1, 2, 3]))),
      await reason(m.createPlayer(c, d.withFormatVersion(good, 99).buffer)),
      await reason(m.createPlayer(c, d.withBrokenImage(good))),
      await reason(during),
      await reason(m.createPlayer(c, good, { signal: before.signal })),
    ] as Outcome[];
    const [unavailable, probes] = await noGl();
    return { r, unavailable, probes, used2d: await reason(m.createPlayer(used2d, good)) };
  });
  const { r: outcomes } = result;
  expect(outcomes[0]).toEqual(['invalid-file', 'プロジェクトファイルを展開できませんでした(壊れているか、形式が違います)']);
  expect(outcomes[1][0]).toBe('unsupported-version');
  expect(outcomes[1][1]).toContain('このファイルは新しい版(99)で保存されています。');
  expect(outcomes[2][0]).toBe('invalid-file');
  expect(outcomes[2][1]).toContain('画像を読み込めませんでした');
  expect(outcomes[3]).toEqual(['aborted', '読み込みを取り消しました']);
  expect(outcomes[4]).toEqual(['aborted', '読み込みを取り消しました']);
  expect(result.unavailable).toEqual(['webgl-unavailable', 'WebGL2 を使えないため、表示できません。']);
  // three.js が渡したキャンバスで試したあと、使い捨ての canvas(文書につないでいない)でも確かめている
  expect(result.probes.at(-1)).toBe('probe');
  expect(result.probes).toContain('canvas');
  expect(result.used2d).toEqual(['canvas-unusable', 'このキャンバスはほかの用途(2D の描画など)で使われています。新しい canvas を渡してください。']);
  // 失敗・取り消しのあとも、同じキャンバスで作れる(WebGL を作る前に失敗しているので)
  await create(page, {});
  await expect.poll(async () => drawn(await snap(page))).toBe(true);
});

test('コンテキストが失われている間に dispose() しても、例外も警告も出さずに片付く', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', m => { if (m.type() === 'warning' || m.type() === 'error') logs.push(m.text()); });
  await open(page);
  await create(page, { autoSwing: true });
  await page.evaluate(() => (window as any).inner.stage.renderer.getContext().getExtension('WEBGL_lose_context').loseContext());
  await expect.poll(() => read<boolean>(page, 'inner.stage.contextLost')).toBe(true);
  await page.evaluate(() => (window as any).player.dispose());
  await frames(page);
  expect(await read<boolean>(page, 'player.playing')).toBe(false);
  expect(logs.filter(l => /THREE|WebGL/i.test(l) && !/CONTEXT_LOST_WEBGL|context lost/i.test(l))).toEqual([]);
});

test('キャンバスの外に触らない(window・document の受け口と on* プロパティ、head の CSS、保存領域、親要素、ResizeObserver)', async ({ page }) => {
  await open(page);
  const look = () => page.evaluate(() => {
    const w = window as any, box = document.getElementById('box')!;
    const handlers = (o: any) => { const out: string[] = []; for (const k in o) if (k.startsWith('on') && o[k] != null) out.push(k); return out.sort(); };
    return {
      // Vite の開発用のサーバーが付けるものは数えず、アプリのコード(/src/)と依存(/node_modules/)が付けたものだけを見る
      listeners: w.__spy.winDoc.filter((s: string) => /\/src\/|\/node_modules\//.test(s)),
      handlers: [handlers(window), handlers(document), handlers(document.body)],
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
  await page.locator('#c').evaluate(c => { (c as HTMLCanvasElement).style.width = '400px'; });
  await page.evaluate(() => {
    const p = (window as any).player;
    p.pause(); p.resize(); p.setFavorite(p.info.favorites[1].id); p.play();
  });
  await frames(page);
  expect(await look()).toEqual(before);
  // ResizeObserver が見ているのはキャンバスだけ
  expect(await page.evaluate(() => (window as any).__spy.observed.map((e: Element) => e === document.getElementById('c')))).toEqual([true]);
  await page.evaluate(() => (window as any).player.dispose());
  expect(await look()).toEqual(before);
  // 外した受け口は、キャンバスの上の操作に反応しない(dispose のあとに回しても視点は動かない)
  const yaw = await read<number>(page, 'inner.project.camera.yaw');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 100, cy);
  await page.mouse.up();
  expect(await read<number>(page, 'inner.project.camera.yaw')).toBe(yaw);
  expect(await page.locator('#c').evaluate(c => (c as HTMLCanvasElement).style.touchAction)).toBe('');
  expect(before.listeners).toEqual([]);
});

test('確認用のページ: 開くとサンプルを再生し、ボタンで止める・お気に入り・作り直し(新しいキャンバス)ができる', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  pageErrors.set(page, errors);
  listenGlErrors(page);
  await page.goto('/player.html?preserve');
  await expect(page.locator('#state')).toContainText('playing: true');
  await expect(page.locator('#state')).toContainText('お気に入り 2');
  await expect.poll(async () => drawn(await snap(page))).toBe(true);
  await page.locator('#play').click();
  await expect(page.locator('#play')).toHaveText('再生');
  await expect(page.locator('#state')).toContainText('playing: false');
  await page.locator('#favorites button', { hasText: '静か' }).click();
  await expect(page.locator('#favorites button', { hasText: '静か' })).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => { (window as any).__old = document.getElementById('c'); });
  await page.locator('#rebuild').click();
  await expect(page.locator('#state')).toContainText('playing: true');
  expect(await page.evaluate(() => (window as any).__old !== document.getElementById('c') && !(window as any).__old.isConnected)).toBe(true);
  await expect.poll(async () => drawn(await snap(page))).toBe(true);
  // 読めないファイルは code と message を出す
  await page.locator('#file').evaluate(input => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([1, 2, 3])], 'broken.pukupop'));
    (input as HTMLInputElement).files = dt.files;
    input.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#error')).toHaveText('invalid-file: プロジェクトファイルを展開できませんでした(壊れているか、形式が違います)');
});
