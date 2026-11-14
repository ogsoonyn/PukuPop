import { describe, it, expect } from 'vitest';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { finalizeTake, takeToJson, takeFromJson, takeSeconds, TAKE_STEP_MULTIPLE, moveKey, type Take, type KeyFrame } from '../../src/physics/take';
import type { RecordSample } from '../../src/physics/recorder';
import { PHYSICS_DT } from '../../src/physics/world';
import { serializeProject, deserializeProject, TAKE_PATH } from '../../src/storage/popstage';
import { createDocument, createProject } from '../../src/model/project';

const cam = (yaw = 0, tx = 0) => ({ fov: 30, yaw, pitch: 0.1, zoom: 1.5, target: { x: tx, y: 0, z: 0 } });
const smp = (yaw: number, tx = 0, grab: RecordSample['grab'] = null): RecordSample => ({
  grab, grabGains: grab ? [['L1', 0.5]] : [], camera: cam(yaw, tx), viewTarget: { x: tx, y: 0, z: 0 },
});
const seconds = (s: number) => Math.round(s / PHYSICS_DT);

describe('操作の記録を整える', () => {
  it('初めの何もしていない所を詰め、終わりは1秒だけ残し、長さを刻みの倍数にそろえる', () => {
    const raw: RecordSample[] = [];
    for (let i = 0; i < seconds(2); i++) raw.push(smp(0));            // 何もしていない2秒
    for (let i = 0; i < seconds(1.5) + 3; i++) raw.push(smp(i * 0.01)); // 回した1.5秒ちょっと
    const lastYaw = raw.at(-1)!.camera.yaw;
    for (let i = 0; i < seconds(5); i++) raw.push(smp(lastYaw));      // 止めるまでの5秒
    const take = finalizeTake(raw)!;
    expect(take.samples.length % TAKE_STEP_MULTIPLE).toBe(0);
    const len = takeSeconds(take);
    expect(len).toBeGreaterThan(2.4); expect(len).toBeLessThan(2.6);
  });

  it('終わりを初めの視点へ寄せて、継ぎ目で飛ばないようにする(1周回っていても巻き戻さない)', () => {
    const raw: RecordSample[] = [];
    const n = seconds(3);
    for (let i = 0; i < n; i++) raw.push(smp((i / n) * Math.PI * 2 + 0.3 + (i * 0.0001), i * 0.1));
    const take = finalizeTake(raw)!, s = take.samples, first = s[0], last = s.at(-1)!;
    const TAU = Math.PI * 2, dyaw = last.camera.yaw - first.camera.yaw;
    // 同じ向きへ寄る(差は 2π の整数倍にごく近い)
    expect(Math.abs(dyaw - TAU * Math.round(dyaw / TAU))).toBeLessThan(0.05);
    expect(Math.round(dyaw / TAU)).toBe(1);
    expect(Math.abs(last.camera.target.x - first.camera.target.x)).toBeLessThan(1);
    expect(Math.abs(last.viewTarget!.x - first.viewTarget!.x)).toBeLessThan(1);
    // 元の並びは書き換えない
    expect(raw.at(-1)!.camera.target.x).toBeCloseTo((n - 1) * 0.1);
  });

  it('短すぎる記録は捨てる', () => {
    expect(finalizeTake(Array.from({ length: 20 }, (_, i) => smp(i * 0.1)))).toBeNull();
    expect(finalizeTake(Array.from({ length: seconds(3) }, () => smp(0)))).toBeNull();
  });
});

describe('操作の記録の保存', () => {
  const makeTake = (): Take => finalizeTake(Array.from({ length: seconds(1) }, (_, i) => smp(i * 0.01, i, i > 30 && i < 80 ? { x: 0.1, y: -0.2, z: 0 } : null)))!;

  it('JSON の往復で中身が変わらない(画角は読み込み側の値)', () => {
    const take = makeTake(), back = takeFromJson(JSON.parse(JSON.stringify(takeToJson(take))), 42)!;
    expect(back.samples.length).toBe(take.samples.length);
    back.samples.forEach((b, i) => {
      const a = take.samples[i];
      expect(b.camera.fov).toBe(42);
      expect(b.camera.yaw).toBeCloseTo(a.camera.yaw, 5);
      expect(b.camera.target.x).toBeCloseTo(a.camera.target.x, 5);
      expect(b.viewTarget!.x).toBeCloseTo(a.viewTarget!.x, 5);
      expect(b.grab === null).toBe(a.grab === null);
      expect(b.grabGains).toEqual(a.grabGains);
    });
    // つかみの効き具合は組にまとめて持つ
    expect(takeToJson(take).gainSets.length).toBe(1);
  });

  it('細工した記録でも、つかみの組は上限まで・サンプル間で共有して読み、長さは刻みの倍数に切り捨てる', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => [`L${i}`, 0.5]);
    const row = [0, 0, 1, 0, 0, 0, 0, 0, 0, 0.1, 0, 0, 0, 0];
    const t = takeFromJson({ version: 1, gainSets: [huge, ...Array(100000).fill([])], samples: Array.from({ length: 61 + 60 }, () => row) }, 30)!;
    expect(t.samples.length).toBe(120);
    expect(t.samples[0].grabGains.length).toBe(8);
    expect(t.samples[0].grabGains).toBe(t.samples[1].grabGains);
  });

  it('最長を超えて積まれた記録は最長で切る', () => {
    const t = finalizeTake(Array.from({ length: seconds(60) + 11 }, (_, i) => smp(i * 0.001)))!;
    expect(t.samples.length).toBeLessThanOrEqual(seconds(60));
    expect(takeFromJson(JSON.parse(JSON.stringify(takeToJson(t))), 30)).not.toBeNull();
  });

  it('壊れた記録は読まない', () => {
    expect(takeFromJson(null, 30)).toBeNull();
    expect(takeFromJson({ version: 2, samples: [] }, 30)).toBeNull();
    expect(takeFromJson({ version: 1, dt: 1 / 60, samples: [] }, 30)).toBeNull();
    expect(takeFromJson({ version: 1, samples: [[1, 2, 3]] }, 30)).toBeNull();
    expect(takeFromJson({ version: 1, samples: Array.from({ length: 10000 }, () => Array(14).fill(0)) }, 30)).toBeNull();
  });

  it('.pukupop に入れて読み戻せる。記録の無いファイル・読めない記録は記録なしで開く', async () => {
    const doc = createDocument({ bytes: new Uint8Array([9, 8, 7, 6]), mime: 'image/jpeg', ext: 'jpg', width: 300, height: 200 }, 'プリン');
    const p = createProject(doc);
    expect((await deserializeProject(serializeProject(p))).project.take).toBeNull();
    expect(unzipSync(serializeProject(p))[TAKE_PATH]).toBeUndefined();

    p.take = makeTake();
    const bytes = serializeProject(p), back = (await deserializeProject(bytes)).project;
    expect(back.take?.samples.length).toBe(p.take.samples.length);

    const broken = zipSync({ ...unzipSync(bytes), [TAKE_PATH]: strToU8('{oops') });
    const opened = (await deserializeProject(broken)).project;
    expect(opened.take).toBeNull();
    expect(opened.documents[0].name).toBe('プリン');
  });
});

describe('キーフレームから動きを作る', () => {
  const view = (yaw: number, zoom = 1, tx = 0) => ({ yaw, pitch: 0, zoom, target: { x: tx, y: 0, z: 0 } });

  it('なめらか2つは往復になり、端でゆっくり止まる。ズームは比で補間する', async () => {
    const { takeFromKeys, TAKE_STEP_MULTIPLE } = await import('../../src/physics/take');
    const t = takeFromKeys([{ view: view(0, 1), seconds: 1, mode: 'smooth' }, { view: view(1, 4, 100), seconds: 1, mode: 'smooth' }], 30)!;
    const s = t.samples, n = s.length;
    expect(n).toBe(seconds(2)); expect(n % TAKE_STEP_MULTIPLE).toBe(0);
    expect(s[0].camera.yaw).toBeCloseTo(0); expect(s[n / 2].camera.yaw).toBeCloseTo(1);
    expect(s[n / 2].camera.zoom).toBeCloseTo(4); expect(s[n / 2].viewTarget!.x).toBeCloseTo(100);
    expect(s[n / 4].camera.zoom).toBeCloseTo(2, 1);
    expect(Math.abs(s[1].camera.yaw - s[0].camera.yaw)).toBeLessThan(1e-3);
    expect(s[0].camera.fov).toBe(30);
    expect(t.keys?.length).toBe(2);
  });

  it('経路を描く曲線は各フレームの時刻にそのフレームを通り、記録と同じ動きになる', async () => {
    const { keyCurve, takeFromKeys } = await import('../../src/physics/take');
    const keys = [
      { view: view(0, 1, 0), seconds: 1, mode: 'smooth' as const }, { view: view(1, 2, 50), seconds: 0.5, mode: 'bounce' as const },
      { view: view(-1, 1.5, -30), seconds: 1.5, mode: 'smooth' as const },
    ];
    const c = keyCurve(keys, 30)!;
    expect(c.total).toBeCloseTo(3); expect(c.starts).toEqual([0, 1, 1.5]);
    keys.forEach((k, i) => {
      const v = c.at(c.starts[i]);
      expect(v.yaw).toBeCloseTo(k.view.yaw); expect(v.zoom).toBeCloseTo(k.view.zoom); expect(v.target.x).toBeCloseTo(k.view.target.x);
    });
    const s = takeFromKeys(keys, 30)!.samples, i = 100;
    expect(s[i].camera.yaw).toBeCloseTo(c.at((i / s.length) * c.total).yaw, 6);
    expect(keyCurve(keys.slice(0, 1), 30)).toBeNull();
  });

  it('なめらかは止まらずに通り抜け、弾むは同じ向きのまま着いて急に止まる', async () => {
    const { takeFromKeys } = await import('../../src/physics/take');
    const k = (mode: 'smooth' | 'bounce') => takeFromKeys([
      { view: view(0), seconds: 1, mode: 'smooth' }, { view: view(1), seconds: 1, mode }, { view: view(2), seconds: 1, mode: 'smooth' },
    ], 30)!.samples;
    const at = (s: readonly any[], i: number) => s[i].camera.yaw;
    const i1 = seconds(1);
    // なめらか: フレーム1の前後で速さが続く(どちらも正で、ほぼ同じ)
    const sm = k('smooth'), vin = at(sm, i1) - at(sm, i1 - 1), vout = at(sm, i1 + 1) - at(sm, i1);
    expect(vin).toBeGreaterThan(0); expect(vout / vin).toBeGreaterThan(0.8);
    // 弾む: 速いまま着き、出ていく速さは 0 近く
    const bo = k('bounce'), bin = at(bo, i1) - at(bo, i1 - 1), bout = at(bo, i1 + 1) - at(bo, i1);
    expect(bin).toBeGreaterThan(vin); expect(Math.abs(bout)).toBeLessThan(bin * 0.1);
    // どの区間でもフレームを越えて行き過ぎない(弾むの手前)
    expect(Math.max(...bo.slice(0, i1).map((x: any) => x.camera.yaw))).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('2つ未満は作らない。範囲外は丸め、上限の数で切り、記録と一緒に保存する', async () => {
    const { takeFromKeys, MAX_KEYS } = await import('../../src/physics/take');
    expect(takeFromKeys([{ view: view(0), seconds: 1, mode: 'smooth' }], 30)).toBeNull();
    // 1周が記録の最短より短いと、保存して読めないので作らない
    expect(takeFromKeys([{ view: view(0), seconds: 0.1, mode: 'smooth' }, { view: view(1), seconds: 0.1, mode: 'smooth' }], 30)).toBeNull();
    const short = takeFromKeys([{ view: view(0), seconds: 0.2, mode: 'smooth' }, { view: view(1), seconds: 0.3, mode: 'bounce' }], 30)!;
    expect(takeFromJson(JSON.parse(JSON.stringify(takeToJson(short))), 30)?.keys?.length).toBe(2);
    const many = Array.from({ length: 20 }, (_, i) => ({ view: view(i * 0.1), seconds: 99, mode: 'bounce' as const }));
    const t = takeFromKeys(many, 30)!;
    expect(t.keys!.length).toBe(MAX_KEYS); expect(t.keys![0].seconds).toBe(5);
    const back = takeFromJson(JSON.parse(JSON.stringify(takeToJson(t))), 30)!;
    expect(back.keys).toEqual(t.keys);
    const bad = takeFromJson({ ...takeToJson(t), keys: [{ view: 'x', mode: 'zzz', seconds: -1 }, {}] }, 30)!;
    expect(bad.keys![0]).toMatchObject({ mode: 'smooth', seconds: 0.1 });
  });
});

describe('キーフレームの並べ替え', () => {
  const key = (yaw: number, seconds: number, mode: KeyFrame['mode'] = 'smooth'): KeyFrame => ({ view: { yaw, pitch: 0, zoom: 1.5, target: { x: 0, y: 0, z: 0 } }, seconds, mode });
  const keys = [key(1, 0.5), key(2, 1, 'bounce'), key(3, 2), key(4, 3)];

  it('視点と通り方が動き、間の秒数は場所に残る。元の並びは変えない', () => {
    const down = moveKey(keys, 0, 2);
    expect(down.map(k => k.view.yaw)).toEqual([2, 3, 1, 4]);
    expect(down.map(k => k.mode)).toEqual(['bounce', 'smooth', 'smooth', 'smooth']);
    expect(down.map(k => k.seconds)).toEqual([0.5, 1, 2, 3]);
    const up = moveKey(keys, 3, 1);
    expect(up.map(k => k.view.yaw)).toEqual([1, 4, 2, 3]);
    expect(up.map(k => k.seconds)).toEqual([0.5, 1, 2, 3]);
    expect(keys.map(k => k.view.yaw)).toEqual([1, 2, 3, 4]);
  });

  it('同じ場所・範囲の外へは動かさない', () => {
    expect(moveKey(keys, 1, 1).map(k => k.view.yaw)).toEqual([1, 2, 3, 4]);
    expect(moveKey(keys, 1, 9).map(k => k.view.yaw)).toEqual([1, 2, 3, 4]);
    expect(moveKey(keys, -1, 0).map(k => k.view.yaw)).toEqual([1, 2, 3, 4]);
  });
});
