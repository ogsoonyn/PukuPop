import { describe, it, expect } from 'vitest';
import { PhysicsWorld, coefficients, PHYSICS_DT } from '../../src/physics/world';
import { motionAnchor } from '../../src/physics/motion';
import { MotionRecorder, applySample } from '../../src/physics/recorder';
import { createDocument, PRESETS, PRESET_ORDER, MOTIONS, MOTION_PARAMS, motionParam, applyPreset, defaultCamera, type Layer, type MotionPattern } from '../../src/model/project';

const image = { bytes: new Uint8Array(), mime: 'image/png', ext: 'png', width: 100, height: 100 };
const layerWith = (patch: Partial<Layer['physics']> = {}): Layer => {
  const l = createDocument(image, 'd').layers[0];
  l.physics = { ...l.physics, ...patch };
  return l;
};
const run = (w: PhysicsWorld, layers: Layer[], seconds: number) => { for (let i = 0; i < seconds / PHYSICS_DT; i++) w.step(layers); };

describe('揺れの物理', () => {
  it('重さだけが効くとき、静止位置は -g·m/k に収束する', () => {
    const l = layerWith({ weight: 0.5 }), w = new PhysicsWorld();
    run(w, [l], 30);
    const { k, m, g } = coefficients(l.physics);
    expect(w.displacement(l.id).y).toBeCloseTo(-g * m / k, 4);
    expect(w.state(l.id).v.y).toBeCloseTo(0, 4);
  });

  it('初速を与えると減衰して止まる', () => {
    const l = layerWith({ weight: 0 }), w = new PhysicsWorld();
    w.state(l.id).v.x = 2;
    run(w, [l], 0.1);
    expect(Math.abs(w.displacement(l.id).x)).toBeGreaterThan(0.01);
    run(w, [l], 40);
    expect(Math.abs(w.displacement(l.id).x)).toBeLessThan(1e-4);
  });

  it('おさまりが大きいほど早く止まる', () => {
    const energyAfter = (damping: number) => {
      const l = layerWith({ weight: 0, damping }), w = new PhysicsWorld();
      w.state(l.id).v.x = 2; run(w, [l], 1.5);
      const s = w.state(l.id); return s.s.x ** 2 + s.v.x ** 2;
    };
    expect(energyAfter(0.9)).toBeLessThan(energyAfter(0.1));
  });

  it('硬いほど細かく速く揺れる(ゼロ交差が多い)', () => {
    const crossings = (hardness: number) => {
      const l = layerWith({ weight: 0, damping: 0, hardness }), w = new PhysicsWorld();
      w.state(l.id).v.x = 1;
      let n = 0, prev = 0;
      for (let i = 0; i < 240; i++) { w.step([l]); const x = w.displacement(l.id).x; if (prev * x < 0) n++; prev = x; }
      return n;
    };
    expect(crossings(PRESETS.buru.hardness)).toBeGreaterThan(crossings(PRESETS.bain.hardness));
  });

  it('つかむとポインタの方向へ引っ張られ、離すと戻る', () => {
    const l = layerWith({ weight: 0 }), w = new PhysicsWorld();
    w.grab = { x: 0.3, y: 0, z: 0 };
    run(w, [l], 5);
    expect(w.displacement(l.id).x).toBeGreaterThan(0.05);
    w.grab = null;
    run(w, [l], 40);
    expect(Math.abs(w.displacement(l.id).x)).toBeLessThan(1e-3);
  });

  it('揺れ無効・非表示のレイヤーは動かない', () => {
    const a = layerWith({ enabled: false, weight: 1 }), w = new PhysicsWorld();
    run(w, [a], 1);
    expect(w.displacement(a.id)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('どの揺らし方も周期 T ごとに同じ位置に戻る(ループ書き出しの前提)', () => {
    for (const m of Object.keys(MOTIONS) as MotionPattern[]) {
      for (const t of [0.05, 0.31, 0.77, 1.2, 1.66]) {
        const p = motionAnchor(m, t, 1.7, 0.6), q = motionAnchor(m, t + 1.7 * 3, 1.7, 0.6);
        expect(q.x, m).toBeCloseTo(p.x, 6); expect(q.y, m).toBeCloseTo(p.y, 6); expect(q.z, m).toBeCloseTo(p.z, 6);
      }
    }
  });

  it('揺らし方の向き: 上下に小刻みは y だけ、鼓動は z だけ、ゆっくり左右は x だけ', () => {
    const axes = (m: MotionPattern) => {
      let x = 0, y = 0, z = 0;
      for (let t = 0; t < 2; t += 0.005) { const p = motionAnchor(m, t, 2, 1); x = Math.max(x, Math.abs(p.x)); y = Math.max(y, Math.abs(p.y)); z = Math.max(z, Math.abs(p.z)); }
      return { x, y, z };
    };
    const j = axes('jiggle'); expect(j.x).toBe(0); expect(j.z).toBe(0); expect(j.y).toBeGreaterThan(0.05);
    const h = axes('heartbeat'); expect(h.x).toBe(0); expect(h.y).toBe(0); expect(h.z).toBeGreaterThan(0.05);
    const s = axes('sway'); expect(s.y).toBe(0); expect(s.z).toBe(0); expect(s.x).toBeGreaterThan(0.05);
    expect(axes('none')).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('ジャンプ: 跳んでいる間は上、着地後は地面(0)', () => {
    const T = 2, at = (u: number) => motionAnchor('jump', u * T, T, 1).y;
    expect(at(0.33)).toBeGreaterThan(0.25); // 跳躍の頂点付近
    expect(at(0.05)).toBeLessThan(0);       // 踏み切り前に沈み込む
    expect(at(0.8)).toBe(0);                // 着地後
  });

  /** プリセットを当てて慣らしたあと、1周期ぶんの変位を記録する */
  const cycle = (preset: keyof typeof PRESETS) => {
    const l = layerWith(); l.physics = applyPreset(l.physics, preset);
    const w = new PhysicsWorld(), T = PRESETS[preset].period;
    w.unitPx = 512; // 長辺 1024px の画像相当
    w.autoSwing = { enabled: true, period: T, strength: 0.5 };
    run(w, [l], Math.ceil(20 / T) * T);
    const xs: number[] = [], ys: number[] = [], zs: number[] = [], rs: number[] = [];
    for (let i = 0; i < Math.round(T / PHYSICS_DT); i++) { w.step([l]); const d = w.displacement(l.id); xs.push(d.x); ys.push(d.y); zs.push(d.z); rs.push(w.spread(l.id)); }
    return { xs, ys, zs, rs, rest: -coefficients(l.physics).g * coefficients(l.physics).m / coefficients(l.physics).k };
  };
  const crossings = (v: number[], c: number) => { let n = 0; for (let i = 1; i < v.length; i++) if ((v[i - 1] - c) * (v[i] - c) < 0) n++; return n; };

  it('ぷるぷる: 横には動かず、上下に何度も震える', () => {
    const { xs, ys, rest } = cycle('puru');
    expect(Math.max(...xs.map(Math.abs))).toBeLessThan(1e-9);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.03);
    expect(crossings(ys, rest)).toBeGreaterThanOrEqual(6);
  });

  it('ばいんばいん: 跳び上がり、着地で静止位置より沈み込んでから上下に弾む', () => {
    const { xs, ys, rest } = cycle('bain');
    expect(Math.max(...xs.map(Math.abs))).toBeLessThan(1e-9);
    expect(Math.max(...ys)).toBeGreaterThan(0.08);           // 跳ぶ
    expect(Math.min(...ys)).toBeLessThan(rest - 0.03);       // 着地で沈み込む
    // 着地後(周期の後半)に静止位置をまたいで何度も弾む
    expect(crossings(ys.slice(Math.round(ys.length * 0.55)), rest)).toBeGreaterThanOrEqual(3);
  });

  it('ためてぼよん: ポップ量をぐーっと縮めてから、元より大きく膨らんで弾む', () => {
    const { zs, xs, ys } = cycle('tame');
    const pop = 80 / 512; // 既定のポップ量 80px を正規化座標へ
    expect(Math.max(...xs.map(Math.abs), ...ys.map(Math.abs))).toBeLessThan(0.02); // 主に手前方向だけ動く
    expect(Math.min(...zs)).toBeLessThan(-0.5 * pop); // 半分以上縮む
    expect(Math.max(...zs)).toBeGreaterThan(0.3 * pop); // 離した勢いで元より 3 割以上膨らむ
    // 縮める量はポップ量に比例する
    expect(motionAnchor('charge', 0.55, 1, 0.5, undefined, 2).z).toBeCloseTo(2 * motionAnchor('charge', 0.55, 1, 0.5, undefined, 1).z, 9);
    expect(motionAnchor('charge', 0.55, 1, 0.5, undefined, 0).z).toBeCloseTo(0, 12);
  });

  it('どのプリセットも発散せず、それぞれ違う動きになる', () => {
    const sig = PRESET_ORDER.map(p => {
      const { xs, ys, zs, rs } = cycle(p);
      const all = [...xs, ...ys, ...zs].map(Math.abs);
      expect(Math.max(...all), p).toBeLessThan(0.6);
      expect(Math.max(...all), p).toBeGreaterThan(0.005);
      return [xs, ys, zs, rs].map(v => (Math.max(...v) - Math.min(...v)).toFixed(3)).join('/') + ':' + crossings(ys, ys[0]);
    });
    expect(new Set(sig).size).toBe(PRESET_ORDER.length);
  });

  it('十分に慣らしたあとは周期ごとに同じ状態に戻る', () => {
    const l = layerWith(), w = new PhysicsWorld();
    w.autoSwing = { enabled: true, period: 1.5, strength: 0.5 };
    run(w, [l], 30);
    const a = { ...w.displacement(l.id) };
    run(w, [l], 1.5);
    const b = w.displacement(l.id);
    expect(b.x).toBeCloseTo(a.x, 3); expect(b.y).toBeCloseTo(a.y, 3);
  });

  it('視点を平行移動すると、画像の動きに遅れて揺れ、止めると戻る', () => {
    const l = layerWith({ weight: 0 }), w = new PhysicsWorld();
    w.unitPx = 50;
    run(w, [l], 0.1);
    expect(w.displacement(l.id).x).toBe(0);
    // 注視点を右へ動かす = 画像は画面上で左へ動く。塗った部分は遅れるので右へずれる
    let maxX = 0;
    for (let i = 0; i < 30; i++) { w.viewTarget = { x: i * 2, y: 0, z: 0 }; w.step([l]); maxX = Math.max(maxX, w.displacement(l.id).x); }
    expect(maxX).toBeGreaterThan(0.01);
    expect(Math.abs(w.displacement(l.id).y)).toBeLessThan(1e-9);
    // 止めた所で反動が出て、その後は収まる
    let minX = 0;
    for (let i = 0; i < 60; i++) { w.step([l]); minX = Math.min(minX, w.displacement(l.id).x); }
    expect(minX).toBeLessThan(-0.01);
    run(w, [l], 40);
    expect(Math.abs(w.displacement(l.id).x)).toBeLessThan(1e-4);
  });

  it('視点が飛んだとき(リセット・一時停止明け)は揺らさない', () => {
    const l = layerWith({ weight: 0 }), w = new PhysicsWorld();
    w.unitPx = 50;
    w.step([l]);
    w.cutView(); w.viewTarget = { x: 500, y: 300, z: 0 };
    run(w, [l], 1);
    expect(w.displacement(l.id)).toEqual({ x: 0, y: 0, z: 0 });
    w.paused = true; w.advance(0.05, [l]);
    w.viewTarget = { x: -500, y: 0, z: 0 };
    w.paused = false; w.advance(0.05, [l]);
    expect(w.displacement(l.id)).toEqual({ x: 0, y: 0, z: 0 });
  });

  describe('回転とズーム', () => {
    /** 視点を from から to へ 0.15 秒で動かして止め、その後 1 秒の変位の最大(成分ごとの絶対値) */
    const flick = (l: Layer, from: Partial<ReturnType<typeof view>>, to: Partial<ReturnType<typeof view>>, w = new PhysicsWorld()) => {
      w.unitPx = 50;
      const a = { ...view(), ...from }, b = { ...view(), ...to }, max = { x: 0, y: 0, z: 0 };
      for (let i = 0; i < 140; i++) {
        const u = Math.min(1, i / 18), m = (k: 'yaw' | 'pitch' | 'zoom') => a[k] + (b[k] - a[k]) * u;
        w.viewAngles = { yaw: m('yaw'), pitch: m('pitch'), roll: 0, zoom: m('zoom') };
        w.step([l]);
        const s = w.displacement(l.id);
        max.x = Math.max(max.x, Math.abs(s.x)); max.y = Math.max(max.y, Math.abs(s.y)); max.z = Math.max(max.z, Math.abs(s.z));
      }
      return max;
    };
    const view = () => ({ yaw: 0, pitch: 0, roll: 0, zoom: 1 });

    it('左右に回すと、ふくらみの高さに応じて横に揺れる。平らなら揺れない', () => {
      const tall = layerWith({ weight: 0 }); tall.pop = 30;
      const low = layerWith({ weight: 0 }); low.pop = 10;
      const flat = layerWith({ weight: 0 }); flat.pop = 0;
      const t = flick(tall, {}, { yaw: 0.8 }), lo = flick(low, {}, { yaw: 0.8 }), f = flick(flat, {}, { yaw: 0.8 });
      expect(t.x).toBeGreaterThan(0.01);
      expect(t.x).toBeGreaterThan(lo.x * 2);
      expect(f.x).toBeLessThan(1e-9);
      expect(t.y).toBeLessThan(1e-9);
    });

    it('上下に回すと縦に揺れる', () => {
      const l = layerWith({ weight: 0 }); l.pop = 30;
      const m = flick(l, {}, { pitch: 0.6 });
      expect(m.y).toBeGreaterThan(0.01);
      expect(m.x).toBeLessThan(1e-9);
    });

    it('回転の中心(注視点)から離れたレイヤーほど大きく揺れる', () => {
      const l = layerWith({ weight: 0 }); l.pop = 10;
      const near = flick(l, {}, { yaw: 0.8 });
      const w = new PhysicsWorld(); w.centerOf = () => ({ x: 0.6, y: 0 });
      const far = flick(l, {}, { yaw: 0.8 }, w);
      expect(far.z).toBeGreaterThan(0.01); // 横にずれた所は、左右に回すと奥行きの向きに動く
      expect(far.x + far.z).toBeGreaterThan((near.x + near.z) * 2);
    });

    it('ズームすると手前・奥の向きに揺れる。拡大率によらず、同じ倍率の変化なら同じだけ揺れる', () => {
      const l = layerWith({ weight: 0 });
      const a = flick(l, { zoom: 1 }, { zoom: 0.8 }), b = flick(l, { zoom: 0.25 }, { zoom: 0.2 });
      expect(a.z).toBeGreaterThan(0.01);
      expect(a.x + a.y).toBeLessThan(1e-9);
      expect(b.z).toBeCloseTo(a.z, 2);
    });

    it('斜めから見ていても、平行移動の揺れは正面から見たときと同じ(画像の向きで同じ量)', () => {
      const pan = (yaw: number, pitch: number) => {
        const l = layerWith({ weight: 0 }), w = new PhysicsWorld(); w.unitPx = 50; l.pop = 20;
        w.viewAngles = { yaw, pitch, roll: 0, zoom: 1 };
        for (let i = 0; i < 40; i++) { w.viewTarget = { x: Math.min(i, 20) * 2, y: Math.min(i, 20), z: 0 }; w.step([l]); }
        return w.displacement(l.id);
      };
      const a = pan(0, 0), b = pan(-0.7, 0.4);
      expect(b.x).toBeCloseTo(a.x, 9); expect(b.y).toBeCloseTo(a.y, 9); expect(b.z).toBeCloseTo(a.z, 9);
      expect(a.x).not.toBe(0);
    });

    it('視点を止めたままポップ量や塗りの重心を変えても揺れない', () => {
      const l = layerWith({ weight: 0 }), w = new PhysicsWorld(); w.unitPx = 50;
      w.viewAngles = { yaw: -0.5, pitch: 0.3, roll: 0, zoom: 1.5 };
      run(w, [l], 0.5);
      l.pop = 400; w.centerOf = () => ({ x: 0.7, y: -0.4 });
      run(w, [l], 0.5);
      expect(w.displacement(l.id)).toEqual({ x: 0, y: 0, z: 0 });
    });

    it('視点が一定の速さで動いている途中で揺れを有効にしたレイヤーは、急に動き出したようには弾まない', () => {
      const l = layerWith({ weight: 0 }), w = new PhysicsWorld(); w.unitPx = 50; l.pop = 15;
      w.centerOf = () => ({ x: 0.6, y: 0 });
      let max = 0;
      for (let i = 0; i < 400; i++) {
        w.viewTarget = { x: i * 0.5, y: 0, z: 0 }; // 一定の速さの平行移動(加速度は 0)
        l.physics.enabled = !(i >= 200 && i < 210);
        w.step([l]);
        if (i >= 210) { const s = w.displacement(l.id); max = Math.max(max, Math.hypot(s.x, s.y, s.z)); }
      }
      expect(max).toBeLessThan(1e-9);
    });

    it('視点が飛んだとき(リセットなど)は、回転・ズームでも揺らさない', () => {
      const l = layerWith({ weight: 0 }), w = new PhysicsWorld(); w.unitPx = 50; l.pop = 30;
      w.step([l]);
      w.cutView(); w.viewAngles = { yaw: 1.2, pitch: -0.5, roll: 0, zoom: 3 };
      run(w, [l], 1);
      expect(w.displacement(l.id)).toEqual({ x: 0, y: 0, z: 0 });
    });
  });

  it('平行移動の途中のスナップショットから復元しても同じ結果になる', () => {
    const l = layerWith({ weight: 0 }), w = new PhysicsWorld();
    w.unitPx = 50;
    const go = (from: number, n: number) => { for (let i = 0; i < n; i++) { w.viewTarget = { x: (from + i) * 3, y: 0, z: 0 }; w.step([l]); } };
    go(0, 10);
    const snap = w.snapshot();
    go(10, 20); const x1 = w.displacement(l.id).x;
    w.restore(snap); go(10, 20);
    expect(w.displacement(l.id).x).toBe(x1);
    expect(x1).not.toBe(0);
  });

  it('スナップショットから復元すると同じ結果になる', () => {
    const l = layerWith(), w = new PhysicsWorld();
    w.autoSwing = { enabled: true, period: 1, strength: 1 };
    run(w, [l], 0.7);
    const snap = w.snapshot();
    run(w, [l], 1); const x1 = w.displacement(l.id).x;
    w.restore(snap); run(w, [l], 1);
    expect(w.displacement(l.id).x).toBe(x1);
  });
});

describe('揺らし方の固有設定', () => {
  const range = (m: MotionPattern, params: Record<string, number>, axis: 'x' | 'y' | 'z', pop = 0) => {
    let lo = 0, hi = 0;
    for (let t = 0; t < 2; t += 0.002) { const v = motionAnchor(m, t, 2, 0.5, undefined, pop, params)[axis]; lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return { lo, hi };
  };

  it('定義の既定値は範囲内、選択式は選択肢の中にある', () => {
    for (const [m, defs] of Object.entries(MOTION_PARAMS)) for (const d of defs) {
      if (d.options) expect(d.options.map(o => o[0]), `${m}.${d.key}`).toContain(d.def);
      else { expect(d.def).toBeGreaterThanOrEqual(d.min); expect(d.def).toBeLessThanOrEqual(d.max); }
      expect(motionParam({}, m as MotionPattern, d.key)).toBe(d.def);
    }
  });

  it('ためる深さ・膨らみの強さが効く', () => {
    expect(range('charge', {}, 'z', 1).lo).toBeCloseTo(-0.7, 2);              // 既定 70%
    expect(range('charge', { 'charge.depth': 1 }, 'z', 1).lo).toBeCloseTo(-1, 2); // 平らまで
    expect(range('charge', { 'charge.depth': 0.3 }, 'z', 1).lo).toBeCloseTo(-0.3, 2);
    expect(range('charge', { 'charge.bulge': 0 }, 'z', 1).hi).toBe(0);
    expect(range('charge', { 'charge.bulge': 1 }, 'z', 1).hi).toBeCloseTo(1, 2);
    // 物理を通しても、膨らみの強さを上げると大きく膨らむ
    const peak = (bulge: number) => {
      const l = layerWith(); l.physics = applyPreset(l.physics, 'tame'); l.physics.motionParams['charge.bulge'] = bulge;
      const w = new PhysicsWorld(); w.unitPx = 512; w.autoSwing = { enabled: true, period: 2, strength: 0.5 };
      run(w, [l], 20); let hi = -1; for (let i = 0; i < 240; i++) { w.step([l]); hi = Math.max(hi, w.displacement(l.id).z); }
      return hi;
    };
    expect(peak(1)).toBeGreaterThan(peak(0) * 1.5);
  });

  it('ジャンプの高さ、伸びる向き、回る向き、震えの細かさが効く', () => {
    expect(range('jump', { 'jump.height': 2 }, 'y').hi).toBeCloseTo(2 * range('jump', {}, 'y').hi, 6);
    const left = range('stretch', { 'stretch.dir': 2 }, 'x');
    expect(left.lo).toBeLessThan(-0.05); expect(left.hi).toBe(0);
    expect(range('stretch', { 'stretch.dir': 2 }, 'y')).toEqual({ lo: 0, hi: 0 });
    expect(range('stretch', { 'stretch.dir': 4 }, 'z').hi).toBeGreaterThan(0.05);
    const cw = motionAnchor('circle', 0.3, 2, 0.5, undefined, 0, { 'circle.dir': -1 }), ccw = motionAnchor('circle', 0.3, 2, 0.5);
    expect(cw.x).toBeCloseTo(-ccw.x, 9); expect(cw.y).toBeCloseTo(ccw.y, 9);
    const zero = (freq: number) => { let n = 0, p = 0; for (let t = 0; t < 2; t += 0.001) { const x = motionAnchor('shiver', t, 2, 0.5, undefined, 0, { 'shiver.freq': freq, 'shiver.wave': 0 }).x; if (p * x < 0) n++; p = x; } return n; };
    expect(zero(16)).toBeGreaterThan(zero(4) * 3);
  });

  it('プリセットを当てると固有設定は既定値に戻る', () => {
    const l = layerWith(); l.physics.motionParams = { 'charge.depth': 0.1 };
    expect(applyPreset(l.physics, 'tame').motionParams).toEqual({});
  });
});

describe('操作の記録', () => {
  it('直近 N 秒を返し、控えから開始点までの記録も付く', () => {
    const rec = new MotionRecorder(), w = new PhysicsWorld(), l = layerWith();
    for (let i = 0; i < 600; i++) {
      rec.record({ grab: i > 300 ? { x: 0.1, y: 0, z: 0 } : null, grabGains: [], camera: defaultCamera() }, () => w.snapshot());
      w.step([l]);
    }
    const r = rec.lastSeconds(2)!;
    expect(r.samples.length).toBe(240);
    expect(r.warmup.length).toBe(0); // 開始点(360)は控え(120の倍数)にちょうど乗る
    const r2 = rec.lastSeconds(1.5)!;
    expect(r2.samples.length).toBe(180);
    expect(r2.warmup.length + r2.samples.length).toBe(600 - 360);
  });

  it('記録から進め直すと、平行移動の揺れ(途中の視点の飛びも含む)がライブと一致する', () => {
    const l = layerWith(), live = new PhysicsWorld(), rec = new MotionRecorder();
    live.unitPx = 50;
    const camera = defaultCamera(), xs: number[] = [];
    const n = 600; // 5 秒。控え(120 刻みごと)をまたいで始める
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0) camera.target = { x: Math.sin(i / 40) * 80, y: (i % 300) * 0.5, z: Math.cos(i / 55) * 20 }; // 描画フレームごとに動く
      if (i === 400) live.cutView(); // 視点のリセット相当
      live.viewTarget = camera.target;
      live.viewAngles = { yaw: camera.yaw, pitch: camera.pitch, roll: 0, zoom: camera.zoom };
      rec.record({ grab: null, grabGains: [], camera: structuredClone(camera), viewCut: live.viewCut }, () => live.snapshot());
      live.step([l]);
      xs.push(live.displacement(l.id).x);
    }
    const r = rec.lastSeconds(n * PHYSICS_DT - 1.3)!;
    expect(r.warmup.length).toBeGreaterThan(0);
    const w = new PhysicsWorld(); w.unitPx = 50;
    w.restore(r.start);
    for (const smp of r.warmup) { applySample(w, smp); w.step([l]); }
    const start = n - r.samples.length;
    r.samples.forEach((smp, k) => { applySample(w, smp); w.step([l]); expect(w.displacement(l.id).x).toBe(xs[start + k]); });
    expect(Math.max(...xs.map(Math.abs))).toBeGreaterThan(0.01);
  });

  it('記録から進め直すと、回転とズームの揺れもライブと一致する', () => {
    const l = layerWith(), live = new PhysicsWorld(), rec = new MotionRecorder();
    l.pop = 30; live.unitPx = 50;
    const camera = defaultCamera(), xs: number[] = [];
    const n = 600;
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0) { camera.yaw = Math.sin(i / 30) * 0.9; camera.pitch = Math.cos(i / 45) * 0.4; camera.zoom = Math.exp(Math.sin(i / 25) * 0.4); }
      live.viewTarget = camera.target;
      live.viewAngles = { yaw: camera.yaw, pitch: camera.pitch, roll: 0, zoom: camera.zoom };
      rec.record({ grab: null, grabGains: [], camera: structuredClone(camera), viewCut: live.viewCut }, () => live.snapshot());
      live.step([l]);
      const s = live.displacement(l.id); xs.push(s.x + s.y + s.z);
    }
    const r = rec.lastSeconds(n * PHYSICS_DT - 1.3)!;
    expect(r.warmup.length).toBeGreaterThan(0);
    const w = new PhysicsWorld(); w.unitPx = 50;
    w.restore(r.start);
    for (const smp of r.warmup) { applySample(w, smp); w.step([l]); }
    const start = n - r.samples.length;
    r.samples.forEach((smp, k) => { applySample(w, smp); w.step([l]); const s = w.displacement(l.id); expect(s.x + s.y + s.z).toBe(xs[start + k]); });
    expect(Math.max(...xs.map(Math.abs))).toBeGreaterThan(0.01);
  });

  it('記録の注視点(「揺らす」で振った量を含む)があればそれを物理へ入れ、無ければ視点の注視点で代える', () => {
    const w = new PhysicsWorld(), camera = defaultCamera();
    camera.target = { x: 5, y: 0, z: 0 };
    applySample(w, { grab: null, grabGains: [], camera, viewTarget: { x: 12, y: 3, z: 0 } });
    expect(w.viewTarget).toEqual({ x: 12, y: 3, z: 0 });
    applySample(w, { grab: null, grabGains: [], camera });
    expect(w.viewTarget).toEqual({ x: 5, y: 0, z: 0 });
  });

  it('カメラは止めたまま、振った量だけ動く記録を再生すると、ライブと同じ揺れになる', () => {
    const l = layerWith(), live = new PhysicsWorld(), rec = new MotionRecorder();
    live.unitPx = 50;
    const camera = defaultCamera(), shake = { x: 0, y: 0, z: 0 }, xs: number[] = [];
    const n = 400;
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0 && i < 200) { shake.x = Math.sin(i / 25) * 60; shake.y = (i % 100) * 0.4; }
      live.viewTarget = { x: camera.target.x + shake.x, y: camera.target.y + shake.y, z: camera.target.z + shake.z };
      live.viewAngles = { yaw: camera.yaw, pitch: camera.pitch, roll: 0, zoom: camera.zoom };
      rec.record({ grab: null, grabGains: [], camera: structuredClone(camera), viewTarget: { ...live.viewTarget }, viewCut: live.viewCut }, () => live.snapshot());
      live.step([l]);
      xs.push(live.displacement(l.id).x);
    }
    const r = rec.lastSeconds(n * PHYSICS_DT - 0.7)!;
    const w = new PhysicsWorld(); w.unitPx = 50;
    w.restore(r.start);
    for (const smp of r.warmup) { applySample(w, smp); w.step([l]); }
    const start = n - r.samples.length;
    r.samples.forEach((smp, k) => { applySample(w, smp); w.step([l]); expect(w.displacement(l.id).x).toBe(xs[start + k]); });
    expect(Math.max(...xs.map(Math.abs))).toBeGreaterThan(0.01);
    expect(r.samples.every(s => s.camera.target.x === 0)).toBe(true); // カメラは動いていない
  });

  it('60秒を超える古い記録は捨てる', () => {
    const rec = new MotionRecorder(), w = new PhysicsWorld();
    for (let i = 0; i < 120 * 70; i++) rec.record({ grab: null, grabGains: [], camera: defaultCamera() }, () => w.snapshot());
    expect(rec.seconds).toBeLessThanOrEqual(61.01);
    expect(rec.seconds).toBeGreaterThanOrEqual(60);
  });
});
