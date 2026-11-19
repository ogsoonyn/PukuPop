/** E2E: 揺れ(つかむ・揺らす・平行移動・回転・ズーム・プリセット・揺らし方) */
import { test, expect } from '@playwright/test';
import { watchGlErrors, boot, openTab, watchSwingX, nextFrames } from './helpers';

watchGlErrors();

test('つかんでドラッグすると揺れる', async ({ page }) => {
  await boot(page);
  await page.keyboard.press('p'); // 一時停止を解除
  await page.evaluate(() => { const a = (window as any).popstage; a.store.patchProject({ autoSwing: { ...a.project.autoSwing, enabled: false } }); });
  await page.keyboard.press('g');
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.45, { steps: 8 });
  await page.waitForTimeout(400);
  const during = await page.evaluate(() => { const a = (window as any).popstage; return a.world.displacement(a.doc.layers[0].id).x; });
  await page.mouse.up();
  expect(during).toBeGreaterThan(0.01);
});

// @local: 描画が 0.1 秒より遅いと視点の飛びとみなして揺らさないので、GPU の無いクラウド環境では流さない(playwright.config.ts)
test('中ドラッグで平行移動すると揺れ、視点のリセットでは揺れない', { tag: '@local' }, async ({ page }) => {
  await boot(page);
  await page.keyboard.press('p'); // 一時停止を解除
  await page.evaluate(() => { const a = (window as any).popstage; a.store.patchProject({ autoSwing: { ...a.project.autoSwing, enabled: false } }); });
  await page.waitForTimeout(1500); // 重さで垂れた所で落ち着かせる
  const box = (await page.locator('#view').boundingBox())!;
  const watching = watchSwingX(page, 1200);
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up({ button: 'middle' });
  const [lo, hi, first] = await watching;
  expect(await page.evaluate(() => (window as any).popstage.project.camera.target.x)).toBeLessThan(0);
  // 画像は右へ動くので、塗った部分は左へ遅れ、止めた所で右へ振れ返す
  expect(first).toBe(-1);
  expect(lo).toBeLessThan(-0.01);
  expect(hi).toBeGreaterThan(0.01);

  await page.waitForTimeout(3000); // 収まるのを待つ
  const still = watchSwingX(page, 800);
  const before = await page.evaluate(() => { const a = (window as any).popstage; return a.world.displacement(a.doc.layers[0].id).x; });
  await page.keyboard.press('Home');
  const [lo2, hi2] = await still;
  expect(await page.evaluate(() => (window as any).popstage.project.camera.target.x)).toBe(0);
  expect(Math.max(Math.abs(lo2 - before), Math.abs(hi2 - before))).toBeLessThan(0.005);
});

// @local: 上と同じ理由で、クラウド環境では流さない
test('右ドラッグで回しても、ホイールでズームしても揺れる', { tag: '@local' }, async ({ page }) => {
  await boot(page);
  await page.keyboard.press('p'); // 一時停止を解除
  await page.evaluate(() => { const a = (window as any).popstage; a.store.patchProject({ autoSwing: { ...a.project.autoSwing, enabled: false } }); });
  await page.waitForTimeout(1500); // 重さで垂れた所で落ち着かせる
  /** ms ミリ秒の間の、先頭レイヤーの揺れの、測り始めからの変化の最大(成分ごと) */
  const watch = (ms: number) => page.evaluate(ms => new Promise<{ x: number; y: number; z: number }>(resolve => {
    const a = (window as any).popstage, t0 = performance.now(), d = () => a.world.displacement(a.doc.layers[0].id);
    const s0 = { ...d() }, m = { x: 0, y: 0, z: 0 };
    const tick = () => {
      const s = d();
      m.x = Math.max(m.x, Math.abs(s.x - s0.x)); m.y = Math.max(m.y, Math.abs(s.y - s0.y)); m.z = Math.max(m.z, Math.abs(s.z - s0.z));
      if (performance.now() - t0 < ms) requestAnimationFrame(tick); else resolve(m);
    };
    tick();
  }), ms);
  const box = (await page.locator('#view').boundingBox())!;
  // 左右に回す
  const rotating = watch(1200);
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.down({ button: 'right' });
  // 描画が重いと、一度に動かした分がフレームの間に収まらず視点の飛びとみなされるので、フレームごとに少しずつ回す
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(box.x + box.width * (0.4 + 0.025 * i), box.y + box.height * 0.5);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
  }
  await page.mouse.up({ button: 'right' });
  expect((await rotating).x).toBeGreaterThan(0.01);

  await page.waitForTimeout(3000); // 収まるのを待つ
  // ホイールで寄る
  const zooming = watch(1200);
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  // 回転と同じく、描画が重くても視点の飛びとみなされないよう、フレームごとに少しずつ回す
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -200);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(r)));
  }
  expect((await zooming).z).toBeGreaterThan(0.01);
});

// @local: 揺らすは視点の注視点をずらして揺らすので、平行移動と同じく描画が遅いと揺れない。クラウド環境では流さない
test('「揺らす」ツール: 左ドラッグで画像は動かずに揺れ、視点も「未保存」も変わらない', { tag: '@local' }, async ({ page }) => {
  await boot(page);
  await page.keyboard.press('p'); // 一時停止を解除
  await page.evaluate(() => { const a = (window as any).popstage; a.store.patchProject({ autoSwing: { ...a.project.autoSwing, enabled: false } }); });
  await page.waitForTimeout(1500);
  await page.keyboard.press('y');
  expect(await page.evaluate(() => (window as any).popstage.tool)).toBe('shake');
  // 自動揺らしを切った分の「未保存」を消してから試す
  const cam0 = await page.evaluate(() => { const a = (window as any).popstage; a.dirty = false; return JSON.stringify(a.project.camera); });
  const box = (await page.locator('#view').boundingBox())!;
  const watching = watchSwingX(page, 1200);
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();
  const [lo, hi, first] = await watching;
  // 中ドラッグで右へ動かしたときと同じく、塗った部分は左へ遅れてから振れ返す
  expect(first).toBe(-1);
  expect(lo).toBeLessThan(-0.01);
  expect(hi).toBeGreaterThan(0.01);
  const after = await page.evaluate(() => { const a = (window as any).popstage; return { cam: JSON.stringify(a.project.camera), shakeX: a.shake.x, dirty: a.dirty }; });
  expect(after.cam).toBe(cam0); // カメラは画像に付いたまま(画面上の位置は変わらない)
  expect(after.shakeX).toBeLessThan(0);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).popstage.dirty)).toBe(false);
  // 「揺らす」でも Space+左ドラッグは平行移動
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  expect(await page.evaluate(() => (window as any).popstage.project.camera.target.x)).toBeGreaterThan(0);
  await page.keyboard.press('Home');
  // 中ドラッグは従来どおり画像を動かす
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 4 });
  await page.mouse.up({ button: 'middle' });
  expect(await page.evaluate(() => (window as any).popstage.project.camera.target.x)).toBeLessThan(0);
});

test('プリセットで材質・揺らし方・周期が変わり、1手で元に戻せる', async ({ page }) => {
  await boot(page);
  await openTab(page, 'layer');
  const state = () => page.evaluate(() => {
    const a = (window as any).popstage;
    return { preset: a.activeLayer.physics.preset, motion: a.activeLayer.physics.motion, hardness: a.activeLayer.physics.hardness, period: a.project.autoSwing.period };
  });
  const before = await state();
  expect(before).toMatchObject({ preset: 'puru', motion: 'jiggle' });
  await expect(page.locator('#pPreset option')).toHaveCount(16); // 15 種類 + カスタム

  await page.selectOption('#pPreset', 'bain');
  expect(await state()).toEqual({ preset: 'bain', motion: 'jump', hardness: 0.25, period: 1.8 });
  await expect(page.locator('#pHardO')).toHaveText('25');
  await expect(page.locator('#pMotion')).toHaveValue('jump');
  await expect(page.locator('#pPresetDesc')).toContainText('ジャンプ');
  await expect(page.locator('#pPeriodO')).toHaveText('1.8秒');

  await page.locator('#view').focus();
  await page.keyboard.press('Control+z');
  expect(await state()).toEqual(before);

  // 揺らし方は詳細設定の中にあり、変えるとカスタムになる
  await expect(page.locator('#pMotion')).toBeHidden();
  await page.locator('#physDetails summary').click();
  await page.selectOption('#pMotion', 'heartbeat');
  await expect(page.locator('#physSummary')).toContainText('鼓動');
  expect(await state()).toMatchObject({ preset: 'custom', motion: 'heartbeat', hardness: before.hardness });
});

test('揺らし方の固有設定: 選んだ揺らし方の項目が出て、変えると1手で戻せる', async ({ page }) => {
  await boot(page);
  await openTab(page, 'layer');
  const params = () => page.evaluate(() => { const p = (window as any).popstage.activeLayer.physics; return { preset: p.preset, mp: p.motionParams }; });
  await page.locator('#physDetails summary').click();
  // 既定(ぷるぷる = 上下に小刻み)の項目
  await expect(page.locator('#motionParams label')).toHaveText(['振れ幅', '2回目の強さ', 'つつく長さ']);
  await page.selectOption('#pPreset', 'tame');
  await expect(page.locator('#motionParams label')).toHaveText(['ためる深さ', 'ためる時間', '膨らみの強さ', '横の広がり', '横の縮み']);
  await expect(page.locator('#mp-depth + output')).toHaveText('70%');
  // ためてぼよんは、横の広がり 0% のためて膨らむ
  await expect(page.locator('#mp-spread + output')).toHaveText('0%');

  await page.locator('#mp-depth').fill('0.95');
  await page.locator('#mp-depth').dispatchEvent('change');
  await expect(page.locator('#mp-depth + output')).toHaveText('95%');
  expect(await params()).toEqual({ preset: 'custom', mp: { 'charge2.spread': 0, 'charge2.depth': 0.95 } });
  expect(await page.evaluate(() => (window as any).popstage.history.undoLabel)).toBe('ためて膨らむ: ためる深さ');

  // 選択式の項目(伸びて戻るの向き)
  await page.selectOption('#pMotion', 'stretch');
  await page.selectOption('#mp-dir', '2');
  expect((await params()).mp).toEqual({ 'charge2.spread': 0, 'charge2.depth': 0.95, 'stretch.dir': 2 });

  await page.locator('#view').focus();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  expect(await params()).toEqual({ preset: 'tame', mp: {} });
  await expect(page.locator('#mp-depth + output')).toHaveText('70%');
});

test('揺らし方「ピストン」: 画像全体が上下に動き、塗った所が遅れて付いてくる', async ({ page }) => {
  await boot(page);
  await openTab(page, 'layer');
  await page.locator('#physDetails summary').click();
  await page.selectOption('#pMotion', 'piston');
  await expect(page.locator('#physSummary')).toContainText('ピストン');
  await expect(page.locator('#motionParams label')).toHaveText(['ストローク', '上がる時間', '上で止まる時間', '下がる時間', '止まり方の鋭さ']);
  await page.selectOption('#pPreset', 'zun');
  await expect(page.locator('#pMotion')).toHaveValue('piston');
  await expect(page.locator('#pPresetDesc')).toContainText('画像ごと');
  await page.locator('#view').focus();
  await page.keyboard.press('p'); // 一時停止を解除
  // 動き出しの飛びをならし終えるまで待つ。ならす量はフレームの dt(0.1 秒で打ち切り)で減るので、描画が遅いと時間では決まらない
  await nextFrames(page); // 飛びは、解除した後のフレームで fix に入る
  await expect.poll(() => page.evaluate(() => { const f = (window as any).popstage.base.fix; return f.x === 0 && f.y === 0 && f.z === 0; }), { timeout: 10000 }).toBe(true);

  type Sample = { g: number; s: number; mesh: number; pickY: number };
  // 描画フレームごとに、画像全体の位置(正規化座標)・塗った所の画像に対する変位・メッシュの位置・画面中央の当たり判定を記録する。
  // 長さは物理の時間で測る(1フレームの dt は 0.1 秒で打ち切るので、描画が遅いと物理は実時間より遅れて進む)。一時停止中は実時間で測る
  const sample = (seconds: number) => page.evaluate(sec => new Promise<Sample[]>((resolve, reject) => {
    const a = (window as any).popstage, l = a.activeLayer, r = a.stage.canvas.getBoundingClientRect(), out: Sample[] = [];
    const t0 = performance.now(), w0 = a.world.time;
    const tick = () => {
      const q = a.stage.pick(r.left + r.width / 2, r.top + r.height / 2);
      out.push({ g: a.world.baseOffset(a.doc.layers).y, s: a.world.displacement(l.id).y, mesh: a.stage.mesh.position.y, pickY: q ? q.y : NaN });
      const wall = (performance.now() - t0) / 1000, elapsed = a.paused ? wall : a.world.time - w0;
      if (wall > sec * 20) reject(new Error('物理の時間が進まない'));
      else if (elapsed < sec) requestAnimationFrame(tick); else resolve(out);
    };
    requestAnimationFrame(tick);
  }), seconds);
  const range = (v: number[]) => Math.max(...v) - Math.min(...v);
  const k = await page.evaluate(() => (window as any).popstage.imageLong / 2);
  const rest = await page.evaluate(() => { const p = (window as any).popstage.activeLayer.physics; return -p.weight * 6 * (0.3 + 2.7 * p.mass) / (20 + 380 * p.hardness); });

  const a = await sample(2.6);
  expect(a.length).toBeGreaterThan(10);
  // 画像全体(メッシュ)がストロークの幅で上下に動き、画面の同じ所に映る画像の位置も変わる
  expect(range(a.map(x => x.g))).toBeGreaterThan(0.08);
  for (const x of a) expect(x.mesh).toBeCloseTo(x.g * k, 3);
  expect(range(a.map(x => x.pickY))).toBeGreaterThan(0.04 * k);
  // 画像が上がっている間、塗った所は遅れて画像に対して下にずれる(慣性で付いてくる)
  const rising = a.filter((x, i) => i > 0 && x.g > a[i - 1].g + 1e-6);
  expect(rising.length).toBeGreaterThan(0);
  expect(rising.reduce((s, x) => s + x.s - rest, 0) / rising.length).toBeLessThan(-0.005);
  expect(range(a.map(x => x.s))).toBeGreaterThan(0.02);

  // ポップを一時OFF の間は、画像も元の位置に置く(物理は進む)
  await page.keyboard.press('f');
  const flat = await sample(1.3);
  expect(range(flat.map(x => x.g))).toBeGreaterThan(0.08);
  for (const x of flat) expect(x.mesh).toBe(0);
  await page.keyboard.press('f');

  // 3面図でも描ける(WebGL のエラーが出ない)
  await page.keyboard.press('m');
  await expect(page.locator('#multiView')).toBeVisible();
  expect(range((await sample(1.3)).map(x => x.mesh))).toBeGreaterThan(0.08 * k);
  await page.keyboard.press('m');

  // 揺れを一時停止すると、画像もなめらかに元の位置へ戻って止まる
  await page.keyboard.press('p');
  // 戻りきるまでのフレーム数は決まっているので、描画が遅いと 0.6 秒では足りない。止まるまで待ってから確かめる
  await expect.poll(async () => (await sample(0.1)).every(x => x.g === 0 && x.mesh === 0 && x.s === 0), { timeout: 10000 }).toBe(true);
  const paused = await sample(0.5);
  for (const x of paused) { expect(x.g).toBe(0); expect(x.mesh).toBe(0); expect(x.s).toBe(0); }
});

test('ピストン: 動いている間に塗っても線はまっすぐで、ブラシの円は止まったポインタの下に付いてくる', async ({ page }) => {
  await boot(page);
  await openTab(page, 'layer');
  await page.selectOption('#pPreset', 'zun');
  await page.evaluate(() => { const a = (window as any).popstage; a.weightOp('全消去', (wm: any) => wm.clear()); a.setTool('brush', false); a.setViewOption('overlay', false); a.setPaused(false); });
  await page.waitForTimeout(600);
  const k = await page.evaluate(() => (window as any).popstage.imageLong / 2);
  const box = (await page.locator('#view').boundingBox())!;
  // フレームごとに、物理の画像の位置・画面のメッシュの位置・塗っている途中か・ブラシの円の位置を記録する
  await page.evaluate(() => {
    const a = (window as any).popstage, out: any[] = ((window as any).__frames = []);
    const tick = () => {
      out.push({ g: a.world.baseOffset(a.doc.layers).y, mesh: a.stage.mesh.position.y, stroking: a.stroking, brush: a.stage.uniforms.uBrush.value.y, on: a.stage.uniforms.uBrushOn.value });
      if ((window as any).__frames === out) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // 止まったポインタの下で、画像が動くとブラシの円の位置(画像の座標)も変わる
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.waitForTimeout(1300);
  // 横にゆっくり塗る(1.5 秒ほど。その間に画像は何度も上下する)
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) { await page.mouse.move(box.x + box.width * (0.35 + 0.3 * i / 40), box.y + box.height * 0.5); await page.waitForTimeout(35); }
  await page.mouse.up();
  await page.mouse.move(1, 1);
  const frames: { g: number; mesh: number; stroking: boolean; brush: number; on: number }[] = await page.evaluate(() => { const f = (window as any).__frames; (window as any).__frames = null; return f; });
  const range = (v: number[]) => Math.max(...v) - Math.min(...v);
  const hovering = frames.filter(f => !f.stroking && f.on === 1).slice(0, 40);
  expect(range(hovering.map(f => f.brush))).toBeGreaterThan(0.04 * k);
  // 塗っている間も物理の画像は動き続けるが、画面の画像は止めておく
  const during = frames.filter(f => f.stroking);
  expect(during.length).toBeGreaterThan(10);
  expect(range(during.map(f => f.g))).toBeGreaterThan(0.08);
  expect(range(during.map(f => f.mesh))).toBe(0);

  // 塗れた線は画像の上でまっすぐ(列ごとの重心の行が一直線に並ぶ。斜めから見ているので傾きはあってよい)
  const res = await page.evaluate(() => {
    const wm = (window as any).popstage.activeLayer.weights, W = wm.width, H = wm.height, pts: [number, number][] = [];
    for (let x = 0; x < W; x++) {
      let s = 0, sy = 0;
      for (let y = 0; y < H; y++) { const v = wm.data[y * W + x]; s += v; sy += v * y; }
      if (s > 255 * 3) pts.push([x, sy / s]);
    }
    const mid = pts.slice(Math.floor(pts.length * 0.15), Math.ceil(pts.length * 0.85)), n = mid.length;
    const mx = mid.reduce((a, p) => a + p[0], 0) / n, my = mid.reduce((a, p) => a + p[1], 0) / n;
    const b = mid.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / mid.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
    return { n, H, worst: Math.max(...mid.map(p => Math.abs(p[1] - (my + b * (p[0] - mx))))) };
  });
  expect(res.n).toBeGreaterThan(20);
  expect(res.worst).toBeLessThan(res.H * 0.006);
});

test('ピストン: 3面図に上がった画像が収まり、回転・拡大した画像ではずれも一緒に回る', async ({ page }) => {
  await boot(page);
  await openTab(page, 'layer');
  await page.selectOption('#pPreset', 'zun');
  await page.evaluate(() => {
    const a = (window as any).popstage, l = a.activeLayer;
    a.store.patchLayer(l.id, { physics: { ...l.physics, motionParams: { 'piston.height': 3 } } }); // ストロークを最大に
    a.setPaused(false);
  });
  await page.locator('#view').focus();
  await page.keyboard.press('m');
  await expect(page.locator('#multiView')).toBeVisible();
  await page.waitForTimeout(300);
  const fit = await page.evaluate(() => {
    const a = (window as any).popstage, st = a.stage, scale = st.orthoScale();
    const reach = a.world.baseReach(a.doc.layers) * a.imageLong / 2;
    const half = (kind: string) => scale * st.subViews.find((v: any) => v.kind === kind).rect.h / 2;
    return { reach, need: a.doc.image.height / 2 + reach, front: half('front'), right: half('right') };
  });
  expect(fit.reach).toBeGreaterThan(100);
  expect(fit.front).toBeGreaterThanOrEqual(fit.need);
  expect(fit.right).toBeGreaterThanOrEqual(fit.need);
  await page.keyboard.press('m');

  // 画像を 90° 回して 2 倍にすると、上へのずれは画像と一緒に回って 2 倍になる
  const pos = await page.evaluate(() => {
    const a = (window as any).popstage, st = a.stage, d = a.doc;
    a.exporting = true; // 描画ループを止めて、ずれを手で入れる
    a.store.patchDocument(d.id, { rotation: { x: 0, y: 0, z: Math.PI / 2 }, scale: 2, position: { x: 5, y: 0, z: 0 } });
    st.setBaseOffset({ x: 0, y: 10, z: 0 });
    st.render(a.project.camera);
    const p = st.mesh.position, out = [p.x, p.y, p.z];
    a.exporting = false;
    return out;
  });
  expect(pos[0]).toBeCloseTo(5 - 20, 6); expect(pos[1]).toBeCloseTo(0, 6); expect(pos[2]).toBeCloseTo(0, 6);
});

test('揺らし方「ためて膨らむ」(charge2): 離した直後に、塗った範囲が画像の面内でも外へ広がる', async ({ page }) => {
  await boot(page);
  await openTab(page, 'layer');
  // 透明な背景に半径 80px の円を描いた画像。円より広く(半径 130px まで)塗り、ポップ量は 0 にして横の広がりだけを見る
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 400;
    const g = c.getContext('2d')!; g.fillStyle = '#e33'; g.beginPath(); g.arc(200, 200, 80, 0, Math.PI * 2); g.fill();
    const b: Blob = await new Promise(r => c.toBlob(x => r(x!), 'image/png'));
    const a = (window as any).popstage;
    a.dirty = false;
    await a.openFile(new File([b], 'disc.png', { type: 'image/png' }));
    a.weightOp('円を塗る', (wm: any) => {
      for (let y = 0; y < wm.height; y++) for (let x = 0; x < wm.width; x++) {
        const d = Math.hypot((x + 0.5) / wm.width * 400 - 200, (y + 0.5) / wm.height * 400 - 200);
        wm.data[y * wm.width + x] = d < 130 ? 255 : d < 160 ? Math.round(255 * (160 - d) / 30) : 0;
      }
    });
    a.store.patchLayer(a.activeLayer.id, { pop: 0 });
    a.store.patchProject({ autoSwing: { ...a.project.autoSwing, enabled: true, period: 2 } });
  });
  await page.locator('#physDetails summary').click();
  await page.selectOption('#pMotion', 'charge2');
  await expect(page.locator('#physSummary')).toContainText('ためて膨らむ');
  await expect(page.locator('#motionParams label')).toHaveText(['ためる深さ', 'ためる時間', '膨らみの強さ', '横の広がり', '横の縮み']);
  await page.evaluate(() => (window as any).popstage.setPaused(false));

  // 描画フレームごとに、広がり r と、正面から書き出した絵の円の幅(px)を記録する
  const samples = await page.evaluate(() => new Promise<{ r: number; width: number }[]>(resolve => {
    const a = (window as any).popstage, id = a.activeLayer.id, out: { r: number; width: number }[] = [], N = 200;
    const cam = { fov: 40, yaw: 0, pitch: 0, zoom: 1, target: { x: 0, y: 0, z: 0 } };
    const t0 = performance.now();
    const tick = () => {
      const px: Uint8ClampedArray = a.stage.renderFrame(N, N, cam, null);
      let lo = N, hi = -1;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (px[(y * N + x) * 4 + 3] > 128) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
      out.push({ r: a.world.spread(id), width: hi - lo + 1 });
      if (performance.now() - t0 < 4500) requestAnimationFrame(tick); else resolve(out);
    };
    requestAnimationFrame(tick);
  }));
  expect(samples.length).toBeGreaterThan(10);
  const by = (f: (s: { r: number }) => number) => samples.reduce((b, s) => (f(s) < f(b) ? s : b));
  const peak = by(s => -s.r), trough = by(s => s.r), rest = by(s => Math.abs(s.r));
  expect(peak.r).toBeGreaterThan(0.1);
  expect(trough.r).toBeLessThan(-0.05);
  expect(Math.abs(rest.r)).toBeLessThan(0.03);
  // 円の幅は広がり r に合わせて変わる(円の縁は塗りの内側なので、幅 × (1 + r) になる)
  expect(peak.width).toBeGreaterThan(rest.width * (1 + 0.7 * peak.r));
  expect(trough.width).toBeLessThan(rest.width * (1 + 0.5 * trough.r));
  // 一時停止すると元の大きさに戻る
  await page.evaluate(() => (window as any).popstage.setPaused(true));
  expect(await page.evaluate(() => (window as any).popstage.world.spread((window as any).popstage.activeLayer.id))).toBe(0);
});

test('揺らし方「ふわっと膨らむ」「一瞬膨らむ」: プリセットで選べ、動かすと塗った範囲が横にも広がる', async ({ page }) => {
  await boot(page);
  await openTab(page, 'layer');
  await page.locator('#physDetails summary').click();
  const cases = [
    { preset: 'pofu', motion: 'puff', label: 'ふわっと膨らむ', params: ['上下の幅', '下がる深さ', '横の広がり', '揺れる長さ'], axis: 'y' },
    { preset: 'pon', motion: 'pulse', label: '一瞬膨らむ', params: ['膨らみ', '横の広がり', '膨らむ長さ'], axis: 'z' },
  ] as const;
  for (const c of cases) {
    await page.selectOption('#pPreset', c.preset);
    await expect(page.locator('#pMotion')).toHaveValue(c.motion);
    await expect(page.locator('#motionParams label')).toHaveText([...c.params]);
    expect(await page.locator('#pMotion option:checked').textContent()).toBe(c.label);
    await page.evaluate(() => { const a = (window as any).popstage; a.store.patchProject({ autoSwing: { ...a.project.autoSwing, enabled: true } }); a.setPaused(false); });
    // 2周期ぶん、広がりと、土台が動く向きの変位の振れ幅を記録する
    const seen = await page.evaluate(axis => new Promise<{ r: number; d: number; side: number }>(resolve => {
      const a = (window as any).popstage, id = a.activeLayer.id, t0 = performance.now(), T = a.project.autoSwing.period;
      let r = 0, lo = Infinity, hi = -Infinity, side = 0;
      const tick = () => {
        const s = a.world.displacement(id);
        r = Math.max(r, a.world.spread(id)); lo = Math.min(lo, s[axis]); hi = Math.max(hi, s[axis]); side = Math.max(side, Math.abs(s.x));
        if (performance.now() - t0 < 2000 * T) requestAnimationFrame(tick); else resolve({ r, d: hi - lo, side });
      };
      requestAnimationFrame(tick);
    }), c.axis);
    expect(seen.r, c.motion).toBeGreaterThan(0.05);
    expect(seen.d, c.motion).toBeGreaterThan(0.01);
    expect(seen.side, c.motion).toBeLessThan(1e-6); // 左右へは動かさない(広がりは面内で中心から外へ)
    await page.evaluate(() => (window as any).popstage.setPaused(true));
  }
});
