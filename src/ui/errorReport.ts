import { NoticeThrottle, benignKind, isAbort } from '../errorNotice';
import { toast } from './dom';

const throttle = new NoticeThrottle();

/** 予期しない例外を、コンソールに残して短く知らせる。連続して出ても、知らせるのは間を空けて1回(間引いた回は、次に知らせる回に件数を添える) */
export function reportError(e: unknown): void {
  if (isAbort(e)) return;
  if (!throttle.take(performance.now())) return;
  const n = throttle.skippedBefore;
  if (n > 0) console.error(e, `(ほか ${n} 件)`); else console.error(e);
  toast('問題が起きました。保存してから開き直してください。', 'error', 8000);
}

/** 捕まえ損ねた例外と、待たれていない Promise の失敗を受ける */
export function bindErrorReport(): void {
  window.addEventListener('error', ev => {
    const kind = benignKind(ev.error, ev.message);
    if (kind === 'ignore') return;
    if (kind === 'log') { console.error(ev.message); return; }
    reportError(ev.error);
  });
  window.addEventListener('unhandledrejection', ev => reportError(ev.reason));
}
