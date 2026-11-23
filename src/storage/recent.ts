/**
 * 最近開いたファイルの一覧(IndexedDB)。
 *   Chrome / Edge: ファイルの場所(FileSystemFileHandle)を覚える。開き直すときにブラウザが読む許可を求める。
 *   ほかのブラウザ: 場所を覚えられないので、中身のコピーを覚える(1件 COPY_MAX まで、合計 COPY_TOTAL まで)。
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
  /** 場所を覚えられないときの中身のコピー。Blob なら一覧を読むだけでは中身がメモリに載らない */
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

/** 場所から読むときに待つ長さ(ミリ秒)。check は許可の確かめ、ask は許可を求める画面(人が答える間も待つ)、read は読み込み(クラウドのファイルは取り込みに時間がかかる) */
export const READ_WAIT = { check: 5000, ask: 20000, read: 20000 };

/** 決めた時間で返事が来なければ TimeoutError にする */
function within<T>(p: Promise<T> | T, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new DOMException('ブラウザから返事がありませんでした', 'TimeoutError')), ms);
    Promise.resolve(p).then(v => { clearTimeout(t); resolve(v); }, err => { clearTimeout(t); reject(err); });
  });
}

/**
 * 項目の中身を読む。場所(ハンドル)を覚えていればそこから、無ければ覚えたコピーから。
 * 許可が得られなければ 'denied'。読めなければ例外(見つからなければ NotFoundError、返事が来なければ TimeoutError)。
 * 返事が来ないまま止まると、押しても何も起きないように見える(一覧は1つずつしか開かないので、ほかも押せなくなる)ので、待つ長さを決めておく。
 * 場所から読むときはブラウザが読む許可を確かめるので、クリックの直後に呼ぶ。
 */
export async function readRecent(e: RecentEntry, wait = READ_WAIT): Promise<File | 'denied'> {
  if (e.handle) {
    const h = e.handle;
    if (h.queryPermission && (await within(h.queryPermission({ mode: 'read' }), wait.check)) !== 'granted'
      && (await within(h.requestPermission?.({ mode: 'read' }), wait.ask)) !== 'granted') return 'denied';
    return await within(h.getFile(), wait.read);
  }
  if (e.bytes) {
    const ext = e.name.split('.').pop()?.toLowerCase() ?? '';
    return new File([e.bytes], e.name, { type: MIME[ext] ?? '' });
  }
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
        const handle = isRealHandle(input.handle) ? input.handle : undefined;
        let bytes: Blob | undefined;
        if (!handle) {
          if (!input.bytes || input.size > COPY_MAX) return false;
          const data = await input.bytes();
          if (data.byteLength > COPY_MAX) return false;
          bytes = new Blob([data as BlobPart]);
        }
        const entries = await recent.list();
        const same = await findSame(entries, { name: input.name, kind: input.kind, handle });
        const entry: RecentEntry = {
          id: same?.id ?? newId(), name: input.name, kind: input.kind, openedAt: Date.now(), size: input.size,
          thumb: input.thumb ?? same?.thumb, handle, bytes,
        };
        const { drop } = trimRecent([entry, ...entries.filter(e => e.id !== entry.id)]);
        await run('readwrite', s => { s.put(entry); for (const id of drop) s.delete(id); });
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
