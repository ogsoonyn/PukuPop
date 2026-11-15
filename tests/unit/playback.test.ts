import { describe, it, expect } from 'vitest';
import { PhysicsWorld, PHYSICS_DT } from '../../src/physics/world';
import { createDocument, createProject, applyPreset, type CameraState, type Document, type Vec3 } from '../../src/model/project';
import { takeFromKeys, type Take } from '../../src/physics/take';
import type { RecordSample } from '../../src/physics/recorder';
import { StageSwing, BASE_EASE, type PlaybackScene } from '../../src/playback/stageSwing';
import { LoopPlayback, sameView } from '../../src/playback/loopPlayback';
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

const view = (yaw: number, x = 0) => ({ yaw, pitch: 0, roll: 0, zoom: 1, target: { x, y: 0, z: 0 } });
const makeTake = (): Take => takeFromKeys([{ view: view(0, 10), seconds: 1, mode: 'smooth' }, { view: view(0.5, 30), seconds: 1, mode: 'smooth' }], 40)!;

function setup(take: Take | null = makeTake()) {
  const { stage, calls } = fakeStage(), doc = docOf(), project = createProject(doc), world = new PhysicsWorld();
  project.take = take;
  const log: string[] = [], stepped: { sample: RecordSample; seeked: boolean; base: unknown }[] = [];
  const pb = new LoopPlayback(world, stage, () => project, {
    stateChanged: () => log.push(`state:${pb.playing}:${pb.paused}`),
    viewChanged: () => log.push('view'),
    stepped: (sample, snapshot, seeked) => { stepped.push({ sample, seeked, base: snapshot().base }); },
  });
  /** 物理を n 刻み進める(App.frame と同じく、刻みごとに step を呼ぶ) */
  const advance = (n: number) => { for (let i = 0; i < n; i++) { pb.step(); world.step(doc.layers); } };
  return { pb, project, world, stage, calls, log, stepped, advance, doc };
}

describe('記録のループ再生(LoopPlayback)', () => {
  it('始めると視点が記録の初めへ動き、描画の前に rig が当たる。止めると rig を外し、動かしていない視点は止めた所の記録の視点になる', () => {
    const { pb, project, world, calls, log, advance } = setup();
    project.camera.yaw = 1.2; project.camera.fov = 50;
    world.grab = { x: 1, y: 0, z: 0 };
    pb.play();
    const s0 = project.take!.samples[0].camera;
    expect(pb.playing).toBe(true);
    expect(sameView(project.camera, s0)).toBe(true);
    expect(project.camera.fov).toBe(50); // 画角は変えない
    expect(world.grab).toBeNull();
    expect(world.viewCut).toBe(true); // 記録の初めへ飛ぶ分では揺らさない
    expect(log).toEqual(['state:true:false', 'view']);
    advance(30);
    expect(pb.position).toBeCloseTo(30 * PHYSICS_DT, 9);
    pb.applyRig();
    const rig = calls.rig.at(-1)!;
    expect(sameView(rig[0], s0)).toBe(true);
    expect(rig[0].fov).toBe(50); expect(rig[1].fov).toBe(50);
    expect(sameView(rig[1], project.take!.samples[29].camera)).toBe(true);
    expect(pb.view).toBe(pb.cam);
    log.length = 0;
    pb.stop();
    expect(pb.playing).toBe(false);
    expect(sameView(project.camera, project.take!.samples[29].camera)).toBe(true);
    expect(calls.rig.at(-1)).toBeNull();
    expect(calls.camera.at(-1)!.yaw).toBe(project.camera.yaw);
    expect(world.viewRig).toBeNull();
    expect(log).toEqual(['state:false:false', 'view']);
    expect(pb.view).toBeNull();
    expect(pb.position).toBe(0);
    pb.applyRig();
    expect(calls.rig.at(-1)).toBeNull();
    pb.stop(); // 止まっていれば何もしない
    expect(log).toEqual(['state:false:false', 'view']);
  });

  it('再生中に見る視点を動かしていれば、止めてもその視点のまま。基準の視点へ戻せる', () => {
    const { pb, project, advance } = setup();
    pb.play();
    advance(10);
    project.camera.yaw = 2;
    pb.resetView();
    expect(sameView(project.camera, pb.from!)).toBe(true);
    project.camera.yaw = 2;
    pb.stop();
    expect(project.camera.yaw).toBe(2);
  });

  it('シークは1周の中に丸めて揺れを消し、次の刻みで控えを取る印を付ける', () => {
    const { pb, project, world, advance, stepped, log } = setup();
    const n = project.take!.samples.length;
    pb.seek(1); // 再生していなければ何もしない
    expect(pb.index).toBe(0);
    pb.play();
    log.length = 0;
    pb.seek(-PHYSICS_DT);
    expect(pb.index).toBe(n - 1);
    pb.seek((n + 3) * PHYSICS_DT);
    expect(pb.index).toBe(3);
    pb.seek(NaN);
    expect(pb.index).toBe(3);
    expect(world.time).toBe(0);
    expect(log).toEqual([]); // シークでは知らせない
    advance(2);
    expect(stepped.map(s => s.seeked)).toEqual([true, false]);
  });

  it('一時停止中は位置が進まず、続けると進む。止まっているときは一時停止できない', () => {
    const { pb, advance, log } = setup();
    pb.setPaused(true);
    expect(pb.paused).toBe(false);
    pb.play();
    advance(5);
    pb.setPaused(true);
    const at = pb.position;
    advance(10);
    expect(pb.position).toBe(at);
    pb.setPaused(false);
    advance(10);
    expect(pb.position).toBeCloseTo(at + 10 * PHYSICS_DT, 9);
    expect(log.filter(l => l.startsWith('state'))).toEqual(['state:true:false', 'state:true:true', 'state:true:false']);
  });

  it('刻みごとのフックには記録の視点で渡し、見る視点を動かしていれば控えの視点を測り直す印にする', () => {
    const { pb, project, advance, stepped } = setup();
    project.camera.fov = 45;
    pb.play();
    advance(1);
    expect(stepped[0].sample.camera.fov).toBe(45);
    expect(sameView(stepped[0].sample.camera, project.take!.samples[0].camera)).toBe(true);
    expect(stepped[0].sample.snap).toBeUndefined(); // 控えを取るかは記録する側が決める
    advance(1);
    expect(stepped[1].base).not.toBeNull(); // 見る視点が基準のままなら、控えの視点はそのまま
    project.camera.yaw = 3; // 見る視点を動かす
    advance(1);
    expect(stepped[2].base).toBeNull();
  });

  it('記録が無ければ始めず、再生の刻みも入れない。捨てると黙って止まる', () => {
    const e = setup(null);
    e.pb.play();
    expect(e.pb.playing).toBe(false);
    expect(e.pb.step()).toBe(false);
    expect(e.log).toEqual([]);
    const { pb, calls, log, world } = setup();
    pb.play();
    log.length = 0;
    pb.discard();
    expect(pb.playing).toBe(false);
    expect(pb.from).toBeNull();
    expect(world.viewRig).toBeNull();
    expect(calls.rig.at(-1)).toBeNull();
    expect(log).toEqual([]);
  });
});
