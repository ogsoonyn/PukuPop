/**
 * 予期しない例外を知らせる間隔の判定。DOM に依存しない(時刻は引数で渡す)。
 * 描画ループで毎フレーム同じ例外が出ても、知らせるのは間を空けて1回だけにする。
 */
export class NoticeThrottle {
  private last = -Infinity;
  private skipped = 0;
  /** 直近に知らせた回(take が true を返した回)より前に、間引かれた回数 */
  skippedBefore = 0;
  constructor(private readonly intervalMs = 10_000) {}

  /** 今知らせてよければ true にして、知らせた時刻を覚える。間隔の内なら false(間引いた回数に数える) */
  take(now: number): boolean {
    if (now - this.last < this.intervalMs) { this.skipped++; return false; }
    this.last = now;
    this.skippedBefore = this.skipped;
    this.skipped = 0;
    return true;
  }
}

/**
 * 知らせなくてよい無害なエラーの見分け。window の error イベントの error と message を渡す。
 * 'ignore': 何もしない(ResizeObserver の通知が同じフレームで終わらなかっただけ)。
 * 'log': コンソールに残すだけ(error が無く、中身が分からない "Script error." など)。null: 知らせる対象
 */
export function benignKind(error: unknown, message: unknown): 'ignore' | 'log' | null {
  if (error !== null && error !== undefined) return null;
  if (typeof message === 'string' && message.startsWith('ResizeObserver loop')) return 'ignore';
  return 'log';
}

/** ユーザーが取り消したときの AbortError は、知らせる対象ではない */
export function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}
