/**
 * 埋め込みモード(Issue #146、src/app/embed.ts)の、クエリの読み取りとサーバーとのやりとり。
 * fetch は作り物に差し替え、送ったリクエストを控えて確かめる
 */
import { describe, it, expect } from 'vitest';
import { parseEmbedParams, backUrl, reopenUrl, createdName, EMBED_NAME_MAX, sameOriginUrl, fetchForOpen, ServerTarget, EmbedError } from '../../src/app/embed';
import { SaveConflictError } from '../../src/app/saveTarget';

const PAGE = 'https://archive.example/pukupop/?x';
const q = (o: Record<string, string>) => `?${new URLSearchParams(o)}`;

describe('埋め込みのクエリ', () => {
  it('既存の .pukupop を開く(save を省くと src に上書きする)', () => {
    expect(parseEmbedParams(q({ src: '/files/cat.pukupop', back: '/files/' }), PAGE)).toEqual({
      kind: 'project', src: 'https://archive.example/files/cat.pukupop', save: 'https://archive.example/files/cat.pukupop',
      name: 'cat.pukupop', back: 'https://archive.example/files/',
    });
    const o = parseEmbedParams(q({ src: 'files/a.pukupop', save: '/api/save?id=3', name: '猫' }), PAGE);
    // 相対 URL はページの URL から解決する
    expect(o).toMatchObject({ kind: 'project', src: 'https://archive.example/pukupop/files/a.pukupop', save: 'https://archive.example/api/save?id=3', name: '猫', back: null });
  });

  it('画像から新しく作る(create が要る)', () => {
    expect(parseEmbedParams(q({ image: '/files/%E7%8C%AB.png', create: '/files/' }), PAGE)).toEqual({
      kind: 'image', image: 'https://archive.example/files/%E7%8C%AB.png', create: 'https://archive.example/files/', name: '猫.png', back: null,
    });
    expect(() => parseEmbedParams(q({ image: '/a.png' }), PAGE)).toThrow(EmbedError);
  });

  it('組み合わせが合わなければ開かない', () => {
    expect(() => parseEmbedParams('', PAGE)).toThrow('開くファイルが指定されていません');
    expect(() => parseEmbedParams('?e2e&embed', PAGE)).toThrow(EmbedError);
    expect(() => parseEmbedParams(q({ src: '/a.pukupop', image: '/a.png', create: '/' }), PAGE)).toThrow(EmbedError);
    expect(() => parseEmbedParams(q({ src: '/a.pukupop', create: '/' }), PAGE)).toThrow(EmbedError);
    expect(() => parseEmbedParams(q({ image: '/a.png', create: '/', save: '/b' }), PAGE)).toThrow(EmbedError);
  });

  it.each([
    ['別のオリジン', 'https://evil.example/upload'],
    ['スキームを省いた別のオリジン', '//evil.example/upload'],
    ['http と https の違い', 'http://archive.example/files/a'],
    ['別のポート', 'https://archive.example:8443/files/a'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,x'],
    ['blob:', 'blob:https://archive.example/0000'],
  ])('同じオリジンでない URL は、どのクエリでも断る: %s', (_, bad) => {
    for (const o of <Record<string, string>[]>[
      { src: bad }, { src: '/a.pukupop', save: bad }, { image: bad, create: '/' }, { image: '/a.png', create: bad }, { src: '/a.pukupop', back: bad },
    ]) expect(() => parseEmbedParams(q(o), PAGE), JSON.stringify(o)).toThrow(/同じオリジン/);
  });

  it('名前は URL の最後の部分か name(制御文字を除き、長さを抑える)', () => {
    expect(parseEmbedParams(q({ src: '/files/' }), PAGE)).toMatchObject({ name: 'untitled.pukupop' });
    expect(parseEmbedParams(q({ src: '/files/a%ZZ.pukupop' }), PAGE)).toMatchObject({ name: 'a%ZZ.pukupop' });
    expect(parseEmbedParams(q({ src: '/a', name: 'x\u0000y\n' }), PAGE)).toMatchObject({ name: 'xy' });
    expect((parseEmbedParams(q({ src: '/a', name: 'あ'.repeat(500) }), PAGE) as { name: string }).name).toHaveLength(200);
  });

  it('戻り先だけを読む(使えなければ null)', () => {
    expect(backUrl(q({ back: '/files/' }), PAGE)).toBe('https://archive.example/files/');
    expect(backUrl(q({ back: 'https://evil.example/' }), PAGE)).toBeNull();
    expect(backUrl(q({ back: 'javascript:alert(1)' }), PAGE)).toBeNull();
    expect(backUrl('', PAGE)).toBeNull();
  });

  it('sameOriginUrl は解決の元とオリジンの比べ先を分けられる(POST の Location)', () => {
    expect(sameOriginUrl('cat.pukupop', 'https://archive.example/files/', PAGE, 'x')).toBe('https://archive.example/files/cat.pukupop');
    expect(() => sameOriginUrl('https://evil.example/a', 'https://archive.example/files/', PAGE, 'x')).toThrow(EmbedError);
  });
});

/** 送ったリクエストを控え、決めた応答を順に返す fetch */
function fakeFetch(...responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error('応答がもうありません');
    if (r instanceof Error) throw r;
    return r;
  };
  return { fn, calls };
}
const header = (init: RequestInit | undefined, name: string) => (init?.headers as Record<string, string> | undefined)?.[name];
const blob = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' });

describe('開くファイルを取る(GET)', () => {
  it('中身・種類・強い ETag を返す', async () => {
    const f = fakeFetch(new Response(new Uint8Array([9, 8]), { headers: { 'Content-Type': 'image/png; charset=x', ETag: '"v1"' } }));
    expect(await fetchForOpen('https://archive.example/a.png', PAGE, f.fn)).toEqual({ bytes: new Uint8Array([9, 8]), type: 'image/png', etag: '"v1"' });
    expect(f.calls[0].init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
  });
  it('弱い ETag は覚えない', async () => {
    const f = fakeFetch(new Response('x', { headers: { ETag: 'W/"v1"' } }));
    expect((await fetchForOpen('https://archive.example/a', PAGE, f.fn)).etag).toBeNull();
  });
  it('リダイレクトの行き着いた先が同じオリジンでなければ開かない', async () => {
    const moved = (to: string) => {
      const r = new Response('x');
      Object.defineProperties(r, { redirected: { value: true }, url: { value: to } });
      return r;
    };
    await expect(fetchForOpen('https://archive.example/go', PAGE, fakeFetch(moved('https://evil.example/x.pukupop')).fn)).rejects.toThrow(EmbedError);
    expect((await fetchForOpen('https://archive.example/go', PAGE, fakeFetch(moved('https://archive.example/store/x')).fn)).bytes).toHaveLength(1);
  });
  it('失敗は状態のコード付きで投げる', async () => {
    await expect(fetchForOpen('https://archive.example/a', PAGE, fakeFetch(new Response('', { status: 404, statusText: 'Not Found' })).fn)).rejects.toThrow('HTTP 404 Not Found');
    await expect(fetchForOpen('https://archive.example/a', PAGE, fakeFetch(new TypeError('Failed to fetch')).fn)).rejects.toThrow('Failed to fetch');
  });
});

describe('サーバーの保存先', () => {
  const url = 'https://archive.example/files/cat.pukupop';

  it('PUT に覚えた ETag を If-Match で付け、応答の ETag を次に使う', async () => {
    const f = fakeFetch(new Response(null, { status: 204, headers: { ETag: '"v2"' } }), new Response(null, { status: 200 }), new Response(null, { status: 200 }));
    const t = new ServerTarget('cat.pukupop', { url, etag: '"v1"' }, PAGE, f.fn);
    await t.write(blob());
    await t.write(blob());
    await t.write(blob()); // 前の応答に ETag が無かったので、確かめずに上書きする
    expect(f.calls.map(c => [c.url, c.init?.method, header(c.init, 'If-Match')])).toEqual([[url, 'PUT', '"v1"'], [url, 'PUT', '"v2"'], [url, 'PUT', undefined]]);
    const init = f.calls[0].init!;
    expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    expect(header(init, 'Content-Type')).toBe('application/zip');
    expect(init.body).toBeInstanceOf(Blob);
  });

  it('412 なら SaveConflictError を投げ、force なら If-Match を付けずに上書きする', async () => {
    const f = fakeFetch(new Response(null, { status: 412 }), new Response(null, { status: 200, headers: { ETag: '"v3"' } }), new Response(null, { status: 200 }));
    const t = new ServerTarget('cat.pukupop', { url, etag: '"v1"' }, PAGE, f.fn);
    await expect(t.write(blob())).rejects.toBeInstanceOf(SaveConflictError);
    await t.write(blob(), { force: true });
    await t.write(blob());
    expect(f.calls.map(c => header(c.init, 'If-Match'))).toEqual(['"v1"', undefined, '"v3"']);
  });

  it('ETag が無いか弱いときは確かめない', async () => {
    const f = fakeFetch(new Response(null, { status: 200, headers: { ETag: 'W/"w"' } }), new Response(null, { status: 200 }));
    const t = new ServerTarget('a', { url }, PAGE, f.fn);
    await t.write(blob());
    await t.write(blob());
    expect(f.calls.map(c => header(c.init, 'If-Match'))).toEqual([undefined, undefined]);
  });

  it('PUT の失敗は状態のコード付きで投げ、ETag は変えない', async () => {
    const f = fakeFetch(new Response(null, { status: 403, statusText: 'Forbidden' }), new TypeError('net'), new Response(null, { status: 200 }));
    const t = new ServerTarget('a', { url, etag: '"v1"' }, PAGE, f.fn);
    await expect(t.write(blob())).rejects.toThrow('HTTP 403 Forbidden');
    await expect(t.write(blob())).rejects.toThrow('net');
    await t.write(blob());
    expect(f.calls.map(c => header(c.init, 'If-Match'))).toEqual(['"v1"', '"v1"', '"v1"']);
  });

  it('新規は最初だけ POST し、応答の Location(POST した URL から解決)へ以後 PUT する', async () => {
    const f = fakeFetch(
      new Response(null, { status: 201, headers: { Location: 'cat.pukupop', ETag: '"n1"' } }),
      new Response(null, { status: 200, headers: { ETag: '"n2"' } }),
    );
    const t = new ServerTarget('cat.pukupop', { create: 'https://archive.example/files/' }, PAGE, f.fn);
    expect(t.location).toBeNull();
    expect(await t.isSame(new ServerTarget('x', { create: 'https://archive.example/files/' }, PAGE, f.fn))).toBe(false);
    await t.write(blob());
    expect(t.location).toBe(url);
    await t.write(blob());
    expect(f.calls.map(c => [c.url, c.init?.method, header(c.init, 'If-Match')])).toEqual([
      ['https://archive.example/files/', 'POST', undefined], [url, 'PUT', '"n1"'],
    ]);
    expect(f.calls[0].init).toMatchObject({ redirect: 'error' });
    expect(await t.isSame(new ServerTarget('y', { url }, PAGE))).toBe(true);
  });

  it('POST が通ったら、保存先(Location)を一度だけ知らせる。知らせる側が失敗しても保存は通す', async () => {
    const f = fakeFetch(
      new Response(null, { status: 500 }),
      new Response(null, { status: 201, headers: { Location: 'cat.pukupop' } }),
      new Response(null, { status: 200 }),
    );
    const seen: string[] = [];
    const t = new ServerTarget('cat.pukupop', { create: 'https://archive.example/files/', onCreated: l => { seen.push(l); throw new Error('x'); } }, PAGE, f.fn);
    const err = console.error; console.error = () => {};
    try {
      await expect(t.write(blob())).rejects.toThrow('HTTP 500');
      expect(seen).toEqual([]);
      await t.write(blob());
      await t.write(blob());
    } finally { console.error = err; }
    expect(seen).toEqual([url]);
    expect(t.location).toBe(url);
  });

  it('POST の応答に Location が無い・別のオリジンなら失敗にし、次もまた POST する', async () => {
    const f = fakeFetch(
      new Response(null, { status: 201 }),
      new Response(null, { status: 201, headers: { Location: 'https://evil.example/x' } }),
      new Response(null, { status: 500 }),
      new Response(null, { status: 201, headers: { Location: '/files/ok.pukupop' } }),
    );
    const t = new ServerTarget('a', { create: 'https://archive.example/files/' }, PAGE, f.fn);
    await expect(t.write(blob())).rejects.toThrow('Location');
    await expect(t.write(blob())).rejects.toThrow(/同じオリジン/);
    await expect(t.write(blob())).rejects.toThrow('HTTP 500');
    await t.write(blob());
    expect(f.calls.map(c => c.init?.method)).toEqual(['POST', 'POST', 'POST', 'POST']);
    expect(t.location).toBe('https://archive.example/files/ok.pukupop');
  });
});

describe('初めて保存したあとのページの URL(Issue #150)', () => {
  const page = 'https://archive.example/pukupop/?image=%2Ffiles%2Fcat.png&create=%2Ffiles%2F&back=%2Fa%2Fb%3Fx%3D1&name=Cat&embed#h';
  it('image・create を外して src を保存先(パスだけ)にし、back などほかのクエリとハッシュを引き継ぐ', () => {
    const u = new URL(reopenUrl(page, 'https://archive.example/files/cat.pukupop?v=2', 'Cat.pukupop'));
    expect(u.pathname).toBe('/pukupop/');
    expect(u.hash).toBe('#h');
    expect([...u.searchParams]).toEqual([['src', '/files/cat.pukupop?v=2'], ['back', '/a/b?x=1'], ['embed', ''], ['name', 'Cat.pukupop']]);
  });
  it('読み直すと、保存したファイルを開き、上書き先も同じ(次の保存は PUT)', () => {
    const next = reopenUrl(page, 'https://archive.example/files/123', 'cat.pukupop');
    expect(parseEmbedParams(new URL(next).search, next)).toEqual({
      kind: 'project', src: 'https://archive.example/files/123', save: 'https://archive.example/files/123', name: 'cat.pukupop', back: 'https://archive.example/a/b?x=1',
    });
  });
  it('保存先のパスが // で始まるときは、絶対 URL のままにする(パスだけだと別のホストとして解決される)', () => {
    const next = reopenUrl(page, 'https://archive.example//evil.example/x.pukupop', 'x.pukupop');
    expect(new URL(next).searchParams.get('src')).toBe('https://archive.example//evil.example/x.pukupop');
    expect(parseEmbedParams(new URL(next).search, next)).toMatchObject({ kind: 'project', src: 'https://archive.example//evil.example/x.pukupop' });
  });
  it('作った作業の名前は拡張子を .pukupop にし、長くても name で渡して切られない', () => {
    expect(createdName('cat.png')).toBe('cat.pukupop');
    expect(createdName('Cat')).toBe('Cat.pukupop');
    expect(createdName('.png')).toBe('untitled.pukupop');
    const long = createdName(`${'あ'.repeat(EMBED_NAME_MAX)}.png`);
    expect(long.length).toBe(EMBED_NAME_MAX);
    expect(long.endsWith('.pukupop')).toBe(true);
    const next = reopenUrl(page, 'https://archive.example/files/1', long);
    expect(parseEmbedParams(new URL(next).search, next).name).toBe(long);
  });
});
