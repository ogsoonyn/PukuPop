/**
 * 保存形式の文書(docs/format.md)に写した実装の値が、実装と食い違っていないかを見る。
 * 見るのは、形式の版・読むときの上限・ZIP の中のパスの名前だけ(文書の文章までは見ない)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { serializeProject, FORMAT_VERSION, UNZIP_LIMITS, FAVORITE_TAKE_LIMIT, TAKE_PATH } from '../../src/storage/popstage';
import { createDocument, createProject } from '../../src/model/project';
import { captureFavorite } from '../../src/model/favorites';
import { takeFromKeys } from '../../src/physics/take';
import { encodeGrayPng } from '../../src/storage/png';

const doc = readFileSync(new URL('../../docs/format.md', import.meta.url), 'utf8');

describe('docs/format.md', () => {
  it('形式の版が実装の FORMAT_VERSION と同じ', () => {
    expect(doc).toContain(`今の形式の版(\`formatVersion\`)は **${FORMAT_VERSION}** です`);
    expect(doc).toContain(`\`formatVersion\` は保存形式の版です。今は \`${FORMAT_VERSION}\``);
  });

  it('読むときの上限の表が UNZIP_LIMITS・FAVORITE_TAKE_LIMIT と同じ', () => {
    const limits: [string, number][] = [...Object.entries(UNZIP_LIMITS), ['FAVORITE_TAKE_LIMIT', FAVORITE_TAKE_LIMIT]];
    const section = doc.slice(doc.indexOf('## 読むときの上限'), doc.indexOf('## 版と互換'));
    for (const [name, bytes] of limits) {
      const row = section.split('\n').find(l => l.startsWith(`| \`${name}\` |`));
      expect(row, name).toBeDefined();
      expect(row, name).toContain(`${bytes / 2 ** 20} MiB(${bytes} バイト)`);
    }
    // 表の行の数も同じ(実装に上限が足されたら気づけるように)
    expect(section.split('\n').filter(l => /^\| `/.test(l))).toHaveLength(limits.length);
  });

  it('編集アプリが書く ZIP の中のパスが、文書の「中のパス」の表にある', () => {
    const img = encodeGrayPng(4, 3, new Uint8Array(12));
    const p = createProject(createDocument({ bytes: img, mime: 'image/png', ext: 'png', width: 4, height: 3 }, 'a.png'));
    const key = (yaw: number) => ({ view: { yaw, pitch: 0, roll: 0, zoom: 1, target: { x: 0, y: 0, z: 0 } }, seconds: 1, mode: 'smooth' as const });
    p.take = takeFromKeys([key(0), key(0.5)], p.camera.fov);
    p.favorites = [captureFavorite(p, p.documents[0], { name: 'a', playing: true })];
    // お気に入りだけが持つ記録(motion/favorite-N.json)も書かれるようにする
    p.take = takeFromKeys([key(0), key(1)], p.camera.fov);
    const names = Object.keys(unzipSync(serializeProject(p, { thumbnail: img })));
    const table = doc.slice(doc.indexOf('### 中のパス'), doc.indexOf('## `project.json`'));
    const patterns = new Set(names.map(n => n.replace(/\d+/g, 'N').replace(/^(images\/doc-N)\.\w+$/, '$1.<ext>')));
    expect(patterns).toEqual(new Set(['project.json', 'images/doc-N.<ext>', 'weights/doc-N-layer-N.png', TAKE_PATH, 'motion/favorite-N.json', 'thumbnail.png']));
    for (const pat of patterns) {
      const shown = pat === 'weights/doc-N-layer-N.png' ? 'weights/doc-N-layer-M.png' : pat;
      expect(table, pat).toContain(`| \`${shown}\` |`);
    }
  });
});
