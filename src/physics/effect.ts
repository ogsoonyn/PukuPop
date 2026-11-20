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
import { effectLab, labTrace, LAB_KEEP } from './effectLab';

/** 押し出す時刻から受け付ける長さの下限(秒)。周期の半分の方が長ければそちら */
export const EFFECT_WINDOW = 0.4;
/** 1レイヤーで同時に出しておく数の上限(古いものから捨てる) */
export const MAX_BURSTS = 3;
/** 受け付けを始めたときに土台の膨らみを調べる数 */
const LOOK = 24;
/** 土台がこの割合まで膨らんだら構える */
const ARM = 0.25;

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
  /** 手前への揺れ具合で決めるとき(effectLab の forward): 今の突き出しの谷の膨らみ・一番速かった速さ・もう出したか、前に出した強さと時刻 */
  valley: number;
  vmax: number;
  done: boolean;
  lastS: number;
  lastT: number;
  /** 一番膨らんだときで前に出した量と時刻 */
  peakS: number;
  peakT: number;
}

export function freshEffect(): EffectState {
  return { win: -Infinity, fired: true, armAt: null, prevI: NaN, prevV: 0, bursts: [], valley: 0, vmax: 0, done: true, lastS: 0, lastT: -Infinity, peakS: 0, peakT: -Infinity };
}

export function copyEffect(e: EffectState): EffectState {
  return { ...e, bursts: e.bursts.map(b => ({ t: b.t, s: { ...b.s }, r: b.r })) };
}

/** [u0, u1) の中に位相 p があるか(周期で一周するのも含む) */
function crossed(u0: number, u1: number, p: number): boolean {
  return u0 <= u1 ? u0 <= p && p < u1 : p >= u0 || p < u1;
}

/** 膨らみの量。手前(ふわっと膨らむは上も)へのずれをポップ量で割ったものと、広がりの和 */
const inflation = (motion: MotionPattern, s: Vec3, r: number, pop: number) => (s.z + (motion === 'puff' ? s.y : 0)) / Math.max(pop, 0.05) + r;

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
  if (effectLab.mode === 'forward') { stepForward(e, layer, t1, s, r, I, v); return; }
  if (auto.enabled && auto.strength > 0) {
    const T = Math.max(0.05, auto.period), frac = (t: number) => (((t / T) % 1) + 1) % 1, len = effectWindow(T);
    const u0 = frac(t0), u1 = frac(t1);
    for (const p of motionPushes(motion, layer.physics.motionParams)) {
      if (!crossed(u0, u1, p)) continue;
      // 受け付けを始める。この後の土台の膨らみの伸びを調べ、構える高さを決める
      const a0 = anchorInflation(layer, auto, t1, pop);
      let top = a0;
      for (let k = 1; k <= LOOK; k++) top = Math.max(top, anchorInflation(layer, auto, t1 + (len * k) / LOOK, pop));
      e.win = t1; e.fired = top - a0 <= 1e-6; e.armAt = a0 + (top - a0) * ARM;
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

/**
 * 手前への揺れ具合で決める(effectLab の forward)。自動揺らしでも手で揺らしても、揺らし方を問わず同じ。
 * burst(膨らみ始め): 突き出しの傾き(膨らむ速さ)が、下限と「前の突き出しの一番の傾き × 割合」の両方を越えた瞬間に出す。
 *   前の突き出しより弱い(減衰中の揺れ返し)ときは越えないので出ない。前の突き出しの傾きは時間で薄れる。
 * peak(一番膨らんだとき): 一番膨らんだ所で、量が下限と「前に出したときの量 × 割合」の両方を越えたら出す
 */
function stepForward(e: EffectState, layer: Layer, t1: number, s: Vec3, r: number, I: number, v: number): void {
  const L = effectLab, peak = layer.effect.timing === 'peak', fade = (x: number, t: number) => x * Math.exp(-(t1 - t) / Math.max(L.decay, 0.01));
  let fire = false, mS: number | undefined, mRef: number | undefined;
  const shoot = () => {
    fire = true;
    e.bursts.push({ t: t1, s: { ...s }, r });
    if (e.bursts.length > MAX_BURSTS) e.bursts.shift();
  };
  if (!Number.isNaN(e.prevI)) {
    // 減っていた(か止まっていた)のが増え始めたら、新しい突き出し。前の突き出しの一番の傾きを覚える(ごく小さい揺れは数えない)
    if (e.prevV <= 0 && v > 0) {
      if (e.vmax >= L.vmin * 0.3) { e.lastS = e.vmax; e.lastT = t1; }
      e.valley = e.prevI; e.vmax = 0; e.done = false;
    }
    e.vmax = Math.max(e.vmax, v);
    if (!e.done) {
      if (peak) {
        if (e.prevV > 0 && v <= 0) {
          e.done = true;
          const S = e.prevI, ref = Math.max(L.amin, L.rebound * fade(e.peakS, e.peakT));
          mS = S; mRef = ref;
          if (S >= ref) { shoot(); e.peakS = S; e.peakT = t1; }
        }
      } else {
        const ref = Math.max(L.vmin, L.rebound * fade(e.lastS, e.lastT));
        if (v >= ref) { e.done = true; mS = v; mRef = ref; shoot(); }
        else if (e.prevV > 0 && v <= 0) { e.done = true; mS = e.vmax; mRef = ref; }
      }
    }
  }
  if (L.trace) {
    let tr = labTrace.get(layer.id);
    if (!tr) labTrace.set(layer.id, (tr = []));
    tr.push({ t: t1, I, v, fire, ...(mS !== undefined ? { S: mS, ref: mRef } : {}) });
    while (tr.length && t1 - tr[0].t > LAB_KEEP) tr.shift();
  }
  e.prevI = I; e.prevV = v;
}
