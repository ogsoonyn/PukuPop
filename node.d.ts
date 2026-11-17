// Node の型は入れていないので、設定ファイル(vite.config.ts・vite.player.config.ts・scripts/third-party-licenses.ts)と E2E で使う所だけ宣言する(@types/node を入れたら消す)
declare module 'node:child_process' {
  export function execSync(command: string, options: { encoding: 'utf8'; stdio?: unknown; cwd?: string }): string;
}
declare module 'node:url' {
  export function fileURLToPath(url: URL | string): string;
}
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  /** 中身をそのまま読む(Node では Buffer。Uint8Array として使う) */
  export function readFileSync(path: string): Uint8Array;
  export function existsSync(path: string): boolean;
}
/** Node の Buffer のうち、E2E で page.route の応答・リクエストの本文に使う所だけ(Playwright は Uint8Array でなく Buffer を求める) */
declare class Buffer extends Uint8Array {
  static from(data: ArrayLike<number> | ArrayBufferLike): Buffer;
  equals(other: Uint8Array): boolean;
}
