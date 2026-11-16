/**
 * Player のライブラリの配布物の元(packages/player)の確かめ。
 * - 入口(src/player/index.ts)が出す名前(値と型)と、手書きの型定義(packages/player/index.d.ts)が出す名前が一致する
 *   (数えられない書き方の export があれば落とす)
 *   (型の中身の一致は tests/types/player-dts.ts が型検査で見る。型の名前は型の上で数えられないので、ここで文字列から見る)
 * - Player の package.json と README の版がそろっている
 */
import { describe, it, expect } from 'vitest';
import entry from '../../src/player/index.ts?raw';
import dts from '../../packages/player/index.d.ts?raw';
import readme from '../../packages/player/README.md?raw';
import pkg from '../../packages/player/package.json';

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/*
 * 名前は文字列から数え、数えられない書き方は拒む(見逃さないように、許す形を決めてそれ以外の export があれば落とす)。
 * リポジトリの typescript(7.x のネイティブ版)にもプログラムから使う API はあるが、unstable/ の下にあり、
 * ネイティブの tsc を別のプロセスで立てて話す作りなので、単体テストからは使わない。
 */

/** 入口の export { … } from / export type { … } from の名前。それ以外の export 文(宣言・export *・default など)があれば投げる */
function entryNames(src: string): { values: string[]; types: string[] } {
  const values: string[] = [], types: string[] = [];
  const code = stripComments(src);
  const allowed = /^export\s+(type\s+)?\{([^}]*)\}\s*from\s*(['"])[^'"\n]+\3\s*;?/;
  for (const m of code.matchAll(/\bexport\b/g)) {
    const a = allowed.exec(code.slice(m.index));
    if (!a) throw new Error(`入口に数えられない export があります(export { … } from と export type { … } from だけにする): ${code.slice(m.index).split('\n')[0]}`);
    const names = a[2].split(',').map(s => s.trim()).filter(Boolean).map(s => s.split(/\s+as\s+/).pop()!.replace(/^type\s+/, ''));
    (a[1] ? types : values).push(...names);
  }
  return { values: values.sort(), types: types.sort() };
}

/**
 * d.ts の export の名前。class は値(型としても使えるが、入口は値として出しているので値に数える)。
 * 数えられる形(行の頭の export type・export interface・export declare class・export declare function)以外の export があれば投げる
 */
function dtsNames(src: string): { values: string[]; types: string[] } {
  const values = new Set<string>(), types = new Set<string>();
  const code = stripComments(src);
  const allowed = /^export\s+(type|interface|declare\s+class|declare\s+function)\s+([A-Za-z_$][\w$]*)/;
  for (const m of code.matchAll(/\bexport\b/g)) {
    const a = m.index === 0 || code[m.index - 1] === '\n' ? allowed.exec(code.slice(m.index)) : null;
    if (!a) throw new Error(`d.ts に数えられない export があります(行の頭の export type・export interface・export declare class・export declare function だけにする): ${code.slice(m.index).split('\n')[0]}`);
    (a[1] === 'type' || a[1] === 'interface' ? types : values).add(a[2]);
  }
  return { values: [...values].sort(), types: [...types].sort() };
}

describe('Player の手書きの型定義(packages/player/index.d.ts)', () => {
  it('入口が出す名前(値・型)と一致する', () => {
    const src = entryNames(entry), d = dtsNames(dts);
    expect(src.values).toEqual(['PlayerError', 'createPlayer']);
    expect(d.values).toEqual(src.values);
    // PlayerError はクラスなので、d.ts では型としても使える(入口は値として出している)
    expect(d.types).toEqual(src.types);
  });

  it('名前の数え方そのものの確かめ', () => {
    expect(entryNames("export { a, b as c } from './x';\nexport type { T, U } from './x';")).toEqual({ values: ['a', 'c'], types: ['T', 'U'] });
    expect(dtsNames('export type A = 1;\nexport interface B {}\nexport declare class C {}\nexport declare function d(): void;\nexport declare function d(x: number): void;\n// export type E = 1;'))
      .toEqual({ values: ['C', 'd'], types: ['A', 'B'] });
  });

  it('数えられない export を見逃さず落とす', () => {
    const entryOk = "export { a } from './x';\n";
    for (const bad of ['export interface Hidden {}', 'export const x = 1;', 'export * from \'./x\';', 'export * as ns from \'./x\';', 'export default 1;', 'export { a };', 'export function f() {}', 'export class K {}', 'export enum E { A }']) {
      expect(() => entryNames(entryOk + bad), bad).toThrow(/数えられない export/);
    }
    const dtsOk = 'export type A = 1;\n';
    for (const bad of ['export declare namespace N {}', 'export abstract class K {}', 'export declare abstract class K {}', 'export declare const c: number;', 'export declare enum E { A }', 'export { A as B };', 'export type { A as C };', 'export * from \'./x\';', 'export default A;', 'export = A;', 'export class K {}', 'export function f(): void;', 'declare namespace M { export type T = 1; }']) {
      expect(() => dtsNames(dtsOk + bad), bad).toThrow(/数えられない export/);
    }
  });

  it('three などほかのモジュールを参照しない', () => {
    expect(stripComments(dts)).not.toMatch(/\bimport\b|\bfrom\s+['"]|<reference\b/);
  });
});

describe('Player の package.json と README', () => {
  it('名前・版・入口がそろい、依存を持たない', () => {
    expect(pkg.name).toBe('pukupop-player');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    expect(pkg.type).toBe('module');
    expect(pkg.exports['.']).toEqual({ types: './index.d.ts', import: './pukupop-player.js' });
    expect(pkg.files.sort()).toEqual(['THIRD-PARTY-LICENSES.txt', 'index.d.ts', 'pukupop-player.js']);
    expect(pkg).not.toHaveProperty('dependencies');
    expect(pkg).not.toHaveProperty('peerDependencies');
  });

  it('README の入れ方の URL が今の版を指す(版を上げたら README も直す)', () => {
    const url = `https://github.com/ogsoonyn/PukuPop/releases/download/player-v${pkg.version}/pukupop-player-${pkg.version}.tgz`;
    expect(readme).toContain(url);
    const versions = [...readme.matchAll(/player-v(\d+\.\d+\.\d+[^/\s]*)\//g)].map(m => m[1]);
    expect(new Set(versions)).toEqual(new Set([pkg.version]));
  });
});
