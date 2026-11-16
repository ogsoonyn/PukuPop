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
import { defineConfig, type Plugin } from 'vite';
import { readFileSync, existsSync } from 'node:fs';
import playerPkg from './packages/player/package.json' with { type: 'json' };

/**
 * ビルドに入った node_modules のパッケージの名前と、実際に解決されたディレクトリ(名前で並べ替え済み)。
 * ディレクトリは moduleId の「…/node_modules/<名前>/」までを切り出す(git worktree のように node_modules が親のディレクトリにあっても合う)
 */
function bundledPackageDirs(moduleIds: readonly string[]): [name: string, dir: string][] {
  // ディレクトリごとに1つ(同じ名前の別の版が入れ子で入っていれば、両方のライセンスを載せる)
  const dirs = new Map<string, string>();
  for (const id of moduleIds) {
    // 最後の node_modules を使う(入れ子の node_modules に入ったものは、そのパッケージ自身のディレクトリになる)
    const m = /^(.*\/node_modules\/((?:@[^/]+\/)?[^/]+)\/)/.exec(id.replace(/\\/g, '/').replace(/^\0+/, ''));
    if (m) dirs.set(m[1], m[2]);
  }
  return [...dirs].map(([dir, name]): [string, string] => [name, dir]).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
}

/** ビルドに入った node_modules のパッケージの名前(並べ替え済み) */
function bundledPackages(moduleIds: readonly string[]): string[] {
  return [...new Set(bundledPackageDirs(moduleIds).map(([name]) => name))];
}

/** 同梱したパッケージのライセンスの表記を THIRD-PARTY-LICENSES.txt として出す。ライセンス文が見つからなければビルドを失敗にする */
function thirdPartyLicenses(): Plugin {
  return {
    name: 'pukupop-player-third-party-licenses',
    generateBundle(_options, bundle) {
      const ids = Object.values(bundle).flatMap(c => (c.type === 'chunk' ? c.moduleIds : []));
      const parts = bundledPackageDirs(ids).map(([name, dir]) => {
        const pkg = JSON.parse(readFileSync(`${dir}package.json`, 'utf8')) as { version: string; license?: string; homepage?: string };
        const file = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license'].find(f => existsSync(dir + f));
        if (!file) throw new Error(`同梱した ${name} のライセンス文が見つかりません`);
        const head = [`${name} ${pkg.version}`, `License: ${pkg.license ?? '(package.json に記載なし)'}`, pkg.homepage ? `Homepage: ${pkg.homepage}` : ''].filter(Boolean);
        return `${head.join('\n')}\n\n${readFileSync(dir + file, 'utf8').trim()}\n`;
      });
      const rule = '-'.repeat(72);
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD-PARTY-LICENSES.txt',
        source: `pukupop-player は次のパッケージを同梱しています。それぞれの著作権表示とライセンス文を載せます。\n\n${rule}\n\n${parts.join(`\n${rule}\n\n`)}`,
      });
    },
  };
}

export default defineConfig({
  publicDir: false,
  // 開発用のサーバーのキャッシュと混ざらないよう分ける
  cacheDir: 'node_modules/.vite-player',
  plugins: [thirdPartyLicenses()],
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
