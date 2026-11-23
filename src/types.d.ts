declare module 'gifenc' {
  export type Palette = number[][];
  export type Format = 'rgb565' | 'rgb444' | 'rgba4444';
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, options?: { format?: Format; oneBitAlpha?: boolean | number; clearAlpha?: boolean; clearAlphaThreshold?: number; clearAlphaColor?: number }): Palette;
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: Format): Uint8Array;
  export interface Encoder {
    writeFrame(index: Uint8Array, width: number, height: number, opts?: { palette?: Palette; delay?: number; repeat?: number; transparent?: boolean; transparentIndex?: number; first?: boolean }): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
  }
  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): Encoder;
}

/* File System Access API(Chrome 系のみ。無いときはダウンロードで代替する) */
interface FilePickerAcceptType { description?: string; accept: Record<string, string[]> }
interface SaveFilePickerOptions { suggestedName?: string; types?: FilePickerAcceptType[]; id?: string }
interface OpenFilePickerOptions { multiple?: boolean; types?: FilePickerAcceptType[]; id?: string; excludeAcceptAllOption?: boolean; startIn?: FileSystemHandle | string }
interface Window {
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  showOpenFilePicker?: (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>;
}
declare const __APP_VERSION__: string;
/** 最後のコミットの日時(ISO 8601。vite.config.ts がビルドのときに git から読む。読めなければ空) */
declare const __COMMIT_DATE__: string;
/** 埋め込み用のビルド(vite build --mode embed)か。埋め込みモードを有効にする(main.ts・src/app/embed.ts) */
declare const __EMBED__: boolean;

/* ファイルの場所を開き直すときの許可(Chrome 系のみ) */
interface FileSystemHandlePermissionDescriptor { mode?: 'read' | 'readwrite' }
interface FileSystemHandle {
  queryPermission?: (d?: FileSystemHandlePermissionDescriptor) => Promise<PermissionState>;
  requestPermission?: (d?: FileSystemHandlePermissionDescriptor) => Promise<PermissionState>;
}
interface DataTransferItem { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }
