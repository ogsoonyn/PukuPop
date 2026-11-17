/**
 * 画像ファイルの先頭のバイトから種類・寸法・向きを読む。デコードはしない。
 * DOM に依存しない(.pukupop の読み込みと、画像を開く画面の両方で使う)。
 */

/** 扱う画像の種類と、そのとき使う拡張子 */
export const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** 先頭のバイトから画像の種類(PNG / JPEG / WebP)を決める。印の確かめ方は imageHeaderSize とそろえる。分からなければ null */
export function sniffImageMime(b: Uint8Array): string | null {
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.length >= 12 && String.fromCharCode(b[0], b[1], b[2], b[3]) === 'RIFF' && String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP') return 'image/webp';
  return null;
}

/** PNG / JPEG / WebP のヘッダから寸法を読む(回転は考えない)。読めなければ null */
export function imageHeaderSize(b: Uint8Array): { width: number; height: number } | null {
  const u16be = (o: number) => (b[o] << 8) | b[o + 1];
  const u24le = (o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { width: ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0, height: ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0 };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) { p++; continue; }
      const m = b[p + 1];
      if (m === 0xff) { p++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
      // SOF0〜SOF15(DHT・JPG・DAC を除く)に寸法がある
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: u16be(p + 7), height: u16be(p + 5) };
      p += 2 + u16be(p + 2);
    }
    return null;
  }
  if (b.length >= 30 && String.fromCharCode(b[0], b[1], b[2], b[3]) === 'RIFF' && String.fromCharCode(b[8], b[9], b[10], b[11]) === 'WEBP') {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === 'VP8X') return { width: 1 + u24le(24), height: 1 + u24le(27) };
    if (kind === 'VP8L') return { width: 1 + (b[21] | ((b[22] & 0x3f) << 8)), height: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)) };
    if (kind === 'VP8 ') return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
  }
  return null;
}

/**
 * JPEG の EXIF の向き(Orientation、1〜8)を読む。JPEG でない・EXIF が無い・読めないときは 1(回転なし)。
 * 5〜8 は縦横が入れ替わる向き。
 */
export function jpegOrientation(b: Uint8Array): number {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let p = 2;
  while (p + 4 <= b.length) {
    // 寸法の読み方(imageHeaderSize)と同じく、マーカーの間の余計なバイトや詰め物は読み飛ばす
    if (b[p] !== 0xff) { p++; continue; }
    const m = b[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
    // 画像データ(SOS)・終わり(EOI)より後ろに EXIF は無い
    if (m === 0xda || m === 0xd9) return 1;
    const len = (b[p + 2] << 8) | b[p + 3];
    if (len < 2) return 1;
    const end = Math.min(b.length, p + 2 + len);
    // APP1 の先頭が "Exif\0\0" なら、その後ろが TIFF の形
    if (m === 0xe1 && p + 10 <= end && b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66 && b[p + 8] === 0 && b[p + 9] === 0) {
      return tiffOrientation(b, p + 10, end);
    }
    p += 2 + len;
  }
  return 1;
}

function tiffOrientation(b: Uint8Array, t: number, end: number): number {
  if (t + 8 > end) return 1;
  const le = b[t] === 0x49 && b[t + 1] === 0x49, be = b[t] === 0x4d && b[t + 1] === 0x4d;
  if (!le && !be) return 1;
  const u16 = (o: number) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  const u32 = (o: number) => (le ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24) : (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const ifd = t + u32(t + 4);
  if (ifd + 2 > end) return 1;
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) return 1;
    // 向きは SHORT(型 3)が1個。ほかの型で書かれたものは向きとして使わない
    if (u16(e) === 0x0112) {
      if (u16(e + 2) !== 3 || u32(e + 4) !== 1) return 1;
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/**
 * ブラウザがデコードしたときの寸法を、デコードせずに見積もる。ヘッダの寸法に、JPEG の EXIF の向きを当てる
 * (ブラウザは既定で EXIF の向きを当てて読むので、5〜8 では縦横が入れ替わる)。読めなければ null
 */
export function imageOrientedSize(b: Uint8Array): { width: number; height: number } | null {
  const size = imageHeaderSize(b);
  if (!size) return null;
  return jpegOrientation(b) >= 5 ? { width: size.height, height: size.width } : size;
}
