import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pkg from './package.json' with { type: 'json' };
import editorPkg from './packages/editor/package.json' with { type: 'json' };
import { thirdPartyLicenses } from './scripts/third-party-licenses.ts';

/** 最後のコミットの日時(「PukuPop について」に出す)。git が無い所では空にする */
function commitDate(): string {
  // 起動した場所ではなく、この設定ファイルのある所で読む
  const cwd = fileURLToPath(new URL('.', import.meta.url));
  try { return execSync('git log -1 --format=%cI', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd }).trim(); } catch { return ''; }
}

/** index.html から PWA のマニフェストの読み込みを外す(埋め込み用のビルドだけ) */
function noManifest(): Plugin {
  return {
    name: 'pukupop-embed-no-manifest',
    transformIndexHtml(html) {
      const out = html.replace(/\s*<link rel="manifest"[^>]*>/, '');
      if (out === html) throw new Error('index.html に <link rel="manifest"> が見つかりません(埋め込み用のビルドで外すため)');
      return out;
    },
  };
}

/** index.html から揺らし方図鑑へのリンクを外す(埋め込み用のビルドだけ。guide.html を入れないため) */
function noGuideLink(): Plugin {
  return {
    name: 'pukupop-embed-no-guide-link',
    transformIndexHtml(html) {
      const out = html.replace(/\s*<!--[^>]*guide\.html[^>]*-->\s*<p id="helpGuide"[\s\S]*?<\/p>/, '');
      if (out === html) throw new Error('index.html に <p id="helpGuide"> が見つかりません(埋め込み用のビルドで外すため)');
      return out;
    },
  };
}

/**
 * `--mode embed` は、ほかのアプリに埋め込む編集画面のビルド(Issue #146。`npm run build:editor`)。
 * 埋め込みモード(src/app/embed.ts)を有効にし(__EMBED__)、dist-editor/app/ に出す。
 * 同梱したパッケージのライセンスの表記(THIRD-PARTY-LICENSES.txt)も出す(scripts/editor-package.mjs が配布物の直下へ移す)。
 * JS に入るものに加え、CSS に入る tailwindcss・daisyui も載せる。
 * PWA のマニフェストは読み込まない(埋め込む側のオリジンに、編集画面をアプリとしてインストールさせない。sw.js と manifest は配布物から外す)。
 * 公開版(ふつうのビルド)では __EMBED__ が false なので、埋め込みの口はビルドに入らない
 */
export default defineConfig(({ mode }) => {
  const embed = mode === 'embed';
  return {
    // 静的ファイルとしてどこに置いても動くよう相対パスで出力する(埋め込み用もサブパスに置ける)
    base: './',
    plugins: [tailwindcss(), ...(embed ? [thirdPartyLicenses(editorPkg.name, ['tailwindcss', 'daisyui']), noManifest(), noGuideLink()] : [])],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __COMMIT_DATE__: JSON.stringify(commitDate()),
      __EMBED__: JSON.stringify(embed),
    },
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 1500,
      // 揺らし方図鑑(guide.html、ヘルプからリンク)は公開版にだけ入れる。埋め込み用の配布物には入れない(リンクも noGuideLink が外す)。
      // 本体の入口の名前は index のまま(出力が index-*.js になる。public/sw.js が古いものを消すときに名前で見分ける)
      ...(embed ? { outDir: 'dist-editor/app', emptyOutDir: true } : {
        rollupOptions: {
          input: { index: 'index.html', guide: 'guide.html' },
          // 入口どうしで共有する部品は shared- を付ける(public/sw.js が、古いものを名前で見分けてキャッシュから消す)。動的に読む部品はそのまま
          output: { chunkFileNames: (c: { isDynamicEntry: boolean }) => c.isDynamicEntry ? 'assets/[name]-[hash].js' : 'assets/shared-[name]-[hash].js' },
        },
      }),
    },
    test: {
      include: ['tests/unit/**/*.test.ts'],
      environment: 'node',
    },
  };
});
