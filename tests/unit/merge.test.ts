import { describe, it, expect } from 'vitest';
import { mergeHeights, scaleFavoritePops } from '../../src/model/merge';
import { LIMITS, type Favorite } from '../../src/model/project';
import { WeightMap } from '../../src/model/weightmap';

const layer = (pop: number, data: number[]) => ({ pop, weights: new WeightMap(data.length, 1, Uint8Array.from(data)) });
/** 高さ(px) */
const heights = (r: { pop: number; weights: WeightMap }) => [...r.weights.data].map(w => w / 255 * r.pop);

describe('レイヤーの結合(model/merge.ts)', () => {
  it('高い方: ポップ量が同じならウェイトの大きい方をそのまま残す', () => {
    const r = mergeHeights([layer(100, [0, 50, 200, 255]), layer(100, [10, 80, 100, 0])], 'max');
    expect(r.pop).toBe(100);
    expect([...r.weights.data]).toEqual([10, 80, 200, 255]);
    expect(r.clipped).toBe(false);
  });

  it('高い方: ポップ量が違うときは高さで比べ、一番大きいポップ量に合わせる', () => {
    // 下: 高さ 100 × 255/255 = 100、上: 200 × 102/255 = 80 → 100 が残る。2つ目は 0 と 200 × 255/255 = 200
    const r = mergeHeights([layer(100, [255, 0]), layer(200, [102, 255])], 'max');
    expect(r.pop).toBe(200);
    expect(heights(r).map(Math.round)).toEqual([100, 200]);
  });

  it('加算: 高さを足し、一番大きいポップ量より高くなったらポップ量を上げて収める', () => {
    const r = mergeHeights([layer(100, [255, 0, 128]), layer(100, [255, 255, 0])], 'add');
    expect(r.pop).toBe(200);
    expect(heights(r).map(Math.round)).toEqual([200, 100, 50]);
    expect(r.clipped).toBe(false);
    // 重なりが無ければポップ量はそのまま
    const flat = mergeHeights([layer(100, [255, 0]), layer(60, [0, 255])], 'add');
    expect(flat.pop).toBe(100);
    expect(heights(flat).map(Math.round)).toEqual([100, 60]);
  });

  it('加算: ポップ量の上限を超えた所は上限で切る', () => {
    const r = mergeHeights([layer(LIMITS.pop.max, [255, 10]), layer(LIMITS.pop.max, [255, 10])], 'add');
    expect(r.pop).toBe(LIMITS.pop.max);
    expect(r.weights.data[0]).toBe(255);
    expect(r.weights.data[1]).toBe(20);
    expect(r.clipped).toBe(true);
  });

  it('3枚以上もまとめられる。ポップ量が 0 のレイヤーは高さ 0 として扱う', () => {
    const r = mergeHeights([layer(100, [50, 0]), layer(0, [255, 255]), layer(100, [0, 70])], 'add');
    expect(r.pop).toBe(100);
    expect([...r.weights.data]).toEqual([50, 70]);
    expect(mergeHeights([layer(100, [50, 0]), layer(0, [255, 255]), layer(100, [0, 70])], 'max').weights.data).toEqual(Uint8Array.from([50, 70]));
  });

  it('どれもポップ量が 0 なら、ウェイトだけを合わせてポップ量は 0 のまま', () => {
    expect(mergeHeights([layer(0, [100, 200]), layer(0, [50, 100])], 'max')).toMatchObject({ pop: 0, clipped: false });
    expect([...mergeHeights([layer(0, [100, 200]), layer(0, [50, 100])], 'add').weights.data]).toEqual([150, 255]);
  });

  it('ポップ量の差が大きくても、塗ってあった所を 0 に丸めない', () => {
    // 10 × 12 / 1500 は 0.08 なので、丸めると 0 になってしまう
    const r = mergeHeights([layer(10, [12, 0]), layer(1500, [0, 255])], 'max');
    expect(r.pop).toBe(1500);
    expect([...r.weights.data]).toEqual([1, 255]);
  });

  it('元のウェイトマップは書き換えない。大きさが違えば断る', () => {
    const a = layer(100, [10, 20]), b = layer(100, [30, 5]);
    mergeHeights([a, b], 'add');
    expect([...a.weights.data]).toEqual([10, 20]);
    expect(() => mergeHeights([a, layer(100, [1, 2, 3])], 'max')).toThrow();
  });
});

describe('結合のときのお気に入りのポップ量(scaleFavoritePops)', () => {
  const fav = (id: string, layers: [string, number][]) => ({ id, layers: layers.map(([lid, pop]) => ({ id: lid, pop })) }) as unknown as Favorite;

  it('結合先のレイヤーのポップ量だけを同じ比率で伸び縮みさせ、ほかは同じものを使う', () => {
    const a = fav('F1', [['A', 100], ['B', 200]]), b = fav('F2', [['C', 50]]);
    const out = scaleFavoritePops([a, b], 'A', 100, 200);
    expect(out[0].layers.map(l => l.pop)).toEqual([200, 200]);
    expect(out[0].id).toBe('F1');
    expect(out[1]).toBe(b);
    // 元のお気に入りは書き換えない
    expect(a.layers[0].pop).toBe(100);
    // 上限で切る
    expect(scaleFavoritePops([fav('F', [['A', 1000]])], 'A', 100, 200)[0].layers[0].pop).toBe(LIMITS.pop.max);
  });

  it('変えるものが無ければ、渡した配列をそのまま返す', () => {
    const list = [fav('F', [['B', 10]])];
    expect(scaleFavoritePops(list, 'A', 100, 200)).toBe(list);
    expect(scaleFavoritePops(list, 'B', 100, 100)).toBe(list);
  });
});
