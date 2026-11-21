import { describe, it, expect } from 'vitest';
import { PhysicsWorld, PHYSICS_DT } from '../../src/physics/world';
import { createDocument, PRESETS, MAX_EFFECT_DRAWS, type Document, type MotionPattern } from '../../src/model/project';
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

function presetDoc(preset: keyof typeof PRESETS, timing: 'burst' | 'peak'): Document {
  const doc = createDocument(image, 'd'), l = doc.layers[0], p = PRESETS[preset];
  l.weights.data.fill(255);
  l.pop = 80;
  l.physics = { ...l.physics, motion: p.motion, preset, hardness: p.hardness, mass: p.mass, damping: p.damping, motionParams: {} };
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
  /** プリセット・周期・タイミングの組み合わせ(出る勢いは既定の 2) */
  const cases: [keyof typeof PRESETS, number, ('burst' | 'peak')[]][] = [
    ['pon', 1.2, ['burst', 'peak']], ['tame', 2, ['burst', 'peak']], ['puku', 2, ['burst', 'peak']], ['doki', 1, ['burst', 'peak']], ['pofu', 1.6, ['burst', 'peak']], ['puu', 2.4, ['burst', 'peak']],
    // 周期が短い・長い
    ['pon', 0.6, ['burst', 'peak']], ['tame', 6, ['burst', 'peak']],
  ];
  for (const [preset, T, timings] of cases) {
    for (const timing of timings) {
      it(`${PRESETS[preset].label} 周期${T}秒(${timing})は1周期に1回、毎周期同じ位置で出る`, () => {
        const doc = presetDoc(preset, timing), w = worldFor(T), n = T < 1 ? 12 : 6;
        // 1周目は止まった所から動き出すので数えない
        const ts = fires(w, doc, T * n).filter(t => t >= T);
        expect(ts.length).toBe(n - 1);
        const phases = ts.map(t => (t / T) % 1);
        for (let i = 1; i < phases.length; i++) expect(Math.abs(phases[i] - phases[i - 1]) * T).toBeLessThan(0.02);
      });
    }
  }

  it('ぷくーっ(ゆっくり膨らむ): 一番膨らんだときは一番膨らんだ所で出る。膨らみ始めは膨らむ速さが出る勢いに届かず、しゅっと戻ったあとの跳ね返りで出る', () => {
    const T = PRESETS.puu.period, time = 0.6, ret = 0.06;
    const phase = (timing: 'burst' | 'peak') => (fires(worldFor(T), presetDoc('puu', timing), T * 4).filter(t => t >= T)[0] / T) % 1;
    expect(phase('peak')).toBeGreaterThan(time - 0.02);
    expect(phase('peak')).toBeLessThan(time + ret);
    expect(phase('burst')).toBeGreaterThan(time + ret);
  });

  it('一番膨らんだときは、膨らみ始めより後に出る', () => {
    const a = fires(worldFor(), presetDoc('pon', 'burst'), 1.2)[0], b = fires(worldFor(), presetDoc('pon', 'peak'), 1.2)[0];
    expect(b).toBeGreaterThan(a);
  });

  it('切ったレイヤー・自動揺らしを切って止まっているとき・手前に動かない揺らし方では出ない', () => {
    const off = presetDoc('pon', 'burst'); off.layers[0].effect.enabled = false;
    expect(fires(worldFor(), off, 3)).toEqual([]);
    const w = worldFor(); w.autoSwing.enabled = false;
    expect(fires(w, presetDoc('pon', 'burst'), 3)).toEqual([]);
    for (const m of ['sway', 'shake', 'jump', 'bounce', 'float'] as MotionPattern[]) expect(fires(worldFor(), docWith(m), 3)).toEqual([]);
  });

  it('手で手前へ押して離すと、揺らし方を問わず1回だけ出し、減衰中の揺れ返しでは出さない', () => {
    for (const motion of ['sway', 'pulse', 'jiggle'] as MotionPattern[]) {
      for (const timing of ['burst', 'peak'] as const) {
        const doc = docWith(motion, timing), w = worldFor(); w.autoSwing.enabled = false;
        const id = doc.layers[0].id, seen = new Set<number>();
        for (let i = 0; i < 360; i++) {
          w.grab = i < 15 ? { x: 0, y: 0, z: -0.3 * (i / 15) } : i < 30 ? { x: 0, y: 0, z: -0.3 } : null;
          w.step(doc.layers);
          for (const b of w.bursts(id)) seen.add(b.t);
        }
        expect(seen.size, `${motion} ${timing}`).toBe(1);
      }
    }
  });

  it('弱く押したときは出さず、出る勢いを下げると出る', () => {
    const run = (burstMin: number) => {
      const doc = docWith('sway'), w = worldFor(); w.autoSwing.enabled = false;
      doc.layers[0].effect.burstMin = burstMin;
      const id = doc.layers[0].id;
      let n = 0;
      for (let i = 0; i < 240; i++) {
        w.grab = i < 15 ? { x: 0, y: 0, z: -0.02 * (i / 15) } : i < 30 ? { x: 0, y: 0, z: -0.02 } : null;
        w.step(doc.layers);
        n = Math.max(n, w.bursts(id).length);
      }
      return n;
    };
    expect(run(2)).toBe(0);
    expect(run(0.5)).toBe(1);
  });

  it('消えるまでの時間を過ぎると消え、控えから戻すと同じように出る', () => {
    const doc = presetDoc('pon', 'burst'), w = worldFor(), id = doc.layers[0].id;
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
    const doc = presetDoc('pon', 'burst'), w = worldFor(), l = doc.layers[0];
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
