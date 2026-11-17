/**
 * 埋め込み用の再生専用の部品(Player、Issue #127)をライブラリとしてビルドする設定。アプリのビルド(vite.config.ts)とは分ける。
 * `npm run build:player` が使う(ビルドのあと scripts/player-package.mjs が配布物をそろえる)。
 *
 * - 入口は src/player/index.ts。ESM を1本だけ出す(dist-player/pukupop-player.js)。
 * - three.js と fflate は同梱する(埋め込み先は three.js を使っていない)。external にしない。
 *   同梱したパッケージのライセンスの表記は、ビルドに入ったモジュールから集めて THIRD-PARTY-LICENSES.txt に書く(版が上がっても食い違わない)。
 * - 動的 import があってもチャンクに分けない(codeSplitting: false)。
 * - アプリの設定の Tailwind のプラグインと define(__APP_VERSION__ など)は引き継がない。
 *   Player の入口から辿れるコードはどちらも使わない(使うと scripts/player-check-build.mjs が見つける)。
 * - public/(service worker・アイコン)は写さない。
 * - 空白まで圧縮し、ソースマップは付けない(理由は .claude/docs/decisions.md)。
 */
import { defineConfig } from 'vite';
import playerPkg from './packages/player/package.json' with { type: 'json' };
import { thirdPartyLicenses, bundledPackages } from './scripts/third-party-licenses.ts';

export default defineConfig({
  publicDir: false,
  // 開発用のサーバーのキャッシュと混ざらないよう分ける
  cacheDir: 'node_modules/.vite-player',
  plugins: [thirdPartyLicenses(playerPkg.name)],
  build: {
    target: 'es2022',
    outDir: 'dist-player',
    emptyOutDir: true,
    sourcemap: false,
    copyPublicDir: false,
    // 1本にまとめるので大きさの警告は出さない(大きさの上限は scripts/player-check-build.mjs が見る)
    chunkSizeWarningLimit: 1500,
    lib: {
      entry: 'src/player/index.ts',
      formats: ['es'],
      fileName: () => 'pukupop-player.js',
    },
    rolldownOptions: {
      // library mode の ESM は既定で空白を残すので、出力の圧縮で空白まで詰める
      output: {
        codeSplitting: false,
        minify: true,
        // 圧縮で three.js の @license のコメントが消えるので、版・ライセンス・同梱したものを先頭に1行で残す(埋め込み先のバンドラも /*! は残す)
        postBanner: chunk => `/*! ${playerPkg.name} ${playerPkg.version} | MIT | 同梱: ${bundledPackages(chunk.moduleIds).join(', ')}(ライセンスは THIRD-PARTY-LICENSES.txt) */`,
      },
    },
  },
});
