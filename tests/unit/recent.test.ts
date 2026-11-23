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
  const handle = (opts: { perm?: PermissionState; ask?: PermissionState; getFile?: () => Promise<File> }) => ({
    queryPermission: async () => opts.perm ?? 'granted',
    requestPermission: async () => opts.ask ?? 'granted',
    getFile: opts.getFile ?? (async () => file),
  }) as unknown as FileSystemFileHandle;
  const item = (h?: FileSystemFileHandle, copy?: string): RecentEntry =>
    ({ id: 'x', name: 'a.png', kind: 'image', openedAt: 0, size: 4, handle: h, bytes: copy ? new Blob([copy]) : undefined });
  const text = async (r: Awaited<ReturnType<typeof readRecent>>) => (r === 'denied' ? r : { body: await r.file.text(), handle: !!r.handle, fromCopy: r.fromCopy, type: r.file.type });

  it('場所から読めれば、場所ごと返す(コピーがあっても使わない)', async () => {
    expect(await text(await readRecent(item(handle({}), 'copy')))).toEqual({ body: 'orig', handle: true, fromCopy: false, type: 'image/png' });
  });

  it('許可が得られなければ、控えのコピーから開く(Android の Chrome)。コピーが無ければ denied', async () => {
    const h = handle({ perm: 'prompt', ask: 'denied' });
    expect(await text(await readRecent(item(h, 'copy')))).toEqual({ body: 'copy', handle: false, fromCopy: true, type: 'image/png' });
    expect(await readRecent(item(h))).toBe('denied');
  });

  it('場所から読めなければ(許可を聞けない・読めない)、控えのコピーから開く。コピーが無ければ例外のまま', async () => {
    const broken = handle({ perm: 'prompt', getFile: async () => { throw new DOMException('x', 'NotFoundError'); } });
    (broken as any).requestPermission = async () => { throw new DOMException('ユーザーの操作が要ります', 'SecurityError'); };
    expect(await text(await readRecent(item(broken, 'copy')))).toEqual({ body: 'copy', handle: false, fromCopy: true, type: 'image/png' });
    const gone = handle({ getFile: async () => { throw new DOMException('x', 'NotFoundError'); } });
    await expect(readRecent(item(gone))).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(await text(await readRecent(item(gone, 'copy')))).toMatchObject({ body: 'copy', fromCopy: true });
  });

  it('場所の無いコピーだけの項目はそのまま開く。どちらも無ければ NotFoundError', async () => {
    expect(await text(await readRecent(item(undefined, 'copy')))).toEqual({ body: 'copy', handle: false, fromCopy: false, type: 'image/png' });
    await expect(readRecent(item())).rejects.toMatchObject({ name: 'NotFoundError' });
  });
});
