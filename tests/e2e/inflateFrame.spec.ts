/** E2E: 膨らませるの範囲を、枠のハンドル(辺・角・中・回す)であとから直す */
import { test, expect, type Page } from '@playwright/test';
import { boot, dragOnStage, watchGlErrors } from './helpers';

watchGlErrors();

const app = <T>(page: Page, fn: (a: any) => T): Promise<T> => page.evaluate(`(${fn.toString()})(window.popstage)`);

/** 範囲の中の位置(su・sv は -1〜1、y は上)の、ページ上の座標 */
async function framePoint(page: Page, su: number, sv: number): Promise<{ x: number; y: number }> {
  return page.evaluate(([su, sv]) => {
    const a = (window as any).popstage, s = a.inflateState, r = s.area, t = s.settings.angle * Math.PI / 180;
    const c = Math.cos(t), n = Math.sin(t), hu = su * r.w / 2, hv = sv * r.h / 2;
    const p = a.stage.imageToMainScreen(r.x + c * hu + n * hv, r.y - n * hu + c * hv);
    const box = document.getElementById('view')!.getBoundingClientRect(), m = a.stage.mainView();
    return { x: box.left + m.x + p.x, y: box.top + m.y + p.y };
  }, [su, sv]);
}

/** ページ上の from から dx・dy だけドラッグする */
async function dragBy(page: Page, from: { x: number; y: number }, dx: number, dy: number, mods: ('Shift' | 'Alt')[] = []): Promise<void> {
  await page.mouse.move(from.x, from.y);
  for (const k of mods) await page.keyboard.down(k);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
  await page.mouse.up();
  for (const k of mods) await page.keyboard.up(k);
  await page.waitForTimeout(50);
}

async function begin(page: Page): Promise<{ x: number; y: number; w: number; h: number }> {
  await boot(page);
  await app(page, a => { a.weightOp('全消去', (wm: any) => wm.clear()); a.resetView(); });
  await page.locator('#view').focus();
  await page.keyboard.press('i');
  await dragOnStage(page, [0.4, 0.35], [0.6, 0.65]);
  await expect(page.locator('#inflateDialog')).toHaveJSProperty('open', true);
  return app(page, a => ({ ...a.inflateState.area }));
}

test('膨らませる: 枠の辺・角で大きさを、中で位置を変えられ、反対側は止まったまま。適用は1手', async ({ page }) => {
  const a0 = await begin(page);
  // 枠と、角4つ・辺4つ・回す丸のハンドルが出る
  await expect(page.locator('#inflateFrame')).toBeVisible();
  await expect(page.locator('#inflateFrame .if-handle')).toHaveCount(9);

  // 右の辺を右へ: 幅だけ増え、左の辺は止まる
  await dragBy(page, await framePoint(page, 1, 0), 60, 0);
  const a1 = await app(page, a => ({ ...a.inflateState.area }));
  expect(a1.w).toBeGreaterThan(a0.w + 20);
  expect(a1.h).toBeCloseTo(a0.h, 3);
  expect(a1.x - a1.w / 2).toBeCloseTo(a0.x - a0.w / 2, 0);
  await expect(page.locator('#inflW')).toHaveValue(String(Math.round(a1.w)));

  // 左下の角を左下へ: 幅も縦も増え、右上の角は止まる
  const tr = await framePoint(page, 1, 1);
  await dragBy(page, await framePoint(page, -1, -1), -30, 30);
  const a2 = await app(page, a => ({ ...a.inflateState.area }));
  expect(a2.w).toBeGreaterThan(a1.w);
  expect(a2.h).toBeGreaterThan(a1.h);
  const tr2 = await framePoint(page, 1, 1);
  expect(Math.hypot(tr2.x - tr.x, tr2.y - tr.y)).toBeLessThan(1.5);

  // 中を掴んで動かすと、大きさはそのままで位置が変わる。膨らみも一緒に動く
  const key = () => app(page, a => { const d: Uint8Array = a.activeLayer.weights.data; let k = 0; for (let i = 0; i < d.length; i++) k += d[i] * (i % 997); return k; });
  const k0 = await key();
  await dragBy(page, await framePoint(page, 0.3, 0.3), 40, -25);
  const a3 = await app(page, a => ({ ...a.inflateState.area }));
  expect(a3.w).toBeCloseTo(a2.w, 3);
  expect(a3.h).toBeCloseTo(a2.h, 3);
  expect(a3.x).toBeGreaterThan(a2.x);
  expect(a3.y).toBeGreaterThan(a2.y); // 画像の座標は y が上向き
  await expect.poll(key).not.toBe(k0);

  // 枠を動かしている途中の Esc は、そのドラッグだけをやめて掴む前に戻す(プレビューは残る)
  const mid = await framePoint(page, 0, 0);
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x + 50, mid.y + 30, { steps: 5 });
  await expect.poll(() => app(page, a => a.inflateState.area.x)).not.toBe(a3.x);
  await page.keyboard.press('Escape');
  await page.mouse.move(mid.x + 80, mid.y + 40, { steps: 3 });
  await page.mouse.up();
  expect(await app(page, a => a.previewingInflate)).toBe(true);
  expect(await app(page, a => ({ ...a.inflateState.area }))).toEqual(a3);

  // 枠の外をドラッグすると、今までどおり描き直す
  await dragOnStage(page, [0.15, 0.15], [0.25, 0.25]);
  const a4 = await app(page, a => ({ ...a.inflateState.area }));
  expect(a4.w).toBeLessThan(a3.w);

  await page.locator('#inflApply').click();
  await expect(page.locator('#inflateFrame')).toBeHidden();
  expect(await app(page, a => a.history.undoLabel)).toMatch(/^膨らませる\(楕円 \d+×\d+px・高さ \d+px\)$/);
});

test('膨らませる: 枠の上の丸で回せ(Shift で 15° ごと)、Shift の角で縦横比を保ち、Alt の辺で中心を止める', async ({ page }) => {
  const a0 = await begin(page);

  // Shift を押して角を動かすと、縦横比が変わらない
  await dragBy(page, await framePoint(page, 1, 1), 50, -10, ['Shift']);
  const a1 = await app(page, a => ({ ...a.inflateState.area }));
  expect(a1.w).toBeGreaterThan(a0.w);
  expect(a1.w / a1.h).toBeCloseTo(a0.w / a0.h, 2);

  // Alt を押して右の辺を動かすと、中心が止まり両側へ広がる
  await dragBy(page, await framePoint(page, 1, 0), 30, 0, ['Alt']);
  const a2 = await app(page, a => ({ ...a.inflateState.area }));
  expect(a2.w).toBeGreaterThan(a1.w + 20);
  expect(a2.x).toBeCloseTo(a1.x, 3);

  // 回す丸(上の辺の中点のさらに上)を、中心のまわりで右へ回すと、時計回り(角度が正)に回る
  const top = await framePoint(page, 0, 1), c = await framePoint(page, 0, 0);
  const l = Math.hypot(top.x - c.x, top.y - c.y), rot = { x: top.x + (top.x - c.x) / l * 28, y: top.y + (top.y - c.y) / l * 28 };
  const R = Math.hypot(rot.x - c.x, rot.y - c.y);
  await page.mouse.move(rot.x, rot.y);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  // 中心のまわりに 40° ぶん回す(Shift で 15° ごとなので 45°)
  for (let i = 1; i <= 8; i++) {
    const t = -Math.PI / 2 + (40 * Math.PI / 180) * i / 8;
    await page.mouse.move(c.x + R * Math.cos(t), c.y + R * Math.sin(t));
  }
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect.poll(() => app(page, a => a.inflateState.settings.angle)).toBe(45);
  await expect(page.locator('#inflAngleN')).toHaveValue('45');
  // 回しても範囲の中心と大きさは変わらない
  expect(await app(page, a => ({ ...a.inflateState.area }))).toEqual(a2);

  await page.locator('#inflApply').click();
  expect(await app(page, a => a.history.undoLabel)).toMatch(/^膨らませる\(楕円 \d+×\d+px・45°・高さ \d+px\)$/);
});

test('形を崩す: 四隅を動かすをオンにすると角を1つずつ動かせ、大きさを変えても崩した形が残る。四角に戻す・描き直しで戻る', async ({ page }) => {
  const a0 = await begin(page);
  const warp = () => app(page, a => a.inflateState.area.warp ?? null);
  // オフの間は、角は大きさを変える
  await expect(page.locator('#inflWarpReset')).toBeDisabled();
  await page.locator('#inflCorner').check();
  // パネルの変更は次のフレームでまとめてプレビューへ当てるので、変わるのを待つ
  await expect.poll(() => app(page, a => a.inflateState.cornerEdit)).toBe(true);

  // 右下の角を内へ(左上へ)寄せる。範囲の大きさ・位置は変わらない
  const br = await framePoint(page, 1, -1);
  await dragBy(page, br, -40, -30);
  const w1 = await warp();
  expect(w1).not.toBeNull();
  expect(w1![4]).toBeLessThan(-0.1); expect(w1![5]).toBeLessThan(-0.1);
  expect(w1!.slice(0, 4).every((v: number) => v === 0)).toBe(true);
  expect(await app(page, a => { const r = a.inflateState.area; return { x: r.x, y: r.y, w: r.w, h: r.h }; })).toEqual({ x: a0.x, y: a0.y, w: a0.w, h: a0.h });
  await expect(page.locator('#inflWarpReset')).toBeEnabled();

  // 動かしている途中の Esc は、掴む前に戻す
  const br2 = await page.evaluate(() => {
    const a = (window as any).popstage, s = a.inflateState, r = s.area, w = r.warp;
    const q = a.stage.imageToMainScreen(r.x + (1 + w[4]) * r.w / 2, r.y - (1 + w[5]) * r.h / 2);
    const box = document.getElementById('view')!.getBoundingClientRect(), m = a.stage.mainView();
    return { x: box.left + m.x + q.x, y: box.top + m.y + q.y };
  });
  await page.mouse.move(br2.x, br2.y); await page.mouse.down();
  await page.mouse.move(br2.x - 20, br2.y - 20, { steps: 4 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await warp()).toEqual(w1);
  expect(await app(page, a => a.previewingInflate)).toBe(true);

  // 数値で大きさを変えても、崩した形は残る
  await page.locator('#inflW').fill(String(a0.w + 40));
  await expect.poll(() => app(page, a => a.inflateState.area.w)).toBe(a0.w + 40);
  expect(await warp()).toEqual(w1);

  // 角の丸み・辺のふくらみは矩形・カマボコで出し、楕円では隠す
  await expect(page.locator('#inflRoundRow')).toBeHidden();
  await page.locator('#inflKind').selectOption('rect');
  await expect(page.locator('#inflRoundRow')).toBeVisible();
  await page.locator('#inflRoundN').fill('50');
  await page.locator('#inflBulgeN').fill('-30');
  await expect.poll(() => app(page, a => [a.inflateState.settings.round, a.inflateState.settings.bulge])).toEqual([0.5, -0.3]);

  // 四角に戻す
  await page.locator('#inflWarpReset').click();
  await expect.poll(warp).toBeNull();
  // もう一度崩してから描き直すと、四角に戻る
  await dragBy(page, await framePoint(page, -1, 1), 30, -20);
  expect(await warp()).not.toBeNull();
  await dragOnStage(page, [0.15, 0.15], [0.3, 0.3]);
  expect(await warp()).toBeNull();

  await page.locator('#inflApply').click();
  expect(await app(page, a => a.history.undoLabel)).toMatch(/^膨らませる\(矩形 .*・崩す・高さ \d+px\)$/);
});
