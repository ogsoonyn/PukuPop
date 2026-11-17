/**
 * dist-editor/ から、リポジトリの直下に配布物を2つ作る。`npm run pack:editor`(CI とリリースのワークフローでも流す)。
 * 先に `npm run build:editor` と `npm run check:editor` が要る。
 *
 * - pukupop-editor-<版>.tgz: npm pack したもの。Node で組んだアプリが package.json の依存に URL を書き、integrity で固定する
 * - pukupop-editor-<版>.zip: 同じ中身を pukupop-editor-<版>/ の下に固めたもの。Node を使わない(静的ファイルを置くだけの)サーバー向け
 *
 * zip は同じ入力から同じバイト列になるようにする(ファイルの並び・日時・圧縮の度合いを決めておく)。
 * リリースのワークフローは、確かめのジョブと同じ sha256 になったことを確かめてから添付する。
 * 名前・大きさ・sha256(と tgz の integrity)を出す。--notes <ファイル> を付けると、リリースの本文をそのファイルに書く。
 * GitHub Actions の上では、tgz・zip・version・sha256・zip_sha256・integrity を GITHUB_OUTPUT にも書く。
 */
import { readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';
import { root, run, fail, setOutput } from './player-lib.mjs';
import { distDir, readEditorPackage, tgzName, zipName, zipRoot } from './editor-lib.mjs';

const notesAt = process.argv.indexOf('--notes');
const notesFile = notesAt >= 0 ? process.argv[notesAt + 1] : null;
if (notesAt >= 0 && !notesFile) fail('--notes のあとにファイルの場所を書いてください');

const pkg = readEditorPackage();
if (!existsSync(join(distDir, 'package.json'))) fail('dist-editor/ がありません。先に npm run build:editor を流してください');

/** dist-editor/ の中のファイル(/ 区切りの相対パス。並べ替え済み) */
function listFiles(dir) {
  const out = [];
  const walk = d => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p); else out.push(relative(distDir, p).replace(/\\/g, '/'));
    }
  };
  walk(dir);
  return out.sort();
}
const files = listFiles(distDir);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const kb = n => `${(n / 1000).toFixed(1)} KB`;

// 1. tgz(npm pack)
const tgz = tgzName(pkg.version), tgzPath = join(root, tgz);
rmSync(tgzPath, { force: true });
const { stdout } = run('npm', ['pack', distDir, '--json', '--ignore-scripts', '--pack-destination', root], { capture: true });
const [info] = JSON.parse(stdout);
if (info.filename !== tgz) fail(`npm pack の名前が想定と違います: ${info.filename}(想定: ${tgz})`);
const packed = info.files.map(f => f.path).sort();
if (JSON.stringify(packed) !== JSON.stringify(files)) fail(`.tgz の中身が dist-editor/ と違います:\n  tgz: ${packed.join(', ')}\n  dist-editor: ${files.join(', ')}`);
const tgzBytes = readFileSync(tgzPath), tgzSha = sha256(tgzBytes);

// 2. zip(同じ中身。日時は決めた値にする。DOS の日時はその地の時刻で書かれるので、正午にして日付がずれないようにする)
const zip = zipName(pkg.version), zipPath = join(root, zip);
const mtime = new Date(2000, 0, 1, 12, 0, 0);
const entries = Object.fromEntries(files.map(f => [`${zipRoot(pkg.version)}/${f}`, [new Uint8Array(readFileSync(join(distDir, f))), { level: 9, mtime }]]));
const zipBytes = zipSync(entries, { level: 9, mtime });
writeFileSync(zipPath, zipBytes);
const zipSha = sha256(zipBytes);

console.log(`\n${tgz}: ${kb(tgzBytes.length)}(展開すると ${kb(info.unpackedSize)}、${files.length} ファイル)`);
console.log(`  sha256:    ${tgzSha}`);
console.log(`  integrity: ${info.integrity}`);
console.log(`${zip}: ${kb(zipBytes.length)}`);
console.log(`  sha256:    ${zipSha}`);

if (notesFile) {
  const tag = `editor-v${pkg.version}`;
  const base = `https://github.com/ogsoonyn/PukuPop/releases/download/${tag}`;
  writeFileSync(notesFile, [
    `pukupop-editor ${pkg.version}(ほかの Web アプリに埋め込む編集画面)`,
    '',
    '埋め込む側と同じオリジンの下(例: `/pukupop/`)から、`app/` の中身を静的ファイルとして配信して使います。',
    '',
    '## 入れ方',
    '',
    '- Node で組んだアプリ: `package.json` の依存に `.tgz` の URL を書きます(npm には公開していません)。`node_modules/pukupop-editor/app/` を配信します。',
    '',
    '  ```json',
    `  "pukupop-editor": "${base}/${tgz}"`,
    '  ```',
    '',
    `- 静的ファイルを置くだけのサーバー: \`.zip\` を展開し、\`${zipRoot(pkg.version)}/app/\` の中身を置きます。`,
    '',
    'この版の `.tgz`・`.zip` は差し替えません。直したものは新しい版として出します。',
    '',
    '## 添付したファイル',
    '',
    `- \`${tgz}\`(${kb(tgzBytes.length)})`,
    `  - sha256: \`${tgzSha}\``,
    `  - integrity(\`package-lock.json\` に記録される値): \`${info.integrity}\``,
    `- \`${zip}\`(${kb(zipBytes.length)})`,
    `  - sha256: \`${zipSha}\``,
    '',
    '使い方と、サーバー側で用意する保存の口は、配布物に入っている README.md(リポジトリの `packages/editor/README.md`)と、リポジトリの `docs/embed.md` を見てください。',
    '',
  ].join('\n'));
  console.log(`リリースの本文を書きました: ${notesFile}`);
}

await setOutput({ tgz, zip, version: pkg.version, sha256: tgzSha, zip_sha256: zipSha, integrity: info.integrity });
