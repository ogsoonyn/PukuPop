import { NoticeThrottle, isAbort } from '../errorNotice';
import { toast } from './dom';

const throttle = new NoticeThrottle();

/** 予期しない例外を、コンソールに残して短く知らせる。連続して出ても、知らせるのは間を空けて1回 */
export function reportError(e: unknown): void {
  if (isAbort(e)) return;
  console.error(e);
  if (throttle.take(performance.now())) toast('問題が起きました。保存してから開き直してください。', 'error', 8000);
}

/** 捕まえ損ねた例外と、待たれていない Promise の失敗を受ける */
export function bindErrorReport(): void {
  window.addEventListener('error', ev => reportError(ev.error ?? ev.message));
  window.addEventListener('unhandledrejection', ev => reportError(ev.reason));
}
