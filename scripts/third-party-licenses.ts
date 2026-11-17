/**
 * 同梱した node_modules のパッケージのライセンスの表記を THIRD-PARTY-LICENSES.txt として出す Vite のプラグイン。
 * Player のライブラリのビルド(vite.player.config.ts)と、埋め込み用の編集画面のビルド(vite.config.ts の --mode embed)が使う。
 * ビルドに入ったモジュールから集めるので、版が上がっても食い違わない。ライセンス文が見つからなければビルドを失敗にする。
 */
import type { Plugin } from 'vite';
import { readFileSync, existsSync } from 'node:fs';

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
export function bundledPackages(moduleIds: readonly string[]): string[] {
  return [...new Set(bundledPackageDirs(moduleIds).map(([name]) => name))];
}

/** product は先頭の文に出す配布物の名前(例: pukupop-player) */
export function thirdPartyLicenses(product: string): Plugin {
  return {
    name: 'pukupop-third-party-licenses',
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
        source: `${product} は次のパッケージを同梱しています。それぞれの著作権表示とライセンス文を載せます。\n\n${rule}\n\n${parts.join(`\n${rule}\n\n`)}`,
      });
    },
  };
}
