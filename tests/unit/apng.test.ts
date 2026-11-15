import { describe, it, expect } from 'vitest';
import { unzlibSync } from 'fflate';
import { ApngWriter, encodeRgbaPng } from '../../src/export/apng';
import { decodePngToGray } from '../../src/storage/png';
import { crc32 } from '../../src/storage/zip';
import { estimateExportBytes, holdsAllFrames, canEncodeAt, FORMAT_INFO } from '../../src/export/encoders';

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

interface Chunk { type: string; data: Uint8Array; crcOk: boolean }

function chunks(bytes: Uint8Array): Chunk[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out: Chunk[] = [];
  let p = 8;
  while (p < bytes.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    const crc = dv.getUint32(p + 8 + len);
    out.push({ type, data: bytes.subarray(p + 8, p + 8 + len), crcOk: crc === crc32(bytes.subarray(p + 4, p + 8 + len)) });
    p += 12 + len;
  }
  expect(p).toBe(bytes.length);
  return out;
}

/** 8ビット RGBA の画像データ(フィルタ付き・zlib)を元に戻す */
function unfilter(width: number, height: number, comp: Uint8Array): Uint8Array {
  const stride = width * 4, raw = unzlibSync(comp), img = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], s = y * (stride + 1) + 1, d = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? img[d + x - 4] : 0, b = y > 0 ? img[d - stride + x] : 0, c = x >= 4 && y > 0 ? img[d - stride + x - 4] : 0;
      let v = raw[s + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      img[d + x] = v & 0xff;
    }
  }
  return img;
}

/** 適当な絵柄(半透明・色の変化を含む)。seed でフレームごとに変える */
function frame(w: number, h: number, seed: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i / w) | 0;
    px[i * 4] = (x * 17 + seed * 31) & 255;
    px[i * 4 + 1] = (y * 23 + seed * 7) & 255;
    px[i * 4 + 2] = (x * y + seed) & 255;
    px[i * 4 + 3] = (x + y * 3 + seed * 40) & 255;
  }
  return px;
}

describe('APNG', () => {
  const W = 7, H = 5, FPS = 30;
  const frames = [0, 1, 2].map(s => frame(W, H, s));
  const bytes = (() => { const a = new ApngWriter(W, H, FPS); for (const f of frames) a.addFrame(f); return a.finish(); })();
  const cs = chunks(bytes);

  it('シグネチャとチャンクの並び', () => {
    expect([...bytes.subarray(0, 8)]).toEqual(SIG);
    expect(cs.map(c => c.type)).toEqual(['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'fcTL', 'fdAT', 'IEND']);
  });

  it('各チャンクの CRC が合う', () => {
    expect(cs.every(c => c.crcOk)).toBe(true);
  });

  it('IHDR は 8ビット RGBA、acTL は枚数と無限ループ', () => {
    const ih = new DataView(cs[0].data.buffer, cs[0].data.byteOffset, 13);
    expect([ih.getUint32(0), ih.getUint32(4), cs[0].data[8], cs[0].data[9], cs[0].data[12]]).toEqual([W, H, 8, 6, 0]);
    const ac = new DataView(cs[1].data.buffer, cs[1].data.byteOffset, 8);
    expect(ac.getUint32(0)).toBe(3);
    expect(ac.getUint32(4)).toBe(0);
  });

  it('fcTL と fdAT の連番は 0 から通しで、fcTL は全面・1/fps 秒・置き換え', () => {
    const seq = cs.filter(c => c.type === 'fcTL' || c.type === 'fdAT').map(c => new DataView(c.data.buffer, c.data.byteOffset).getUint32(0));
    expect(seq).toEqual([0, 1, 2, 3, 4]);
    for (const c of cs.filter(c => c.type === 'fcTL')) {
      const d = new DataView(c.data.buffer, c.data.byteOffset, 26);
      expect(c.data.length).toBe(26);
      expect([d.getUint32(4), d.getUint32(8), d.getUint32(12), d.getUint32(16)]).toEqual([W, H, 0, 0]);
      expect([d.getUint16(20), d.getUint16(22)]).toEqual([1, FPS]);
      expect([c.data[24], c.data[25]]).toEqual([0, 0]);
    }
  });

  it('全フレームの画素が元のとおりに戻る', () => {
    const data = cs.filter(c => c.type === 'IDAT' || c.type === 'fdAT').map(c => (c.type === 'IDAT' ? c.data : c.data.subarray(4)));
    data.forEach((d, i) => expect([...unfilter(W, H, d)]).toEqual([...frames[i]]));
  });

  it('1枚目は既存の PNG デコーダで読める(APNG に対応していないアプリでは1枚目が出る)', () => {
    const g = decodePngToGray(bytes), f = frames[0];
    expect([g.width, g.height]).toEqual([W, H]);
    const lum = Array.from({ length: W * H }, (_, i) => Math.round(0.299 * f[i * 4] + 0.587 * f[i * 4 + 1] + 0.114 * f[i * 4 + 2]));
    expect([...g.data]).toEqual(lum);
  });

  it('フレームが無い・大きさや fps がおかしいときは例外', () => {
    expect(() => new ApngWriter(4, 4, 30).finish()).toThrow();
    expect(() => new ApngWriter(0, 4, 30)).toThrow();
    expect(() => new ApngWriter(4, 4, 29.97)).toThrow();
    expect(() => new ApngWriter(4, 4, 30).addFrame(new Uint8ClampedArray(3))).toThrow();
  });
});

describe('静止画 PNG', () => {
  it('RGBA の PNG を作り、画素が戻る', () => {
    const W = 9, H = 4, f = frame(W, H, 5), png = encodeRgbaPng(W, H, f), cs = chunks(png);
    expect([...png.subarray(0, 8)]).toEqual(SIG);
    expect(cs.map(c => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(cs.every(c => c.crcOk)).toBe(true);
    expect([...unfilter(W, H, cs[1].data)]).toEqual([...f]);
  });
});

describe('書き出しの形式の表', () => {
  it('APNG は全フレームを溜めるのでメモリの目安を出し、静止画は出さない', async () => {
    expect(holdsAllFrames('apng')).toBe(true);
    expect(holdsAllFrames('still')).toBe(false);
    expect(estimateExportBytes('apng', 100, 100, 10)).toBe(estimateExportBytes('png', 100, 100, 10));
    expect(estimateExportBytes('still', 100, 100, 10)).toBe(0);
    expect(await canEncodeAt('apng', 4000, 4000)).toBe(true);
    expect(await canEncodeAt('still', 4000, 4000)).toBe(true);
    expect(FORMAT_INFO.apng.alpha && FORMAT_INFO.still.alpha).toBe(true);
  });
});
