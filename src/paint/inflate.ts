/**
 * 範囲(楕円・矩形・カマボコ)を指定して一括で膨らませる処理(DOM に依存しない)。
 * 範囲の「縁からの深さ」(縁が 0、いちばん奥が 1)を、なだらかさで割ってから断面の形に通し、
 * 頂上のウェイト(level)を掛けて元のウェイトと重ねる。楕円をなだらかさ 100%・ドームにすると回転楕円体になる。
 * 仕上げのぼかし(blur)を付けると、今回の膨らみだけをぼかしてから重ねる(前のウェイトはぼかさない)。
 */
import { gaussianBlurFloat, type WeightMap, type Rect } from '../model/weightmap';

export type InflateProfile = 'dome' | 'cushion' | 'cone';
export type InflateBlend = 'max' | 'add' | 'replace';

export type InflateKind = 'ellipse' | 'rect' | 'kamaboko';
/** 形の選択肢の名前(表示と、アンドゥの名前に使う) */
export const INFLATE_KINDS: Record<InflateKind, string> = { ellipse: '楕円', rect: '矩形', kamaboko: 'カマボコ' };

/**
 * 中心と半径はウェイトマップのピクセル単位(行 0 が上)。
 * angle は形の傾き(ラジアン)。正で画面上の時計回り(行が下へ増えるので、x 軸から +y へ回す向き)。rx・ry は傾ける前の半径。
 * kamaboko は、傾ける前の形で上下の辺からだけ盛り上がり、左右の端は切り立つ(稜線は横向き。縦にするには角度で回す)。
 */
export interface InflateShape { kind: InflateKind; cx: number; cy: number; rx: number; ry: number; angle?: number }

export interface InflateParams {
  /** 頂上のウェイト 0〜1(高さ ÷ ポップ量) */
  level: number;
  /** 0 で縁が切り立った平らな台、1 で中心までずっと傾く */
  softness: number;
  profile: InflateProfile;
  blend: InflateBlend;
  /** 仕上げのぼかしの半径(ウェイトマップのピクセル)。0 か省略でぼかさない */
  blur?: number;
}

/** 断面の形。t は縁から奥への位置 0〜1、戻り値は高さ 0〜1 */
export function profileAt(t: number, p: InflateProfile): number {
  t = t <= 0 ? 0 : t >= 1 ? 1 : t;
  if (p === 'dome') return Math.sqrt(1 - (1 - t) * (1 - t)); // 断面が円弧(縁で切り立ち、頂上は丸い)
  if (p === 'cushion') return t * t * (3 - 2 * t);           // 縁も頂上もなめらか
  return t;
}

/** なだらかさ 0 でも縁がギザギザにならないよう、最低 1.5px の傾きを残す */
const ramp = (depth: number, softness: number, radiusPx: number) => depth / Math.max(softness, Math.min(1, 1.5 / Math.max(0.5, radiusPx)));

function blend(base: number, v: number, mode: InflateBlend): number {
  const n = v * 255;
  const out = mode === 'max' ? Math.max(base, n) : mode === 'add' ? base + n : n;
  return Math.round(out < 0 ? 0 : out > 255 ? 255 : out);
}

/** 図形の中の、縁からの深さ 0〜1(外は 0 以下)。x, y はピクセルの中心 */
export function shapeDepth(s: InflateShape, x: number, y: number, rot = rotation(s)): number {
  let dx = x - s.cx, dy = y - s.cy;
  // 傾いた形は、点を逆に回して傾ける前の形で測る
  if (rot) { const { c, n } = rot, u = dx * c + dy * n; dy = -dx * n + dy * c; dx = u; }
  if (s.kind === 'ellipse') return 1 - Math.hypot(dx / s.rx, dy / s.ry);
  // カマボコは上下の辺からの距離だけで測る(稜線は横)。左右の端の外は形の外
  if (s.kind === 'kamaboko') return Math.abs(dx) >= s.rx + 0.5 ? -1 : (s.ry - Math.abs(dy)) / s.ry;
  // 矩形は縁からの距離を短い方の半径で割る(長い辺に沿って稜線ができる寄棟屋根の形)
  return Math.min(s.rx - Math.abs(dx), s.ry - Math.abs(dy)) / Math.min(s.rx, s.ry);
}

/** 傾きの cos・sin(傾けていなければ null)。ピクセルごとに計算しないよう、先に1回だけ求める */
const rotation = (s: InflateShape) => (s.angle ? { c: Math.cos(s.angle), n: Math.sin(s.angle) } : null);

/** 傾けた形の外接矩形の半分の幅・縦 */
export function shapeExtent(s: InflateShape): { ex: number; ey: number } {
  const c = Math.abs(Math.cos(s.angle ?? 0)), n = Math.abs(Math.sin(s.angle ?? 0));
  return s.kind === 'ellipse'
    ? { ex: Math.hypot(s.rx * c, s.ry * n), ey: Math.hypot(s.rx * n, s.ry * c) }
    : { ex: s.rx * c + s.ry * n, ey: s.rx * n + s.ry * c };
}

/** 斜面を測る半径(この長さで縁から奥までの深さ 1 になる) */
const slopeRadius = (s: InflateShape) => (s.kind === 'kamaboko' ? s.ry : Math.min(s.rx, s.ry));

/** ぼかしの半径から、形の外へにじむ幅(ガウスの 3σ。半径 ≒ 2σ) */
const blurMargin = (blur: number) => Math.ceil(blur * 1.5);

function shapeBounds(s: InflateShape, w: number, h: number, margin = 0): Rect | null {
  const e = shapeExtent(s), ex = e.ex + margin, ey = e.ey + margin;
  const x0 = Math.max(0, Math.floor(s.cx - ex)), y0 = Math.max(0, Math.floor(s.cy - ey));
  const x1 = Math.min(w, Math.ceil(s.cx + ex)), y1 = Math.min(h, Math.ceil(s.cy + ey));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * base(同じ大きさの元のウェイト)に図形の膨らみを重ねて wm へ書く。図形の外接矩形の外には触れない。
 * 戻り値は書いた矩形。
 */
export function inflateShape(wm: WeightMap, base: Uint8Array, s: InflateShape, p: InflateParams): Rect | null {
  if (s.rx < 0.5 || s.ry < 0.5) return null;
  const blur = p.blur && p.blur > 0 ? p.blur : 0;
  const r = shapeBounds(s, wm.width, wm.height, blurMargin(blur)); if (!r) return null;
  const W = wm.width, d = wm.data, R = slopeRadius(s), rot = rotation(s);
  /** その点の膨らみ(0〜level)と、形の中にどれだけ入っているか(0〜1。カマボコの切り立った端だけ 1px で 0 へ落とす) */
  const sample = (x: number, y: number): [number, number] => {
    const depth = shapeDepth(s, x, y, rot);
    if (depth <= 0) return [0, 0];
    const cover = s.kind === 'kamaboko' ? endCover(s, x, y, rot) : 1;
    return [cover * p.level * profileAt(ramp(depth, p.softness, R), p.profile), cover];
  };
  if (!blur) {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
      const [v, cover] = sample(x + 0.5, y + 0.5);
      if (cover <= 0) continue;
      const i = y * W + x;
      d[i] = p.blend === 'replace' ? mixReplace(base[i], v, cover) : blend(base[i], v, p.blend);
    }
    return r;
  }
  // 仕上げのぼかし: 今回の膨らみだけを、にじむ幅まで広げた矩形の中で作ってぼかし、それから元のウェイトと重ねる。
  // 矩形の端は画像の端か、膨らみが届かない所なので、ぼかしの端の扱いで形が崩れない。
  // 置き換えるでは、形の覆い(中が 1)も同じくぼかし、前のウェイトをその割合だけ残す(にじんだ所を 0 近くへ削らないため)
  const n = r.w * r.h, f = new Float32Array(n), m = p.blend === 'replace' ? new Float32Array(n) : null;
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const [v, cover] = sample(r.x + x + 0.5, r.y + y + 0.5);
    f[y * r.w + x] = v;
    if (m) m[y * r.w + x] = cover;
  }
  const sigma = blur / 2; // 半径 ≒ 2σ(「全体をぼかす」と同じ)
  gaussianBlurFloat(f, r.w, r.h, sigma);
  if (m) gaussianBlurFloat(m, r.w, r.h, sigma);
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const j = y * r.w + x, v = f[j];
    if (m ? m[j] * 255 < 0.5 : v * 255 < 0.5) continue; // 届かない所は元のまま
    const i = (r.y + y) * W + r.x + x;
    d[i] = m ? mixReplace(base[i], v, m[j]) : blend(base[i], v, p.blend);
  }
  return r;
}

/** 置き換える: 形の中(cover = 1)は今回の膨らみに、縁のにじみでは前のウェイトを残す割合を cover で決める */
function mixReplace(base: number, v: number, cover: number): number {
  const c = cover < 0 ? 0 : cover > 1 ? 1 : cover;
  const out = base * (1 - c) + v * 255;
  return Math.round(out < 0 ? 0 : out > 255 ? 255 : out);
}

/** カマボコの左右の切り立った端を、1px の幅で 0 へ落とす(傾けたときに端がギザギザにならないよう) */
function endCover(s: InflateShape, x: number, y: number, rot: ReturnType<typeof rotation>): number {
  let dx = x - s.cx;
  if (rot) dx = dx * rot.c + (y - s.cy) * rot.n;
  const c = s.rx - Math.abs(dx) + 0.5;
  return c <= 0 ? 0 : c >= 1 ? 1 : c;
}
