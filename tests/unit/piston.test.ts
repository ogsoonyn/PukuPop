import { describe, it, expect } from 'vitest';
import { PhysicsWorld, PHYSICS_DT, coefficients } from '../../src/physics/world';
import { motionAnchor, pistonOffset } from '../../src/physics/motion';
import { MotionRecorder, applySample } from '../../src/physics/recorder';
import { runExport } from '../../src/export/exporter';
import { Store, createDocument, createProject, applyPreset, defaultCamera, MOTIONS, PRESETS, type Layer, type MotionPattern, type Vec3 } from '../../src/model/project';

const image = { bytes: new Uint8Array(), mime: 'image/png', ext: 'png', width: 1024, height: 1024 };
const T = 1.2, STRENGTH = 0.5; // 既定の周期と強さ
const layerOf = (preset: keyof typeof PRESETS, motion?: MotionPattern): Layer => {
  const l = createDocument(image, 'd').layers[0];
  l.physics = applyPreset(l.physics, preset);
  if (motion) l.physics = { ...l.physics, motion, motionParams: {} };
  return l;
};
const worldOf = (period = T) => {
  const w = new PhysicsWorld();
  w.unitPx = 512;
  w.autoSwing = { enabled: true, period, strength: STRENGTH };
  return w;
};
const run = (w: PhysicsWorld, layers: Layer[], seconds: number) => { for (let i = 0, n = Math.round(seconds / PHYSICS_DT); i < n; i++) w.step(layers); };
const add = (a: Vec3, b: Vec3, k = 1): Vec3 => ({ x: a.x + k * b.x, y: a.y + k * b.y, z: a.z + k * b.z });

describe('ピストン(画像全体が動く揺らし方)', () => {
  it('画像全体の位置は周期 T で元に戻り、途中でつながっている(ループ書き出しの前提)', () => {
    const params: Record<string, number>[] = [{}, { 'piston.sharp': 0 }, { 'piston.up': 0.6, 'piston.top': 0.5, 'piston.down': 0.6 }];
    for (const p of params) {
      for (const t of [0.05, 0.31, 0.77, 1.2, 1.66]) {
        const a = pistonOffset(t, 1.7, 0.6, undefined, p), b = pistonOffset(t + 1.7 * 3, 1.7, 0.6, undefined, p);
        expect(b.y).toBeCloseTo(a.y, 9);
      }
      // 位置が飛ばない(1刻みの変化が小さい)。下で止まっている所(周期の頭)は 0
      let prev = pistonOffset(0, T, 1, undefined, p).y, maxJump = 0;
      expect(prev).toBe(0);
      for (let t = PHYSICS_DT; t <= T + 1e-9; t += PHYSICS_DT) { const y = pistonOffset(t, T, 1, undefined, p).y; maxJump = Math.max(maxJump, Math.abs(y - prev)); prev = y; }
      expect(maxJump).toBeLessThan(0.02);
    }
    // 上下だけに、ストロークの幅で動く。土台(アンカー)は動かさない
    let hi = 0;
    for (let t = 0; t < T; t += 0.001) { const g = pistonOffset(t, T, 1); expect(g.x).toBe(0); expect(g.z).toBe(0); hi = Math.max(hi, g.y); }
    expect(hi).toBeCloseTo(0.2, 6);
    expect(pistonOffset(0.3, T, 1, undefined, { 'piston.height': 2 }).y).toBeCloseTo(2 * pistonOffset(0.3, T, 1).y, 9);
    expect(motionAnchor('piston', 0.3, T, 1)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('画像を動かすのは、揺れが有効で表示中のピストンのレイヤーがあり、自動揺らし中で一時停止していないときだけ', () => {
    const p = layerOf('zun'), other = layerOf('puru'), w = worldOf();
    const t = 0.25 * T, at = (layers: Layer[]) => w.baseOffset(layers, t).y;
    expect(at([p])).toBeGreaterThan(0.05);
    expect(at([other])).toBe(0);
    expect(at([other, p])).toBe(at([p]));
    p.visible = false; expect(at([p])).toBe(0); p.visible = true;
    p.physics.enabled = false; expect(at([p])).toBe(0); p.physics.enabled = true;
    w.autoSwing = { ...w.autoSwing, enabled: false }; expect(at([p])).toBe(0); w.autoSwing = { ...w.autoSwing, enabled: true };
    w.paused = true; expect(at([p])).toBe(0); w.paused = false;
    // ピストンのレイヤーが複数あるときは、並びで最初のレイヤーの設定で決める
    const q = layerOf('zun'); q.physics.motionParams = { 'piston.height': 2 };
    expect(at([p, q])).toBe(at([p]));
    expect(at([q, p])).toBeCloseTo(2 * at([p]), 9);
  });

  it('塗った部分の画面上の位置(画像の位置 + 変位)は、動く土台にバネで繋いだ物体を動かない座標で計算したものと一致する', () => {
    const l = layerOf('zun'), w = worldOf();
    const { k, m, c, g } = coefficients(l.physics);
    let X = 0, V = 0; // 動かない座標での、塗った部分の位置と速度(y)
    for (let i = 0; i < 600; i++) {
      const G0 = w.baseOffset([l], w.time - PHYSICS_DT).y, G1 = w.baseOffset([l]).y, Gv = (G1 - G0) / PHYSICS_DT;
      V += ((-k * (X - G1) - c * (V - Gv) - g * m) / m) * PHYSICS_DT; X += V * PHYSICS_DT;
      w.step([l]);
      expect(w.baseOffset([l]).y + w.displacement(l.id).y).toBeCloseTo(X, 9);
    }
  });

  it('ほかのレイヤーも、画像の動きに遅れて揺れる(画像は1枚なので)', () => {
    const p = layerOf('zun'), other = layerOf('puru'), w = worldOf();
    other.physics.weight = 0;
    run(w, [p, other], 0.5);
    const s = w.displacement(other.id);
    expect(Math.abs(s.y)).toBeGreaterThan(1e-3); // 上下に小刻みの動きだけでなく、画像の動きの慣性も受ける
    const alone = worldOf(); run(alone, [other], 0.5);
    expect(Math.abs(s.y - alone.displacement(other.id).y)).toBeGreaterThan(1e-3);
  });

  /* ---------- 既存の揺らし方との違い(計測値の回帰チェック) ---------- */

  type Tr = Vec3[];
  /** 慣らしたあと1周期ぶん、画像の位置 U と、塗った部分の画像に対する変位 R を記録する(画面上は U + w·R) */
  const cycle = (preset: keyof typeof PRESETS, motion: MotionPattern) => {
    const l = layerOf(preset, motion), w = worldOf();
    run(w, [l], Math.ceil(20 / T) * T);
    const U: Tr = [], R: Tr = [];
    for (let i = 0; i < Math.round(T / PHYSICS_DT); i++) { U.push(w.baseOffset([l])); R.push({ ...w.displacement(l.id) }); w.step([l]); }
    return { U, R, P: U.map((u, i) => add(u, R[i])) };
  };
  const demean = (a: Tr): Tr => { const m = a.reduce((s, v) => add(s, v, 1 / a.length), { x: 0, y: 0, z: 0 }); return a.map(v => add(v, m, -1)); };
  const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
  const rms = (a: Tr) => Math.sqrt(demean(a).reduce((s, v) => s + dot(v, v), 0) / a.length);
  /** 画面上の変位の場(w = 0, 0.25, …, 1 の頂点の軌道)の正規化相互相関。時間のずれは全頂点で共通にして最大をとる */
  const fieldNcc = (a: { U: Tr; R: Tr }, b: { U: Tr; R: Tr }) => {
    const F = (d: { U: Tr; R: Tr }) => [0, 0.25, 0.5, 0.75, 1].map(wt => demean(d.U.map((u, i) => add(u, d.R[i], wt))));
    const fa = F(a), fb = F(b), n = a.U.length;
    const e = (f: Tr[]) => f.reduce((s, t) => s + t.reduce((q, v) => q + dot(v, v), 0), 0);
    let best = -1;
    for (let k = 0; k < n; k++) {
      let s = 0;
      for (let j = 0; j < fa.length; j++) for (let i = 0; i < n; i++) s += dot(fa[j][i], fb[j][(i - k + n) % n]);
      best = Math.max(best, s / Math.sqrt(e(fa) * e(fb)));
    }
    return best;
  };

  for (const preset of ['puru', 'zun'] as const) {
    it(`既存のどの揺らし方とも違う動きになる(材質: ${PRESETS[preset].label}、周期 ${T} 秒、強さ ${STRENGTH})`, () => {
      const piston = cycle(preset, 'piston');
      // 塗っていない所(w = 0)も動く。既存の揺らし方では必ず止まっている
      expect(rms(piston.U)).toBeGreaterThan(0.03);
      // 塗った所は画像と一緒に動き、画像に対しては遅れて付いてくる分だけ動く(既存の揺らし方では 100%)
      const ratio = rms(piston.R) / rms(piston.P);
      expect(ratio).toBeGreaterThan(0.15); expect(ratio).toBeLessThan(0.8);
      for (const m of Object.keys(MOTIONS) as MotionPattern[]) {
        if (m === 'piston' || m === 'none') continue;
        const d = cycle(preset, m);
        expect(rms(d.U), m).toBe(0);
        expect(rms(d.R) / rms(d.P), m).toBeCloseTo(1, 9);
        // 違いの本体は上の2つ(構造の違い)。軌道の形の相関は「上下に1周期1回」の揺らし方どうしでは高めに出るので、
        // 既存どうしの最も近い組(この2つの材質で 0.89 と 0.94)を超えないことだけを余裕をもって確かめる。
        // 計測では連続ジャンプが最も近く 0.76 / 0.83、ジャンプは 0.65 / 0.64
        expect(fieldNcc(piston, d), m).toBeLessThan(0.9);
      }
    });
  }

  /* ---------- 書き出し ---------- */

  it('十分に慣らしたあとは、画像の位置も変位も周期ごとに同じに戻る', () => {
    const l = layerOf('zun'), w = worldOf();
    run(w, [l], Math.ceil(20 / T) * T);
    const a = { ...w.displacement(l.id) }, ga = w.baseOffset([l]).y;
    run(w, [l], T);
    expect(w.displacement(l.id).y).toBeCloseTo(a.y, 5);
    expect(w.baseOffset([l]).y).toBeCloseTo(ga, 9);
  });

  it('スナップショットから復元しても、操作の記録を再生しても、ライブと同じ動きになる', () => {
    const l = layerOf('zun'), live = worldOf(), rec = new MotionRecorder();
    const camera = defaultCamera(), ys: number[] = [];
    const n = 700;
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0 && i < 300) camera.target = { x: Math.sin(i / 30) * 40, y: 0, z: 0 }; // 平行移動の揺れも重なる
      live.viewTarget = camera.target;
      live.viewAngles = { yaw: camera.yaw, pitch: camera.pitch, roll: 0, zoom: camera.zoom };
      rec.record({ grab: i > 400 && i < 450 ? { x: 0.1, y: 0.05, z: 0 } : null, grabGains: [], camera: structuredClone(camera), viewTarget: { ...live.viewTarget }, viewCut: live.viewCut }, () => live.snapshot());
      live.grab = i > 400 && i < 450 ? { x: 0.1, y: 0.05, z: 0 } : null;
      live.step([l]);
      ys.push(live.baseOffset([l]).y + live.displacement(l.id).y);
    }
    const r = rec.lastSeconds(n * PHYSICS_DT - 1.1)!;
    const w = worldOf();
    w.restore(r.start);
    for (const smp of r.warmup) { applySample(w, smp); w.step([l]); }
    const start = n - r.samples.length;
    r.samples.forEach((smp, k) => { applySample(w, smp); w.step([l]); expect(w.baseOffset([l]).y + w.displacement(l.id).y).toBe(ys[start + k]); });
  });

  it('自動の揺れの書き出しは、何度やっても同じで、周期の整数倍の長さなら継ぎ目なくループする', async () => {
    const doc = createDocument(image, 'd');
    doc.layers[0].physics = applyPreset(doc.layers[0].physics, 'zun');
    const store = new Store(createProject(doc));
    store.project.autoSwing = { enabled: false, period: T, strength: STRENGTH }; // 書き出しでは自動揺らしを入れる
    const once = async () => {
      const frames: { g: number; s: number }[] = [];
      const stage = { renderFrame: (w: number, h: number) => new Uint8ClampedArray(w * h * 4) };
      await runExport({
        stage: stage as never, store, recorder: new MotionRecorder(),
        centerOf: () => ({ x: 0, y: 0 }),
        applySwing: (world, d) => frames.push({ g: world.baseOffset(d.layers).y, s: world.displacement(d.layers[0].id).y }),
      }, { format: 'gif', width: 2, height: 2, fps: 30, duration: 2 * T, background: '#fff', motion: 'auto' }, () => {}, new AbortController().signal);
      return frames;
    };
    const a = await once(), b = await once();
    expect(a).toEqual(b);
    const per = Math.round(T * 30);
    expect(a.length).toBe(2 * per);
    expect(a[0].g).toBeCloseTo(0, 9); // 周期の頭(下で止まっている所)から始まる
    expect(Math.max(...a.map(f => f.g))).toBeGreaterThan(0.05);
    // 1周期あとが同じ = 最後のフレームの次が最初のフレームにつながる
    for (let i = 0; i < per; i++) { expect(a[i + per].g).toBeCloseTo(a[i].g, 9); expect(a[i + per].s).toBeCloseTo(a[i].s, 5); }
  });
});
