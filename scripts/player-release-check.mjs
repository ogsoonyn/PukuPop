/**
 * Player のリリースのタグを確かめる(.github/workflows/release-player.yml の最初に流す。手元でも流せる)。
 *
 *   node scripts/player-release-check.mjs --tag player-v0.1.0 [--sha <コミット>] [--main <ref>]
 *
 * タグの形が player-v<semver> で、版が packages/player/package.json の version と一致し、コミットが main の履歴に含まれること。
 * 中身は release-tag-check.mjs(編集画面のリリースと共有する)。
 */
import { checkReleaseTag } from './release-tag-check.mjs';

await checkReleaseTag({ prefix: 'player-v', pkgPath: 'packages/player/package.json' });
