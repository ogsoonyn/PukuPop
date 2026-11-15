import { describe, it, expect } from 'vitest';
import { PhysicsWorld, PHYSICS_DT } from '../../src/physics/world';
import { createDocument, applyPreset, type CameraState, type Document, type Vec3 } from '../../src/model/project';
import { StageSwing, BASE_EASE, type PlaybackScene } from '../../src/playback/stageSwing';
import type { PlaybackStage } from '../../src/playback/stageApi';

/** Stage の偽物。再生のつなぎが呼んだものを控える(three.js を import しない) */
function fakeStage() {
  const calls = {
    swing: new Map<number, { s: Vec3; visible: boolean }>(),
    spread: new Map<number, { center: { x: number; y: number }; r: number }>(),
    base: [] as Vec3[],
    reach: [] as number[],
    rig: [] as ([CameraState, CameraState] | null)[],
    camera: [] as CameraState[],
  };
  const stage: PlaybackStage = {
    setSwing: (i, s, visible) => { calls.swing.set(i, { s: { ...s }, visible }); },
    setSpread: (i, center, r) => { calls.spread.set(i, { center: { ...center }, r }); },
    setBaseOffset: v => { calls.base.push({ ...v }); },
    setBaseReach: px => { calls.reach.push(px); },
    setRig: (from, to) => { calls.rig.push(from && to ? [structuredClone(from), structuredClone(to)] : null); },
    applyCamera: c => { calls.camera.push(structuredClone(c)); },
  };
  return { stage, calls };
}

const image = { bytes: new Uint8Array(), mime: 'image/png', ext: 'png', width: 400, height: 200 };
const docOf = (): Document => createDocument(image, 'd');
const sceneOf = (doc: Document | undefined): PlaybackScene => ({ doc, centers: new Map() });
const run = (w: PhysicsWorld, doc: Document, seconds: number) => { for (let i = 0, n = Math.round(seconds / PHYSICS_DT); i < n; i++) w.step(doc.layers); };

describe('物理から描画へのつなぎ(StageSwing)', () => {
  it('揺れを元画像のピクセル(長い辺の半分を 1)にして当て、隠したレイヤー・揺れを切ったレイヤーは揺らさない', () => {
    const { stage, calls } = fakeStage(), doc = docOf(), w = new PhysicsWorld();
    doc.layers[0].weights.data.fill(255);
    const sw = new StageSwing(stage, sceneOf(doc));
    w.unitPx = 200;
    w.grab = { x: 0.1, y: 0, z: 0 };
    w.grabGains = new Map([[doc.layers[0].id, 1]]);
    run(w, doc, 0.2);
    sw.applySwing(w, doc);
    const d = w.displacement(doc.layers[0].id), got = calls.swing.get(0)!;
    expect(got.s.x).toBeCloseTo(d.x * 200, 9);
    expect(got.visible).toBe(true);
    doc.layers[0].visible = false;
    sw.applySwing(w, doc);
    expect(calls.swing.get(0)!.visible).toBe(false);
  });

  it('重心は控えを使い回し、控えが捨てられたら求め直す。ドキュメントが無ければ 0', () => {
    const { stage } = fakeStage(), doc = docOf(), scene = sceneOf(doc), sw = new StageSwing(stage, scene);
    const wm = doc.layers[0].weights;
    // 右半分だけ塗る
    for (let y = 0; y < wm.height; y++) for (let x = wm.width / 2; x < wm.width; x++) wm.data[y * wm.width + x] = 255;
    const c = sw.layerCenter(doc, doc.layers[0]);
    expect(c.x).toBeGreaterThan(0);
    expect(scene.centers.get(doc.layers[0].id)).toBe(c);
    // 正規化座標(長い辺の半分を 1)
    expect(sw.centerOf(doc.layers[0]).x).toBeCloseTo(c.x / 200, 9);
    wm.data.fill(0);
    expect(sw.layerCenter(doc, doc.layers[0])).toBe(c); // 控えがあるうちは求め直さない
    scene.centers.clear();
    expect(sw.layerCenter(doc, doc.layers[0])).not.toBe(c);
    expect(new StageSwing(stage, sceneOf(undefined)).centerOf(doc.layers[0])).toEqual({ x: 0, y: 0 });
  });

  it('画像全体のずれ(ピストン)は、止めている間は止めた所に留まり、戻すと BASE_EASE でならして動きに戻る', () => {
    const { stage, calls } = fakeStage(), doc = docOf(), sw = new StageSwing(stage, sceneOf(doc)), w = new PhysicsWorld();
    const l = doc.layers[0];
    l.weights.data.fill(255);
    l.physics = applyPreset(l.physics, 'zun');
    w.unitPx = 200;
    w.autoSwing = { enabled: true, period: 1.2, strength: 0.5 };
    // 切り替えの飛びをならし終えるまで回す
    for (let i = 0; i < 120; i++) { run(w, doc, 1 / 60); sw.showBase(1 / 60, w, doc); }
    for (let i = 0; i < 60 && !sw.shifted; i++) { run(w, doc, 1 / 60); sw.showBase(1 / 60, w, doc); }
    expect(sw.shifted).toBe(true);
    expect(sw.base.fix).toEqual({ x: 0, y: 0, z: 0 });
    expect(calls.base.at(-1)).toEqual(sw.base.shown);
    sw.holdImage(true);
    const held = { ...sw.base.shown };
    for (let i = 0; i < 20; i++) { run(w, doc, 1 / 60); sw.showBase(1 / 60, w, doc); }
    expect(sw.base.shown).toEqual(held);
    sw.holdImage(false);
    const fix0 = Math.abs(sw.base.fix.y);
    run(w, doc, 1 / 60); sw.showBase(1 / 60, w, doc);
    expect(Math.abs(sw.base.fix.y)).toBeCloseTo(fix0 * Math.exp(-(1 / 60) / BASE_EASE), 6);
    sw.resetBase();
    expect(sw.base.shown).toEqual({ x: 0, y: 0, z: 0 });
    expect(sw.shifted).toBe(false);
  });

  it('静止画用には、ならした画像全体のずれを当て直す', () => {
    const { stage, calls } = fakeStage(), doc = docOf(), sw = new StageSwing(stage, sceneOf(doc)), w = new PhysicsWorld();
    sw.base.shown = { x: 1, y: 2, z: 3 };
    sw.applyShown(w, doc);
    expect(calls.base.at(-1)).toEqual({ x: 1, y: 2, z: 3 });
  });
});
