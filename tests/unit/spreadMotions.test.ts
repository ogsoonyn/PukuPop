import { describe, it, expect } from 'vitest';
import { PhysicsWorld, PHYSICS_DT } from '../../src/physics/world';
import { motionAnchor, motionSpread } from '../../src/physics/motion';
import { createDocument, applyPreset, PRESETS, type Layer } from '../../src/model/project';

const image = { bytes: new Uint8Array(), mime: 'image/png', ext: 'png', width: 1024, height: 1024 };
const STRENGTH = 0.5;
const run = (w: PhysicsWorld, layers: Layer[], seconds: number) => { for (let i = 0, n = Math.round(seconds / PHYSICS_DT); i < n; i++) w.step(layers); };

/** プリセットを当てて慣らしたあと、1周期ぶんの変位と広がりを記録する */
const cycle = (preset: 'pofu' | 'pon') => {
  const l = createDocument(image, 'd').layers[0];
  l.physics = applyPreset(l.physics, preset);
  const w = new PhysicsWorld(), T = PRESETS[preset].period;
  w.unitPx = 512;
  w.autoSwing = { enabled: true, period: T, strength: STRENGTH };
  run(w, [l], Math.ceil(20 / T) * T);
  const xs: number[] = [], ys: number[] = [], zs: number[] = [], rs: number[] = [];
  for (let i = 0; i < Math.round(T / PHYSICS_DT); i++) {
    w.step([l]); const d = w.displacement(l.id);
    xs.push(d.x); ys.push(d.y); zs.push(d.z); rs.push(w.spread(l.id));
  }
  return { xs, ys, zs, rs, T };
};
const argmax = (v: number[]) => v.indexOf(Math.max(...v));

describe('ふわっと膨らむ(一瞬だけ上下に揺れて、同時に横にも膨らむ)', () => {
  const T = 2, at = (u: number, p?: Record<string, number>) => motionAnchor('puff', u * T, T, STRENGTH, undefined, 0, p);
  const spreadAt = (u: number, p?: Record<string, number>) => motionSpread('puff', u * T, T, STRENGTH, p);

  it('土台: 周期の頭で上がってから少し下がり、そのあとは止まる。上下にしか動かない', () => {
    // 既定の揺れる長さは 30%: 0〜15% で上がり、15〜30% で下がる
    expect(at(0)).toEqual({ x: 0, y: 0, z: 0 });
    expect(at(0.075).y).toBeCloseTo(0.1 * STRENGTH, 9);          // 上の山
    expect(at(0.225).y).toBeCloseTo(-0.1 * STRENGTH * 0.5, 9);   // 下の山(下がる深さ 50%)
    for (const u of [0.3, 0.5, 0.9]) expect(at(u).y).toBe(0);
    for (let u = 0; u < 1; u += 0.01) { expect(at(u).x).toBe(0); expect(at(u).z).toBe(0); }
  });

  it('広がり: 上がるのと同時に外へ広がり、上がり終わると元に戻る', () => {
    expect(spreadAt(0)).toBe(0);
    expect(spreadAt(0.075)).toBeCloseTo(0.2, 9); // 横の広がり 20%(強さ 50% で、ためて膨らむと同じ尺度)
    for (const u of [0.15, 0.225, 0.5]) expect(spreadAt(u)).toBe(0);
    for (let u = 0; u < 0.15; u += 0.01) expect(spreadAt(u)).toBeGreaterThanOrEqual(0); // 縮みはしない
  });

  it('固有設定が効く', () => {
    expect(at(0.075, { 'puff.height': 2 }).y).toBeCloseTo(2 * at(0.075).y, 9);
    for (let u = 0; u < 1; u += 0.01) expect(at(u, { 'puff.down': 0 }).y).toBeGreaterThanOrEqual(0);
    expect(spreadAt(0.075, { 'puff.spread': 0.4 })).toBeCloseTo(0.4, 9);
    expect(spreadAt(0.075, { 'puff.spread': 0 })).toBe(0);
    // 揺れる長さを 60% にすると、上の山は 15% の所へずれる
    expect(at(0.15, { 'puff.time': 0.6 }).y).toBeCloseTo(0.1 * STRENGTH, 9);
    expect(spreadAt(0.15, { 'puff.time': 0.6 })).toBeCloseTo(0.2, 9);
  });

  it('プリセット「ぽふん」: 上へふわっと動いて横にも膨らみ、周期の終わりには落ち着く', () => {
    const { xs, ys, rs } = cycle('pofu'), n = ys.length;
    expect(Math.max(...xs.map(Math.abs))).toBeLessThan(1e-9);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.03);
    expect(Math.max(...rs)).toBeGreaterThan(0.1);
    // いちばん広がるのは周期の前半(上がっている間の少し後)
    expect(argmax(rs)).toBeLessThan(n / 2);
    // 周期の最後の 1 割では、広がりは山の 1 割強ほどまでおさまっている(計測: ぽふん 8%、ぽんっ 7%)
    expect(Math.max(...rs.slice(Math.round(n * 0.9)).map(Math.abs))).toBeLessThan(0.12 * Math.max(...rs));
  });
});

describe('一瞬膨らむ(手前に少し膨らんですぐ戻り、同時に横にも膨らむ)', () => {
  const T = 2, pop = 0.3;
  const at = (u: number, p?: Record<string, number>, pp = pop) => motionAnchor('pulse', u * T, T, STRENGTH, undefined, pp, p);
  const spreadAt = (u: number, p?: Record<string, number>) => motionSpread('pulse', u * T, T, STRENGTH, p);

  it('土台: 周期の頭で一度だけ手前に膨らみ、すぐ戻る。手前にしか動かず、ポップ量に比例する', () => {
    // 既定の膨らむ長さは 15%: 7.5% の所が山
    expect(at(0)).toEqual({ x: 0, y: 0, z: 0 });
    expect(at(0.075).z).toBeCloseTo(pop * 0.3, 9); // 膨らみ 30% × 2 × 強さ 50%
    for (const u of [0.15, 0.5, 0.9]) expect(at(u).z).toBe(0);
    for (let u = 0; u < 1; u += 0.01) { expect(at(u).x).toBe(0); expect(at(u).y).toBe(0); expect(at(u).z).toBeGreaterThanOrEqual(0); }
    expect(at(0.075, undefined, 2 * pop).z).toBeCloseTo(2 * at(0.075).z, 9);
    expect(at(0.075, undefined, 0).z).toBe(0);
  });

  it('広がり: 手前に膨らむのと同時に外へ広がって戻る', () => {
    expect(spreadAt(0)).toBe(0);
    expect(spreadAt(0.075)).toBeCloseTo(0.15, 9); // 横の広がり 15%
    for (const u of [0.15, 0.5]) expect(spreadAt(u)).toBe(0);
    for (let u = 0; u < 0.15; u += 0.005) expect(spreadAt(u) / 0.15).toBeCloseTo(at(u).z / (pop * 0.3), 9); // 同じ形
  });

  it('固有設定が効く', () => {
    expect(at(0.075, { 'pulse.bulge': 0.6 }).z).toBeCloseTo(2 * at(0.075).z, 9);
    expect(spreadAt(0.075, { 'pulse.spread': 0.3 })).toBeCloseTo(0.3, 9);
    expect(spreadAt(0.075, { 'pulse.spread': 0 })).toBe(0);
    // 膨らむ長さを 40% にすると、山は 20% の所へずれる
    expect(at(0.2, { 'pulse.time': 0.4 }).z).toBeCloseTo(pop * 0.3, 9);
    expect(at(0.2).z).toBe(0);
  });

  it('プリセット「ぽんっ」: 手前にも横にも膨らんで弾み、周期の終わりには落ち着く', () => {
    const { xs, ys, zs, rs } = cycle('pon'), n = zs.length, popN = 80 / 512; // 既定のポップ量 80px
    expect(Math.max(...xs.map(Math.abs))).toBeLessThan(1e-9);
    expect(Math.max(...zs)).toBeGreaterThan(0.2 * popN);
    expect(Math.max(...rs)).toBeGreaterThan(0.08);
    expect(argmax(zs)).toBeLessThan(n / 3);
    expect(argmax(rs)).toBeLessThan(n / 3);
    // 上下は重さで少し下がっているだけで、揺らし方では動かさない
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.01);
    // 周期の最後の 1 割では、広がりは山の 1 割強ほどまでおさまっている(計測: ぽふん 8%、ぽんっ 7%)
    expect(Math.max(...rs.slice(Math.round(n * 0.9)).map(Math.abs))).toBeLessThan(0.12 * Math.max(...rs));
  });
});
