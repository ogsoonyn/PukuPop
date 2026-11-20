import { describe, it, expect } from 'vitest';
import { PhysicsWorld, PHYSICS_DT } from '../../src/physics/world';
import { effectWindow } from '../../src/physics/effect';
import { effectLab } from '../../src/physics/effectLab';
import { motionPushes } from '../../src/physics/motion';
import { createDocument, MOTIONS, EFFECT_MOTIONS, MAX_EFFECT_DRAWS, type Document, type MotionPattern } from '../../src/model/project';
import { StageSwing, effectEnvelope } from '../../src/playback/stageSwing';
import type { PlaybackEffect, PlaybackStage } from '../../src/playback/stageApi';

const image = { bytes: new Uint8Array(), mime: 'image/png', ext: 'png', width: 400, height: 400 };

function docWith(motion: MotionPattern, timing: 'burst' | 'peak' = 'burst', params: Record<string, number> = {}): Document {
  const doc = createDocument(image, 'd'), l = doc.layers[0];
  l.weights.data.fill(255);
  l.pop = 80;
  l.physics = { ...l.physics, motion, preset: 'custom', hardness: 0.5, mass: 0.2, damping: 0.2, motionParams: params };
  l.effect = { ...l.effect, enabled: true, timing };
  return doc;
}

function worldFor(period = 1.2): PhysicsWorld {
  const w = new PhysicsWorld();
  w.unitPx = 200;
  w.autoSwing = { enabled: true, period, strength: 0.8 };
  return w;
}

/** seconds 秒進めて、出た時刻の一覧を返す */
function fires(w: PhysicsWorld, doc: Document, seconds: number): number[] {
  const id = doc.layers[0].id, out: number[] = [];
  let last = -1;
  for (let i = 0, n = Math.round(seconds / PHYSICS_DT); i < n; i++) {
    w.step(doc.layers);
    const b = w.bursts(id);
    const t = b.length ? b[b.length - 1].t : -1;
    if (t !== last && t >= 0) { out.push(t); last = t; }
  }
  return out;
}

describe('膨らんだ瞬間のエフェクトを出す時刻', () => {
  it('押し出す時刻のある揺らし方だけで使える(画面が見る EFFECT_MOTIONS と揃っている)', () => {
    for (const m of Object.keys(MOTIONS) as MotionPattern[]) expect(motionPushes(m).length > 0).toBe(EFFECT_MOTIONS.has(m));
    expect([...EFFECT_MOTIONS].sort()).toEqual(['charge', 'charge2', 'heartbeat', 'puff', 'pulse']);
    expect(motionPushes('charge', { 'charge.time': 0.7 })).toEqual([0.7]);
  });

  /** 揺らし方・周期・固有設定の組み合わせ。perCycle は1周期に出る数 */
  const cases: [MotionPattern, number, number, Record<string, number>][] = [
    ['pulse', 1, 1.2, {}], ['charge', 1, 1.2, {}], ['charge2', 1, 1.2, {}], ['puff', 1, 1.2, {}], ['heartbeat', 2, 1.2, {}],
    // 周期が長い・短い
    ['pulse', 1, 10, {}], ['puff', 1, 10, {}], ['heartbeat', 2, 10, {}], ['charge', 1, 10, {}], ['pulse', 1, 0.3, {}],
    // 固有設定を端に寄せる
    ['pulse', 1, 3, { 'pulse.time': 0.6 }], ['puff', 1, 3, { 'puff.time': 0.8 }], ['puff', 1, 1.2, { 'puff.time': 0.8 }],
    ['puff', 1, 1.2, { 'puff.spread': 0 }], ['charge', 1, 2, { 'charge.time': 0.9 }], ['charge2', 1, 2, { 'charge2.time': 0.2 }],
  ];
  for (const [motion, perCycle, T, params] of cases) {
    for (const timing of ['burst', 'peak'] as const) {
      it(`${motion} 周期${T}秒 ${JSON.stringify(params)}(${timing})は押し出し1回につき1回だけ、毎周期同じ位置で出る`, () => {
        const doc = docWith(motion, timing, params), w = worldFor(T), n = T < 1 ? 12 : 6;
        const ts = fires(w, doc, T * n);
        expect(ts.length).toBe(n * perCycle);
        // 周期の中の位置が毎回同じ(跳ね返りや前の周期の残りの揺れで、出る所が変わらない)。1周目は止まった所から動き出すので比べない
        const phases = ts.map(t => (t / T) % 1);
        for (let i = 2 * perCycle; i < phases.length; i++) expect(Math.abs(phases[i] - phases[i - perCycle]) * T).toBeLessThan(0.02);
        // 押し出す時刻から受け付ける長さの中で出る
        const pushes = motionPushes(motion, params);
        for (const ph of phases) expect(pushes.some(p => { const d = ((ph - p) % 1 + 1) % 1; return d * T <= effectWindow(T); })).toBe(true);
      });
    }
  }

  it('鼓動の拍の間隔が短く2拍の膨らみがつながるときも、毎周期同じ数・同じ位置で出る', () => {
    for (const timing of ['burst', 'peak'] as const) {
      const T = 1.2, ts = fires(worldFor(T), docWith('heartbeat', timing, { 'heartbeat.gap': 0.08 }), T * 6);
      const per = ts.filter(t => t >= T * 2 && t < T * 3).length;
      expect(per).toBeGreaterThanOrEqual(1);
      expect(ts.filter(t => t >= T * 4 && t < T * 5).length).toBe(per);
    }
  });

  it('一番膨らんだときは、膨らみ始めより後に出る', () => {
    const a = fires(worldFor(), docWith('pulse', 'burst'), 1.2)[0], b = fires(worldFor(), docWith('pulse', 'peak'), 1.2)[0];
    expect(b).toBeGreaterThan(a);
  });

  it('切ったレイヤー・自動揺らしを切ったとき・押し出す時刻の無い揺らし方では出ない', () => {
    const off = docWith('pulse'); off.layers[0].effect.enabled = false;
    expect(fires(worldFor(), off, 3)).toEqual([]);
    const w = worldFor(); w.autoSwing.enabled = false;
    expect(fires(w, docWith('pulse'), 3)).toEqual([]);
    expect(fires(worldFor(), docWith('sway'), 3)).toEqual([]);
  });

  it('消えるまでの時間を過ぎると消え、控えから戻すと同じように出る', () => {
    const doc = docWith('pulse'), w = worldFor(), id = doc.layers[0].id;
    fires(w, doc, 0.3);
    expect(w.bursts(id).length).toBe(1);
    const snap = w.snapshot(), w2 = worldFor();
    w2.restore(snap);
    expect(w2.bursts(id)).toEqual(w.bursts(id));
    // 控えから戻した側も同じ時刻で出る
    expect(fires(w2, doc, 2.4)).toEqual(fires(w, doc, 2.4));
    const w3 = worldFor();
    w3.restore(snap);
    fires(w3, doc, doc.layers[0].effect.duration + 0.1);
    expect(w3.bursts(id).length).toBe(0);
  });
});

describe('エフェクトの描き方', () => {
  it('出た直後に濃くなり、広がりながら薄くなって消える', () => {
    const a = effectEnvelope(0, 0.5, 0.3), b = effectEnvelope(0.1, 0.5, 0.3), c = effectEnvelope(0.9, 0.5, 0.3);
    expect(a.alpha).toBe(0);
    expect(b.alpha).toBeGreaterThan(c.alpha);
    expect(c.scale).toBeGreaterThan(b.scale);
    expect(effectEnvelope(1, 0.5, 0.3).alpha).toBeCloseTo(0, 9);
    expect(effectEnvelope(1, 0.5, 0.3).scale).toBeCloseTo(1.3, 9);
  });

  it('出したときの形を、レイヤーの番号・重心・色・重ね方と一緒に Stage へ渡す', () => {
    const doc = docWith('pulse'), w = worldFor(), l = doc.layers[0];
    l.effect = { ...l.effect, ring: true, color: 'custom', customColor: '#ff0000', blend: 'add' };
    const got: PlaybackEffect[][] = [];
    const stage: PlaybackStage = {
      setSwing() {}, setSpread() {}, setBaseOffset() {}, setBaseReach() {}, setRig() {}, applyCamera() {},
      setEffects: list => { got.push([...list]); },
    };
    const sw = new StageSwing(stage, { doc, centers: new Map() });
    fires(w, doc, 0.35);
    sw.applySwing(w, doc);
    const e = got.at(-1)!;
    expect(e.length).toBe(1);
    const b = w.bursts(l.id)[0], k = 200;
    expect(e[0].index).toBe(0);
    expect(e[0].swing.z).toBeCloseTo(b.s.z * k, 9);
    expect(e[0].ring).toBe(true);
    expect(e[0].additive).toBe(true);
    expect(e[0].tint).toEqual([1, 0, 0]);
    expect(e[0].alpha).toBeGreaterThan(0);
    // 多すぎるときは、レイヤーをまたいで新しいものを残し、古い順に渡す
    l.effect.duration = 1.5;
    for (let j = 0; j < 7; j++) { const l2 = { ...l, id: `L${j}`, effect: { ...l.effect } }; doc.layers.push(l2); }
    const w2 = worldFor(0.5);
    fires(w2, doc, 0.5 * 6 + 0.2);
    sw.applySwing(w2, doc);
    const many = got.at(-1)!;
    expect(many.length).toBe(MAX_EFFECT_DRAWS);
    expect(new Set(many.map(x => x.index)).size).toBe(8);
    // 古い順(広がりが大きい順)に並ぶ
    for (let j = 1; j < many.length; j++) expect(many[j].scale).toBeLessThanOrEqual(many[j - 1].scale + 1e-9);
    doc.layers.length = 1;
    // 隠したレイヤーは出さない
    l.visible = false;
    sw.applySwing(w, doc);
    expect(got.at(-1)).toEqual([]);
  });
});

describe('手前への揺れ具合で出す(テストページの forward、実験)', () => {
  const withForward = (f: () => void) => { const m = effectLab.mode; effectLab.mode = 'forward'; try { f(); } finally { effectLab.mode = m; } };
  it('膨らむ揺らし方は1周期に1回、左右に揺れるだけでは出ない', () => withForward(() => {
    const T = 1.2;
    for (const timing of ['burst', 'peak'] as const) expect(fires(worldFor(T), docWith('pulse', timing), T * 6).filter(t => t >= T * 2).length).toBe(4);
    expect(fires(worldFor(T), docWith('sway'), T * 6)).toEqual([]);
  }));
  it('手で手前へ押して離すと、揺れ返しでは出さず1回だけ出す(揺らし方を問わない)', () => withForward(() => {
    for (const motion of ['sway', 'pulse'] as MotionPattern[]) {
      const doc = docWith(motion), w = worldFor(); w.autoSwing.enabled = false;
      const id = doc.layers[0].id, seen = new Set<number>();
      for (let i = 0; i < 360; i++) {
        w.grab = i < 15 ? { x: 0, y: 0, z: -0.3 * (i / 15) } : i < 30 ? { x: 0, y: 0, z: -0.3 } : null;
        w.step(doc.layers);
        for (const b of w.bursts(id)) seen.add(b.t);
      }
      expect(seen.size).toBe(1);
    }
  }));
});
