/**
 * npm pack した pukupop-editor-<版>.tgz と、pukupop-editor-<版>.zip を確かめる。`npm run check:editor-pack`
 * (CI とリリースのワークフローでも流す)。先に `npm run pack:editor` が要る。
 *
 * 1. OS の一時ディレクトリに最小の package.json を作り、.tgz を npm install する(--offline。依存が無いので取りに行くものは無い)。
 *    node_modules/pukupop-editor/app/index.html があり、入ったファイルが dist-editor/ と同じ中身であること
 * 2. .zip を展開すると、pukupop-editor-<版>/ の下に、.tgz と同じファイルが同じ中身で並ぶこと
 * 終わったら一時ディレクトリを消す。
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { unzipSync } from 'fflate';
import { root, run, fail } from './player-lib.mjs';
import { distDir, readEditorPackage, tgzName, zipName, zipRoot } from './editor-lib.mjs';

const pkg = readEditorPackage();
const tgz = join(root, tgzName(pkg.version)), zip = join(root, zipName(pkg.version));
for (const f of [tgz, zip]) if (!existsSync(f)) fail(`${f} がありません。先に npm run pack:editor を流してください`);

/** ディレクトリの中のファイル(/ 区切りの相対パス → 中身) */
function readTree(dir) {
  const out = new Map();
  const walk = d => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p); else out.set(relative(dir, p).replace(/\\/g, '/'), readFileSync(p));
    }
  };
  walk(dir);
  return out;
}
/** 2つの (パス → 中身) が同じか。違えば理由を返す */
function diff(a, b, what) {
  const ka = [...a.keys()].sort(), kb = [...b.keys()].sort();
  if (JSON.stringify(ka) !== JSON.stringify(kb)) return `${what}のファイルの一覧が違います:\n  ${ka.join(', ')}\n  ${kb.join(', ')}`;
  const changed = ka.filter(k => !Buffer.from(a.get(k)).equals(Buffer.from(b.get(k))));
  return changed.length ? `${what}の中身が違うファイルがあります: ${changed.join(', ')}` : null;
}

const dist = readTree(distDir);
const tmp = mkdtempSync(join(tmpdir(), 'pukupop-editor-'));
try {
  // 1. tgz を空のプロジェクトに入れる
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'check-pukupop-editor', private: true, version: '0.0.0' }));
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tgz], { cwd: tmp });
  const installed = join(tmp, 'node_modules', 'pukupop-editor');
  if (!existsSync(join(installed, 'app', 'index.html'))) fail('入れたパッケージに app/index.html がありません');
  const fromTgz = readTree(installed);
  // npm install は package.json に項目(_resolved など)を足すことがあるので、package.json は名前と版だけ比べる
  const got = JSON.parse(fromTgz.get('package.json').toString('utf8'));
  if (got.name !== pkg.name || got.version !== pkg.version) fail(`入れたパッケージの名前・版が違います: ${got.name} ${got.version}`);
  fromTgz.delete('package.json');
  const distNoPkg = new Map(dist); distNoPkg.delete('package.json');
  const d1 = diff(fromTgz, distNoPkg, '.tgz から入れたものと dist-editor/ で、');
  if (d1) fail(d1);

  // 2. zip を展開して比べる
  const prefix = `${zipRoot(pkg.version)}/`;
  const entries = unzipSync(new Uint8Array(readFileSync(zip)));
  const outside = Object.keys(entries).filter(k => !k.startsWith(prefix));
  if (outside.length) fail(`.zip に ${prefix} の外のファイルがあります: ${outside.join(', ')}`);
  const fromZip = new Map(Object.entries(entries).filter(([k]) => !k.endsWith('/')).map(([k, v]) => [k.slice(prefix.length), v]));
  const d2 = diff(fromZip, dist, '.zip と dist-editor/ で、');
  if (d2) fail(d2);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`配布物の確かめ: 問題なし(${tgzName(pkg.version)} を空のプロジェクトに入れられ、${zipName(pkg.version)} と中身が同じ。${dist.size} ファイル)`);
