/**
 * Player(Issue #127)の失敗の種類。createPlayer はここの PlayerError で失敗する。
 * DOM を参照しないので、振り分け(loadErrorCode)はブラウザ無しで単体テストできる。
 */
import { NewerFormatError } from '../storage/popstage';

/**
 * 失敗の種類。
 * - 'aborted': options.signal で取り消された
 * - 'invalid-file': 読めない・壊れているファイル(ZIP でない、project.json が無い・不正、画像やウェイトが壊れている、上限を超えるなど)
 * - 'unsupported-version': このプレーヤーより新しい版の形式で保存されている
 * - 'canvas-unusable': キャンバスが使えない(dispose() したキャンバス・ほかのライブラリが WebGL を手放したキャンバス、2D などほかの用途で使われている、ほかの Player が使っている)
 * - 'webgl-unavailable': WebGL2 を使えない(ブラウザ・端末が対応していない、作れない)
 */
export type PlayerErrorCode = 'aborted' | 'invalid-file' | 'unsupported-version' | 'canvas-unusable' | 'webgl-unavailable';

/** createPlayer の失敗。code で種類を見分ける。message は画面にそのまま出せる日本語。元の例外があれば cause に入る */
export class PlayerError extends Error {
  readonly code: PlayerErrorCode;
  constructor(code: PlayerErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PlayerError';
    this.code = code;
  }
}

/** ファイルの読み込み(deserializeProject・画像のデコード)の失敗の種類。新しい版は読み込み側のクラスで見分け、文言では見分けない */
export function loadErrorCode(e: unknown): PlayerErrorCode {
  return e instanceof NewerFormatError ? 'unsupported-version' : 'invalid-file';
}

/** 読み込みの失敗を PlayerError にする。メッセージは読み込み側のまま */
export function loadError(e: unknown): PlayerError {
  if (e instanceof PlayerError) return e;
  const message = e instanceof Error && e.message ? e.message : 'ファイルを読み込めませんでした';
  return new PlayerError(loadErrorCode(e), message, { cause: e });
}

/** 取り消し。signal.reason を cause に入れる */
export const abortedError = (reason?: unknown): PlayerError => new PlayerError('aborted', '読み込みを取り消しました', { cause: reason });
