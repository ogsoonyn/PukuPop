import { describe, it, expect } from 'vitest';
import { NoticeThrottle, isAbort } from '../../src/errorNotice';

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
