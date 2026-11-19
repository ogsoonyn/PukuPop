/**
 * ポップ量(と膨らませる高さ)のスライダーの目盛り。右端は設定の「ポップ量の最大値」(max、100〜1500px)。
 * - max が 1000px 以下なら、1 目盛り 1px(目盛りは 0〜max)。
 * - それより大きいときは 0〜1000 の目盛りに割り当て、よく使う 0〜500px は前半に 1 目盛り 1px で置き、
 *   残りの 500px〜max は後半に詰める(1 目盛り 1px 以上動くので、矢印キーで動かしても止まらない)。
 * 数値の欄は max を超えて打てる(LIMITS.pop.max まで)。ポップ量のスライダーは、超えたレイヤーでは右端をその値まで広げる(panels.ts の popSliderMax)。
 * ここの関数に渡した max を超える値は、スライダーの右端に止まる。
 */
import { LIMITS } from '../model/project';

/** 設定の「ポップ量の最大値」の範囲と既定値 */
export const POP_MAX_SETTING = { min: 100, max: LIMITS.pop.max, step: 50, def: 500 } as const;
const KNEE = 500;
const FINE_MAX = 1000;

export const clampPopMax = (v: number): number =>
  Number.isFinite(v) ? Math.max(POP_MAX_SETTING.min, Math.min(POP_MAX_SETTING.max, Math.round(v))) : POP_MAX_SETTING.def;

/** スライダーの目盛りの数(input の max に入れる) */
export const popSliderRange = (max: number): number => Math.min(clampPopMax(max), FINE_MAX);

const upperStep = (max: number) => (max - KNEE) / (FINE_MAX - KNEE);

export function sliderToPop(s: number, max: number): number {
  const m = clampPopMax(max), v = Math.max(0, Math.min(popSliderRange(m), s));
  if (m <= FINE_MAX) return Math.round(v);
  return Math.round(v <= KNEE ? v : KNEE + (v - KNEE) * upperStep(m));
}

export function popToSlider(pop: number, max: number): number {
  const m = clampPopMax(max), v = Math.max(LIMITS.pop.min, Math.min(m, pop));
  if (m <= FINE_MAX) return Math.round(v);
  return Math.round(v <= KNEE ? v : KNEE + (v - KNEE) / upperStep(m));
}
