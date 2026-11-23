import { describe, it, expect } from 'vitest';
import { trimRecent, readRecent, RECENT_MAX, COPY_TOTAL, type RecentEntry } from '../../src/storage/recent';

const entry = (id: string, openedAt: number, copy = 0): RecentEntry =>
  ({ id, name: `${id}.png`, kind: 'image', openedAt, size: copy, bytes: copy ? new Blob([new Uint8Array(copy)]) : undefined });

describe('最近開いたファイルの上限', () => {
  it('新しい順に並べ、件数の上限を超えた古いものから外す', () => {
    const list = Array.from({ length: RECENT_MAX + 3 }, (_, i) => entry(`e${i}`, i));
    const { keep, drop } = trimRecent(list);
    expect(keep.map(e => e.id)).toEqual(Array.from({ length: RECENT_MAX }, (_, i) => `e${RECENT_MAX + 2 - i}`));
    expect(drop.sort()).toEqual(['e0', 'e1', 'e2']);
  });

  it('コピーの合計が上限を超えたら、古いコピーから外す(場所だけの項目は残す)', () => {
    const big = Math.floor(COPY_TOTAL / 3) + 1;
    const { keep, drop } = trimRecent([entry('new', 5, big), entry('handleOnly', 4), entry('b', 3, big), entry('c', 2, big), entry('d', 1, 10)]);
    expect(keep.map(e => e.id)).toEqual(['new', 'handleOnly', 'b', 'd']);
    expect(drop).toEqual(['c']);
  });
});

describe('最近開いたファイルを読む(readRecent)', () => {
  const file = new File(['orig'], 'a.png', { type: 'image/png' });
  const handle = (opts: { perm?: PermissionState; ask?: () => Promise<PermissionState>; getFile?: () => Promise<File> }) => ({
    queryPermission: async () => opts.perm ?? 'granted',
    requestPermission: opts.ask ?? (async () => 'granted'),
    getFile: opts.getFile ?? (async () => file),
  }) as unknown as FileSystemFileHandle;
  const item = (h?: FileSystemFileHandle, copy?: string): RecentEntry =>
    ({ id: 'x', name: 'a.png', kind: 'image', openedAt: 0, size: 4, handle: h, bytes: copy ? new Blob([copy]) : undefined });
  const wait = { check: 20, ask: 20 };

  it('場所から読めれば、そのファイルを返す', async () => {
    expect(await readRecent(item(handle({})), wait)).toBe(file);
  });

  it('許可が得られなければ denied', async () => {
    expect(await readRecent(item(handle({ perm: 'prompt', ask: async () => 'denied' })), wait)).toBe('denied');
  });

  it('許可の返事・読み込みが止まったままなら、決めた時間で TimeoutError にする(押しても何も起きないままにしない)', async () => {
    await expect(readRecent(item(handle({ perm: 'prompt', ask: () => new Promise(() => {}) })), wait)).rejects.toMatchObject({ name: 'TimeoutError' });
    await expect(readRecent(item(handle({ getFile: () => new Promise(() => {}) })), wait)).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('場所の無いコピーの項目はコピーから開く。どちらも無ければ NotFoundError', async () => {
    const r = await readRecent(item(undefined, 'copy'), wait);
    expect(r !== 'denied' && [await r.text(), r.type]).toEqual(['copy', 'image/png']);
    await expect(readRecent(item(), wait)).rejects.toMatchObject({ name: 'NotFoundError' });
  });
});
