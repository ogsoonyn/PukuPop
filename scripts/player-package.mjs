/**
 * Player のライブラリのビルド(vite.player.config.ts → dist-player/)のあとに、配布物をそろえる。
 * `npm run build:player` が、Vite のビルドのあとに流す。
 *
 * dist-player/ を npm pack にそのまま渡せるパッケージにする:
 * - packages/player の package.json・README.md・index.d.ts(手書きの型定義)
 * - リポジトリの LICENSE
 * - ビルドした1本(pukupop-player.js)と THIRD-PARTY-LICENSES.txt(同梱したパッケージのライセンス。Vite のプラグインが出す)
 */
import { copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { root, pkgDir, distDir, bundleName, readPlayerPackage, fail } from './player-lib.mjs';

for (const f of [bundleName, 'THIRD-PARTY-LICENSES.txt']) {
  if (!existsSync(join(distDir, f))) fail(`dist-player/${f} がありません。先に vite build --config vite.player.config.ts を流してください`);
}
for (const f of ['package.json', 'README.md', 'index.d.ts']) copyFileSync(join(pkgDir, f), join(distDir, f));
copyFileSync(join(root, 'LICENSE'), join(distDir, 'LICENSE'));

const pkg = readPlayerPackage();
console.log(`dist-player/ に ${pkg.name} ${pkg.version} の配布物をそろえました`);
