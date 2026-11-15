/**
 * RGBA(ストレートアルファ・上の行から)の PNG と APNG を組み立てる。DOM と three.js に依存しないので単体テストできる。
 * ライブラリを足さずに作るため、圧縮は fflate の zlibSync、CRC はウェイトの PNG・ZIP と同じものを使う。
 * キャンバスの toBlob を通さないのは、乗算済みアルファへの変換で半透明の色が丸まらないようにするため。
 */
import { zlibSync } from 'fflate';
import { crc32 } from '../storage/zip';

const SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
/** 圧縮の強さ(fflate の 0〜9)。書き出しの待ち時間と大きさの釣り合いで、ウェイトの PNG と同じにする */
const LEVEL = 6;

/** チャンク(長さ・種類・中身・CRC)を作る。CRC は種類と中身にかかる */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** IHDR(8ビット RGBA・インターレース無し) */
function ihdr(width: number, height: number): Uint8Array {
  const d = new Uint8Array(13), dv = new DataView(d.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  d[8] = 8; d[9] = 6; // 8ビット・RGBA
  return pngChunk('IHDR', d);
}

/** 行ごとに Paeth フィルタを掛けて zlib で圧縮した画像データ(IDAT / fdAT の中身) */
export function compressRgba(width: number, height: number, rgba: ArrayLike<number>): Uint8Array {
  if (rgba.length !== width * height * 4) throw new Error('size mismatch');
  const stride = width * 4, raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1) + 1, r = y * stride, up = r - stride;
    raw[o - 1] = 4;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? rgba[r + x - 4] : 0, b = y > 0 ? rgba[up + x] : 0, c = x >= 4 && y > 0 ? rgba[up + x - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      raw[o + x] = (rgba[r + x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
    }
  }
  return zlibSync(raw, { level: LEVEL });
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** 1枚の RGBA の PNG を作る */
export function encodeRgbaPng(width: number, height: number, rgba: ArrayLike<number>): Uint8Array {
  return concat([SIG, ihdr(width, height), pngChunk('IDAT', compressRgba(width, height, rgba)), pngChunk('IEND', new Uint8Array(0))]);
}

/**
 * APNG を1フレームずつ組み立てる。フレームは受け取ったときに圧縮し、圧縮後のチャンクだけを持つ(生の RGBA は溜めない)。
 * 毎フレーム全面を置き換える(dispose_op = NONE、blend_op = SOURCE)。無限にループする(num_plays = 0)。
 * 1枚目は IDAT に入れるので、APNG に対応していないアプリでは1枚目の静止画として出る。
 */
export class ApngWriter {
  private parts: Uint8Array[] = [];
  /** fcTL と fdAT で通しの連番 */
  private seq = 0;
  private count = 0;

  constructor(readonly width: number, readonly height: number, readonly fps: number) {
    if (!(width > 0 && height > 0)) throw new Error('size must be positive');
    if (!(fps > 0 && fps <= 0xffff && Number.isInteger(fps))) throw new Error('fps must be an integer');
  }

  get frames(): number { return this.count; }

  addFrame(rgba: ArrayLike<number>): void {
    const data = compressRgba(this.width, this.height, rgba);
    this.parts.push(this.fctl());
    if (this.count === 0) this.parts.push(pngChunk('IDAT', data));
    else {
      const d = new Uint8Array(4 + data.length);
      new DataView(d.buffer).setUint32(0, this.seq++);
      d.set(data, 4);
      this.parts.push(pngChunk('fdAT', d));
    }
    this.count++;
  }

  /** 組み立てた APNG を、つなぐ前の部品の並びで返す(Blob にそのまま渡せる。全体をもう1回写さない)。1枚も無ければ例外 */
  finishParts(): Uint8Array[] {
    if (!this.count) throw new Error('no frames');
    const actl = new Uint8Array(8), dv = new DataView(actl.buffer);
    dv.setUint32(0, this.count); dv.setUint32(4, 0); // num_frames、num_plays(0 で無限)
    return [SIG, ihdr(this.width, this.height), pngChunk('acTL', actl), ...this.parts, pngChunk('IEND', new Uint8Array(0))];
  }

  /** 組み立てた APNG を1つにつなぐ(確かめ用。書き出しは finishParts を使う)。1枚も無ければ例外 */
  finish(): Uint8Array { return concat(this.finishParts()); }

  /** fcTL(全面・表示時間 1/fps 秒・前のフレームはそのまま・置き換え) */
  private fctl(): Uint8Array {
    const d = new Uint8Array(26), dv = new DataView(d.buffer);
    dv.setUint32(0, this.seq++);
    dv.setUint32(4, this.width); dv.setUint32(8, this.height);
    dv.setUint32(12, 0); dv.setUint32(16, 0); // x_offset、y_offset
    dv.setUint16(20, 1); dv.setUint16(22, this.fps); // delay_num / delay_den
    d[24] = 0; // APNG_DISPOSE_OP_NONE
    d[25] = 0; // APNG_BLEND_OP_SOURCE
    return pngChunk('fcTL', d);
  }
}
