/**
 * 最近開いたファイルの一覧(IndexedDB)。
 *   Chrome / Edge: ファイルの場所(FileSystemFileHandle)を覚える。開き直すときにブラウザが読む許可を求める。
 *   ほかのブラウザ: 場所を覚えられないので、中身のコピーを覚える(1件 COPY_MAX まで、合計 COPY_TOTAL まで)。
 *   Android の Chrome: 場所を覚えても、開き直すときに読めないことがある(Chrome 132 から場所を受け取れるが、
 *   覚えた場所は読む許可が切れて読めなくなる)。場所と一緒にコピーも覚え、読めなければコピーから開く。
 *   場所を IndexedDB に入れられなかったときも、コピーだけで覚え直す。
 * 一覧はこのブラウザの中だけに残り、サーバーへは送らない。
 */
const DB_NAME = 'popstage-recent';
const STORE = 'entries';

export const RECENT_MAX = 12;
export const COPY_MAX = 50 << 20;
export const COPY_TOTAL = 200 << 20;

export type RecentKind = 'project' | 'image';

export interface RecentEntry {
  id: string;
  name: string;
  kind: RecentKind;
  openedAt: number;
  /** ファイルのバイト数 */
  size: number;
  /** 一覧に出す縮小画像(PNG) */
  thumb?: Blob;
  /** ファイルの場所(Chrome 系) */
  handle?: FileSystemFileHandle;
  /** 場所を覚えられないとき(と Android で場所の控えとして)の中身のコピー。Blob なら一覧を読むだけでは中身がメモリに載らない */
  bytes?: Blob;
}

export interface RecentInput {
  name: string;
  kind: RecentKind;
  size: number;
  thumb?: Blob;
  handle?: FileSystemFileHandle | null;
  /** 場所が無いときに使う中身。COPY_MAX を超えるなら読まない */
  bytes?: () => Promise<Uint8Array> | Uint8Array;
}

/** 覚えた場所から読めないことがあるので、場所と一緒にコピーも覚えるブラウザか(Android の Chrome) */
export function keepsCopyWithHandle(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

/** 本物のファイルハンドルか(テスト用の作り物などは IndexedDB に入らない) */
export function isRealHandle(h: unknown): h is FileSystemFileHandle {
  return typeof FileSystemFileHandle !== 'undefined' && h instanceof FileSystemFileHandle;
}

/**
 * 新しい項目を先頭に置き、件数と、コピーの合計サイズの上限に収まるよう古いものから外す。
 * 戻り値は残す一覧(新しい順)と、外す項目の id。
 */
export function trimRecent(entries: readonly RecentEntry[]): { keep: RecentEntry[]; drop: string[] } {
  const sorted = [...entries].sort((a, b) => b.openedAt - a.openedAt);
  const keep: RecentEntry[] = [], drop: string[] = [];
  let copies = 0;
  for (const e of sorted) {
    const copy = e.bytes?.size ?? 0;
    if (keep.length >= RECENT_MAX || copies + copy > COPY_TOTAL) { drop.push(e.id); continue; }
    copies += copy;
    keep.push(e);
  }
  return { keep, drop };
}

/** 同じファイルの項目を探す。場所どうしは同じ実体か、コピーどうしは同じ名前・種類かで比べる */
async function findSame(entries: readonly RecentEntry[], input: { name: string; kind: RecentKind; handle?: FileSystemFileHandle }): Promise<RecentEntry | undefined> {
  for (const e of entries) {
    if (e.kind !== input.kind) continue;
    if (input.handle && e.handle) {
      try { if (await e.handle.isSameEntry(input.handle)) return e; } catch { /* 比べられなければ別物とみなす */ }
    } else if (!input.handle && !e.handle && e.name === input.name) return e;
  }
  return undefined;
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pukupop: 'application/zip', popstage: 'application/zip' };

function fromCopy(e: RecentEntry, bytes: Blob): File {
  const ext = e.name.split('.').pop()?.toLowerCase() ?? '';
  return new File([bytes], e.name, { type: MIME[ext] ?? '' });
}

/**
 * 項目の中身を読む。場所から読めたときだけ handle を返す(上書き保存の先になる)。
 * 場所から読めず(許可が得られない・読めない)控えのコピーがあれば、コピーを返す(fromCopy)。
 * 許可が得られずコピーも無ければ 'denied'。読めずコピーも無ければ例外(見つからなければ NotFoundError)。
 * 場所から読むときはブラウザが読む許可を確かめるので、クリックの直後に呼ぶ。
 */
export async function readRecent(e: RecentEntry): Promise<{ file: File; handle?: FileSystemFileHandle; fromCopy: boolean } | 'denied'> {
  if (e.handle) {
    const h = e.handle;
    try {
      if (h.queryPermission && (await h.queryPermission({ mode: 'read' })) !== 'granted'
        && (await h.requestPermission?.({ mode: 'read' })) !== 'granted') {
        return e.bytes ? { file: fromCopy(e, e.bytes), fromCopy: true } : 'denied';
      }
      return { file: await h.getFile(), handle: h, fromCopy: false };
    } catch (err) {
      if (e.bytes) return { file: fromCopy(e, e.bytes), fromCopy: true };
      throw err;
    }
  }
  if (e.bytes) return { file: fromCopy(e, e.bytes), fromCopy: false };
  throw new DOMException('中身が残っていません', 'NotFoundError');
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(STORE, mode), req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}

const newId = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** 一覧の書き換えを直列にする(続けて開いたときに、片方の追加が消えないように) */
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const p = queue.then(fn, fn);
  queue = p.catch(() => undefined);
  return p;
};

export const recent = {
  /** 新しい順の一覧。読めなければ空 */
  async list(): Promise<RecentEntry[]> {
    try { return ((await run<RecentEntry[]>('readonly', s => s.getAll())) ?? []).sort((a, b) => b.openedAt - a.openedAt); }
    catch (e) { console.warn('recent list failed', e); return []; }
  },

  /** 開いた・保存したファイルを先頭に足す。覚えられなかったら false(作業は止めない) */
  add(input: RecentInput): Promise<boolean> {
    return serial(async () => {
      try {
        let handle = isRealHandle(input.handle) ? input.handle : undefined;
        const copy = async (): Promise<Blob | undefined> => {
          if (!input.bytes || input.size > COPY_MAX) return undefined;
          const data = await input.bytes();
          return data.byteLength > COPY_MAX ? undefined : new Blob([data as BlobPart]);
        };
        // 場所を覚えたうえでのコピーは控えなので、作れなくても場所だけで覚える
        let bytes = !handle || keepsCopyWithHandle() ? await copy() : undefined;
        if (!handle && !bytes) return false;
        const put = async (): Promise<void> => {
          const entries = await recent.list();
          const same = await findSame(entries, { name: input.name, kind: input.kind, handle });
          const entry: RecentEntry = {
            id: same?.id ?? newId(), name: input.name, kind: input.kind, openedAt: Date.now(), size: input.size,
            thumb: input.thumb ?? same?.thumb, handle, bytes,
          };
          const { drop } = trimRecent([entry, ...entries.filter(e => e.id !== entry.id)]);
          await run('readwrite', s => { s.put(entry); for (const id of drop) s.delete(id); });
        };
        try { await put(); } catch (e) {
          // 場所を IndexedDB に入れられないブラウザがある。コピーだけで覚え直す
          if (!handle) throw e;
          console.warn('recent add with handle failed, keeping a copy instead', e);
          handle = undefined;
          bytes ??= await copy();
          if (!bytes) return false;
          await put();
        }
        return true;
      } catch (e) { console.warn('recent add failed', e); return false; }
    });
  },

  remove(id: string): Promise<void> {
    return serial(async () => { try { await run('readwrite', s => s.delete(id)); } catch (e) { console.warn('recent remove failed', e); } });
  },

  clear(): Promise<void> {
    return serial(async () => { try { await run('readwrite', s => s.clear()); } catch (e) { console.warn('recent clear failed', e); } });
  },
};
