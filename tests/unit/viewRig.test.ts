import { describe, it, expect } from 'vitest';
import { PhysicsWorld, PHYSICS_DT, pose, rigPose } from '../../src/physics/world';
import { createDocument, type Layer } from '../../src/model/project';

const image = { bytes: new Uint8Array(), mime: 'image/png', ext: 'png', width: 100, height: 100 };
const layer = (): Layer => { const l = createDocument(image, 'd').layers[0]; l.physics = { ...l.physics, weight: 0 }; l.pop = 30; return l; };
const ang = (yaw: number, pitch: number, zoom: number, roll = 0) => ({ yaw, pitch, roll, zoom });

describe('再生中に画像を動かす(viewRig)', () => {
  it('見る視点が基準のままなら、画像から見た視点は記録の視点と同じ', () => {
    const from = pose({ x: 1, y: 2, z: 0 }, ang(0.3, -0.2, 1.4)), to = pose({ x: -3, y: 0.5, z: 1 }, ang(-0.8, 0.4, 0.7));
    const r = rigPose(from, to, from);
    for (const k of ['e', 'r', 'u', 'b'] as const) {
      expect(r[k].x).toBeCloseTo(to[k].x, 12); expect(r[k].y).toBeCloseTo(to[k].y, 12); expect(r[k].z).toBeCloseTo(to[k].z, 12);
    }
  });

  it('見る視点を動かさなければ、今までの再生(視点を動かす)と同じ揺れになる', () => {
    const l1 = layer(), l2 = { ...l1 }, a = new PhysicsWorld(), b = new PhysicsWorld();
    a.unitPx = b.unitPx = 50;
    const from = { target: { x: 0, y: 0, z: 0 }, view: ang(0, 0, 1.5) };
    for (let i = 0; i < 240; i++) {
      const t = i * PHYSICS_DT, target = { x: 40 * Math.sin(t * 5), y: 10 * t, z: 0 }, view = ang(0.6 * Math.sin(t * 3), 0.3 * Math.cos(t * 2), 1.5 * Math.exp(0.4 * Math.sin(t * 4)));
      a.viewTarget = target; a.viewAngles = view; a.step([l1]);
      b.viewRig = { from, to: { target, view } }; b.viewTarget = { ...from.target }; b.viewAngles = { ...from.view }; b.step([l2]);
      const da = a.displacement(l1.id), db = b.displacement(l2.id);
      expect(db.x).toBeCloseTo(da.x, 9); expect(db.y).toBeCloseTo(da.y, 9); expect(db.z).toBeCloseTo(da.z, 9);
    }
    expect(Math.abs(a.displacement(l1.id).x) + Math.abs(a.displacement(l1.id).y)).toBeGreaterThan(0);
  });

  it('画像が止まっていても、見る視点を動かせば揺れる', () => {
    const l = layer(), w = new PhysicsWorld();
    w.unitPx = 50;
    const from = { target: { x: 0, y: 0, z: 0 }, view: ang(0, 0, 1.5) };
    w.viewRig = { from, to: from };
    let max = 0;
    for (let i = 0; i < 60; i++) { w.viewTarget = { x: i * 2, y: 0, z: 0 }; w.viewAngles = from.view; w.step([l]); max = Math.max(max, Math.abs(w.displacement(l.id).x)); }
    expect(max).toBeGreaterThan(0.01);
  });
});
