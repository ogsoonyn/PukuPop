import { describe, it, expect } from 'vitest';
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
