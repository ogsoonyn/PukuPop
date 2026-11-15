/**
 * タブごとの自動保存の予約と取り消し(編集アプリだけの機能)。IndexedDB への読み書きは storage/autosave.ts。
 * App とは AutosaveHost の分だけでつながる。
 */
import { serializeProjectBlob } from '../storage/popstage';
import { autosave } from '../storage/autosave';
import { autosaveFailureReason, isQuotaExceeded, requestPersistOnce } from '../storage/persist';
import { toast } from '../ui/dom';
import { suggestedName, tabName, type Tab } from './tab';

/** 変更してから自動保存するまで(ミリ秒) */
export const AUTOSAVE_DELAY = 2000;

export interface AutosaveHost {
  /** 開いているタブ(閉じたタブは保存しない) */
  readonly tabs: readonly Tab[];
  /** 表に出ているタブ */
  readonly activeTab: Tab;
  /** 表のタブが確定していない状態(塗りの最中・ぼかしや膨らませるのプレビュー中)か */
  readonly unsettled: boolean;
  /** 計測(デバッグ表示を開いたときだけ) */
  readonly perf: { event(e: { t: number; d: number; kind: string; detail?: string }): void } | null;
  /** 自動保存の成否が変わった(ステータスバー) */
  statusChanged(): void;
}

export class TabAutosaver {
  constructor(private readonly host: AutosaveHost) {}

  /** そのタブの自動保存を予約する。裏に回ったタブも中身は変わらないので、予約どおりに保存する */
  schedule(tab: Tab): void {
    const host = this.host;
    clearTimeout(tab.autosaveTimer);
    /** 表のタブの塗りの最中・ぼかしのプレビュー中は、確定していない状態を保存しないよう後に回す */
    const unsettled = () => tab === host.activeTab && host.unsettled;
    const live = () => host.tabs.includes(tab) && tab.dirty && !!tab.project.documents[0];
    tab.autosaveTimer = window.setTimeout(() => {
      tab.autosaveTimer = 0;
      if (!live()) return;
      if (unsettled()) { this.schedule(tab); return; }
      const fail = (e: unknown) => {
        console.warn('autosave failed', e);
        tab.autosaveError = autosaveFailureReason(e);
        tab.autosaveQuota = isQuotaExceeded(e);
        // 裏のタブの失敗はステータスバーに出ないので、その場で知らせる
        if (tab !== host.activeTab) toast(tab.autosaveQuota ? `「${tabName(tab)}」の自動保存に失敗しました。ブラウザの保存領域が足りません。そのタブをファイルに保存してください。` : `「${tabName(tab)}」の自動保存に失敗しました(${tab.autosaveError})。そのタブを保存してください。`, 'error', 8000);
        host.statusChanged();
      };
      // 直列化は重いので、操作の合間(アイドル時間)に行う
      idle(() => {
        if (!live()) return;
        if (unsettled()) { this.schedule(tab); return; }
        try {
          const t = performance.now();
          const bytes = serializeProjectBlob(tab.project, { pngCache: tab.pngCache });
          const t1 = performance.now();
          const run = autosave.save(tab.id, { savedAt: Date.now(), name: suggestedName(tab), bytes, order: tab.order })
            .then(() => {
              tab.lastAutosave = new Date(); tab.autosaveError = null; tab.autosaveQuota = false; host.statusChanged();
              void requestPersistOnce();
              // 書き込んでいる間にタブを閉じたら、書いた分を消す
              if (!host.tabs.includes(tab)) return autosave.clear(tab.id);
            }, fail);
          if (host.perf) {
            const p = host.perf;
            p.event({ t, d: t1 - t, kind: 'autosave', detail: `${(bytes.size / 1e6).toFixed(1)}MB を直列化(メインスレッド)` });
            void run.then(() => p.event({ t: t1, d: performance.now() - t1, kind: 'autosave-write', detail: 'IndexedDB への書き込み完了まで(非同期)' }));
          }
          tab.autosaving = tab.autosaving.then(() => run);
        } catch (e) { fail(e); }
      });
    }, AUTOSAVE_DELAY);
  }

  /** タブの自動保存を取り消して消す(実行中のものは終わってから消す) */
  drop(t: Tab): void {
    clearTimeout(t.autosaveTimer); t.autosaveTimer = 0;
    void t.autosaving.then(() => autosave.clear(t.id));
  }
}

/** ブラウザが暇なときに実行する(requestIdleCallback が無ければすぐ後に) */
function idle(fn: () => void): void {
  if ('requestIdleCallback' in window) window.requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 0);
}
