/**
 * 膨らませるの「形を崩す」の計算(DOM に依存しない)。
 * 形の中の位置を、半径で割った -1〜1 の座標(正規化した座標)で扱う。x は右、y は下(ウェイトマップの行の向き)。
 *   四隅を動かす(warp): 四角の四隅(左上・右上・右下・左下)を、正規化した座標でずらす。中は双一次で写す
 *   辺のふくらみ(bulge): 4辺を同じだけ外へ(マイナスで内へ)反らせる。-1〜1 で、1 のとき辺の中ほどが半径の半分だけ外へ出る
 * 点を測るときは、崩した形から崩す前の四角の座標へ戻し(toSquare)、枠を描くときは逆に写す(fromSquare)。
 */

/** 四隅のずれ。[左上 x, 左上 y, 右上 x, 右上 y, 右下 x, 右下 y, 左下 x, 左下 y](正規化した座標) */
export type Warp = readonly number[];

/** 崩す前の四隅(左上・右上・右下・左下) */
const BASE = [-1, -1, 1, -1, 1, 1, -1, 1] as const;

/** 辺のふくらみの最大(半径に対する割合) */
const BULGE_MAX = 0.5;

/** 四隅を動かせる幅(正規化した座標。1 で半径と同じだけ) */
export const WARP_MAX = 1.5;

/** 辺のふくらみ -1〜1 を、半径に対する割合にする */
const bulgeK = (bulge: number) => (bulge < -1 ? -1 : bulge > 1 ? 1 : bulge) * BULGE_MAX;

/** 崩していないか */
export const isFlatWarp = (w: Warp | null | undefined): boolean => !w || w.every(v => v === 0);

/** 崩したあとの四隅(左上・右上・右下・左下) */
export function warpCorners(w: Warp | null | undefined): { x: number; y: number }[] {
  const out = [];
  for (let i = 0; i < 4; i++) out.push({ x: BASE[i * 2] + (w?.[i * 2] ?? 0), y: BASE[i * 2 + 1] + (w?.[i * 2 + 1] ?? 0) });
  return out;
}

/** ピクセルごとに四隅を作り直さないよう、同じ warp の四隅は覚えておく */
const cornerCache = new WeakMap<Warp, { x: number; y: number }[]>();
function cachedCorners(w: Warp): { x: number; y: number }[] {
  let q = cornerCache.get(w);
  if (!q) { q = warpCorners(w); cornerCache.set(w, q); }
  return q;
}

const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;

/**
 * 四隅 q(左上・右上・右下・左下)の双一次の写し方で、点 (x, y) になる四角の中の位置 (s, t)(0〜1)。
 * 四角の外の点も、外へ延ばして求める(ふくらませた辺は四角の外へ出るため)。解が無ければ null
 */
export function invBilinear(x: number, y: number, q: readonly { x: number; y: number }[]): { s: number; t: number } | null {
  const a = q[0], b = q[1], c = q[2], d = q[3];
  const ex = b.x - a.x, ey = b.y - a.y, fx = d.x - a.x, fy = d.y - a.y;
  const gx = a.x - b.x + c.x - d.x, gy = a.y - b.y + c.y - d.y, hx = x - a.x, hy = y - a.y;
  const k2 = cross(gx, gy, fx, fy), k1 = cross(ex, ey, fx, fy) + cross(hx, hy, gx, gy), k0 = cross(hx, hy, ex, ey);
  const uOf = (t: number) => {
    const dx = ex + gx * t, dy = ey + gy * t;
    return Math.abs(dx) > Math.abs(dy) ? (hx - fx * t) / dx : (hy - fy * t) / dy;
  };
  if (Math.abs(k2) < 1e-9) {
    if (Math.abs(k1) < 1e-12) return null;
    const t = -k0 / k1, s = uOf(t);
    return Number.isFinite(s) ? { s, t } : null;
  }
  const disc = k1 * k1 - 4 * k0 * k2; if (disc < 0) return null;
  const r = Math.sqrt(disc), cands = [(-k1 - r) / (2 * k2), (-k1 + r) / (2 * k2)];
  // 2つの解のうち、四角に近い方(中にあればそれ)を取る
  let best: { s: number; t: number } | null = null, bestOut = Infinity;
  for (const t of cands) {
    const s = uOf(t); if (!Number.isFinite(s)) continue;
    const out = Math.max(0, -s, s - 1) + Math.max(0, -t, t - 1);
    if (out < bestOut) { best = { s, t }; bestOut = out; }
  }
  return best;
}

/**
 * 崩した形の点(正規化した座標)を、崩す前の四角の座標へ戻す。四角の中なら -1〜1。
 * ふくらみは、辺の中ほどほど大きく、角では 0 になるよう、もう一方の向きの位置で割り合いを変える
 */
export function toSquare(X: number, Y: number, w: Warp | null | undefined, bulge: number): { x: number; y: number } | null {
  let x = X, y = Y;
  if (!isFlatWarp(w)) {
    const st = invBilinear(X, Y, cachedCorners(w!)); if (!st) return null;
    x = st.s * 2 - 1; y = st.t * 2 - 1;
  }
  if (bulge) {
    const B = bulgeK(bulge), x0 = x;
    x = x / (1 + B * (1 - Math.min(1, y * y)));
    y = y / (1 + B * (1 - Math.min(1, x0 * x0)));
  }
  return { x, y };
}

/** ふくらみだけを戻す(toSquare のふくらみの部分) */
function unbulge(sx: number, sy: number, B: number): [number, number] {
  return [sx / (1 + B * (1 - Math.min(1, sy * sy))), sy / (1 + B * (1 - Math.min(1, sx * sx)))];
}

/**
 * 崩す前の四角の点(-1〜1)を、崩した形の点へ写す(枠の輪郭を描くとき)。
 * ふくらみの逆は、近い値から始めてニュートン法で求める(角の近くでは単純な繰り返しが収束しにくいため)
 */
export function fromSquare(x: number, y: number, w: Warp | null | undefined, bulge: number): { x: number; y: number } {
  let sx = x, sy = y;
  const B = bulge ? bulgeK(bulge) : 0;
  if (B) {
    sx = x * (1 + B * (1 - Math.min(1, y * y))); sy = y * (1 + B * (1 - Math.min(1, x * x)));
    const e = 1e-6;
    for (let i = 0; i < 30; i++) {
      const [fx, fy] = unbulge(sx, sy, B), rx = fx - x, ry = fy - y;
      if (Math.abs(rx) + Math.abs(ry) < 1e-10) break;
      const [ax, ay] = unbulge(sx + e, sy, B), [bx, by] = unbulge(sx, sy + e, B);
      const j11 = (ax - fx) / e, j21 = (ay - fy) / e, j12 = (bx - fx) / e, j22 = (by - fy) / e;
      const det = j11 * j22 - j12 * j21; if (Math.abs(det) < 1e-12) break;
      sx -= (j22 * rx - j12 * ry) / det; sy -= (-j21 * rx + j11 * ry) / det;
    }
  }
  if (isFlatWarp(w)) return { x: sx, y: sy };
  return bilinear(sx, sy, cachedCorners(w!));
}

/** 四角の座標 (x, y)(-1〜1 の外へも延ばせる)を、四隅 q の双一次で写す */
function bilinear(x: number, y: number, q: readonly { x: number; y: number }[]): { x: number; y: number } {
  const s = (x + 1) / 2, t = (y + 1) / 2;
  return {
    x: (1 - s) * (1 - t) * q[0].x + s * (1 - t) * q[1].x + s * t * q[2].x + (1 - s) * t * q[3].x,
    y: (1 - s) * (1 - t) * q[0].y + s * (1 - t) * q[1].y + s * t * q[2].y + (1 - s) * t * q[3].y,
  };
}

/**
 * 崩した形が届く範囲(正規化した座標の、x・y の最小と最大)。外接矩形を求めるのに使う。
 * ふくらませた点は四角の座標で ±(1 + ふくらみ) の中に収まり、双一次で写した点はその四隅を写した点の凸包に入るので、
 * その4点の範囲を取る
 */
export function warpReach(w: Warp | null | undefined, bulge: number): { x0: number; x1: number; y0: number; y1: number } {
  const k = 1 + Math.max(0, bulgeK(bulge)), q = warpCorners(w);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [u, v] of [[-k, -k], [k, -k], [k, k], [-k, k]]) {
    const c = bilinear(u, v, q);
    x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x); y0 = Math.min(y0, c.y); y1 = Math.max(y1, c.y);
  }
  return { x0, x1, y0, y1 };
}
