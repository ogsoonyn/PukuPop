/**
 * 埋め込み用の編集画面の配布物の元(packages/editor)の確かめ。
 * - package.json と README の入れ方の URL の版がそろっている
 * - README と docs/embed.md に書いたクエリの名前が、実装(src/app/embed.ts)の読むものと一致する
 */
import { describe, it, expect } from 'vitest';
import readme from '../../packages/editor/README.md?raw';
import embedDoc from '../../docs/embed.md?raw';
import embedSrc from '../../src/app/embed.ts?raw';
import pkg from '../../packages/editor/package.json';

describe('埋め込み用の編集画面の配布物', () => {
  it('README の入れ方の URL が今の版を指す', () => {
    const urls = [...readme.matchAll(/releases\/download\/editor-v([^/\s"]+)\/pukupop-editor-([^\s"`]+?)\.(tgz|zip)/g)];
    expect(urls.length).toBeGreaterThan(0);
    for (const [, tag, file] of urls) expect([tag, file]).toEqual([pkg.version, pkg.version]);
    // zip の展開先のディレクトリの名前も版を含む
    for (const [, v] of readme.matchAll(/pukupop-editor-(\d[^/\s`]*)\/app\//g)) expect(v).toBe(pkg.version);
    for (const [, v] of readme.matchAll(/pukupop-editor-(\d[^\s`]*?)\.zip/g)) expect(v).toBe(pkg.version);
  });

  it('README のクエリの表が、実装の読むクエリと一致する', () => {
    const documented = [...readme.matchAll(/^\| `([a-z]+)` \|/gm)].map(m => m[1]).sort();
    const read = [...new Set([...embedSrc.matchAll(/\b(?:url|get)\('([a-z]+)'/g)].map(m => m[1]))].sort();
    expect(documented).toEqual(['back', 'create', 'image', 'name', 'save', 'src']);
    expect(read).toEqual(documented);
  });

  it('docs/embed.md が README から辿れ、口の要点(If-Match・412・Location)を書いている', () => {
    expect(readme).toContain('docs/embed.md');
    for (const s of ['If-Match', '412', 'Location', 'ETag', '同じオリジン']) expect(embedDoc).toContain(s);
  });
});
