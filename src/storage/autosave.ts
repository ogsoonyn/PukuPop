/**
 * IndexedDB への自動保存。タブを閉じても作業が消えないようにする。
 * 中身は .pukupop と同じバイト列。保存は Blob で渡す(大きな画像を毎回メインスレッドで複製しないため)。
 * 読み込みは、古い版が保存した Uint8Array にも対応する。
 * アプリの中のタブごとに、タブの id をキーにして1件ずつ持つ。タブに分ける前の版は、キー 'current' の1件だけだった
 * (そのまま読めるよう、キーは何でもよいことにしてある)。
 */
const DB_NAME = 'popstage';
const STORE = 'autosave';

export interface AutosaveEntry { key: string; savedAt: number; name: string; bytes: Uint8Array; order: number }
export interface AutosaveInput { savedAt: number; name: string; bytes: Uint8Array | Blob; order?: number }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode), req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('書き込みが中断されました'));
    });
  } finally { db.close(); }
}

/** 読み込んだ1件を確かめて形をそろえる。壊れていれば undefined */
async function toEntry(key: IDBValidKey, v: unknown): Promise<AutosaveEntry | undefined> {
  if (typeof key !== 'string' || !v || typeof v !== 'object') return undefined;
  const e = v as Partial<AutosaveInput>;
  const bytes = e.bytes instanceof Blob ? new Uint8Array(await e.bytes.arrayBuffer()) : e.bytes instanceof Uint8Array ? e.bytes : null;
  if (!bytes) return undefined;
  return {
    key, bytes,
    savedAt: typeof e.savedAt === 'number' ? e.savedAt : 0,
    name: typeof e.name === 'string' ? e.name : '',
    order: typeof e.order === 'number' ? e.order : 0,
  };
}

export const autosave = {
  async save(key: string, entry: AutosaveInput): Promise<void> { await tx('readwrite', s => s.put(entry, key)); },
  /** 残っている全部(タブの並び順。読めないものは飛ばす) */
  async loadAll(): Promise<AutosaveEntry[]> {
    let raw: [IDBValidKey, unknown][] = [];
    try {
      const db = await open();
      try {
        raw = await new Promise((resolve, reject) => {
          const t = db.transaction(STORE, 'readonly'), req = t.objectStore(STORE).openCursor(), acc: [IDBValidKey, unknown][] = [];
          req.onsuccess = () => { const c = req.result; if (c) { acc.push([c.key, c.value]); c.continue(); } };
          t.oncomplete = () => resolve(acc);
          t.onerror = () => reject(t.error);
          t.onabort = () => reject(t.error ?? new Error('読み込みが中断されました'));
        });
      } finally { db.close(); }
    } catch { return []; }
    const out: AutosaveEntry[] = [];
    for (const [k, v] of raw) { const e = await toEntry(k, v).catch(() => undefined); if (e) out.push(e); }
    return out.sort((a, b) => a.order - b.order || a.savedAt - b.savedAt);
  },
  async clear(key: string): Promise<void> { try { await tx('readwrite', s => s.delete(key)); } catch { /* 無視 */ } },
};
