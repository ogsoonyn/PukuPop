/**
 * Player のライブラリ(Issue #127)のビルド・確かめ・npm pack・リリースのスクリプトが共有する場所と道具。
 * Windows でも Linux でも動くよう、シェルに頼らず Node の API だけで書く。
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** リポジトリの直下 */
export const root = fileURLToPath(new URL('..', import.meta.url));
/** Player の package.json・README・手書きの index.d.ts の置き場所(版の元はここの package.json だけ) */
export const pkgDir = join(root, 'packages', 'player');
/** ライブラリのビルド結果。npm pack はこのディレクトリをそのままパッケージにする */
export const distDir = join(root, 'dist-player');
/** ビルドした1本の名前 */
export const bundleName = 'pukupop-player.js';

/** packages/player/package.json */
export function readPlayerPackage() {
  return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
}

/** npm pack の既定の名前(pukupop-player-<版>.tgz) */
export const tgzName = version => `pukupop-player-${version}.tgz`;

/** semver(前置きの v なし。プレリリースは付けてよい、ビルドのメタデータは付けない) */
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

/**
 * コマンドを流す(シェルを通さない。npm だけは Windows で npm.cmd になるので、そこだけシェルを通す)。
 * 失敗したら終了コードを付けて投げる。capture なら標準出力を返す
 */
export function run(cmd, args, { cwd = root, capture = false, allowFail = false } = {}) {
  const win = process.platform === 'win32' && cmd === 'npm';
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', shell: win });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} が失敗しました(終了コード ${r.status})`);
  return { status: r.status, stdout: r.stdout ?? '' };
}

/** リポジトリの TypeScript(tsc)を Node で流す(新しく何も入れない) */
export function tsc(args, opts) {
  return run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), ...args], opts);
}

/** 失敗を分かる文言で出して終える */
export function fail(message) {
  console.error(`\n失敗: ${message}`);
  process.exit(1);
}

/** GitHub Actions の出力(GITHUB_OUTPUT)に書く。手元では何もしない */
export async function setOutput(values) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const { appendFileSync } = await import('node:fs');
  appendFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
}
