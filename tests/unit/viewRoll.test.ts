import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { wrapAngle, createDocument, createProject, type Layer } from '../../src/model/project';
import { keyCurve, takeToJson, takeFromJson, finalizeTake, type KeyFrame } from '../../src/physics/take';
import { PhysicsWorld, pose } from '../../src/physics/world';
import { serializeProject, deserializeProject } from '../../src/storage/popstage';
import { smoothRoll } from '../../src/ui/smoothRoll';
import type { RecordSample } from '../../src/physics/recorder';

const D = Math.PI / 180;
const image = { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', ext: 'png', width: 100, height: 100 };

describe('視点の傾き(ロール)', () => {
  it('角度を -π 以上 π 未満へ丸める', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI)).toBeCloseTo(-Math.PI);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(-Math.PI);
    expect(wrapAngle(190 * D)).toBeCloseTo(-170 * D);
    expect(wrapAngle(-370 * D)).toBeCloseTo(-10 * D);
  });

  it('傾けると、画面の右・上が手前の軸のまわりに回る(画像は時計回りに傾いて見える)', () => {
    const t = { x: 0, y: 0, z: 0 }, a = pose(t, { yaw: 0, pitch: 0, roll: 0, zoom: 1 }), b = pose(t, { yaw: 0, pitch: 0, roll: Math.PI / 2, zoom: 1 });
    // カメラが反時計回りに 90° 回ると、画面の右は元の上を向く
    expect(b.r.x).toBeCloseTo(a.u.x); expect(b.r.y).toBeCloseTo(a.u.y);
    expect(b.u.x).toBeCloseTo(-a.r.x); expect(b.u.y).toBeCloseTo(-a.r.y);
    expect(b.b).toEqual(a.b);
  });

  it('傾けた勢いで揺れる。中心から遠いほど大きく揺れる', () => {
    const swing = (cx: number) => {
      const l: Layer = createDocument(image, 'd').layers[0];
      l.physics = { ...l.physics, weight: 0 }; l.pop = 10;
      const w = new PhysicsWorld(); w.unitPx = 50; w.centerOf = () => ({ x: cx, y: 0 });
      let max = 0;
      for (let i = 0; i < 60; i++) {
        w.viewAngles = { yaw: 0, pitch: 0, roll: Math.min(i, 20) * 2 * D, zoom: 1 };
        w.step([l]);
        const s = w.displacement(l.id); max = Math.max(max, Math.hypot(s.x, s.y));
      }
      return max;
    };
    expect(swing(0.8)).toBeGreaterThan(swing(0.1));
    expect(swing(0.8)).toBeGreaterThan(1e-3);
  });

  it('キーフレームの間は近いほうの回り方でつなぐ(最後から最初へ戻る区間も)', () => {
    const key = (roll: number): KeyFrame => ({ view: { yaw: 0, pitch: 0, roll: roll * D, zoom: 1, target: { x: 0, y: 0, z: 0 } }, seconds: 1, mode: 'smooth' });
    const c = keyCurve([key(170), key(-170)], 30)!;
    // 170° → -170° は 180° を通る(0° を通って逆回りしない)
    expect(Math.abs(c.at(0.5).roll)).toBeCloseTo(Math.PI, 1);
    expect(Math.abs(c.at(1.5).roll)).toBeCloseTo(Math.PI, 1);
    // 3つで1周するときも、どの区間も 180° より遠回りしない
    const c3 = keyCurve([key(150), key(-150), key(-90)], 30)!;
    const n = 300;
    for (let i = 0; i < n; i++) {
      const a = c3.at((i / n) * c3.total).roll, b = c3.at(((i + 1) / n) * c3.total - 1e-9).roll;
      expect(Math.abs(wrapAngle(b - a))).toBeLessThan(10 * D);
    }
  });

  it('記録の末尾も近いほうの回り方で初めへ寄せる', () => {
    const raw: RecordSample[] = [];
    for (let i = 0; i < 240; i++) {
      const roll = wrapAngle((170 + i * 0.1) * D); // 170° から 194°(-166°)まで回る
      raw.push({ grab: null, grabGains: [], camera: { fov: 30, yaw: 0, pitch: 0, roll, zoom: 1, target: { x: 0, y: 0, z: 0 } }, viewTarget: { x: 0, y: 0, z: 0 } });
    }
    const s = finalizeTake(raw)!.samples;
    for (let i = 1; i < s.length; i++) expect(Math.abs(wrapAngle(s[i].camera.roll - s[i - 1].camera.roll))).toBeLessThan(2 * D);
  });

  it('記録に傾きを保存して戻す。傾きの無い古い記録は 0° で読む', () => {
    const samples: RecordSample[] = Array.from({ length: 120 }, (_, i) => ({
      grab: null, grabGains: [], camera: { fov: 30, yaw: 0, pitch: 0, roll: wrapAngle(i * 3 * D), zoom: 1, target: { x: 0, y: 0, z: 0 } }, viewTarget: { x: 0, y: 0, z: 0 },
    }));
    const json = takeToJson({ samples });
    const back = takeFromJson(JSON.parse(JSON.stringify(json)), 30)!;
    back.samples.forEach((s, i) => expect(wrapAngle(s.camera.roll - samples[i].camera.roll)).toBeCloseTo(0, 5));
    const old = { ...json, samples: json.samples.map(a => a.slice(0, 14)) };
    expect(takeFromJson(old, 30)!.samples.every(s => s.camera.roll === 0)).toBe(true);
  });

  it('.pukupop に視点・お気に入り・キーフレームの傾きを保存して戻す。古いファイルは 0°', async () => {
    const p = createProject(createDocument(image, 'd'));
    p.camera.roll = 0.5;
    const { project: q } = await deserializeProject(serializeProject(p));
    expect(q.camera.roll).toBeCloseTo(0.5);
    // 項目の無い古いファイル
    const doc = { name: 'x', image: { path: 'images/doc-0.png', width: 10, height: 10 }, layers: [{ name: 'L', weights: { path: 'none.png' } }] };
    const old = zipSync({ 'project.json': strToU8(JSON.stringify({ formatVersion: 1, app: 'PopStage', project: { camera: { yaw: 0.3 }, favorites: [] }, documents: [doc] })), 'images/doc-0.png': new Uint8Array([1]) });
    const r = (await deserializeProject(old)).project;
    expect(r.camera.roll).toBe(0); expect(r.camera.yaw).toBeCloseTo(0.3);
    // 範囲外の値は丸める
    const big = zipSync({ 'project.json': strToU8(JSON.stringify({ formatVersion: 1, app: 'PukuPop', project: { camera: { roll: 7 } }, documents: [doc] })), 'images/doc-0.png': new Uint8Array([1]) });
    expect((await deserializeProject(big)).project.camera.roll).toBeCloseTo(wrapAngle(7));
  });

  it('なめらかに回す: 続けて押した分も取りこぼさず、ほかの操作が角度を変えたらやめる', () => {
    let roll = 0, owner = {}, now = 0;
    const queue: ((t: number) => void)[] = [];
    const s = smoothRoll({ get: () => roll, set: r => { roll = r; }, owner: () => owner }, cb => { queue.push(cb); return queue.length; });
    const run = (frames: number) => { for (let i = 0; i < frames && queue.length; i++) { now += 16; queue.shift()!(now); } };
    s.add(15 * D); s.add(15 * D);
    run(3);
    expect(roll).toBeGreaterThan(0); expect(roll).toBeLessThan(30 * D);
    run(200);
    expect(roll).toBeCloseTo(30 * D, 6);
    // 180° を越えても続けて回る
    s.add(170 * D); run(400);
    expect(roll).toBeCloseTo(wrapAngle(200 * D), 6);
    // 途中でリセット(視点を差し替え)されたら止まる
    s.add(15 * D); run(2);
    owner = {}; roll = 0; run(50);
    expect(roll).toBe(0);
  });
});
