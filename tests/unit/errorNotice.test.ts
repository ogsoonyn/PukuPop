import { describe, it, expect } from 'vitest';
import { NoticeThrottle, isAbort, benignKind } from '../../src/errorNotice';

describe('NoticeThrottle', () => {
  it('最初は知らせ、間隔の内は知らせない', () => {
    const t = new NoticeThrottle(1000);
    expect(t.take(0)).toBe(true);
    expect(t.take(1)).toBe(false);
    expect(t.take(999)).toBe(false);
  });
  it('間隔が過ぎたらまた知らせる(知らせなかった分は時刻を進めない)', () => {
    const t = new NoticeThrottle(1000);
    expect(t.take(500)).toBe(true);
    expect(t.take(1400)).toBe(false);
    expect(t.take(1500)).toBe(true);
    expect(t.take(2000)).toBe(false);
  });
  it('毎フレーム出る例外でも、10秒の間に知らせるのは1回だけ', () => {
    const t = new NoticeThrottle(10_000);
    let n = 0;
    for (let i = 0; i < 600; i++) if (t.take(i * 16)) n++;
    expect(n).toBe(1);
  });
});

describe('isAbort', () => {
  it('AbortError だけを取り消しとみなす', () => {
    expect(isAbort(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isAbort(new Error('x'))).toBe(false);
    expect(isAbort(null)).toBe(false);
    expect(isAbort('AbortError')).toBe(false);
  });
});

describe('NoticeThrottle の間引いた回数', () => {
  it('知らせた回に、その前に間引いた回数を残す', () => {
    const t = new NoticeThrottle(1000);
    expect(t.take(0)).toBe(true);
    expect(t.skippedBefore).toBe(0);
    for (let i = 1; i <= 5; i++) expect(t.take(i)).toBe(false);
    expect(t.take(1000)).toBe(true);
    expect(t.skippedBefore).toBe(5);
    expect(t.take(2000)).toBe(true);
    expect(t.skippedBefore).toBe(0);
  });
});

describe('benignKind', () => {
  it('error が無い ResizeObserver loop は何もしない', () => {
    expect(benignKind(null, 'ResizeObserver loop completed with undelivered notifications.')).toBe('ignore');
    expect(benignKind(undefined, 'ResizeObserver loop limit exceeded')).toBe('ignore');
  });
  it('error が無いそのほかは console に残すだけ', () => {
    expect(benignKind(null, 'Script error.')).toBe('log');
    expect(benignKind(null, '')).toBe('log');
  });
  it('error があれば知らせる対象(message が ResizeObserver loop でも)', () => {
    expect(benignKind(new Error('x'), 'Uncaught Error: x')).toBeNull();
    expect(benignKind(new Error('x'), 'ResizeObserver loop limit exceeded')).toBeNull();
  });
});
