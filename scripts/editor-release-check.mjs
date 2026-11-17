/**
 * 埋め込み用の編集画面のリリースのタグを確かめる(.github/workflows/release-editor.yml の最初に流す。手元でも流せる)。
 *
 *   node scripts/editor-release-check.mjs --tag editor-v0.1.0 [--sha <コミット>] [--main <ref>]
 *
 * タグの形が editor-v<semver> で、版が packages/editor/package.json の version と一致し、コミットが main の履歴に含まれること。
 * 中身は release-tag-check.mjs(Player のリリースと共有する)。
 */
import { checkReleaseTag } from './release-tag-check.mjs';

await checkReleaseTag({ prefix: 'editor-v', pkgPath: 'packages/editor/package.json' });
