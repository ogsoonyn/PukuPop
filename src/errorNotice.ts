/**
 * 予期しない例外を知らせる間隔の判定。DOM に依存しない(時刻は引数で渡す)。
 * 描画ループで毎フレーム同じ例外が出ても、知らせるのは間を空けて1回だけにする。
 */
export class NoticeThrottle {
  private last = -Infinity;
  constructor(private readonly intervalMs = 10_000) {}

  /** 今知らせてよければ true にして、知らせた時刻を覚える。間隔の内なら false */
  take(now: number): boolean {
    if (now - this.last < this.intervalMs) return false;
    this.last = now;
    return true;
  }
}

/** ユーザーが取り消したときの AbortError は、知らせる対象ではない */
export function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}
