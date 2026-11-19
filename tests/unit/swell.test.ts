import { describe, it, expect } from 'vitest';
import { PhysicsWorld, PHYSICS_DT } from '../../src/physics/world';
import { motionAnchor, motionSpread, motionPushes } from '../../src/physics/motion';
import { createDocument, applyPreset, PRESETS, EFFECT_MOTIONS, type Layer } from '../../src/model/project';

const image = { bytes: new Uint8Array(), mime: 'image/png', ext: 'png', width: 1024, height: 1024 };
const z = (u: number, p: Record<string, number> = {}, pop = 0.2) => motionAnchor('swell', u, 1, 0.5, undefined, pop, p).z;
const r = (u: number, p: Record<string, number> = {}) => motionSpread('swell', u, 1, 0.5, p);

describe('ゆっくり膨らむ', () => {
  it('膨らむ時間をかけてなめらかに大きくなり、戻る時間で元に戻る(強さ 50% で設定の値がそのまま効く)', () => {
    expect(z(0)).toBe(0);
    expect(z(0.3)).toBeCloseTo(0.2 * 0.5 * 0.5, 9);       // 膨らむ時間 60% の半分で、膨らみ 50% の半分
    expect(z(0.6 - 1e-9)).toBeCloseTo(0.2 * 0.5, 6);        // 一番膨らむ
    expect(z(0.63)).toBeCloseTo(0.2 * 0.5 * 0.5, 6);       // 戻る時間 6% の半分
    expect(z(0.66)).toBe(0);
    expect(z(0.9)).toBe(0);
    // 膨らみは単調に増える(じわじわ)
    for (let u = 0.01; u < 0.6; u += 0.01) expect(z(u)).toBeGreaterThan(z(u - 0.01));
    // 横の広がりも同じ形
    expect(r(0.3)).toBeCloseTo(0.2 * 0.5, 9);
    expect(r(0.66)).toBe(0);
    // 戻る時間 0% はぱっと離す
    expect(z(0.6, { 'swell.ret': 0 })).toBe(0);
    expect(z(0.599, { 'swell.ret': 0 })).toBeGreaterThan(0.09);
    // ポップ量に比例する
    expect(z(0.4, {}, 0.4)).toBeCloseTo(2 * z(0.4, {}, 0.2), 12);
    // エフェクトは出さない
    expect(motionPushes('swell')).toEqual([]);
    expect(EFFECT_MOTIONS.has('swell')).toBe(false);
  });

  it('ぷくーっ: じわじわ付いていき、しゅっと戻った勢いで内へ弾む', () => {
    const l: Layer = createDocument(image, 'd').layers[0];
    l.physics = applyPreset(l.physics, 'puu');
    const T = PRESETS.puu.period, w = new PhysicsWorld();
    w.unitPx = 512; w.autoSwing = { enabled: true, period: T, strength: 0.5 };
    for (let i = 0; i < Math.round((T * 4) / PHYSICS_DT); i++) w.step([l]);
    const zs: number[] = [], rs: number[] = [];
    for (let i = 0; i < Math.round(T / PHYSICS_DT); i++) { w.step([l]); zs.push(w.displacement(l.id).z); rs.push(w.spread(l.id)); }
    const pop = l.pop / 512;
    expect(Math.max(...zs)).toBeGreaterThan(0.4 * pop);
    expect(Math.min(...zs)).toBeLessThan(-0.1 * pop);   // 戻った勢いで元より凹む
    expect(Math.max(...rs)).toBeGreaterThan(0.15);
    expect(Math.min(...rs)).toBeLessThan(-0.03);
  });
});

describe('鼓動の横の広がり', () => {
  it('既定の 0% では広がらず(足す前と同じ)、設定すると2拍と同じ形で広がる', () => {
    for (let u = 0; u < 1; u += 0.01) expect(motionSpread('heartbeat', u, 1, 0.5)).toBe(0);
    const p = { 'heartbeat.spread': 0.2 };
    const beat = (u: number) => motionAnchor('heartbeat', u, 1, 0.5, undefined, 0, p).z / (0.22 * 0.5);
    for (const u of [0.03, 0.06, 0.1, 0.26, 0.3, 0.5]) expect(motionSpread('heartbeat', u, 1, 0.5, p)).toBeCloseTo(0.2 * beat(u), 12);
    expect(PRESETS.doki.params).toEqual({ spread: 0.15 });
  });
});
