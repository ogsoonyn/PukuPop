/**
 * Player のライブラリのビルド結果(dist-player/)に、埋め込み先を壊すものが入っていないことを確かめる。
 * `npm run check:player` で流す(CI とリリースのワークフローでも流す)。先に `npm run build:player` が要る。
 *
 * 確かめること:
 * - 配布物のファイルがそろっていて、ほかのもの(CSS・分かれたチャンク・ソースマップ)が無い
 * - ビルドした1本が ESM で、import 文・動的 import・export ... from で外のモジュールを参照していない(全部同梱)
 * - export しているのが createPlayer と PlayerError だけ(inspect などが出ていない)。Node で読み込んで確かめる
 *   (Node には DOM が無いので、モジュールの先頭で window・document に触ると落ちる)
 * - 編集アプリの部品(Tailwind・daisyUI の CSS、設定の保存、IndexedDB、service worker、localStorage)が入っていない
 * - 手書きの index.d.ts がほかのモジュール(three など)を参照していない
 * - package.json の exports・types・files が指すファイルがあり、dependencies が無い
 * - 大きさ(そのまま・gzip)が上限を超えていない
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { parseAst } from 'vite';
import { distDir, bundleName, readPlayerPackage, SEMVER, fail } from './player-lib.mjs';

/**
 * 大きさの上限(バイト)。0.1.0 を作ったときの大きさ(そのまま 606 KB・gzip 159 KB)の約 1.3 倍。
 * 越えたら、増えた理由(three.js の版上げ・引き込んだモジュール)を確かめてから上げる
 */
const LIMIT = { raw: 790_000, gzip: 207_000 };

/** dist-player/ にあってよいファイル(npm pack に入るもの) */
const EXPECTED = [bundleName, 'index.d.ts', 'package.json', 'README.md', 'LICENSE', 'THIRD-PARTY-LICENSES.txt'].sort();

/** 出力に入っていてはいけないもの(編集アプリの部品・保存領域) */
const FORBIDDEN = [
  ['localStorage', /localStorage/],
  ['sessionStorage', /sessionStorage/],
  ['indexedDB', /indexedDB/],
  ['serviceWorker', /serviceWorker/],
  ['設定の保存(popstage.prefs)', /popstage\.prefs/],
  ['Tailwind', /tailwind|--tw-/i],
  ['daisyUI', /daisyui/i],
  ['アプリの版の埋め込み(__APP_VERSION__ / __COMMIT_DATE__)', /__APP_VERSION__|__COMMIT_DATE__/],
  ['import.meta(Vite の環境変数など)', /import\.meta/],
];

const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); };

// 1. ファイルの一覧
const files = readdirSync(distDir).sort();
check(JSON.stringify(files) === JSON.stringify(EXPECTED), `dist-player/ のファイルが想定と違います: ${files.join(', ')}(想定: ${EXPECTED.join(', ')})`);

// 2. 1本の ESM で、外のモジュールを参照していない
const code = readFileSync(join(distDir, bundleName), 'utf8');
const ast = parseAst(code);
const exported = [];
const external = [];
for (const node of ast.body) {
  if (node.type === 'ImportDeclaration') external.push(`import ... from '${node.source.value}'`);
  if (node.type === 'ExportAllDeclaration') external.push(`export * from '${node.source.value}'`);
  if (node.type === 'ExportDefaultDeclaration') exported.push('default');
  if (node.type === 'ExportNamedDeclaration') {
    if (node.source) external.push(`export ... from '${node.source.value}'`);
    for (const s of node.specifiers) exported.push(s.exported.name ?? s.exported.value);
    if (node.declaration) problems.push('export に宣言が直接付いています(想定は末尾の export { … } だけ)');
  }
}
/** 構文木の全体から、動的 import と require( を探す */
(function walk(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walk(n); return; }
  if (node.type === 'ImportExpression') external.push('import(…)');
  if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') external.push('require(…)');
  for (const k in node) if (k !== 'type' && typeof node[k] === 'object') walk(node[k]);
})(ast);
check(external.length === 0, `外のモジュールを参照しています(全部同梱するはず): ${[...new Set(external)].join(', ')}`);
check(JSON.stringify(exported.sort()) === JSON.stringify(['PlayerError', 'createPlayer']), `export が createPlayer と PlayerError だけではありません: ${exported.join(', ')}`);

// 3. Node で読み込む(読んだだけで落ちない = 先頭で window・document に触らない。export の中身も確かめる)
try {
  const before = new Set(Object.getOwnPropertyNames(globalThis));
  const m = await import(pathToFileURL(join(distDir, bundleName)).href);
  const keys = Object.keys(m).sort();
  check(JSON.stringify(keys) === JSON.stringify(['PlayerError', 'createPlayer']), `読み込んだモジュールの export: ${keys.join(', ')}`);
  check(typeof m.createPlayer === 'function', 'createPlayer が関数ではありません');
  check(typeof m.PlayerError === 'function', 'PlayerError がクラスではありません');
  const e = new m.PlayerError('aborted', 'x');
  check(e instanceof Error && e.name === 'PlayerError' && e.code === 'aborted', 'PlayerError の name・code が想定と違います');
  const added = Object.getOwnPropertyNames(globalThis).filter(k => !before.has(k));
  check(added.length === 0, `読み込んだだけで globalThis に足されたもの: ${added.join(', ')}`);
} catch (e) {
  problems.push(`Node で読み込めません(モジュールの先頭で DOM に触っている?): ${e instanceof Error ? e.message : e}`);
}

// 4. 編集アプリの部品が入っていない
for (const [name, re] of FORBIDDEN) check(!re.test(code), `出力に ${name} が入っています`);

// 5. 型定義がほかのモジュールを参照していない(three の型が無くても使える)
const dts = readFileSync(join(distDir, 'index.d.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
check(!/\bimport\b|\bfrom\s+['"]|\brequire\s*\(|<reference\b/.test(dts), 'index.d.ts がほかのモジュールを参照しています');

// 6. package.json
const pkg = JSON.parse(readFileSync(join(distDir, 'package.json'), 'utf8'));
check(JSON.stringify(pkg) === JSON.stringify(readPlayerPackage()), 'dist-player/package.json が packages/player/package.json と違います(build:player を流し直してください)');
check(pkg.name === 'pukupop-player', `name が pukupop-player ではありません: ${pkg.name}`);
check(SEMVER.test(pkg.version ?? ''), `version が semver ではありません: ${pkg.version}`);
check(pkg.type === 'module', 'type が module ではありません');
check(!pkg.dependencies && !pkg.peerDependencies && !pkg.optionalDependencies, '依存が書かれています(three.js と fflate は同梱するので要らない)');
const targets = [pkg.types, pkg.module, pkg.exports?.['.']?.types, pkg.exports?.['.']?.default, pkg.exports?.['./package.json']];
for (const t of targets) check(typeof t === 'string' && files.includes(t.replace(/^\.\//, '')), `package.json が指すファイルがありません: ${t}`);
for (const f of pkg.files ?? []) check(files.includes(f), `files に書いたファイルがありません: ${f}`);
// 条件は types を先に、残りは default で受ける(import に限ると require や条件を見ない道具から引けない)
check(JSON.stringify(pkg.exports?.['.']) === JSON.stringify({ types: './index.d.ts', default: `./${bundleName}` }), 'exports の "." が想定と違います({ types, default } の順にする)');

// 7. 大きさ
const raw = Buffer.byteLength(code), gzip = gzipSync(code).length;
const kb = n => `${(n / 1000).toFixed(1)} KB`;
console.log(`${bundleName}: そのまま ${kb(raw)}(上限 ${kb(LIMIT.raw)})/ gzip ${kb(gzip)}(上限 ${kb(LIMIT.gzip)})`);
check(raw <= LIMIT.raw, `大きさが上限を超えました: ${kb(raw)} > ${kb(LIMIT.raw)}`);
check(gzip <= LIMIT.gzip, `gzip の大きさが上限を超えました: ${kb(gzip)} > ${kb(LIMIT.gzip)}`);

if (problems.length) fail(`ビルドの確かめで ${problems.length} 件の問題が見つかりました:\n- ${problems.join('\n- ')}`);
console.log(`ビルドの確かめ: 問題なし(${pkg.name} ${pkg.version}、export: ${exported.join(', ')})`);
