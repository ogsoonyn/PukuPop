/**
 * ブラウザの保存領域(IndexedDB の自動保存・最近開いたファイル)を、空きが減っても消されないよう頼む。
 * 頼むのは、初めて作業を残したとき(最初の自動保存の成功か、ファイルの保存)。起動直後には頼まない
 * (Firefox は利用者に確認を出すので、「作業を残したから」という場面に合わせる)。
 * 判断は DOM に依存しない純粋な関数 `shouldRequestPersist` に分けてある。
 */
import { prefs } from './prefs';

/** 断られたあと、頼み直さない日数。理由は .claude/docs/decisions.md */
export const PERSIST_RETRY_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
/** prefs のキー: 断られた日時(ミリ秒) */
export const PERSIST_DENIED_KEY = 'storagePersistDeniedAt';

export const QUOTA_MESSAGE = 'ブラウザの保存領域が足りません。ファイルに保存してください。';

export interface PersistState {
  /** すでに永続化されているか(`navigator.storage.persisted()`) */
  persisted: boolean;
  /** このページを開いてから、もう頼んだか */
  askedThisSession: boolean;
  /** 前に断られた日時。断られたことが無ければ undefined */
  deniedAt?: number;
  now: number;
}

/** 永続化を頼むべきか */
export function shouldRequestPersist(s: PersistState): boolean {
  if (s.persisted || s.askedThisSession) return false;
  if (typeof s.deniedAt === 'number' && Number.isFinite(s.deniedAt)) {
    // 時計が戻って未来の日時になっているときは、頼み直しを止め続けないよう、断られていないものとみなす
    if (s.deniedAt <= s.now && s.now - s.deniedAt < PERSIST_RETRY_DAYS * DAY) return false;
  }
  return true;
}

/** 保存先の容量不足か(IndexedDB の書き込みの失敗) */
export function isQuotaExceeded(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'QuotaExceededError';
}

/** 自動保存の失敗の理由を、利用者に出す文言にする */
export function autosaveFailureReason(e: unknown): string {
  if (isQuotaExceeded(e)) return QUOTA_MESSAGE;
  return e instanceof Error ? e.message : String(e);
}

let asked = false;

/**
 * 必要なら永続化を頼む。ページを開いている間に1回だけ。
 * 使えないブラウザや例外は黙って無視する(保存は止めない)。断られたら日時を覚える。
 */
export async function requestPersistOnce(): Promise<void> {
  if (asked) return;
  try {
    const s = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!s || typeof s.persist !== 'function') return;
    const persisted = typeof s.persisted === 'function' ? await s.persisted() : false;
    const deniedAt = prefs.get<number>(PERSIST_DENIED_KEY);
    // await をまたぐので、同時に呼ばれても1回になるよう、判断と印付けを続けて行う
    if (!shouldRequestPersist({ persisted, askedThisSession: asked, deniedAt, now: Date.now() })) { asked = true; return; }
    asked = true;
    const granted = await s.persist();
    if (granted) prefs.set(PERSIST_DENIED_KEY, null);
    else prefs.set(PERSIST_DENIED_KEY, Date.now());
  } catch { /* 頼めなかっただけ */ }
}

export interface StorageInfo { usage: number; quota: number; persisted: boolean | null }

/** ブラウザに残している量と使える量(見積もり)。分からなければ null */
export async function storageInfo(): Promise<StorageInfo | null> {
  try {
    const s = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!s || typeof s.estimate !== 'function') return null;
    const { usage, quota } = await s.estimate();
    if (typeof usage !== 'number' || typeof quota !== 'number') return null;
    const persisted = typeof s.persisted === 'function' ? await s.persisted() : null;
    return { usage, quota, persisted };
  } catch { return null; }
}
