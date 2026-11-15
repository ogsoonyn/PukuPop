import { describe, it, expect } from 'vitest';
import { createPlayer, PlayerError, type PlayerErrorCode } from '../../src/player';
import { loadErrorCode, loadError } from '../../src/player/errors';
import { createDocument, createProject } from '../../src/model/project';
import { serializeProject, migrate, NewerFormatError, FORMAT_VERSION } from '../../src/storage/popstage';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

/** src の全ファイルの中身(import を辿るため) */
const sources = import.meta.glob('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** 入口から辿れるファイル(相対パスの import と export ... from。型だけの import も含める) */
function reachable(entry: string): string[] {
  const seen = new Set<string>(), queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = sources[file];
    if (src === undefined) throw new Error(`見つからない: ${file}`);
    for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|^import\s+['"](\.[^'"]+)['"]/gm)) {
      const rel = m[1] ?? m[2] ?? m[3];
      const url = new URL(rel, 'file:///x/' + file.replace(/^(\.\.\/)+/, '')).pathname.slice(3);
      const path = '../../' + url.replace(/^\//, '');
      const cand = [path + '.ts', path + '/index.ts', path].find(p => p in sources);
      if (!cand) throw new Error(`辿れない: ${rel}(${file})`);
      queue.push(cand);
    }
  }
  return [...seen].map(f => f.replace('../../', '')).sort();
}

/** Player の約束(キャンバスの外に触らない)に反する書き方を探す。コメントの中は見ない */
function outsideTouches(code: string): string[] {
  const src = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const rules: [string, RegExp][] = [
    ['CSS の import', /import\s+['"][^'"]+\.css['"]/],
    ['window などへの受け口', /\b(?:window|document|globalThis|self|visualViewport)\s*\.\s*(?:addEventListener\b|on[a-z]+\s*=(?!=))/],
    ['matchMedia', /\bmatchMedia\s*\(/],
    ['head・body への追加', /\bdocument\s*\.\s*(?:head|body)\s*\.\s*(?:append|appendChild|prepend|insertBefore|insertAdjacentElement|insertAdjacentHTML)\b/],
    ['style・link の要素', /\bcreateElement\s*\(\s*['"](?:style|link)['"]/],
    ['保存領域', /localStorage|sessionStorage|indexedDB|serviceWorker/],
  ];
  return rules.filter(([, re]) => re.test(src)).map(([name]) => name);
}

describe('Player の入口から辿れるコード', () => {
  it('編集アプリの部品・CSS・保存領域・window に触るモジュールを引き込まない', () => {
    const files = reachable('../../src/player/index.ts');
    expect(files).toContain('src/player/player.ts');
    expect(files).toContain('src/playback/frame.ts');
    const forbidden = files.filter(f =>
      f === 'src/app.ts' || f.startsWith('src/app/') || f.startsWith('src/commands/') || f.startsWith('src/export/')
      || f.startsWith('src/debug/') || f === 'src/main.ts' || f === 'src/errorNotice.ts'
      || /^src\/storage\/(prefs|autosave|recent|persist)\.ts$/.test(f)
      || (f.startsWith('src/ui/') && f !== 'src/ui/imageio.ts')
      || f === 'src/player/demo.ts');
    expect(forbidden).toEqual([]);
    // 辿れるファイルは CSS を import・追加せず、window・document などに受け口を付けず、保存領域を使わない
    for (const f of files) expect(outsideTouches(sources['../../' + f]), f).toEqual([]);
  });

  it('外に触る書き方を見つけられる(確かめ方そのものの確かめ)', () => {
    for (const bad of [
      "  window.addEventListener('x', () => {})",
      'globalThis.addEventListener("x", f)',
      'self . addEventListener("x", f)',
      'visualViewport.addEventListener("resize", f)',
      'document.addEventListener("x", f)',
      'window.onresize = f',
      'document.onkeydown= f',
      "matchMedia('(prefers-color-scheme: dark)').addEventListener('change', f)",
      'document.head.append(style)',
      'document.body.appendChild(el)',
      'document.head.insertBefore(a, b)',
      "document.createElement('style')",
      'document.createElement("link")',
      "import './a.css'",
      'localStorage.getItem(k)',
    ]) expect(outsideTouches(bad), bad).not.toEqual([]);
    // キャンバスに付けるのはよい。コメントの中の言及は見ない
    expect(outsideTouches("canvas.addEventListener('wheel', f)\n// window.addEventListener('x', f)\n/* document.onclick = f */")).toEqual([]);
  });
});

describe('Player の読み込みの失敗(描画を作る前に、code 付きで失敗する)', () => {
  const canvas = () => ({}) as HTMLCanvasElement; // 読み込みで失敗するので、キャンバスには触らない
  const good = () => {
    const doc = createDocument({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', ext: 'png', width: 40, height: 30 }, 'a');
    return serializeProject(createProject(doc));
  };
  const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as PlayerError);

  it('壊れたファイルは invalid-file。メッセージは読み込みのまま', async () => {
    const e = await failure(createPlayer(canvas(), new Uint8Array([1, 2, 3])));
    expect(e).toBeInstanceOf(PlayerError);
    expect(e!.code).toBe('invalid-file');
    expect(e!.message).toBe('プロジェクトファイルを展開できませんでした(壊れているか、形式が違います)');
    expect(e!.cause).toBeInstanceOf(Error);
  });

  it('新しい版のファイルは unsupported-version。版を添える(ArrayBuffer も受ける)', async () => {
    const files = unzipSync(good()), json = JSON.parse(strFromU8(files['project.json']));
    json.formatVersion = 99;
    files['project.json'] = strToU8(JSON.stringify(json));
    const bytes = zipSync(files);
    const e = await failure(createPlayer(canvas(), bytes.buffer as ArrayBuffer));
    expect(e!.code).toBe('unsupported-version');
    expect(e!.message).toContain('このファイルは新しい版(99)で保存されています。');
    expect(e!.cause).toBeInstanceOf(NewerFormatError);
  });

  it('画像の入っていないファイルは invalid-file', async () => {
    const files = unzipSync(good()), json = JSON.parse(strFromU8(files['project.json']));
    json.documents = [];
    files['project.json'] = strToU8(JSON.stringify(json));
    const e = await failure(createPlayer(canvas(), zipSync(files)));
    expect([e!.code, e!.message]).toEqual(['invalid-file', 'プロジェクトに画像が入っていません']);
  });

  it('呼ぶ前から取り消してあれば、何もせずに aborted', async () => {
    const ac = new AbortController();
    ac.abort('reason');
    const e = await failure(createPlayer(canvas(), good(), { signal: ac.signal }));
    expect([e!.code, e!.cause]).toEqual(['aborted', 'reason']);
  });

  it('読み込み中に取り消すと aborted(読み込みが失敗しても、取り消しを優先する)', async () => {
    for (const bytes of [good(), new Uint8Array([1, 2, 3])]) {
      const ac = new AbortController(), p = failure(createPlayer(canvas(), bytes, { signal: ac.signal }));
      ac.abort();
      expect((await p)!.code).toBe('aborted');
    }
  });

  it('同じキャンバスで読み込み中に2つ目を呼ぶと canvas-unusable。1つ目を取り消せば、すぐ次を作り始められる', async () => {
    const c = canvas(), ac = new AbortController();
    const a = failure(createPlayer(c, new Uint8Array([1, 2, 3]), { signal: ac.signal }));
    // ここまで同期で呼ぶ(1つ目の読み込みはまだ終わっていない)
    const b = failure(createPlayer(c, new Uint8Array([1, 2, 3])));
    ac.abort(); // 取り消した時点で印が外れる(1つ目の失敗を待たない)
    const d = failure(createPlayer(c, new Uint8Array([1, 2, 3])));
    expect((await b)!.code).toBe('canvas-unusable');
    expect((await a)!.code).toBe('aborted');
    expect((await d)!.code).toBe('invalid-file');
    // 読み込みに失敗したあとも印は外れている
    expect((await failure(createPlayer(c, new Uint8Array([1, 2, 3]))))!.code).toBe('invalid-file');
  });
});

describe('読み込みの失敗の振り分け(DOM 無し)', () => {
  it('新しい版は読み込み側のクラスで見分け、ほかは invalid-file にする', () => {
    let newer: unknown;
    try { migrate({ formatVersion: FORMAT_VERSION + 1 }); } catch (e) { newer = e; }
    expect(newer).toBeInstanceOf(NewerFormatError);
    const cases: [unknown, PlayerErrorCode][] = [
      [newer, 'unsupported-version'],
      [new Error('このファイルは新しい版(9)で保存されています。'), 'invalid-file'], // 文言では見分けない
      [new Error('project.json が見つかりません'), 'invalid-file'],
      ['文字列', 'invalid-file'],
    ];
    for (const [e, code] of cases) expect(loadErrorCode(e)).toBe(code);
    const pe = loadError(newer);
    expect([pe.code, pe.message, pe.cause]).toEqual(['unsupported-version', (newer as Error).message, newer]);
    expect(loadError(pe)).toBe(pe);
  });
});
