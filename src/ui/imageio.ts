/** 画像のデコードとサムネイル。DOM(Canvas)を使うので Model からは分けておく。 */
import type { ImageAsset } from '../model/project';
import type { GrayImage } from '../storage/png';
import { IMAGE_TYPES, imageHeaderSize, sniffImageMime } from '../storage/imagehead';

export { IMAGE_TYPES, imageHeaderSize };

export function isImageFile(f: File): boolean { return f.type in IMAGE_TYPES || /\.(png|jpe?g|webp)$/i.test(f.name); }
/** クリップボードの画像は名前が無いか `image.png` なので、「貼り付けた画像.png」にする(元の名前があればそのまま) */
export function pastedImageFile(f: File): File {
  if (f.name && !/^image\.\w+$/i.test(f.name)) return f;
  return new File([f], `貼り付けた画像.${IMAGE_TYPES[f.type] ?? 'png'}`, { type: f.type, lastModified: f.lastModified });
}

export function isProjectFile(f: File): boolean { return /\.(pukupop|popstage)$/i.test(f.name); }

/** 読み込める画像の画素数の上限。デコードすると幅×高さ×4バイトを確保するので、それを抑える */
export const MAX_IMAGE_PIXELS = 120_000_000;

/**
 * 画像ファイルを読み、元の寸法と表示用のキャンバスを返す。デコードは1回だけで、寸法の取得と表示に使い回す。
 * 大きすぎる画像は、ヘッダの寸法を見てデコードする前に弾く。
 */
export async function fileToAsset(file: File, maxDisplay: number): Promise<{ asset: ImageAsset; canvas: HTMLCanvasElement }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type in IMAGE_TYPES ? file.type : sniffImageMime(bytes);
  if (!mime) throw new Error('PNG / JPEG / WebP の画像を選んでください。');
  const bmp = await decodeBitmap(bytes, mime);
  const asset: ImageAsset = { bytes, mime, ext: IMAGE_TYPES[mime], width: bmp.width, height: bmp.height };
  return { asset, canvas: bitmapToCanvas(bmp, maxDisplay) };
}

async function decodeBitmap(bytes: Uint8Array, mime: string): Promise<ImageBitmap> {
  // 画素数は回転(EXIF)の影響を受けないので、ヘッダの寸法で判定できる
  // 受け付けるのは PNG / JPEG / WebP だけで、正しいファイルなら必ずヘッダを読める。
  // 読めないもの(中身が別の形式など)は、大きさを確かめられないのでデコードしない
  const size = imageHeaderSize(bytes);
  if (!size) throw new Error('画像を読み込めませんでした(壊れているか、PNG / JPEG / WebP ではありません)。');
  if (size.width * size.height > MAX_IMAGE_PIXELS) {
    throw new Error(`画像が大きすぎます(${size.width}×${size.height})。${MAX_IMAGE_PIXELS / 1e6} メガピクセル以下にしてください。`);
  }
  try {
    return await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    throw new Error('画像を読み込めませんでした(壊れているか、対応していない形式です)。');
  }
}

function bitmapToCanvas(bmp: ImageBitmap, maxSize: number): HTMLCanvasElement {
  const s = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c;
}

/** 表示用に、最大 maxSize に縮めたキャンバスへ描く。画像が壊れていれば日本語のメッセージで例外を投げる。 */
export async function decodeForDisplay(asset: ImageAsset, maxSize: number): Promise<HTMLCanvasElement> {
  return bitmapToCanvas(await decodeBitmap(asset.bytes, asset.mime), maxSize);
}

/** キャンバスのアルファを w×h で取り出す(「アルファから生成」用)。 */
export function canvasAlpha(c: HTMLCanvasElement, w: number, h: number): Uint8Array {
  const t = document.createElement('canvas'); t.width = w; t.height = h;
  const g = t.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(c, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
  return out;
}

/** 内蔵デコーダで読めないPNG(インターレース等)をブラウザで読む。 */
export async function browserDecodeGray(bytes: Uint8Array): Promise<GrayImage> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0); bmp.close();
  const d = g.getImageData(0, 0, c.width, c.height).data, out = new Uint8Array(c.width * c.height);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
  return { width: c.width, height: c.height, data: out };
}

export function rgbaToPng(rgba: Uint8ClampedArray, w: number, h: number): Promise<Uint8Array> {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  const img = g.createImageData(w, h); img.data.set(rgba); g.putImageData(img, 0, 0);
  return new Promise((res, rej) => c.toBlob(async b => (b ? res(new Uint8Array(await b.arrayBuffer())) : rej(new Error('PNG化に失敗しました'))), 'image/png'));
}

/** レイヤー一覧用の小さなウェイト画像。color(#rrggbb)は重ね表示と同じレイヤーの色で、塗りが濃いほど濃く出る */
export function drawWeightThumb(canvas: HTMLCanvasElement, data: Uint8Array, w: number, h: number, color = '#ff3380'): void {
  const n = parseInt(color.slice(1), 16), r = (n >> 16) & 255, gr = (n >> 8) & 255, b = n & 255;
  const s = Math.min(canvas.width / w, canvas.height / h);
  const tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(tw, th);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(h - 1, Math.floor((y + 0.5) / s));
    for (let x = 0; x < tw; x++) {
      const v = data[sy * w + Math.min(w - 1, Math.floor((x + 0.5) / s))], i = (y * tw + x) * 4;
      // 色はレイヤーの色のまま、塗るほど濃くする(白に寄せるとレイヤーどうしで見分けにくくなるため)
      img.data[i] = r; img.data[i + 1] = gr; img.data[i + 2] = b; img.data[i + 3] = 40 + v * 0.84;
    }
  }
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.putImageData(img, Math.floor((canvas.width - tw) / 2), Math.floor((canvas.height - th) / 2));
}
