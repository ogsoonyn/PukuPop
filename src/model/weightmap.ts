/**
 * ウェイトマップ: 1チャンネル8ビット。0 が動かない、255 が最大。
 * 行 0 が画像の上端。CPU 側のこの配列が正本で、GPU テクスチャは表示用の複製。
 */
export interface Rect { x: number; y: number; w: number; h: number }

export const TILE = 64;
export const MAX_WEIGHT_SIZE = 1024;

export function weightSizeFor(imageW: number, imageH: number): { w: number; h: number } {
  const s = Math.min(1, MAX_WEIGHT_SIZE / Math.max(imageW, imageH));
  return { w: Math.max(1, Math.round(imageW * s)), h: Math.max(1, Math.round(imageH * s)) };
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export class WeightMap {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number, data?: Uint8Array) {
    this.width = width;
    this.height = height;
    if (data && data.length !== width * height) throw new Error('weight map size mismatch');
    this.data = data ?? new Uint8Array(width * height);
  }

  get fullRect(): Rect { return { x: 0, y: 0, w: this.width, h: this.height }; }
  get tilesX(): number { return Math.ceil(this.width / TILE); }
  get tilesY(): number { return Math.ceil(this.height / TILE); }

  clone(): WeightMap { return new WeightMap(this.width, this.height, this.data.slice()); }

  /** u,v は 0〜1(v は下が 0)。双線形補間した値を 0〜1 で返す。 */
  sampleUV(u: number, v: number): number {
    const x = u * this.width - 0.5, y = (1 - v) * this.height - 0.5;
    const x0 = Math.max(0, Math.min(this.width - 1, Math.floor(x))), y0 = Math.max(0, Math.min(this.height - 1, Math.floor(y)));
    const x1 = Math.min(this.width - 1, x0 + 1), y1 = Math.min(this.height - 1, y0 + 1);
    const fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
    const d = this.data, W = this.width;
    const a = d[y0 * W + x0] * (1 - fx) + d[y0 * W + x1] * fx;
    const b = d[y1 * W + x0] * (1 - fx) + d[y1 * W + x1] * fx;
    return (a * (1 - fy) + b * fy) / 255;
  }

  /** ウェイトで重み付けした重心(u, v は 0〜1、v は下が 0)。何も塗っていなければ中央 */
  centroidUV(): { u: number; v: number } {
    const d = this.data, W = this.width, H = this.height;
    let sum = 0, sx = 0, sy = 0;
    for (let y = 0; y < H; y++) {
      let row = 0, rx = 0;
      for (let x = 0, i = y * W; x < W; x++, i++) { const w = d[i]; if (w) { row += w; rx += w * x; } }
      sum += row; sx += rx; sy += row * y;
    }
    if (!sum) return { u: 0.5, v: 0.5 };
    return { u: (sx / sum + 0.5) / W, v: 1 - (sy / sum + 0.5) / H };
  }

  max(): number { let m = 0; for (const v of this.data) if (v > m) m = v; return m; }

  isEmpty(): boolean { for (const v of this.data) if (v) return false; return true; }

  /* ---------- タイル(アンドゥ差分の単位) ---------- */

  tileRect(tx: number, ty: number): Rect {
    const x = tx * TILE, y = ty * TILE;
    return { x, y, w: Math.min(TILE, this.width - x), h: Math.min(TILE, this.height - y) };
  }

  readRect(r: Rect): Uint8Array {
    const out = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) out.set(this.data.subarray((r.y + y) * this.width + r.x, (r.y + y) * this.width + r.x + r.w), y * r.w);
    return out;
  }

  writeRect(r: Rect, src: Uint8Array): void {
    for (let y = 0; y < r.h; y++) this.data.set(src.subarray(y * r.w, (y + 1) * r.w), (r.y + y) * this.width + r.x);
  }

  /* ---------- 一括コマンド ---------- */

  clear(): void { this.data.fill(0); }

  invert(): void { const d = this.data; for (let i = 0; i < d.length; i++) d[i] = 255 - d[i]; }

  /** 最大値が 255 になるよう全体を拡大する。 */
  normalize(): void {
    const m = this.max();
    if (m === 0 || m === 255) return;
    const k = 255 / m, d = this.data;
    for (let i = 0; i < d.length; i++) d[i] = Math.min(255, Math.round(d[i] * k));
  }

  /** レイヤー全体にガウスぼかし(半径はウェイトマップのピクセル単位)。 */
  gaussianBlur(radius: number): void {
    if (radius <= 0) return;
    const f = Float32Array.from(this.data);
    gaussianBlurFloat(f, this.width, this.height, radius / 2); // 半径 ≒ 2σ
    for (let i = 0; i < f.length; i++) this.data[i] = Math.round(Math.max(0, Math.min(255, f[i])));
  }

  /** 不透明部分を一括で塗る。alpha は srcW×srcH の 0〜255(行 0 が上)。 */
  setFromAlpha(alpha: Uint8Array, srcW: number, srcH: number): void {
    for (let y = 0; y < this.height; y++) {
      const sy = Math.min(srcH - 1, Math.floor((y + 0.5) * srcH / this.height));
      for (let x = 0; x < this.width; x++) {
        const sx = Math.min(srcW - 1, Math.floor((x + 0.5) * srcW / this.width));
        this.data[y * this.width + x] = alpha[sy * srcW + sx];
      }
    }
  }

  /**
   * ウェイトを外へ広げる(グレースケールの膨張。各画素を、縦横 radius 画素以内の最大値にする)。
   * 塗った所の中の値は小さくならず、境目だけが外へ動く。
   */
  dilate(radius: number): void {
    const r = Math.floor(radius);
    if (r <= 0) return;
    const { width: w, height: h } = this;
    const tmp = new Uint8Array(w * h);
    maxFilter1D(this.data, tmp, w, h, 1, w, r);   // 横
    maxFilter1D(tmp, this.data, h, w, w, 1, r);   // 縦
  }

  /** 別サイズのマップから最近傍で写す(読み込み時のサイズ違い対策)。 */
  static resampled(src: WeightMap, w: number, h: number): WeightMap {
    if (src.width === w && src.height === h) return src.clone();
    const out = new WeightMap(w, h);
    out.setFromAlpha(src.data, src.width, src.height);
    return out;
  }
}

/** 3回のボックスぼかしでガウスを近似する(その場で書き換え)。 */
export function gaussianBlurFloat(f: Float32Array, w: number, h: number, sigma: number): void {
  const n = 3, wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2, m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const tmp = new Float32Array(f.length);
  for (let i = 0; i < n; i++) {
    const r = ((i < m ? wl : wu) - 1) / 2;
    boxH(f, tmp, w, h, r); boxV(tmp, f, w, h, r);
  }
}

function boxH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.max(0, Math.min(w - 1, k))];
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc / (2 * r + 1);
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
}

function boxV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[Math.max(0, Math.min(h - 1, k)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = acc / (2 * r + 1);
      acc += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x];
    }
  }
}

/**
 * 1方向の最大値フィルタ(単調キューで、半径によらず画素数に比例する手間)。
 * 長さ n の列が lines 本並ぶ。列の中の隣は step、次の列は lineStep 離れている。
 */
function maxFilter1D(src: Uint8Array, dst: Uint8Array, n: number, lines: number, step: number, lineStep: number, r: number): void {
  const q = new Int32Array(n);
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    let head = 0, tail = 0, next = 0;
    for (let i = 0; i < n; i++) {
      // 窓 [i - r, i + r] の右端まで入れる
      for (const end = Math.min(n - 1, i + r); next <= end; next++) {
        const v = src[base + next * step];
        while (tail > head && src[base + q[tail - 1] * step] <= v) tail--;
        q[tail++] = next;
      }
      while (q[head] < i - r) head++;
      dst[base + i * step] = src[base + q[head] * step];
    }
  }
}
