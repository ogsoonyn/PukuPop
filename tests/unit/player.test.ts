import { describe, it, expect } from 'vitest';
import { createPlayer } from '../../src/player';
import { createDocument, createProject } from '../../src/model/project';
import { serializeProject } from '../../src/storage/popstage';
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

describe('Player の入口から辿れるコード', () => {
  it('編集アプリの部品・CSS・保存領域・window に触るモジュールを引き込まない', () => {
    const files = reachable('../../src/player/index.ts');
    expect(files).toContain('src/player/player.ts');
    expect(files).toContain('src/playback/frame.ts');
    const forbidden = files.filter(f =>
      f === 'src/app.ts' || f.startsWith('src/app/') || f.startsWith('src/commands/') || f.startsWith('src/export/')
      || f.startsWith('src/debug/') || f === 'src/main.ts' || f === 'src/errorNotice.ts'
      || /^src\/storage\/(prefs|autosave|recent|persist)\.ts$/.test(f)
      || (f.startsWith('src/ui/') && f !== 'src/ui/imageio.ts' && f !== 'src/ui/smoothZoom.ts')
      || f === 'src/player/demo.ts');
    expect(forbidden).toEqual([]);
    // 辿れるファイルは CSS を import せず、モジュールを読んだだけで window・document に受け口を付けない
    for (const f of files) {
      // コメントの中の言及は見ない
      const src = sources['../../' + f].replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/import\s+['"][^'"]+\.css['"]/);
      expect(src, f).not.toMatch(/^(?:window|document)\.addEventListener/m);
      expect(src, f).not.toMatch(/localStorage|sessionStorage|indexedDB|serviceWorker/);
    }
  });
});

describe('Player の読み込みの失敗(描画を作る前に、理由付きで失敗する)', () => {
  const canvas = {} as HTMLCanvasElement; // 読み込みで失敗するので、キャンバスには触らない
  const good = () => {
    const doc = createDocument({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', ext: 'png', width: 40, height: 30 }, 'a');
    return serializeProject(createProject(doc));
  };

  it('壊れたファイルは、読み込みのメッセージのまま失敗する', async () => {
    await expect(createPlayer(canvas, new Uint8Array([1, 2, 3]))).rejects.toThrow('プロジェクトファイルを展開できませんでした(壊れているか、形式が違います)');
  });

  it('新しい版のファイルは、版を添えて失敗する(ArrayBuffer も受ける)', async () => {
    const files = unzipSync(good()), json = JSON.parse(strFromU8(files['project.json']));
    json.formatVersion = 99;
    files['project.json'] = strToU8(JSON.stringify(json));
    const bytes = zipSync(files);
    await expect(createPlayer(canvas, bytes.buffer as ArrayBuffer)).rejects.toThrow('このファイルは新しい版(99)で保存されています。');
  });

  it('画像の入っていないファイルは失敗する', async () => {
    const files = unzipSync(good()), json = JSON.parse(strFromU8(files['project.json']));
    json.documents = [];
    files['project.json'] = strToU8(JSON.stringify(json));
    await expect(createPlayer(canvas, zipSync(files))).rejects.toThrow('プロジェクトに画像が入っていません');
  });
});
