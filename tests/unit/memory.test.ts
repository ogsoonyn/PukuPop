import { describe, it, expect } from 'vitest';
import { formatBytes, projectDataBytes, sumMemory } from '../../src/model/memory';
import { createDocument, createLayer, createProject } from '../../src/model/project';

describe('メモリの見積もり', () => {
  it('画像のファイルとウェイトと PNG を足す', () => {
    const doc = createDocument({ bytes: new Uint8Array(1000), mime: 'image/png', ext: 'png', width: 64, height: 32 }, 'a');
    const p = createProject(doc);
    const w = doc.layers.reduce((a, l) => a + l.weights.data.byteLength, 0);
    expect(w).toBeGreaterThan(0);
    expect(projectDataBytes(p)).toBe(1000 + w);
    doc.layers.push(createLayer(doc));
    expect(projectDataBytes(p, 50)).toBe(1000 + w * 2 + 50);
  });
  it('タブの分を合計する', () => {
    const m = sumMemory([
      { name: 'a', active: true, data: 1, history: 2, render: 3 },
      { name: 'b', active: false, data: 10, history: 20, render: 0 },
    ], null);
    expect([m.data, m.history, m.render, m.total]).toEqual([11, 22, 3, 36]);
  });
  it('短く書く', () => {
    expect(formatBytes(512)).toBe('1KB');
    expect(formatBytes(800 * 1024)).toBe('800KB');
    expect(formatBytes(4.5 * 1024 * 1024)).toBe('4.5MB');
    expect(formatBytes(320 * 1024 * 1024)).toBe('320MB');
    expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.2GB');
  });
});
