/**
 * レイヤーの結合。複数のレイヤーの高さ(ウェイト × ポップ量)を1枚にまとめる。DOM と three.js を参照しない。
 * 揺れ・重ね方・名前などの設定は呼び出し側で決める(App.mergeLayers は一番下のレイヤーのものを残す)。
 */
import { LIMITS, type Favorite, type Layer } from './project';
import { WeightMap } from './weightmap';

/**
 * 結合の重ね方。max: 高い方を残す(膨らみを別々のレイヤーで作ったものをまとめる)。add: 高さを足し合わせる。
 * レイヤーの重ね方(BlendMode)とは別で、結合のときだけ使う
 */
export type MergeMode = 'max' | 'add';

export const MERGE_MODES: Record<MergeMode, { label: string; desc: string }> = {
  max: { label: '高い方', desc: '重なった所は、高い方のレイヤーの高さを残します' },
  add: { label: '加算', desc: '重なった所は、高さを足し合わせます' },
};

/** 非表示のレイヤーを含むときに断る理由(非表示のレイヤーは高さに入っていないので、入れても捨てても見た目が変わる) */
export const MERGE_HIDDEN_NOTE = '非表示のレイヤーは結合できません。表示してから結合してください。';

export interface MergeResult {
  /** 結合したレイヤーのポップ量 */
  pop: number;
  weights: WeightMap;
  /** 加算で、ポップ量の上限を超えた所を上限で切ったか */
  clipped: boolean;
}

/**
 * 高さを合わせる。高さは「ウェイト / 255 × ポップ量」。
 * ポップ量は、高い方なら結合するレイヤーの一番大きい値にする(どのレイヤーのポップ量も同じなら、ウェイトはそのまま)。
 * 加算なら、それと足した高さの一番高い所の大きい方にする(上限 LIMITS.pop.max。超えた所は上限で切る)。
 * どのレイヤーもポップ量が 0 のときは、ウェイトだけを合わせる(高さは 0 のまま)。ほかにポップ量のあるレイヤーがあれば、
 * ポップ量が 0 のレイヤーの塗りは高さ 0 なので残らない。
 * ポップ量の違うレイヤーを合わせると低い方のウェイトは縮むが、塗ってあった所を 0 に丸めない(ぼかした縁が消えないように)。
 * ウェイトマップの大きさはどれも同じ(同じ画像のレイヤー)とする
 */
export function mergeHeights(layers: readonly Pick<Layer, 'pop' | 'weights'>[], mode: MergeMode): MergeResult {
  if (!layers.length) throw new Error('結合するレイヤーがありません');
  const { width: w, height: h } = layers[0].weights;
  if (layers.some(l => l.weights.width !== w || l.weights.height !== h)) throw new Error('ウェイトマップの大きさが違います');
  const n = w * h;
  const topPop = Math.max(...layers.map(l => l.pop));
  // ポップ量がどれも 0 なら、ウェイトをそのまま合わせる(どのレイヤーも 1 として扱う)
  const scales = layers.map(l => (topPop > 0 ? l.pop : 1));
  // 高さ(ポップ量 × ウェイト。ウェイトの 255 で割る前の値)
  const height = new Float64Array(n);
  for (let k = 0; k < layers.length; k++) {
    const d = layers[k].weights.data, s = scales[k];
    if (!s) continue;
    if (mode === 'max') { for (let i = 0; i < n; i++) { const v = d[i] * s; if (v > height[i]) height[i] = v; } }
    else for (let i = 0; i < n; i++) height[i] += d[i] * s;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) if (height[i] > peak) peak = height[i];
  const base = topPop > 0 ? topPop : 1;
  // 加算で一番大きいポップ量より高くなったら、ポップ量を上げて収める
  let pop = base;
  if (mode === 'add' && topPop > 0) pop = Math.min(LIMITS.pop.max, Math.max(topPop, Math.ceil(peak / 255)));
  const clipped = topPop > 0 && peak / 255 > pop;
  const out = new WeightMap(w, h);
  const k = 1 / pop;
  for (let i = 0; i < n; i++) if (height[i] > 0) out.data[i] = Math.max(1, Math.min(255, Math.round(height[i] * k)));
  return { pop: topPop > 0 ? pop : 0, weights: out, clipped };
}

/**
 * 結合でレイヤーのポップ量を from から to に変えたとき、お気に入りの中のそのレイヤーのポップ量を同じ比率で伸び縮みさせる。
 * 結合でウェイトは新しいポップ量に合わせて縮むので、そのままのお気に入りを当てると高さが崩れるため。
 * 変えるものが無ければ、渡した配列をそのまま返す
 */
export function scaleFavoritePops(list: readonly Favorite[], layerId: string, from: number, to: number): readonly Favorite[] {
  if (from === to) return list;
  const scale = (p: number) => (from > 0 ? Math.min(LIMITS.pop.max, Math.round(p * to / from)) : to);
  let changed = false;
  const out = list.map(f => {
    if (!f.layers.some(l => l.id === layerId)) return f;
    changed = true;
    // お気に入りは書き換えないので、作り直す
    return { ...f, layers: f.layers.map(l => (l.id === layerId ? { ...l, pop: scale(l.pop) } : l)) };
  });
  return changed ? out : list;
}
