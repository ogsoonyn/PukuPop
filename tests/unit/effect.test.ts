import { describe, it, expect } from 'vitest';
import { strToU8, strFromU8, unzipSync, zipSync } from 'fflate';
import { PhysicsWorld, PHYSICS_DT } from '../../src/physics/world';
import { EFFECT_WINDOW } from '../../src/physics/effect';
import { motionPushes, hasPush } from '../../src/physics/motion';
import { createDocument, createProject, type Document, type MotionPattern, type Vec3 } from '../../src/model/project';
import { StageSwing, effectEnvelope } from '../../src/playback/stageSwing';
import type { PlaybackEffect, PlaybackStage } from '../../src/playback/stageApi';
import { serializeProject, deserializeProject } from '../../src/storage/popstage';

const image = { bytes: new Uint8Array(), mime: 'image/png', ext: 'png', width: 400, height: 400 };

function docWith(motion: MotionPattern, timing: 'burst' | 'peak' = 'burst'): Document {
  const doc = createDocument(image, 'd'), l = doc.layers[0];
  l.weights.data.fill(255);
  l.pop = 80;
  l.physics = { ...l.physics, motion, preset: 'custom', hardness: 0.5, mass: 0.2, damping: 0.2 };
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
  it('押し出す時刻のある揺らし方だけで使える', () => {
    expect(hasPush('pulse')).toBe(true);
    expect(hasPush('heartbeat')).toBe(true);
    expect(hasPush('charge')).toBe(true);
    expect(hasPush('charge2')).toBe(true);
    expect(hasPush('puff')).toBe(true);
    for (const m of ['sway', 'shake', 'float', 'jiggle', 'piston', 'none'] as MotionPattern[]) expect(hasPush(m)).toBe(false);
    expect(motionPushes('charge', { 'charge.time': 0.7 })).toEqual([0.7]);
  });

  for (const [motion, perCycle] of [['pulse', 1], ['charge', 1], ['charge2', 1], ['puff', 1], ['heartbeat', 2]] as const) {
    for (const timing of ['burst', 'peak'] as const) {
      it(`${motion}(${timing})は押し出し1回につき1回だけ、毎周期同じ位置で出る`, () => {
        const T = 1.2, doc = docWith(motion, timing), w = worldFor(T);
        const ts = fires(w, doc, T * 6);
        expect(ts.length).toBe(6 * perCycle);
        // 周期の中の位置が毎回同じ(跳ね返りで出たり出なかったりしない)
        const phases = ts.map(t => (t / T) % 1);
        // 1周目は止まった所から動き出すので比べない
        for (let i = 2 * perCycle; i < phases.length; i++) expect(Math.abs(phases[i] - phases[i - perCycle])).toBeLessThan(0.02);
        // 押し出す時刻から受け付ける長さの中で出る
        const pushes = motionPushes(motion);
        for (const ph of phases) expect(pushes.some(p => { const d = ((ph - p) % 1 + 1) % 1; return d * T <= EFFECT_WINDOW; })).toBe(true);
      });
    }
  }

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
    // 隠したレイヤーは出さない
    l.visible = false;
    sw.applySwing(w, doc);
    expect(got.at(-1)).toEqual([]);
  });
});

describe('エフェクトの保存', () => {
  it('保存して読むと戻り、項目の無い古いファイルは切ったものとして読む。形の合わない値は既定値', async () => {
    const doc = createDocument({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', ext: 'png', width: 40, height: 20 }, 'p');
    doc.layers[0].effect = { enabled: true, ring: true, timing: 'peak', opacity: 0.8, spread: 0.5, duration: 1.2, color: 'custom', customColor: '#12ab34', blend: 'add' };
    const bytes = serializeProject(createProject(doc));
    const back = await deserializeProject(bytes);
    expect(back.project.documents[0].layers[0].effect).toEqual(doc.layers[0].effect);

    const files = unzipSync(bytes), json = JSON.parse(strFromU8(files['project.json']));
    delete json.documents[0].layers[0].effect;
    const old = await deserializeProject(zipSync({ ...files, 'project.json': strToU8(JSON.stringify(json)) }));
    expect(old.project.documents[0].layers[0].effect.enabled).toBe(false);

    json.documents[0].layers[0].effect = { enabled: 'yes', timing: 'later', opacity: 9, spread: -1, duration: 'x', color: 'red', customColor: 'url(x)', blend: 'screen' };
    const bad = (await deserializeProject(zipSync({ ...files, 'project.json': strToU8(JSON.stringify(json)) }))).project.documents[0].layers[0].effect;
    expect(bad).toEqual({ enabled: false, ring: false, timing: 'burst', opacity: 1, spread: 0.05, duration: 0.55, color: 'white', customColor: '#ff8ab8', blend: 'normal' });
  });
});

export type { Vec3 };
