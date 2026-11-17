/**
 * 埋め込み用の編集画面のビルド(vite build --mode embed → dist-editor/app/)のあとに、配布物をそろえる。
 * `npm run build:editor` が、Vite のビルドのあとに流す。
 *
 * - THIRD-PARTY-LICENSES.txt(同梱したパッケージのライセンス。Vite のプラグインが app/ に出す)を dist-editor/ の直下へ移す
 *   (app/ は配信するディレクトリなので、配信しないものは置かない)
 * - service worker(public/sw.js)は埋め込みモードでは登録せず、PWA のマニフェストも読み込まない(vite.config.ts)ので、app/ から外す
 * - packages/editor の package.json・README.md と、リポジトリの LICENSE を写す
 */
import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { root, fail } from './player-lib.mjs';
import { pkgDir, distDir, appDir, readEditorPackage } from './editor-lib.mjs';

if (!existsSync(join(appDir, 'index.html'))) fail('dist-editor/app/index.html がありません。先に vite build --mode embed を流してください');
const licenses = join(appDir, 'THIRD-PARTY-LICENSES.txt');
if (!existsSync(licenses)) fail('dist-editor/app/THIRD-PARTY-LICENSES.txt がありません(vite build --mode embed が出すはず)');
renameSync(licenses, join(distDir, 'THIRD-PARTY-LICENSES.txt'));
for (const f of ['sw.js', 'manifest.webmanifest']) rmSync(join(appDir, f), { force: true });
for (const f of ['package.json', 'README.md']) copyFileSync(join(pkgDir, f), join(distDir, f));
copyFileSync(join(root, 'LICENSE'), join(distDir, 'LICENSE'));

const pkg = readEditorPackage();
console.log(`dist-editor/ に ${pkg.name} ${pkg.version} の配布物をそろえました`);
