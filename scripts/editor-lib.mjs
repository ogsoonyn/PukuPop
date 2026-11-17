/**
 * 埋め込み用の編集画面(Issue #146)のビルド・確かめ・npm pack・リリースのスクリプトが共有する場所と道具。
 * コマンドの実行などの道具は Player のもの(player-lib.mjs)を使う。
 *
 * 配布物(dist-editor/。tgz も zip も同じ並び):
 *   app/                      ビルドした編集画面(index.html・assets/・icons/・manifest.webmanifest)。これをサブパスに置いて配信する
 *   package.json・README.md・LICENSE・THIRD-PARTY-LICENSES.txt
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './player-lib.mjs';

/** 編集画面の package.json・README の置き場所(版の元はここの package.json だけ) */
export const pkgDir = join(root, 'packages', 'editor');
/** 配布物のディレクトリ。npm pack はこのディレクトリをそのままパッケージにする */
export const distDir = join(root, 'dist-editor');
/** ビルドした編集画面(vite build --mode embed の出力) */
export const appDir = join(distDir, 'app');

/** packages/editor/package.json */
export function readEditorPackage() {
  return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
}

/** npm pack の既定の名前(pukupop-editor-<版>.tgz) */
export const tgzName = version => `pukupop-editor-${version}.tgz`;
/** 静的ファイルを置くだけのサーバー向けの zip(pukupop-editor-<版>.zip。中は pukupop-editor-<版>/ の下に tgz と同じ並び) */
export const zipName = version => `pukupop-editor-${version}.zip`;
export const zipRoot = version => `pukupop-editor-${version}`;

/**
 * 埋め込みの起動(クエリの読み取り)が入っているかの目印にする文言(src/app/embed.ts の parseEmbedParams のエラー)。
 * 埋め込み用のビルドには入り、公開版のビルドには入らないこと(__EMBED__ が false なら木から落ちる)を確かめる
 */
export const EMBED_MARKER = '開くファイルが指定されていません';
