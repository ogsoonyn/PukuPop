/**
 * 膨らんだ瞬間のエフェクトを出す時刻を決める。DOM と Three.js に依存しない。
 *
 * 揺らし方を問わず、揺れの結果の「手前への膨らみ」だけで決める(自動揺らしでも、手で揺らしても同じ)。
 * 膨らみの量 I は、手前へのずれ(ふわっと膨らむは上へのずれも)をポップ量で割ったものと、塗った範囲の広がり(中心からの距離に対する割合)の和。
 * I が増え始めてから減り始めるまでを1回の「突き出し」とみなし、1回につき1度だけ決める。
 *   burst(膨らみ始め): I の傾き(I/秒)が、レイヤーの burstMin と「前の突き出しの一番急な傾き」の両方を越えた瞬間に出す。
 *     減衰中の揺れ返しは前の突き出しより弱いので越えず、出ない。
 *   peak(一番膨らんだとき): 一番膨らんだ所で、I が PEAK_MIN と「前に出したときの I」の両方を越えたら出す。
 *   前の強さは FADE 秒ごとに 1/e へ薄れる(しばらく揺れていなければ、弱い突き出しでも出る)。
 * 出したときのずれと広がりを覚えておき(Burst)、描画はその形のコピーを広げながら薄くする(playback/stageSwing.ts)。
 * 揺れの結果だけで決まるので、記録の再生・書き出し・Player でも同じ所で出る。
 */
import type { Layer, MotionPattern, Vec3 } from '../model/project';

/** 一番膨らんだときの下限: I */
export const PEAK_MIN = 0.12;
/** 前の強さが 1/e へ薄れる時間(秒) */
export const FADE = 4;
/** 前の突き出しとして覚える下限(burstMin に対する割合)。ごく小さい揺れで前の強さを上書きしない */
const STROKE_MIN = 0.3;
/** 1レイヤーで同時に出しておく数の上限(古いものから捨てる) */
export const MAX_BURSTS = 3;

/** 出したエフェクト1つ。t は出した物理の時刻、s と r はそのときのずれ(正規化座標)と広がり */
export interface Burst { t: number; s: Vec3; r: number }

export interface EffectState {
  /** 1刻み前の膨らみの量と、その傾き。prevI が NaN なら次の刻みで測り始める */
  prevI: number;
  prevV: number;
  /** 今の突き出しの一番急な傾きと、今の突き出しでもう決めたか */
  vmax: number;
  done: boolean;
  /** 前の突き出しの一番急な傾きと、それを覚えた時刻(次の突き出しが始まった時刻) */
  lastV: number;
  lastVT: number;
  /** 一番膨らんだときで、前に出したときの量と時刻 */
  lastPeak: number;
  lastPeakT: number;
  bursts: Burst[];
}

export function freshEffect(): EffectState {
  return { prevI: NaN, prevV: 0, vmax: 0, done: true, lastV: 0, lastVT: -Infinity, lastPeak: 0, lastPeakT: -Infinity, bursts: [] };
}

export function copyEffect(e: EffectState): EffectState {
  return { ...e, bursts: e.bursts.map(b => ({ t: b.t, s: { ...b.s }, r: b.r })) };
}

/** 膨らみの量。手前(ふわっと膨らむは上も)へのずれをポップ量で割ったものと、広がりの和 */
const inflation = (motion: MotionPattern, s: Vec3, r: number, pop: number) => (s.z + (motion === 'puff' ? s.y : 0)) / Math.max(pop, 0.05) + r;

/**
 * 1刻み進めた後に呼ぶ。t0 は刻みの前の時刻、t1 は後の時刻。s, r は進めた後のずれと広がり、pop はポップ量(正規化座標)。
 * 出したものは消えるまでの時間を過ぎたら捨てる
 */
export function stepEffect(e: EffectState, layer: Layer, t0: number, t1: number, s: Vec3, r: number, pop: number): void {
  const fx = layer.effect;
  if (e.bursts.length) e.bursts = e.bursts.filter(b => t1 - b.t < fx.duration);
  const I = inflation(layer.physics.motion, s, r, pop);
  const v = Number.isNaN(e.prevI) ? 0 : (I - e.prevI) / Math.max(t1 - t0, 1e-6);
  const fade = (x: number, t: number) => x * Math.exp(-(t1 - t) / FADE);
  const shoot = () => {
    e.bursts.push({ t: t1, s: { ...s }, r });
    if (e.bursts.length > MAX_BURSTS) e.bursts.shift();
  };
  if (!Number.isNaN(e.prevI)) {
    // 減っていた(か止まっていた)のが増え始めたら、新しい突き出し。前の突き出しの一番急な傾きを覚えておく
    if (e.prevV <= 0 && v > 0) {
      if (e.vmax >= fx.burstMin * STROKE_MIN) { e.lastV = e.vmax; e.lastVT = t1; }
      e.vmax = 0; e.done = false;
    }
    e.vmax = Math.max(e.vmax, v);
    if (!e.done) {
      if (fx.timing === 'peak') {
        if (e.prevV > 0 && v <= 0) {
          e.done = true;
          if (e.prevI >= Math.max(PEAK_MIN, fade(e.lastPeak, e.lastPeakT))) { shoot(); e.lastPeak = e.prevI; e.lastPeakT = t1; }
        }
      } else if (v >= Math.max(fx.burstMin, fade(e.lastV, e.lastVT))) { e.done = true; shoot(); }
      else if (e.prevV > 0 && v <= 0) e.done = true;
    }
  }
  e.prevI = I; e.prevV = v;
}
