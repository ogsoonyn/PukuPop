/**
 * 膨らんだ瞬間のエフェクトを出す時刻を決める。DOM と Three.js に依存しない。
 *
 * 揺れの計算の結果だけで「膨らんだ瞬間」を探すと、バネの跳ね返りも膨らみとして拾い、出る周期と出ない周期が混ざる。
 * そこで、揺らし方が押し出し始める時刻(motion.ts の motionPushes)から受け付けを始め、次のように決める。
 *   1. 受け付けを始めたとき、その後の土台(揺らし方の動きそのもの。バネを通す前)の膨らみを先に調べ、
 *      土台がその伸びの 1/4 まで膨らんだら構える(それより前の、前の膨らみの跳ね返りや残りの揺れでは出さない)。
 *   2. 構えたあと、揺れの結果が条件を満たした最初の1回だけ出す。
 *        burst: 膨らむ速さが一番速い所(速さが増えから減りに変わった所)
 *        peak: 一番膨らんだ所(速さが正から 0 以下に変わった所)
 * 受け付けるのは、EFFECT_WINDOW 秒と周期の半分の長い方まで。次の押し出し時刻が来たら、そこから受け付け直す
 * (鼓動の拍の間隔が短く、2拍の膨らみが1つにつながるときは1回になる)。
 * 膨らみの量は、手前へのずれ(ふわっと膨らむは上へのずれも)をポップ量で割ったものと、塗った範囲の広がり(中心からの距離に対する割合)の和で測る。
 * 出したときのずれと広がりを覚えておき(Burst)、描画はその形のコピーを広げながら薄くする(playback/stageSwing.ts)。
 * 自動揺らしの時刻だけで決まるので、記録の再生・書き出し・Player でも同じ所で出る。
 */
import type { AutoSwing, Layer, MotionPattern, Vec3 } from '../model/project';
import { motionAnchor, motionPushes, motionSpread } from './motion';

/** 押し出す時刻から受け付ける長さの下限(秒)。周期の半分の方が長ければそちら */
export const EFFECT_WINDOW = 0.4;
/** 1レイヤーで同時に出しておく数の上限(古いものから捨てる) */
export const MAX_BURSTS = 3;
/** 受け付けを始めたときに土台の膨らみを調べる数(揺らし方図鑑もグラフに使う) */
export const EFFECT_LOOK = 24;
/** 土台がこの割合まで膨らんだら構える(揺らし方図鑑もグラフに使う) */
export const EFFECT_ARM = 0.25;

/** 出したエフェクト1つ。t は出した物理の時刻、s と r はそのときのずれ(正規化座標)と広がり */
export interface Burst { t: number; s: Vec3; r: number }

export interface EffectState {
  /** 受け付けを始めた時刻。受け付けていないときは -Infinity */
  win: number;
  /** 今の受け付けの間に、もう出したか */
  fired: boolean;
  /** 土台の膨らみがこの値に届いたら構える。届いたら null */
  armAt: number | null;
  /** 1刻み前の膨らみの量と、その速さ。prevI が NaN なら次の刻みで測り始める */
  prevI: number;
  prevV: number;
  bursts: Burst[];
}

export function freshEffect(): EffectState {
  return { win: -Infinity, fired: true, armAt: null, prevI: NaN, prevV: 0, bursts: [] };
}

export function copyEffect(e: EffectState): EffectState {
  return { ...e, bursts: e.bursts.map(b => ({ t: b.t, s: { ...b.s }, r: b.r })) };
}

/** [u0, u1) の中に位相 p があるか(周期で一周するのも含む) */
export function crossed(u0: number, u1: number, p: number): boolean {
  return u0 <= u1 ? u0 <= p && p < u1 : p >= u0 || p < u1;
}

/** 膨らみの量。手前(ふわっと膨らむは上も)へのずれをポップ量で割ったものと、広がりの和 */
export const inflation = (motion: MotionPattern, s: Vec3, r: number, pop: number) => (s.z + (motion === 'puff' ? s.y : 0)) / Math.max(pop, 0.05) + r;

const tmp: Vec3 = { x: 0, y: 0, z: 0 };
/** 時刻 t の土台の膨らみの量 */
function anchorInflation(layer: Layer, auto: AutoSwing, t: number, pop: number): number {
  const { motion, motionParams: mp } = layer.physics;
  motionAnchor(motion, t, auto.period, auto.strength, tmp, pop, mp);
  return inflation(motion, tmp, motionSpread(motion, t, auto.period, auto.strength, mp), pop);
}

/** 受け付ける長さ(秒) */
export const effectWindow = (period: number): number => Math.max(EFFECT_WINDOW, period / 2);

/**
 * 1刻み進めた後に呼ぶ。t0 は刻みの前の時刻、t1 は後の時刻。s, r は進めた後のずれと広がり、pop はポップ量(正規化座標)。
 * 自動揺らしが切れているとき・押し出す時刻の無い揺らし方では新しく出さない(出したものは消えるまで残す)
 */
export function stepEffect(e: EffectState, layer: Layer, auto: AutoSwing, t0: number, t1: number, s: Vec3, r: number, pop: number): void {
  const fx = layer.effect, motion = layer.physics.motion;
  // 消えるまでの時間を過ぎたものを捨てる
  if (e.bursts.length) e.bursts = e.bursts.filter(b => t1 - b.t < fx.duration);
  const I = inflation(motion, s, r, pop);
  const v = Number.isNaN(e.prevI) ? 0 : (I - e.prevI) / Math.max(t1 - t0, 1e-6);
  if (auto.enabled && auto.strength > 0) {
    const T = Math.max(0.05, auto.period), frac = (t: number) => (((t / T) % 1) + 1) % 1, len = effectWindow(T);
    const u0 = frac(t0), u1 = frac(t1);
    for (const p of motionPushes(motion, layer.physics.motionParams)) {
      if (!crossed(u0, u1, p)) continue;
      // 受け付けを始める。この後の土台の膨らみの伸びを調べ、構える高さを決める
      const a0 = anchorInflation(layer, auto, t1, pop);
      let top = a0;
      for (let k = 1; k <= EFFECT_LOOK; k++) top = Math.max(top, anchorInflation(layer, auto, t1 + (len * k) / EFFECT_LOOK, pop));
      e.win = t1; e.fired = top - a0 <= 1e-6; e.armAt = a0 + (top - a0) * EFFECT_ARM;
    }
    if (!e.fired && t1 - e.win < len) {
      if (e.armAt !== null && anchorInflation(layer, auto, t1, pop) >= e.armAt) e.armAt = null;
      const fire = e.armAt === null && e.prevV > 0 && (fx.timing === 'peak' ? v <= 0 : v < e.prevV);
      if (fire) {
        e.fired = true;
        e.bursts.push({ t: t1, s: { ...s }, r });
        if (e.bursts.length > MAX_BURSTS) e.bursts.shift();
      }
    }
  }
  e.prevI = I; e.prevV = v;
}
