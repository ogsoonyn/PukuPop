/**
 * 書き出し形式ごとのエンコーダ。フレームは上の行から並んだ RGBA(ストレートアルファ)で受け取る。
 */
import { Output, BufferTarget, Mp4OutputFormat, WebMOutputFormat, CanvasSource, QUALITY_HIGH, canEncodeVideo } from 'mediabunny';
import { Zip, ZipPassThrough } from 'fflate';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { ApngWriter, encodeRgbaPng } from './apng';

/** still は今の見た目の静止画1枚(PNG)。ほかは動き */
export type ExportFormat = 'mp4' | 'webm' | 'webm-alpha' | 'png' | 'gif' | 'apng' | 'still';

export const FORMAT_INFO: Record<ExportFormat, { label: string; ext: string; mime: string; alpha: boolean }> = {
  mp4: { label: 'MP4(H.264)', ext: 'mp4', mime: 'video/mp4', alpha: false },
  webm: { label: 'WebM(VP9)', ext: 'webm', mime: 'video/webm', alpha: false },
  'webm-alpha': { label: 'WebM 透過(VP9 + α)', ext: 'webm', mime: 'video/webm', alpha: true },
  png: { label: '連番PNG(ZIP)', ext: 'zip', mime: 'application/zip', alpha: true },
  gif: { label: 'GIF', ext: 'gif', mime: 'image/gif', alpha: true },
  apng: { label: 'APNG', ext: 'png', mime: 'image/png', alpha: true },
  still: { label: '静止画 PNG(今の見た目)', ext: 'png', mime: 'image/png', alpha: true },
};

export interface FrameEncoder {
  addFrame(rgba: Uint8ClampedArray, index: number): Promise<void>;
  finish(): Promise<Blob>;
  cancel(): Promise<void>;
}

export interface EncoderOptions { width: number; height: number; fps: number; transparent: boolean }

/** このブラウザで選べる形式を調べる(WebCodecs が無ければ連番PNG・GIF・APNG・静止画だけ)。 */
export async function availableFormats(width = 1280, height = 720): Promise<Record<ExportFormat, boolean>> {
  const hasWC = typeof VideoEncoder !== 'undefined';
  const check = async (codec: 'avc' | 'vp9') => {
    if (!hasWC) return false;
    try { return await canEncodeVideo(codec, { width: even(width), height: even(height) }); } catch { return false; }
  };
  const [avc, vp9] = await Promise.all([check('avc'), check('vp9')]);
  return { mp4: avc, webm: vp9, 'webm-alpha': vp9, png: true, gif: true, apng: true, still: true };
}

export const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** 実際に書き出すサイズで、動画のエンコードができるかを調べる(連番PNG・GIF・APNG・静止画は常に可) */
export async function canEncodeAt(format: ExportFormat, width: number, height: number): Promise<boolean> {
  if (!isVideo(format)) return true;
  if (typeof VideoEncoder === 'undefined') return false;
  try { return await canEncodeVideo(format === 'mp4' ? 'avc' : 'vp9', { width: even(width), height: even(height) }); } catch { return false; }
}

/**
 * 書き出し中にメモリへ溜まる量のおおよその見積もり(バイト)。連番PNG・GIF・APNG は全フレームをメモリに溜めてから保存する。
 * 圧縮率は絵柄で大きく変わるので、多めに見積もる(PNG・APNG は1画素 1.5 バイト、GIF は 0.8 バイト)。動画と静止画は小さいので 0 とする。
 */
export function estimateExportBytes(format: ExportFormat, width: number, height: number, frames: number): number {
  const perPixel = format === 'png' || format === 'apng' ? 1.5 : format === 'gif' ? 0.8 : 0;
  return width * height * frames * perPixel;
}

/** これを超える見積もりのときは、書き出す前に確認する */
export const EXPORT_MEMORY_WARN = 1.5 * 1024 ** 3;

export function createEncoder(format: ExportFormat, o: EncoderOptions): FrameEncoder {
  switch (format) {
    case 'mp4': return new VideoFrameEncoder('mp4', o);
    case 'webm': return new VideoFrameEncoder('webm', o);
    case 'webm-alpha': return new VideoFrameEncoder('webm', { ...o, transparent: true });
    case 'png': return new PngSequenceEncoder(o);
    case 'gif': return new GifFrameEncoder(o);
    case 'apng': return new ApngFrameEncoder(o);
    case 'still': return new StillPngEncoder(o);
  }
}

/** WebCodecs で作る動画の形式か */
export const isVideo = (format: ExportFormat): boolean => format === 'mp4' || format === 'webm' || format === 'webm-alpha';

/** 全フレームをメモリに溜めてから保存する形式か(書き出す前にメモリの目安を示す) */
export const holdsAllFrames = (format: ExportFormat): boolean => format === 'png' || format === 'gif' || format === 'apng';

/* ---------- MP4 / WebM(WebCodecs + mediabunny) ---------- */

class VideoFrameEncoder implements FrameEncoder {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private output: Output<Mp4OutputFormat | WebMOutputFormat, BufferTarget>;
  private source: CanvasSource;
  private started: Promise<void>;
  private image: ImageData;

  constructor(private container: 'mp4' | 'webm', private o: EncoderOptions) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = o.width; this.canvas.height = o.height;
    this.ctx = this.canvas.getContext('2d', { alpha: o.transparent })!;
    this.image = this.ctx.createImageData(o.width, o.height);
    this.output = new Output({
      format: container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
      target: new BufferTarget(),
    });
    this.source = new CanvasSource(this.canvas, {
      codec: container === 'mp4' ? 'avc' : 'vp9',
      quality: QUALITY_HIGH,
      alpha: o.transparent ? 'keep' : 'discard',
      keyFrameInterval: 2,
    });
    this.output.addVideoTrack(this.source, { frameRate: o.fps });
    this.started = this.output.start();
  }

  async addFrame(rgba: Uint8ClampedArray, index: number): Promise<void> {
    await this.started;
    this.image.data.set(rgba);
    this.ctx.clearRect(0, 0, this.o.width, this.o.height);
    this.ctx.putImageData(this.image, 0, 0);
    await this.source.add(index / this.o.fps, 1 / this.o.fps);
  }

  async finish(): Promise<Blob> {
    await this.started;
    await this.output.finalize();
    const buf = this.output.target.buffer;
    if (!buf) throw new Error('動画の生成に失敗しました');
    return new Blob([buf], { type: this.container === 'mp4' ? 'video/mp4' : 'video/webm' });
  }

  async cancel(): Promise<void> { try { await this.started; await this.output.cancel(); } catch { /* 無視 */ } }
}

/* ---------- 連番PNG(ZIP) ---------- */

class PngSequenceEncoder implements FrameEncoder {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private image: ImageData;
  private chunks: Uint8Array[] = [];
  private zip: Zip;
  private done: Promise<void>;

  constructor(private o: EncoderOptions) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = o.width; this.canvas.height = o.height;
    this.ctx = this.canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(o.width, o.height);
    let resolve!: () => void, reject!: (e: unknown) => void;
    this.done = new Promise((a, b) => { resolve = a; reject = b; });
    this.zip = new Zip((err, chunk, final) => {
      if (err) { reject(err); return; }
      this.chunks.push(chunk);
      if (final) resolve();
    });
  }

  async addFrame(rgba: Uint8ClampedArray, index: number): Promise<void> {
    this.image.data.set(rgba);
    this.ctx.clearRect(0, 0, this.o.width, this.o.height);
    this.ctx.putImageData(this.image, 0, 0);
    const blob = await new Promise<Blob>((res, rej) => this.canvas.toBlob(b => (b ? res(b) : rej(new Error('PNG化に失敗しました'))), 'image/png'));
    const file = new ZipPassThrough(`frame_${String(index + 1).padStart(5, '0')}.png`);
    this.zip.add(file);
    file.push(new Uint8Array(await blob.arrayBuffer()), true);
  }

  async finish(): Promise<Blob> {
    this.zip.end();
    await this.done;
    return new Blob(this.chunks as BlobPart[], { type: 'application/zip' });
  }

  async cancel(): Promise<void> { this.zip.terminate(); this.chunks = []; }
}

/* ---------- GIF(gifenc、フレームごとにパレット量子化) ---------- */

class GifFrameEncoder implements FrameEncoder {
  private gif = GIFEncoder();
  private elapsedCs = 0; // 書き込んだ遅延の合計(1/100 秒)

  constructor(private o: EncoderOptions) {}

  async addFrame(rgba: Uint8ClampedArray, index: number): Promise<void> {
    const { width, height, fps, transparent } = this.o;
    // GIF の遅延は 1/100 秒単位なので、累積の誤差が出ないよう各フレームの遅延を配分する
    const targetCs = Math.round(((index + 1) * 100) / fps), delayCs = Math.max(2, targetCs - this.elapsedCs);
    this.elapsedCs += delayCs;
    if (transparent) {
      const palette = quantize(rgba, 256, { format: 'rgba4444', oneBitAlpha: true });
      const idx = applyPalette(rgba, palette, 'rgba4444');
      const ti = palette.findIndex(p => p[3] === 0);
      this.gif.writeFrame(idx, width, height, { palette, delay: delayCs * 10, repeat: 0, transparent: ti >= 0, transparentIndex: Math.max(0, ti) });
    } else {
      const palette = quantize(rgba, 256);
      const idx = applyPalette(rgba, palette);
      this.gif.writeFrame(idx, width, height, { palette, delay: delayCs * 10, repeat: 0 });
    }
    // 重い処理なので UI に一度戻す
    await new Promise(r => setTimeout(r, 0));
  }

  async finish(): Promise<Blob> {
    this.gif.finish();
    return new Blob([this.gif.bytes() as BlobPart], { type: 'image/gif' });
  }

  async cancel(): Promise<void> { /* 何もしない */ }
}

/* ---------- APNG(フルカラー・8ビット透過のループ) ---------- */

class ApngFrameEncoder implements FrameEncoder {
  private apng: ApngWriter;

  constructor(o: EncoderOptions) { this.apng = new ApngWriter(o.width, o.height, o.fps); }

  async addFrame(rgba: Uint8ClampedArray): Promise<void> {
    // 受け取ったフレームはその場で圧縮する(渡された配列は次のフレームで書き換わる)
    this.apng.addFrame(rgba);
    // 重い処理なので UI に一度戻す
    await new Promise(r => setTimeout(r, 0));
  }

  async finish(): Promise<Blob> {
    return new Blob([this.apng.finish() as BlobPart], { type: 'image/png' });
  }

  async cancel(): Promise<void> { /* 何もしない */ }
}

/* ---------- 静止画 PNG(1枚) ---------- */

class StillPngEncoder implements FrameEncoder {
  private png: Uint8Array | null = null;

  constructor(private o: EncoderOptions) {}

  async addFrame(rgba: Uint8ClampedArray): Promise<void> {
    this.png = encodeRgbaPng(this.o.width, this.o.height, rgba);
  }

  async finish(): Promise<Blob> {
    if (!this.png) throw new Error('画像の生成に失敗しました');
    return new Blob([this.png as BlobPart], { type: 'image/png' });
  }

  async cancel(): Promise<void> { this.png = null; }
}
