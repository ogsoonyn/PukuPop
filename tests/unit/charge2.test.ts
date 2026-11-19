import { describe, it, expect } from 'vitest';
import { PhysicsWorld, PHYSICS_DT } from '../../src/physics/world';
import { motionAnchor, motionSpread, SPREAD_MOTIONS } from '../../src/physics/motion';
import { MotionRecorder, applySample } from '../../src/physics/recorder';
import { runExport } from '../../src/export/exporter';
import { WeightMap } from '../../src/model/weightmap';
import { Store, createDocument, createProject, applyPreset, defaultCamera, MOTIONS, PRESETS, type Layer, type MotionPattern } from '../../src/model/project';

/** 塗った範囲を広げる揺らし方(ためて膨らむ・ゆっくり膨らむ・鼓動のほかは spreadMotions.test.ts で確かめる)。足し忘れを見張るため、motion.ts とは別に書く */
const SPREADING = new Set<MotionPattern>(['charge2', 'swell', 'puff', 'pulse', 'heartbeat']);
const image = { bytes: new Uint8Array(), mime: 'image/png', ext: 'png', width: 1024, height: 1024 };
const STRENGTH = 0.5;
const layerOf = (preset: keyof typeof PRESETS, motion?: MotionPattern): Layer => {
  const l = createDocument(image, 'd').layers[0];
  l.physics = applyPreset(l.physics, preset);
  if (motion) l.physics = { ...l.physics, motion, motionParams: {} };
  return l;
};
const worldOf = (period: number) => {
  const w = new PhysicsWorld();
  w.unitPx = 512;
  w.autoSwing = { enabled: true, period, strength: STRENGTH };
  return w;
};
const run = (w: PhysicsWorld, layers: Layer[], seconds: number) => { for (let i = 0, n = Math.round(seconds / PHYSICS_DT); i < n; i++) w.step(layers); };
/** 慣らしたあと1周期ぶんの広がり */
const spreadCycle = (l: Layer, T: number) => {
  const w = worldOf(T);
  run(w, [l], Math.ceil(20 / T) * T);
  const rs: number[] = [];
  for (let i = 0; i < Math.round(T / PHYSICS_DT); i++) { w.step([l]); rs.push(w.spread(l.id)); }
  return rs;
};

describe('ためて膨らむ2(塗った範囲も横に広がる)', () => {
  it('広がりの土台: ためている間は内へ縮め、離した瞬間に外へ広げ、周期 T で元に戻る', () => {
    const T = 2, at = (u: number, p?: Record<string, number>) => motionSpread('charge2', u * T, T, STRENGTH, p);
    expect(at(0)).toBeCloseTo(0, 12);
    expect(at(0.59)).toBeCloseTo(-0.2 * 0.5, 2);            // 横の広がり 20% × 横の縮み 50%
    expect(at(0.64)).toBeCloseTo(0.2, 9);                   // 離した瞬間の山(ためる時間 60% + 押し出しの半分)
    expect(at(0.9)).toBe(0);
    expect(at(0.64, { 'charge2.spread': 0.4 })).toBeCloseTo(0.4, 9);
    expect(at(0.59, { 'charge2.pinch': 0 })).toBeCloseTo(0, 12);
    expect(at(0.64, { 'charge2.spread': 0 })).toBe(0);
    // 広げる揺らし方はどれも周期 T で元に戻り(ループ書き出しの前提)、ほかの揺らし方はいつも 0
    expect(new Set(SPREAD_MOTIONS)).toEqual(SPREADING);
    for (const m of SPREADING) {
      // 鼓動の横の広がりは後から足した項目で、既定は 0%(足す前と同じ)
      const pp = m === 'heartbeat' ? { 'heartbeat.spread': 0.2 } : undefined;
      for (const t of [0.05, 0.31, 0.77, 1.2, 1.66]) expect(motionSpread(m, t + 1.7 * 3, 1.7, 0.6, pp), m).toBeCloseTo(motionSpread(m, t, 1.7, 0.6, pp), 9);
      expect(Math.max(...Array.from({ length: 170 }, (_, i) => motionSpread(m, i * 0.01, 1.7, 0.6, pp))), m).toBeGreaterThan(0.05);
    }
    for (const m of Object.keys(MOTIONS) as MotionPattern[]) {
      if (SPREADING.has(m)) continue;
      for (let t = 0; t < T; t += 0.01) expect(motionSpread(m, t, T, 1), m).toBe(0);
    }
  });

  it('横の広がり 0% では広がらず、手前への動きは広がりの設定に関わらない(統合した前の「ためて膨らむ」と同じ動き)', () => {
    for (const t of [0.1, 0.9, 1.25, 1.3, 1.9]) {
      expect(motionSpread('charge2', t, 2, STRENGTH, { 'charge2.spread': 0, 'charge2.pinch': 1 })).toBeCloseTo(0, 12);
      const a = motionAnchor('charge2', t, 2, STRENGTH, undefined, 0.3, { 'charge2.depth': 0.5, 'charge2.bulge': 1, 'charge2.spread': 0 });
      const b = motionAnchor('charge2', t, 2, STRENGTH, undefined, 0.3, { 'charge2.depth': 0.5, 'charge2.bulge': 1, 'charge2.spread': 0.4 });
      expect(b).toEqual(a);
    }
  });

  it('広がりはバネで遅れて付いてきて、離したあとは土台の山より大きく広がって弾む', () => {
    const T = PRESETS.puku.period, rs = spreadCycle(layerOf('puku'), T);
    expect(Math.max(...rs)).toBeGreaterThan(0.2);   // 土台の山(20%)を越えて広がる
    expect(Math.min(...rs)).toBeLessThan(-0.1);     // ためている間は縮む
    // いちばん広がるのは、土台の山(離した瞬間)より後
    const peak = rs.indexOf(Math.max(...rs)) * PHYSICS_DT, kick = 0.64 * T;
    expect(peak).toBeGreaterThan(kick);
    // ためて膨らむでは広がらない
    expect(spreadCycle(layerOf('tame'), T).every(r => r === 0)).toBe(true);
  });

  it('広がりは、つかむ・平行移動では動かず、揺れ無効・非表示・一時停止・自動揺らしOFF で 0 に戻る', () => {
    const l = layerOf('puku'), w = worldOf(2);
    w.autoSwing = { ...w.autoSwing, enabled: false };
    w.grab = { x: 0.3, y: 0.2, z: 0.1 };
    for (let i = 0; i < 60; i++) { w.viewTarget = { x: i * 5, y: 0, z: i * 3 }; w.step([l]); }
    expect(w.spread(l.id)).toBe(0);
    w.grab = null; w.autoSwing = { ...w.autoSwing, enabled: true };
    run(w, [l], 1.3);
    expect(Math.abs(w.spread(l.id))).toBeGreaterThan(0.01);
    l.visible = false; w.step([l]); expect(w.spread(l.id)).toBe(0); l.visible = true;
    run(w, [l], 1.3);
    w.paused = true; w.reset(); expect(w.spread(l.id)).toBe(0); w.paused = false;
    run(w, [l], 1.3);
    w.autoSwing = { ...w.autoSwing, enabled: false };
    run(w, [l], 40);
    expect(Math.abs(w.spread(l.id))).toBeLessThan(1e-4);
  });

  it('広げる揺らし方のほかは塗った範囲の大きさを変えない。ためて膨らむ2 の広がりの計測値の回帰チェック', () => {
    for (const [preset, T] of [['tame', 1.2], ['tame', 2], ['puru', 1.2]] as const) {
      for (const m of Object.keys(MOTIONS) as MotionPattern[]) {
        const rs = spreadCycle(layerOf(preset, m), T);
        if (!SPREADING.has(m)) { expect(rs.every(r => r === 0), m).toBe(true); continue; }
        if (m !== 'charge2') continue;
        const hi = Math.max(...rs), lo = Math.min(...rs);
        // 計測: tame 1.2秒 +13% / -14%、tame 2秒 +28% / -22%、puru 1.2秒 +27% / -19%
        expect(hi, `${preset} ${T}`).toBeGreaterThan(0.1);
        expect(lo, `${preset} ${T}`).toBeLessThan(-0.08);
        expect(hi).toBeLessThan(0.6); expect(lo).toBeGreaterThan(-0.6); // 裏返るほどは縮まない
      }
    }
  });

  it('十分に慣らしたあとは周期ごとに同じ広がりに戻り、記録の再生でもライブと同じになる', () => {
    const l = layerOf('puku'), T = 2, w = worldOf(T);
    run(w, [l], Math.ceil(20 / T) * T);
    const a = w.spread(l.id); run(w, [l], T);
    expect(w.spread(l.id)).toBeCloseTo(a, 4); // おさまりが小さいので、慣らし 20 秒でも 1e-5 程度は残る

    const live = worldOf(T), rec = new MotionRecorder(), rs: number[] = [], n = 700, camera = defaultCamera();
    for (let i = 0; i < n; i++) {
      live.grab = i > 200 && i < 260 ? { x: 0.1, y: 0, z: 0.05 } : null;
      rec.record({ grab: live.grab ? { ...live.grab } : null, grabGains: [], camera, viewTarget: { ...live.viewTarget }, viewCut: live.viewCut }, () => live.snapshot());
      live.step([l]); rs.push(live.spread(l.id));
    }
    const r = rec.lastSeconds(n * PHYSICS_DT - 1.1)!, re = worldOf(T);
    re.restore(r.start);
    for (const smp of r.warmup) { applySample(re, smp); re.step([l]); }
    const start = n - r.samples.length;
    r.samples.forEach((smp, k) => { applySample(re, smp); re.step([l]); expect(re.spread(l.id)).toBe(rs[start + k]); });
  });

  it('自動の揺れの書き出しは決定的で、周期の整数倍で継ぎ目なくループする', async () => {
    const doc = createDocument(image, 'd'), T = 2;
    doc.layers[0].physics = applyPreset(doc.layers[0].physics, 'puku');
    const store = new Store(createProject(doc));
    store.project.autoSwing = { enabled: true, period: T, strength: STRENGTH };
    const once = async () => {
      const rs: number[] = [];
      await runExport({
        stage: { renderFrame: (w: number, h: number) => new Uint8ClampedArray(w * h * 4) } as never, store, recorder: new MotionRecorder(),
        centerOf: () => ({ x: 0, y: 0 }),
        applySwing: (world, d) => { rs.push(world.spread(d.layers[0].id)); },
      }, { format: 'gif', width: 2, height: 2, fps: 30, duration: 2 * T, background: '#fff', motion: 'auto' }, () => {}, new AbortController().signal);
      return rs;
    };
    const a = await once(), b = await once(), per = T * 30;
    expect(a).toEqual(b);
    expect(Math.max(...a)).toBeGreaterThan(0.1);
    for (let i = 0; i < per; i++) expect(a[i + per]).toBeCloseTo(a[i], 4);
  });

  it('広がりの中心: ウェイトで重み付けした重心(何も塗っていなければ中央)', () => {
    const wm = new WeightMap(100, 50);
    expect(wm.centroidUV()).toEqual({ u: 0.5, v: 0.5 });
    // 左上の 10×10 を塗る: 重心は x = 5、上から y = 5
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) wm.data[y * 100 + x] = 255;
    expect(wm.centroidUV().u).toBeCloseTo(5 / 100, 9);
    expect(wm.centroidUV().v).toBeCloseTo(1 - 5 / 50, 9);
    // 右下の1点を薄く塗ると、重心は少しだけそちらへ寄る
    wm.data[49 * 100 + 99] = 64;
    const c = wm.centroidUV();
    expect(c.u).toBeGreaterThan(5 / 100); expect(c.u).toBeLessThan(0.5);
  });
});
