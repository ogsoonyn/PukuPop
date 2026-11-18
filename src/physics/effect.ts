/**
 * 膨らんだ瞬間のエフェクトを出す時刻を決める。DOM と Three.js に依存しない。
 *
 * 揺れの計算の結果だけで「膨らんだ瞬間」を探すと、バネの跳ね返りも膨らみとして拾い、出る周期と出ない周期が混ざる。
 * そこで、揺らし方が押し出し始める時刻(motion.ts の motionPushes)を過ぎたら EFFECT_WINDOW 秒だけ受け付け、
 * その間に揺れの結果が条件を満たした最初の1回だけ出す。
 *   burst: 膨らむ速さが一番速い所(受け付けてから速さが増え始め、それが減りに変わった所。前の膨らみの跳ね返りが減っていく所では出さない)
 *   peak: 一番膨らんだ所(受け付けてから速さが増え始めたあと、速さが正から 0 以下に変わった所)
 * 膨らみの量は、手前へのずれをポップ量で割ったものと、塗った範囲の広がり(中心からの距離に対する割合)の和で測る。
 * 出したときのずれと広がりを覚えておき(Burst)、描画はその形のコピーを広げながら薄くする(playback/stageSwing.ts)。
 * 自動揺らしの時刻だけで決まるので、記録の再生・書き出し・Player でも同じ所で出る。
 */
import type { AutoSwing, Layer, Vec3 } from '../model/project';
import { motionPushes } from './motion';

/** 押し出す時刻から、出すのを受け付ける長さ(秒) */
export const EFFECT_WINDOW = 0.4;
/** 1レイヤーで同時に出しておく数の上限(古いものから捨てる) */
export const MAX_BURSTS = 4;

/** 出したエフェクト1つ。t は出した物理の時刻、s と r はそのときのずれ(正規化座標)と広がり */
export interface Burst { t: number; s: Vec3; r: number }

export interface EffectState {
  /** 受け付けを始めた時刻。受け付けていないときは -Infinity */
  win: number;
  /** 今の受け付けの間に、もう出したか */
  fired: boolean;
  /** 今の受け付けの間に、膨らむ速さが増え始めたか(前の膨らみの跳ね返りで出さないため) */
  rose: boolean;
  /** 1刻み前の膨らみの量と、その速さ */
  prevI: number;
  prevV: number;
  bursts: Burst[];
}

export function freshEffect(): EffectState {
  return { win: -Infinity, fired: true, rose: false, prevI: 0, prevV: 0, bursts: [] };
}

export function copyEffect(e: EffectState): EffectState {
  return { ...e, bursts: e.bursts.map(b => ({ t: b.t, s: { ...b.s }, r: b.r })) };
}

/** [u0, u1) の中に位相 p があるか(周期で一周するのも含む) */
function crossed(u0: number, u1: number, p: number): boolean {
  return u0 <= u1 ? u0 <= p && p < u1 : p >= u0 || p < u1;
}

/**
 * 1刻み進めた後に呼ぶ。t0 は刻みの前の時刻、t1 は後の時刻。s, r は進めた後のずれと広がり、pop はポップ量(正規化座標)。
 * 自動揺らしが切れているとき・押し出す時刻の無い揺らし方では新しく出さない(出したものは消えるまで残す)
 */
export function stepEffect(e: EffectState, layer: Layer, auto: AutoSwing, t0: number, t1: number, s: Vec3, r: number, pop: number): void {
  const fx = layer.effect;
  // 消えるまでの時間を過ぎたものを捨てる
  if (e.bursts.length) e.bursts = e.bursts.filter(b => t1 - b.t < fx.duration);
  const I = s.z / Math.max(pop, 0.05) + r, v = (I - e.prevI) / Math.max(t1 - t0, 1e-6);
  if (auto.enabled && auto.strength > 0) {
    const T = Math.max(0.05, auto.period), frac = (t: number) => (((t / T) % 1) + 1) % 1;
    const u0 = frac(t0), u1 = frac(t1);
    for (const p of motionPushes(layer.physics.motion, layer.physics.motionParams)) {
      if (crossed(u0, u1, p)) { e.win = t1; e.fired = false; e.rose = false; }
    }
    if (!e.fired && t1 - e.win < EFFECT_WINDOW) {
      if (v > e.prevV && v > 0) e.rose = true;
      const fire = e.rose && e.prevV > 0 && (fx.timing === 'peak' ? v <= 0 : v < e.prevV);
      if (fire) {
        e.fired = true;
        e.bursts.push({ t: t1, s: { ...s }, r });
        if (e.bursts.length > MAX_BURSTS) e.bursts.shift();
      }
    }
  }
  e.prevI = I; e.prevV = v;
}
