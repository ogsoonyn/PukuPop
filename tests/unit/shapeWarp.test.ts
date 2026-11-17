import { describe, it, expect } from 'vitest';
import { WeightMap } from '../../src/model/weightmap';
import { fromSquare, invBilinear, toSquare, warpCorners, warpReach } from '../../src/paint/shapeWarp';
import { inflateShape, shapeDepth, shapeExtent, type InflateParams, type InflateShape } from '../../src/paint/inflate';

const params = (p: Partial<InflateParams> = {}): InflateParams => ({ level: 1, softness: 0, profile: 'dome', blend: 'max', ...p });
const at = (wm: WeightMap, x: number, y: number) => wm.data[y * wm.width + x];
/** 右下の角だけを内側(左上)へ寄せたずれ */
const pullBR = [0, 0, 0, 0, -0.8, -0.8, 0, 0];

describe('形を崩す計算', () => {
  it('崩していなければ、そのままの座標', () => {
    expect(toSquare(0.3, -0.4, null, 0)).toEqual({ x: 0.3, y: -0.4 });
    expect(fromSquare(0.3, -0.4, null, 0)).toEqual({ x: 0.3, y: -0.4 });
  });

  it('四隅を動かした形と四角の座標を行き来しても戻る(四角の外へ延ばした所も)', () => {
    const w = [0.2, 0.1, -0.3, 0.2, -0.8, -0.6, 0.1, -0.2];
    for (const [x, y] of [[0, 0], [0.5, -0.5], [-0.9, 0.9], [1, 1], [1.2, 0], [0, -1.1]]) {
      const p = fromSquare(x, y, w, 0), q = toSquare(p.x, p.y, w, 0)!;
      expect(q.x).toBeCloseTo(x, 6); expect(q.y).toBeCloseTo(y, 6);
    }
    // 四隅は動かした所へ写る
    const c = warpCorners(w);
    expect(fromSquare(1, 1, w, 0)).toEqual({ x: c[2].x, y: c[2].y });
    const st = invBilinear(c[0].x, c[0].y, c)!;
    expect(st.s).toBeCloseTo(0, 9); expect(st.t).toBeCloseTo(0, 9);
  });

  it('辺のふくらみ: 辺の中ほどが外(マイナスで内)へ出て、角は動かない', () => {
    expect(fromSquare(1, 0, null, 1).x).toBeCloseTo(1.5, 3);
    expect(fromSquare(1, 0, null, -1).x).toBeCloseTo(0.5, 3);
    expect(fromSquare(1, 1, null, 1)).toEqual({ x: 1, y: 1 });
    const p = fromSquare(0.6, 0.3, null, 0.7), q = toSquare(p.x, p.y, null, 0.7)!;
    expect(q.x).toBeCloseTo(0.6, 3); expect(q.y).toBeCloseTo(0.3, 3);
  });
});

describe('崩した形で膨らませる', () => {
  const rect = { kind: 'rect' as const, cx: 32, cy: 32, rx: 20, ry: 20 };

  it('四隅を動かす: 右下の角を内へ寄せると、その角のあたりは膨らまず、左上はそのまま。楕円にも効く', () => {
    const a = new WeightMap(64, 64), b = new WeightMap(64, 64);
    inflateShape(a, a.data.slice(), rect, params());
    inflateShape(b, b.data.slice(), { ...rect, warp: pullBR }, params());
    expect(at(a, 48, 48)).toBe(255);
    expect(at(b, 48, 48)).toBe(0);
    expect(at(b, 16, 16)).toBe(at(a, 16, 16));
    const e = new WeightMap(64, 64);
    inflateShape(e, e.data.slice(), { ...rect, kind: 'ellipse', warp: pullBR }, params());
    expect(at(e, 32 + 12, 32 + 12)).toBe(0);
    expect(at(e, 32 - 12, 32 - 12)).toBeGreaterThan(0);
  });

  it('四隅を外へ広げると、外接矩形もそこまで広がる', () => {
    const wm = new WeightMap(96, 96);
    const r = inflateShape(wm, wm.data.slice(), { ...rect, cx: 48, cy: 48, warp: [0, 0, 0, 0, 0.8, 0.8, 0, 0] }, params());
    expect(r!.x + r!.w).toBeGreaterThanOrEqual(48 + 36);
    expect(at(wm, 48 + 32, 48 + 32)).toBeGreaterThan(0);
  });

  it('角の丸み: 角が欠け、辺の中ほどは変わらない。楕円には効かない', () => {
    const a = new WeightMap(64, 64);
    inflateShape(a, a.data.slice(), { ...rect, round: 1 }, params());
    expect(at(a, 13, 13)).toBe(0);
    expect(at(a, 13, 32)).toBe(255);
    const e1 = new WeightMap(64, 64), e2 = new WeightMap(64, 64);
    inflateShape(e1, e1.data.slice(), { ...rect, kind: 'ellipse' }, params({ softness: 1 }));
    inflateShape(e2, e2.data.slice(), { ...rect, kind: 'ellipse', round: 1, bulge: 1 }, params({ softness: 1 }));
    expect(e2.data).toEqual(e1.data);
  });

  it('辺のふくらみ: プラスで辺の外まで膨らみ、マイナスで辺の中ほどがへこむ。カマボコにも効く', () => {
    const out = new WeightMap(64, 64), inn = new WeightMap(64, 64);
    inflateShape(out, out.data.slice(), { ...rect, bulge: 1 }, params());
    inflateShape(inn, inn.data.slice(), { ...rect, bulge: -1 }, params());
    expect(at(out, 32 + 24, 32)).toBe(255); // 元の辺(32 + 20)の外
    expect(at(inn, 32 + 16, 32)).toBe(0);   // 元の辺の内側
    const k = new WeightMap(64, 64);
    inflateShape(k, k.data.slice(), { ...rect, kind: 'kamaboko', bulge: 1 }, params({ softness: 1, profile: 'cone' }));
    expect(at(k, 32, 32 + 24)).toBeGreaterThan(0);
  });
});

describe('形を崩す: 見直しで足した確かめ', () => {
  it('ふくらみが最大でも、角の近くで輪郭と測り方が食い違わない', () => {
    for (const b of [1, -1, 0.6]) for (const [x, y] of [[0.98, 0.98], [1, 0.9], [0.9, -1], [-0.95, 0.99], [0.2, 1]]) {
      const p = fromSquare(x, y, null, b), q = toSquare(p.x, p.y, null, b)!;
      expect(Math.abs(q.x - x)).toBeLessThan(1e-6); expect(Math.abs(q.y - y)).toBeLessThan(1e-6);
    }
  });

  it('ふくらみは -1〜1 に収める(範囲の外を渡しても 1 と同じ)', () => {
    const s: InflateShape = { kind: 'rect', cx: 50, cy: 50, rx: 20, ry: 20, bulge: 5 };
    expect(shapeExtent(s)).toEqual(shapeExtent({ ...s, bulge: 1 }));
    expect(shapeDepth(s, 50, 75)).toBeCloseTo(shapeDepth({ ...s, bulge: 1 }, 50, 75), 9);
  });

  it('外接矩形は崩した側だけ広がる(左上の角を外へ引くと、右下は広がらない)', () => {
    const r = warpReach([-1, -1, 0, 0, 0, 0, 0, 0], 0);
    expect(r).toEqual({ x0: -2, x1: 1, y0: -2, y1: 1 });
    const e = shapeExtent({ kind: 'rect', cx: 0, cy: 0, rx: 10, ry: 10, warp: [-1, -1, 0, 0, 0, 0, 0, 0] });
    expect(e.x0).toBeCloseTo(-20, 9); expect(e.x1).toBeCloseTo(10, 9);
  });

  it('崩して傾けた形も、傾ける前と同じ所が膨らむ', () => {
    const w = [0.3, 0, 0, 0.2, -0.4, -0.3, 0, 0];
    const s: InflateShape = { kind: 'rect', cx: 50, cy: 50, rx: 20, ry: 12, warp: w };
    const t: InflateShape = { ...s, angle: Math.PI / 2 };
    // 90° 回すと、傾ける前の (dx, dy) は画面の (-dy, dx) に来る
    for (const [dx, dy] of [[5, 3], [-10, 4], [15, -8]]) {
      expect(shapeDepth(t, 50 - dy, 50 + dx)).toBeCloseTo(shapeDepth(s, 50 + dx, 50 + dy), 6);
    }
  });

  it('四隅がねじれた(潰れた)形でも、計算が止まらず値が 0〜255 に収まる', () => {
    const wm = new WeightMap(64, 64), base = wm.data.slice();
    // 右上と右下を入れ替える(ねじれた四角)・右の2つを1点に潰す
    for (const warp of [[0, 0, 0, 2, 0, -2, 0, 0], [0, 0, -1, 1, -1, -1, 0, 0]]) {
      inflateShape(wm, base, { kind: 'rect', cx: 32, cy: 32, rx: 20, ry: 20, warp }, params());
      for (const v of wm.data) expect(v >= 0 && v <= 255).toBe(true);
    }
  });

  it('カマボコの覆いは端だけで下がり、置き換えるでも上下の辺に前のウェイトを残さない', () => {
    const wm = new WeightMap(64, 64);
    wm.data.fill(200);
    const base = wm.data.slice();
    inflateShape(wm, base, { kind: 'kamaboko', cx: 32, cy: 32.3, rx: 20, ry: 10 }, params({ blend: 'replace', level: 0 }));
    // 上の辺のすぐ内側(深さはほぼ 0)は、置き換えて 0 になる
    expect(at(wm, 32, 22)).toBe(0);
  });
});
