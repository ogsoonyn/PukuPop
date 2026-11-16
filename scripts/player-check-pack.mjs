/**
 * npm pack した pukupop-player-<版>.tgz を、空のプロジェクトに入れて使えることを確かめる。
 * `npm run check:player-pack`(引数で .tgz の場所を渡せる。省くとリポジトリの直下の pukupop-player-<版>.tgz)。
 * CI とリリースのワークフローでも流す。先に `npm run pack:player` が要る。
 *
 * 1. OS の一時ディレクトリに最小の package.json を作り、.tgz を npm install する(--offline。依存が無いので取りに行くものは無い)
 * 2. Node から import('pukupop-player') する。Node には DOM が無いので、読み込んだだけで落ちない
 *    (= モジュールの先頭で window・document に触っていない)ことの確かめにもなる。createPlayer と PlayerError が関数で、
 *    export はその2つだけ、読み込んでも globalThis に何も足さないこと、pukupop-player/package.json も読めることを見る
 * 3. 入れた README.md の ```ts と ```tsx のコード、と API を一通り使うコードを、リポジトリの tsc で型検査する。
 *    lib は DOM と ES2022 だけ、types は空(three などの型は無い)、skipLibCheck は切る(d.ts の中のエラーも見る)。
 *    moduleResolution は bundler と node16 の両方で見る。React の例は、ここに書いた最小の react の型(useEffect・useRef・useState と JSX)で見る
 * 終わったら一時ディレクトリを消す。
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { root, readPlayerPackage, tgzName, run, tsc, fail } from './player-lib.mjs';

/** API を一通り使うコード(型が実装と食い違っていないかは tests/types/player-dts.ts。ここは埋め込み先から使えるかを見る) */
const API_USAGE = String.raw`
import { createPlayer, PlayerError } from 'pukupop-player';
import type { Player, PlayerOptions, PlayerInfo, PlayerFavorite, PlayerInteraction, PlayerErrorCode } from 'pukupop-player';

export async function use(canvas: HTMLCanvasElement, bytes: ArrayBuffer): Promise<string> {
  const interaction: PlayerInteraction = 'none';
  const options: PlayerOptions = { autoplay: false, interaction, autoResize: false, signal: new AbortController().signal };
  try {
    const p: Player = await createPlayer(canvas, bytes, options);
    const info: PlayerInfo = p.info;
    const fav: PlayerFavorite | undefined = info.favorites[0];
    const n: number = info.width + info.height + info.takeSeconds;
    const ok: boolean = fav ? p.setFavorite(fav.id) : false;
    const playing: boolean = p.playing;
    p.play(); p.pause(); p.resize(); p.dispose();
    await createPlayer(canvas, new Uint8Array(bytes));
    return String(n) + ok + playing;
  } catch (e) {
    if (e instanceof PlayerError) return describe(e.code) + e.message + String(e.cause);
    throw e;
  }
}

/** code は5種類だけ(足されたら、ここが網羅していないと型エラーになる) */
function describe(code: PlayerErrorCode): string {
  switch (code) {
    case 'aborted': return 'a';
    case 'invalid-file': return 'b';
    case 'unsupported-version': return 'c';
    case 'canvas-unusable': return 'd';
    case 'webgl-unavailable': return 'e';
    default: { const never: never = code; return never; }
  }
}

// 埋め込み先が読めないもの(内部の口)は型にも無い
// @ts-expect-error inspect は公開しない
import { inspect } from 'pukupop-player';
void inspect;
// @ts-expect-error 読むだけ
declare const p0: Player; p0.playing = true;
// @ts-expect-error info は凍結した読むだけのもの
declare const i0: PlayerInfo; i0.width = 1;
`;
/** React の例を型検査するための、最小の react の型(@types/react は入れない) */
const REACT_STUB = String.raw`
declare module 'react' {
  export interface RefObject<T> { current: T }
  export function useRef<T>(initial: T | null): RefObject<T | null>;
  export function useState<T>(initial: T): [T, (value: T) => void];
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
}
declare namespace JSX {
  interface Element { readonly __jsx: true }
  interface IntrinsicAttributes { key?: string | number }
  interface ElementChildrenAttribute { children: unknown }
  interface IntrinsicElements {
    div: { children?: unknown; className?: string };
    p: { children?: unknown; role?: string };
    canvas: { key?: string | number; ref?: import('react').RefObject<HTMLCanvasElement | null>; style?: Record<string, string | number>; className?: string };
  }
}
`;

const tgz = resolve(process.argv[2] ?? join(root, tgzName(readPlayerPackage().version)));
if (!existsSync(tgz)) fail(`${tgz} がありません。先に npm run pack:player を流してください`);

const dir = mkdtempSync(join(tmpdir(), 'pukupop-player-check-'));
const write = (file, text) => writeFileSync(join(dir, file), text);
const step = s => console.log(`\n▶ ${s}`);
let ok = false;
try {
  write('package.json', JSON.stringify({ name: 'pukupop-player-consumer', version: '0.0.0', private: true, type: 'module' }, null, 2));

  step('.tgz を空のプロジェクトに入れる(ネットワークを使わない)');
  run('npm', ['install', tgz, '--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--no-package-lock'], { cwd: dir });
  const installed = join(dir, 'node_modules', 'pukupop-player');
  if (!existsSync(join(installed, 'package.json'))) throw new Error('node_modules/pukupop-player が入っていません');
  if (existsSync(join(dir, 'node_modules', 'three')) || existsSync(join(dir, 'node_modules', 'fflate'))) throw new Error('依存(three・fflate)まで入りました。同梱のはずです');

  step('Node から import する(DOM の無い所で読み込んでも落ちない)');
  write('import-check.mjs', `
const before = new Set(Object.getOwnPropertyNames(globalThis));
const m = await import('pukupop-player');
const added = Object.getOwnPropertyNames(globalThis).filter(k => !before.has(k));
const pkg = (await import('pukupop-player/package.json', { with: { type: 'json' } })).default;
const keys = Object.keys(m).sort();
const problems = [];
if (JSON.stringify(keys) !== JSON.stringify(['PlayerError', 'createPlayer'])) problems.push('export: ' + keys.join(', '));
if (typeof m.createPlayer !== 'function') problems.push('createPlayer が関数ではない');
if (typeof m.PlayerError !== 'function') problems.push('PlayerError がクラスではない');
const e = new m.PlayerError('invalid-file', 'x');
if (!(e instanceof Error) || e.name !== 'PlayerError' || e.code !== 'invalid-file') problems.push('PlayerError の name・code が違う');
if (added.length) problems.push('globalThis に足されたもの: ' + added.join(', '));
if (pkg.name !== 'pukupop-player') problems.push('package.json が読めない');
if (problems.length) { console.error(problems.join('\\n')); process.exit(1); }
console.log('import できました: ' + keys.join(', ') + '(' + pkg.name + ' ' + pkg.version + ')');
`);
  run(process.execPath, ['import-check.mjs'], { cwd: dir });

  step('README のコードと、API を一通り使うコードを型検査する(three の型は無し)');
  const readme = readFileSync(join(installed, 'README.md'), 'utf8');
  const blocks = [...readme.matchAll(/^```(ts|tsx)\n([\s\S]*?)^```$/gm)];
  if (!blocks.some(b => b[1] === 'ts') || !blocks.some(b => b[1] === 'tsx')) throw new Error('README に ```ts と ```tsx のコードが見つかりません');
  mkdirSync(join(dir, 'src'));
  blocks.forEach((b, i) => write(join('src', `readme-${i + 1}.${b[1]}`), b[2]));
  write(join('src', 'api.ts'), API_USAGE);
  write(join('src', 'react.d.ts'), REACT_STUB);
  console.log(`README から ${blocks.length} 個のコードを取り出しました(${blocks.map(b => b[1]).join(', ')})`);
  const base = {
    target: 'ES2022', lib: ['DOM', 'ES2022'], types: [], strict: true, noEmit: true, skipLibCheck: false,
    jsx: 'preserve', isolatedModules: true, noUnusedLocals: false,
  };
  for (const [label, opts] of [['bundler', { module: 'ESNext', moduleResolution: 'bundler' }], ['node16', { module: 'Node16', moduleResolution: 'Node16' }]]) {
    write(`tsconfig.${label}.json`, JSON.stringify({ compilerOptions: { ...base, ...opts }, include: ['src'] }, null, 2));
    console.log(`moduleResolution: ${label}`);
    tsc(['-p', `tsconfig.${label}.json`], { cwd: dir });
  }
  ok = true;
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (!ok) fail(`${tgz} を空のプロジェクトで使えませんでした`);
console.log('\n空のプロジェクトでの確かめ: 問題なし');
