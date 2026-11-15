import { describe, expect, it } from 'vitest';
import { areaPoint, moveArea, resizeArea, roundArea, turnBetween, flippedAt, toLocal, wrapAngle, MIN_SIZE } from '../../src/paint/areaEdit';

const A = { x: 10, y: 20, w: 100, h: 60 };
type P = { x?: number; y?: number; w?: number; h?: number };
const close = (a: P, b: P) => {
  for (const k of Object.keys(b) as (keyof typeof b)[]) expect(a[k]).toBeCloseTo(b[k]!, 6);
};

describe('枠のハンドルで範囲を直す', () => {
  it('右の辺を動かすと、左の辺は止まったまま幅だけ変わる', () => {
    const r = resizeArea(A, 0, { su: 1, sv: 0 }, { x: 60, y: 20 }, { x: 80, y: 25 });
    close(r, { x: 20, y: 20, w: 120, h: 60 });
    expect(r.x - r.w / 2).toBeCloseTo(A.x - A.w / 2);
  });

  it('左上の角を動かすと、右下の角が止まる(y は上向き)', () => {
    const r = resizeArea(A, 0, { su: -1, sv: 1 }, { x: -40, y: 50 }, { x: -50, y: 60 });
    close(r, { w: 110, h: 70 });
    const br = areaPoint(r, 0, 1, -1), br0 = areaPoint(A, 0, 1, -1);
    close(br, br0);
  });

  it('掴んだ所とハンドルがずれていても跳ばない(動かさなければ同じ範囲)', () => {
    const r = resizeArea(A, 30, { su: 1, sv: 1 }, { x: 55, y: 48 }, { x: 55, y: 48 });
    close(r, A);
  });

  it('傾けた形でも、辺は形の向きに沿って伸び、反対の辺が止まる', () => {
    const ang = 30, t = ang * Math.PI / 180, u = { x: Math.cos(t), y: -Math.sin(t) }, v = { x: Math.sin(t), y: Math.cos(t) };
    const p0 = areaPoint(A, ang, 1, 0);
    const r = resizeArea(A, ang, { su: 1, sv: 0 }, p0, { x: p0.x + u.x * 40, y: p0.y + u.y * 40 });
    close(r, { w: 140, h: 60 });
    close(areaPoint(r, ang, -1, 0), areaPoint(A, ang, -1, 0));
    // 伸ばす向きに垂直に動かしても、範囲は変わらない
    close(resizeArea(A, ang, { su: 1, sv: 0 }, p0, { x: p0.x + v.x * 30, y: p0.y + v.y * 30 }), A);
  });

  it('Alt では中心を止めて両側へ広げる', () => {
    const r = resizeArea(A, 0, { su: 1, sv: 0 }, { x: 60, y: 20 }, { x: 70, y: 20 }, { fromCenter: true });
    close(r, { x: 10, y: 20, w: 120, h: 60 });
  });

  it('Shift では縦横比を保つ(辺でも角でも)', () => {
    const e = resizeArea(A, 0, { su: 1, sv: 0 }, { x: 60, y: 20 }, { x: 110, y: 20 }, { keepAspect: true });
    close(e, { w: 150, h: 90, y: 20 });
    // 角は対角線の向きに沿って動かした分だけ広がる
    const c = resizeArea(A, 0, { su: 1, sv: 1 }, { x: 60, y: 50 }, { x: 110, y: 80 }, { keepAspect: true });
    expect(c.w / c.h).toBeCloseTo(A.w / A.h);
    expect(c.h).toBeCloseTo(90);
    close(areaPoint(c, 0, -1, -1), areaPoint(A, 0, -1, -1));
  });

  it('Shift で角を内側へ動かすと、縦横比を保ったまま縮む', () => {
    const c = resizeArea(A, 0, { su: 1, sv: 1 }, { x: 60, y: 50 }, { x: 10, y: 20 }, { keepAspect: true });
    close(c, { w: 50, h: 30 });
    close(areaPoint(c, 0, -1, -1), areaPoint(A, 0, -1, -1));
    // 横だけ内側へ寄せても、対角線の向きへ射影した分だけ縦も縮む
    const e = resizeArea(A, 0, { su: 1, sv: 1 }, { x: 60, y: 50 }, { x: 10, y: 50 }, { keepAspect: true });
    expect(e.w).toBeCloseTo(100 * (1 - 5000 / 13600), 6);
    expect(e.w / e.h).toBeCloseTo(A.w / A.h);
  });

  it('Shift で角を斜めに動かしても、大きさは跳ばずに続けて変わる(#91)', () => {
    // 横を広げて縦を縮める向きへ少しずつ動かす。縦横の大きく変わった方に合わせると途中で入れ替わって跳んでいた
    const ang = 20, h = { su: 1, sv: 1 } as const, s0 = areaPoint(A, ang, 1, 1);
    let prev = A.w;
    for (let i = 1; i <= 200; i++) {
      const t = i * 0.5;
      const p = { x: s0.x + t * 1.2, y: s0.y - t * 0.9 };
      const r = resizeArea(A, ang, h, s0, p, { keepAspect: true });
      expect(Math.abs(r.w - prev)).toBeLessThan(1);
      expect(r.w / r.h).toBeCloseTo(A.w / A.h);
      prev = r.w;
    }
  });

  it('Shift と Alt で角を動かすと、中心を止めて対角線の向きに広がる', () => {
    const h = { su: 1, sv: 1 } as const, s0 = areaPoint(A, 0, 1, 1);
    const r = resizeArea(A, 0, h, s0, { x: s0.x + 25, y: s0.y + 15 }, { keepAspect: true, fromCenter: true });
    close(r, { x: A.x, y: A.y, w: 150, h: 90 });
  });

  it('大きさを整数にそろえても、止める側の辺は動かない', () => {
    const ang = 25, h = { su: -1, sv: 0 } as const;
    const r = resizeArea(A, ang, h, areaPoint(A, ang, -1, 0), { x: areaPoint(A, ang, -1, 0).x - 10.37, y: areaPoint(A, ang, -1, 0).y });
    const q = roundArea(r, ang, h);
    expect(Number.isInteger(q.w) && Number.isInteger(q.h)).toBe(true);
    close(areaPoint(q, ang, 1, 0), areaPoint(A, ang, 1, 0));
  });

  it('反対側を越えて裏返さず、最小の大きさで止まる', () => {
    const r = resizeArea(A, 0, { su: 1, sv: 0 }, { x: 60, y: 20 }, { x: -500, y: 20 });
    expect(r.w).toBe(MIN_SIZE);
    expect(r.x - r.w / 2).toBeCloseTo(A.x - A.w / 2);
  });

  it('中を掴んで動かすと、動かした分だけ移る', () => {
    close(moveArea(A, { x: 0, y: 0 }, { x: 5, y: -7 }), { x: 15, y: 13, w: 100, h: 60 });
  });

  it('回す量: 画面上で時計回りが正。半周をまたいでも続けて足せる', () => {
    // 中心の真上(y が上)から真右へ回すのは、画面上で時計回りに 90°
    const top = { x: A.x, y: A.y + 50 }, right = { x: A.x + 50, y: A.y }, bottom = { x: A.x, y: A.y - 50 }, left = { x: A.x - 50, y: A.y };
    expect(turnBetween(A, top, right)).toBeCloseTo(90);
    expect(turnBetween(A, right, top)).toBeCloseTo(-90);
    // 1周を4回に分けて回すと 360°(atan2 の ±180° の継ぎ目をまたぐ)
    const sum = [turnBetween(A, top, right), turnBetween(A, right, bottom), turnBetween(A, bottom, left), turnBetween(A, left, top)].reduce((s, v) => s + v);
    expect(sum).toBeCloseTo(360);
  });

  it('回り込む前の角度で、形の上下が入れ替わったかが分かる', () => {
    expect(flippedAt(0)).toBe(false);
    expect(flippedAt(90)).toBe(false);
    expect(flippedAt(-90)).toBe(false);
    expect(flippedAt(100)).toBe(true);
    expect(flippedAt(-100)).toBe(true);
    expect(flippedAt(200)).toBe(true);
    expect(flippedAt(280)).toBe(false);
    expect(flippedAt(-280)).toBe(false);
  });

  it('wrapAngle は -90〜90 に収める', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(100)).toBe(-80);
    expect(wrapAngle(-100)).toBe(80);
    expect(wrapAngle(90)).toBe(90);
    expect(wrapAngle(-90)).toBe(-90);
    expect(wrapAngle(270)).toBe(90);
  });

  it('toLocal と areaPoint は互いに逆', () => {
    const p = areaPoint(A, -40, 0.3, -0.7), q = toLocal(A, -40, p);
    expect(q.lu).toBeCloseTo(0.3 * A.w / 2);
    expect(q.lv).toBeCloseTo(-0.7 * A.h / 2);
  });
});
