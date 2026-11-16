/**
 * dist-player/ を npm pack して、リポジトリの直下に pukupop-player-<版>.tgz を作る。
 * `npm run pack:player` で流す(CI とリリースのワークフローでも流す)。先に `npm run build:player` と `npm run check:player` が要る。
 *
 * .tgz の中身が想定どおり(ビルドした1本・型定義・package.json・README・LICENSE・同梱したもののライセンス)かを確かめ、
 * 名前・大きさ・sha256・integrity を出す。
 * --notes <ファイル> を付けると、リリースの本文(入れ方・sha256・integrity)をそのファイルに書く(リリースのワークフローが使う)。
 * GitHub Actions の上では、tgz・version・sha256・integrity を GITHUB_OUTPUT にも書く。
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { root, distDir, readPlayerPackage, tgzName, run, fail, setOutput } from './player-lib.mjs';

const EXPECTED = ['LICENSE', 'README.md', 'THIRD-PARTY-LICENSES.txt', 'index.d.ts', 'package.json', 'pukupop-player.js'];

const notesAt = process.argv.indexOf('--notes');
const notesFile = notesAt >= 0 ? process.argv[notesAt + 1] : null;
if (notesAt >= 0 && !notesFile) fail('--notes のあとにファイルの場所を書いてください');

const pkg = readPlayerPackage();
const name = tgzName(pkg.version), tgz = join(root, name);
if (!existsSync(join(distDir, 'package.json'))) fail('dist-player/ がありません。先に npm run build:player を流してください');
rmSync(tgz, { force: true });

const { stdout } = run('npm', ['pack', distDir, '--json', '--ignore-scripts', '--pack-destination', root], { capture: true });
const [info] = JSON.parse(stdout);
if (info.filename !== name) fail(`npm pack の名前が想定と違います: ${info.filename}(想定: ${name})`);
const paths = info.files.map(f => f.path).sort();
if (JSON.stringify(paths) !== JSON.stringify(EXPECTED)) fail(`.tgz の中身が想定と違います: ${paths.join(', ')}(想定: ${EXPECTED.join(', ')})`);
const empty = info.files.filter(f => f.size === 0).map(f => f.path);
if (empty.length) fail(`.tgz に空のファイルがあります: ${empty.join(', ')}`);

const bytes = readFileSync(tgz);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const kb = n => `${(n / 1000).toFixed(1)} KB`;
console.log(`\n${name}: ${kb(bytes.length)}(展開すると ${kb(info.unpackedSize)})`);
for (const f of info.files) console.log(`  ${f.path.padEnd(26)} ${kb(f.size).padStart(10)}  gzip ${kb(gzipSync(readFileSync(join(distDir, f.path))).length).padStart(9)}`);
console.log(`sha256:    ${sha256}`);
console.log(`integrity: ${info.integrity}`);

if (notesFile) {
  const tag = `player-v${pkg.version}`;
  const url = `https://github.com/ogsoonyn/PukuPop/releases/download/${tag}/${name}`;
  writeFileSync(notesFile, [
    `pukupop-player ${pkg.version}(埋め込み用の再生専用の部品)`,
    '',
    '## 入れ方',
    '',
    '`package.json` の依存に、添付した `.tgz` の URL を書きます(npm には公開していません)。',
    '',
    '```json',
    `"pukupop-player": "${url}"`,
    '```',
    '',
    'この版の `.tgz` は差し替えません。直したものは新しい版として出します。',
    '',
    '## 添付したファイル',
    '',
    `- \`${name}\`(${kb(bytes.length)})`,
    `- sha256: \`${sha256}\``,
    `- integrity(\`package-lock.json\` に記録される値): \`${info.integrity}\``,
    '',
    '使い方は `.tgz` に入っている README.md(リポジトリの `packages/player/README.md`)を見てください。',
    '',
  ].join('\n'));
  console.log(`リリースの本文を書きました: ${notesFile}`);
}

await setOutput({ tgz: name, version: pkg.version, sha256, integrity: info.integrity });
