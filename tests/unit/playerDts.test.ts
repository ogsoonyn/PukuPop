/**
 * Player のライブラリの配布物の元(packages/player)の確かめ。
 * - 入口(src/player/index.ts)が出す名前(値と型)と、手書きの型定義(packages/player/index.d.ts)が出す名前が一致する
 *   (型の中身の一致は tests/types/player-dts.ts が型検査で見る。型の名前は型の上で数えられないので、ここで文字列から見る)
 * - Player の package.json と README の版がそろっている
 */
import { describe, it, expect } from 'vitest';
import entry from '../../src/player/index.ts?raw';
import dts from '../../packages/player/index.d.ts?raw';
import readme from '../../packages/player/README.md?raw';
import pkg from '../../packages/player/package.json';

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** 入口の export { … } from / export type { … } from の名前 */
function entryNames(src: string): { values: string[]; types: string[] } {
  const values: string[] = [], types: string[] = [];
  for (const m of stripComments(src).matchAll(/export\s+(type\s+)?\{([^}]*)\}\s*from/g)) {
    const names = m[2].split(',').map(s => s.trim()).filter(Boolean).map(s => s.split(/\s+as\s+/).pop()!.replace(/^type\s+/, ''));
    (m[1] ? types : values).push(...names);
  }
  expect(stripComments(src)).not.toMatch(/export\s+\*/); // export * があると数えられない
  return { values: values.sort(), types: types.sort() };
}

/** d.ts の export の名前。class は値と型の両方 */
function dtsNames(src: string): { values: string[]; types: string[] } {
  const values: string[] = [], types: string[] = [];
  for (const m of stripComments(src).matchAll(/^export\s+(?:declare\s+)?(function|class|const|let|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (m[1] === 'type' || m[1] === 'interface') types.push(m[2]);
    else values.push(m[2]);
  }
  expect(stripComments(src)).not.toMatch(/^export\s*(\{|\*|default)/m); // 名前を数える書き方だけにする
  return { values: values.sort(), types: types.sort() };
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
    expect(dtsNames('export type A = 1;\nexport interface B {}\nexport declare class C {}\nexport declare function d(): void;\n// export type E = 1;'))
      .toEqual({ values: ['C', 'd'], types: ['A', 'B'] });
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
