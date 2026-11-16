/**
 * Player のリリースのタグを確かめる(.github/workflows/release-player.yml の最初に流す。手元でも流せる)。
 *
 *   node scripts/player-release-check.mjs --tag player-v0.1.0 [--sha <コミット>] [--main <ref>]
 *
 * - タグの形が player-v<semver> であること(例: player-v0.1.0)
 * - タグの版が packages/player/package.json の version と一致すること
 * - タグの指すコミットが main の履歴に含まれること(リリースのタグは main のコミットに打つ)
 *
 * --tag を省くと環境変数 TAG を使う。--sha を省くとタグの指すコミット(git rev-parse <タグ>^{commit})を使う。
 * --main を省くと origin/main(ワークフローは先に fetch しておく)。
 * 通れば版を出す(GitHub Actions の上では GITHUB_OUTPUT の version にも書く)。通らなければ理由を出して終了コード 1 で終える。
 */
import { readPlayerPackage, run, fail, setOutput, SEMVER } from './player-lib.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) fail(`--${name} のあとに値を書いてください`);
  return v;
}

const tag = arg('tag') ?? process.env.TAG;
if (!tag) fail('タグを --tag か環境変数 TAG で渡してください(例: player-v0.1.0)');
const mainRef = arg('main') ?? 'origin/main';

// 1. タグの形
const m = /^player-v(.+)$/.exec(tag);
if (!m || !SEMVER.test(m[1])) fail(`タグ「${tag}」は player-v<版> の形ではありません(版は semver。例: player-v0.1.0)`);
const version = m[1];

// 2. 版の一致
const pkg = readPlayerPackage();
if (pkg.version !== version) {
  fail(`タグの版(${version})が packages/player/package.json の version(${pkg.version})と違います。版を上げるコミットを main に入れてから、そのコミットにタグを打ってください`);
}

// 3. main の履歴に含まれる
const git = (args, opts) => run('git', args, { capture: true, ...opts });
const sha = arg('sha') ?? (() => {
  const r = git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { allowFail: true });
  if (r.status !== 0) fail(`タグ「${tag}」がこのリポジトリにありません(--sha でコミットを渡すこともできます)`);
  return r.stdout.trim();
})();
const commit = git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { allowFail: true });
if (commit.status !== 0) fail(`コミット「${sha}」が見つかりません`);
const main = git(['rev-parse', '--verify', '--quiet', `${mainRef}^{commit}`], { allowFail: true });
if (main.status !== 0) fail(`「${mainRef}」が見つかりません(git fetch origin main をしてから流してください)`);
const anc = run('git', ['merge-base', '--is-ancestor', commit.stdout.trim(), main.stdout.trim()], { allowFail: true });
if (anc.status === 1) {
  fail(`タグ「${tag}」の指すコミット ${commit.stdout.trim().slice(0, 12)} は ${mainRef} の履歴に含まれていません。リリースのタグは main のコミット(develop → main のリリース PR をマージしたあと)に打ってください。リリースは作りません`);
}
if (anc.status !== 0) fail(`git merge-base が失敗しました(終了コード ${anc.status})`);

console.log(`タグの確かめ: 問題なし(${tag}、版 ${version}、コミット ${commit.stdout.trim().slice(0, 12)} は ${mainRef} の履歴に含まれる)`);
await setOutput({ version });
