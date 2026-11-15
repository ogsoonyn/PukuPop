import { describe, it, expect, vi, afterEach } from 'vitest';
import { shouldRequestPersist, isQuotaExceeded, autosaveFailureReason, PERSIST_RETRY_DAYS, QUOTA_MESSAGE } from '../../src/storage/persist';

const DAY = 24 * 60 * 60 * 1000;
const now = 1_800_000_000_000;
const base = { persisted: false, askedThisSession: false, now };

describe('永続化を頼むか', () => {
  it('まだ通っておらず、断られたことも無ければ頼む', () => {
    expect(shouldRequestPersist(base)).toBe(true);
  });
  it('すでに通っていれば頼まない', () => {
    expect(shouldRequestPersist({ ...base, persisted: true })).toBe(false);
  });
  it('このページを開いている間に頼んだら、もう頼まない', () => {
    expect(shouldRequestPersist({ ...base, askedThisSession: true })).toBe(false);
  });
  it('断られてから一定の日数は頼み直さず、過ぎたら頼む', () => {
    expect(shouldRequestPersist({ ...base, deniedAt: now - DAY })).toBe(false);
    expect(shouldRequestPersist({ ...base, deniedAt: now - (PERSIST_RETRY_DAYS * DAY - 1) })).toBe(false);
    expect(shouldRequestPersist({ ...base, deniedAt: now - PERSIST_RETRY_DAYS * DAY })).toBe(true);
  });
  it('断られた日時が未来(時計が戻った)や壊れた値なら、断られていないものとして頼む', () => {
    expect(shouldRequestPersist({ ...base, deniedAt: now + DAY })).toBe(true);
    expect(shouldRequestPersist({ ...base, deniedAt: NaN })).toBe(true);
  });
});

describe('容量不足の見分け', () => {
  it('error.name が QuotaExceededError のものだけ容量不足', () => {
    expect(isQuotaExceeded({ name: 'QuotaExceededError', message: 'x' })).toBe(true);
    expect(isQuotaExceeded(Object.assign(new Error('x'), { name: 'QuotaExceededError' }))).toBe(true);
    expect(isQuotaExceeded(new Error('QuotaExceededError'))).toBe(false);
    expect(isQuotaExceeded(null)).toBe(false);
    expect(isQuotaExceeded('QuotaExceededError')).toBe(false);
  });
  it('容量不足は分かる言葉に、ほかはブラウザの文言のまま出す', () => {
    expect(autosaveFailureReason({ name: 'QuotaExceededError', message: 'raw' })).toBe(QUOTA_MESSAGE);
    expect(autosaveFailureReason(new Error('壊れた'))).toBe('壊れた');
    expect(autosaveFailureReason('文字列')).toBe('文字列');
  });
});

describe('requestPersistOnce', () => {
  // asked がモジュールの変数なので、テストごとに読み込み直す。prefs は localStorage / window を使うので、必要な分だけ差し替える
  const load = async (storage: unknown) => {
    vi.resetModules();
    const ls = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => { ls.set(k, v); } });
    vi.stubGlobal('window', { addEventListener: () => {}, setTimeout: (f: () => void) => setTimeout(f, 0) });
    vi.stubGlobal('navigator', storage === undefined ? {} : { storage });
    return (await import('../../src/storage/persist')).requestPersistOnce;
  };
  afterEach(() => { vi.unstubAllGlobals(); });

  it('2回同時に呼んでも persist は1回だけ', async () => {
    const persist = vi.fn(async () => true);
    const once = await load({ persist, persisted: async () => false });
    await Promise.all([once(), once()]);
    await once();
    expect(persist).toHaveBeenCalledTimes(1);
  });
  it('persisted が reject しても、例外を投げずに終わる', async () => {
    const persist = vi.fn(async () => true);
    const once = await load({ persist, persisted: () => Promise.reject(new Error('x')) });
    await expect(once()).resolves.toBeUndefined();
  });
  it('persist が返らない間に呼んだ2回目は、待たずにすぐ返る', async () => {
    const persist = vi.fn(() => new Promise<boolean>(() => {}));
    const once = await load({ persist, persisted: async () => false });
    void once(); // 返らない
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await expect(once()).resolves.toBeUndefined();
    expect(persist).toHaveBeenCalledTimes(1);
  });
  it('navigator.storage が無ければ、何もせず返る', async () => {
    const once = await load(undefined);
    await expect(once()).resolves.toBeUndefined();
  });
});
