/**
 * 埋め込み用の編集画面のビルド(dist-editor/)を確かめる。`npm run check:editor`(CI とリリースのワークフローでも流す)。
 * 先に `npm run build:editor` が要る。公開版のビルド(dist/)があれば、そちらも見る。
 *
 * - 配布物の直下のファイルがそろっている(package.json・README.md・LICENSE・THIRD-PARTY-LICENSES.txt・app/index.html)
 * - app/ に service worker(sw.js)・PWA のマニフェストと、ライセンスの表記(直下へ移したもの)が無い。index.html がマニフェストを読み込まない
 * - ライセンスの表記に、CSS に入る tailwindcss・daisyui も載っている
 * - index.html が読み込むものは相対パス(サブパスに置いても動く)。/ で始まる参照・外のオリジンの参照が無い
 * - JS に埋め込みの起動(クエリの読み取り)が入っている。service worker を登録するコードが無い
 * - 公開版(dist/)には埋め込みの起動が入っていない(外から保存先を指定できない)
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, fail } from './player-lib.mjs';
import { distDir, appDir, readEditorPackage, EMBED_MARKER } from './editor-lib.mjs';

const pkg = readEditorPackage();
for (const f of ['package.json', 'README.md', 'LICENSE', 'THIRD-PARTY-LICENSES.txt', 'app/index.html']) {
  if (!existsSync(join(distDir, f))) fail(`dist-editor/${f} がありません。npm run build:editor を流してください`);
}
for (const f of ['sw.js', 'manifest.webmanifest', 'THIRD-PARTY-LICENSES.txt']) if (existsSync(join(appDir, f))) fail(`dist-editor/app/${f} があります(配信するディレクトリには置かない)`);
const built = JSON.parse(readFileSync(join(distDir, 'package.json'), 'utf8'));
if (built.name !== pkg.name || built.version !== pkg.version) fail('dist-editor/package.json が packages/editor/package.json と違います。npm run build:editor を流し直してください');

const html = readFileSync(join(appDir, 'index.html'), 'utf8');
if (/rel="manifest"/.test(html)) fail('index.html が PWA のマニフェストを読み込んでいます(埋め込む側のオリジンにインストールさせない)');
const licenses = readFileSync(join(distDir, 'THIRD-PARTY-LICENSES.txt'), 'utf8');
for (const name of ['three', 'fflate', 'tailwindcss', 'daisyui']) {
  if (!new RegExp(`^${name} \\d`, 'm').test(licenses)) fail(`THIRD-PARTY-LICENSES.txt に ${name} がありません`);
}
const refs = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map(m => m[1]);
const bad = refs.filter(r => r.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(r));
if (bad.length) fail(`index.html に相対パスでない参照があります(サブパスに置くと読めない・外へ取りに行く): ${bad.join(', ')}`);
for (const r of refs) if (!existsSync(join(appDir, r.split(/[?#]/)[0]))) fail(`index.html が読み込む ${r} がありません`);

/** ディレクトリの中の .js を全部読む */
const scripts = dir => (existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.js')).map(f => readFileSync(join(dir, f), 'utf8')) : []);
const js = scripts(join(appDir, 'assets'));
if (!js.length) fail('dist-editor/app/assets/ に JS がありません');
if (!js.some(s => s.includes(EMBED_MARKER))) fail('埋め込み用のビルドに、埋め込みの起動(src/app/embed.ts)が入っていません(__EMBED__ が true になっていない?)');
if (js.some(s => s.includes('serviceWorker.register'))) fail('埋め込み用のビルドに service worker を登録するコードがあります');

const publicJs = scripts(join(root, 'dist', 'assets'));
if (publicJs.some(s => s.includes(EMBED_MARKER))) fail('公開版のビルド(dist/)に埋め込みの起動が入っています。埋め込みの口は埋め込み用のビルドだけにする');

console.log(`ビルドの確かめ: 問題なし(${pkg.name} ${pkg.version}${publicJs.length ? '。公開版のビルドに埋め込みの口が無いことも確かめた' : ''})`);
