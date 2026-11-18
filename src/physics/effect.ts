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
import { motionAnchor, motionPushes, motionSpread, motionTurns } from './motion';

/** 押し出す時刻から受け付ける長さの下限(秒)。周期の半分の方が長ければそちら */
export const EFFECT_WINDOW = 0.4;
/** 1レイヤーで同時に出しておく数の上限(古いものから捨てる) */
export const MAX_BURSTS = 3;
/** 受け付けを始めたときに土台の膨らみを調べる数 */
const LOOK = 24;
/** 土台がこの割合まで膨らんだら構える */
const ARM = 0.25;

/** 出したエフェクト1つ。t は出した物理の時刻、s と r はそのときのずれ(正規化座標)と広がり。d は広がりながら流れる向き(切り返しのとき) */
export interface Burst { t: number; s: Vec3; r: number; d?: Vec3 }
/** 残像のための、少し前の形(実験) */
export interface TrailSample { t: number; s: Vec3; r: number }
/** 残像のために覚えておく長さ(秒) */
export const TRAIL_KEEP = 0.6;
/** 切り返しとみなす速さの下限(正規化座標/秒)。これより遅い向きの変わり目では出さない */
const TURN_SPEED = 0.2;
/** 上下左右のエフェクト(切り返し・着地)を続けて出さない間(秒) */
const TURN_GAP = 0.5;

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
  /** 切り返しで受け付けている向き(実験)。0 なら膨らみで受け付けている */
  dir: number;
  /** 残像のための少し前の形(実験、出し方が残像のときだけ) */
  hist: TrailSample[];
  /** 手で揺らしたとき(実験): 最後に手で動かした時刻と、前の切り返しから一番速かった xy の速さ */
  handT: number;
  hpk: { x: number; y: number };
  /** 覚えている揺れ(切り返しの時刻と、その揺れの速さ) */
  swings: { t: number; v: number }[];
  prevHx: number;
  prevHy: number;
}

export function freshEffect(): EffectState {
  return { win: -Infinity, fired: true, armAt: null, prevI: NaN, prevV: 0, bursts: [], dir: 0, hist: [], handT: -Infinity, hpk: { x: 0, y: 0 }, swings: [], prevHx: NaN, prevHy: NaN };
}

export function copyEffect(e: EffectState): EffectState {
  return {
    ...e,
    bursts: e.bursts.map(b => ({ t: b.t, s: { ...b.s }, r: b.r, ...(b.d ? { d: { ...b.d } } : {}) })),
    hist: e.hist.map(h => ({ t: h.t, s: { ...h.s }, r: h.r })),
    hpk: { ...e.hpk }, swings: e.swings.map(w => ({ ...w })),
  };
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
export function stepEffect(e: EffectState, layer: Layer, auto: AutoSwing, t0: number, t1: number, s: Vec3, r: number, pop: number, hand = false): void {
  const fx = layer.effect, motion = layer.physics.motion;
  // 消えるまでの時間を過ぎたものを捨てる
  if (e.bursts.length) e.bursts = e.bursts.filter(b => t1 - b.t < fx.duration);
  if (fx.style !== 'trail') stepHand(e, motion, auto, t0, t1, s, r, hand);
  if (fx.style === 'trail') {
    // 残像: 少し前の形を覚えておくだけ(描き方は playback/stageSwing.ts)
    e.hist.push({ t: t1, s: { ...s }, r });
    while (e.hist.length && t1 - e.hist[0].t > TRAIL_KEEP) e.hist.shift();
    e.prevI = NaN;
    return;
  }
  if (e.hist.length) e.hist = [];
  const turns = motionTurns(motion, layer.physics.motionParams);
  if (turns.length) { stepTurn(e, turns, auto, t0, t1, s, r); return; }
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
 * 切り返し・着地(実験)。土台が端まで行った・着地した時刻(motionTurns)から受け付け、塗った部分の速さの向きが
 * 受け付けた向きから逆に変わった最初の1回だけ出す。左右の切り返しは、それまで動いていた向きへ少し流しながら広げる
 */
function stepTurn(e: EffectState, turns: readonly { u: number; axis: 'x' | 'y'; dir: 1 | -1 }[], auto: AutoSwing, t0: number, t1: number, s: Vec3, r: number): void {
  const axis = turns[0].axis, I = s[axis];
  const v = Number.isNaN(e.prevI) ? 0 : (I - e.prevI) / Math.max(t1 - t0, 1e-6);
  if (auto.enabled && auto.strength > 0) {
    const T = Math.max(0.05, auto.period), frac = (t: number) => (((t / T) % 1) + 1) % 1, len = effectWindow(T);
    const u0 = frac(t0), u1 = frac(t1);
    for (const p of turns) if (crossed(u0, u1, p.u)) { e.win = t1; e.fired = false; e.dir = p.dir; e.armAt = 0; }
    // armAt に、受け付けてから受け付けた向きに一番速かった速さを持つ(ゆっくりした向きの変わり目では出さない)
    if (!e.fired && e.armAt !== null) e.armAt = Math.max(e.armAt, v * e.dir);
    if (!e.fired && t1 - e.win < len && (e.armAt ?? 0) > TURN_SPEED && e.prevV * e.dir > 0 && v * e.dir <= 0 && t1 - (e.bursts.at(-1)?.t ?? -Infinity) > TURN_GAP) {
      e.fired = true;
      e.bursts.push({ t: t1, s: { ...s }, r, d: axis === 'x' ? { x: e.dir, y: 0, z: 0 } : { x: 0, y: e.dir, z: 0 } });
      if (e.bursts.length > MAX_BURSTS) e.bursts.shift();
    }
  }
  e.prevI = I; e.prevV = v;
}

/** 手で揺らしたあと、これだけの間(秒)は揺れの勢いで出す */
const HAND_KEEP = 1.5;
/** 揺れの大きさを覚えておく長さ(秒)。この間で一番大きい揺れの切り返しだけで出す */
const HAND_HISTORY = 2.5;
/** 手で揺らしたときに出す速さの下限(正規化座標/秒)。膨らむ揺らし方(前に突き出る)は弱い揺れでも出す */
const HAND_SPEED = 0.8;
const HAND_PUSH_SPEED = 0.15;
/** 切り返しとして数える速さの下限(これより小さい向きの変わり目は揺れとして覚えない) */
const HAND_NOISE = 0.03;

/**
 * 手で揺らしたとき(つかむ・視点を動かす。実験)。自動揺らしの時刻が無いので、揺れの結果だけで決める:
 * 切り返し(一番速かった向きと逆へ動き出した所)ごとに、その揺れの速さを HAND_HISTORY 秒覚えておき、
 * 速さが下限を越え、覚えている揺れのどれよりも大きいときだけ出す(1回動かしたあとの、だんだん小さくなる揺れ返しでは出さない)。
 * 手で動かしている間は出さず、手を止めた・離したあとの揺れで出す。自動揺らしが入っている間は、手で動かしてから HAND_KEEP 秒の間だけ
 */
function stepHand(e: EffectState, motion: MotionPattern, auto: AutoSwing, t0: number, t1: number, s: Vec3, r: number, hand: boolean): void {
  if (hand) e.handT = t1;
  const dt = Math.max(t1 - t0, 1e-6);
  const v = { x: Number.isNaN(e.prevHx) ? 0 : (s.x - e.prevHx) / dt, y: Number.isNaN(e.prevHy) ? 0 : (s.y - e.prevHy) / dt };
  e.prevHx = s.x; e.prevHy = s.y;
  if (e.swings.length) e.swings = e.swings.filter(w => t1 - w.t < HAND_HISTORY);
  const autoOn = auto.enabled && auto.strength > 0;
  if (autoOn && t1 - e.handT > HAND_KEEP) { e.hpk = { x: 0, y: 0 }; e.swings = []; return; }
  // 手で動かしている間は出さない(手を止めた・離したあとの揺れで出す)
  if (hand) { e.hpk = { x: 0, y: 0 }; return; }
  if (Math.hypot(v.x, v.y) > Math.hypot(e.hpk.x, e.hpk.y)) e.hpk = { ...v };
  const pk = Math.hypot(e.hpk.x, e.hpk.y);
  if (pk <= HAND_NOISE || v.x * e.hpk.x + v.y * e.hpk.y > 0) return;
  // 切り返し。覚えている揺れより大きいときだけ出す
  const push = PUSH_MOTIONS(motion), min = push ? HAND_PUSH_SPEED : HAND_SPEED;
  const biggest = e.swings.reduce((m, w) => Math.max(m, w.v), 0);
  if (pk > min && pk > biggest) {
    const side = Math.abs(e.hpk.x) >= Math.abs(e.hpk.y);
    // 膨らむ揺らし方は今までと同じく手前へ広げ、そのほかは揺れた向きの側だけを広げる
    const d = push ? undefined : side ? { x: Math.sign(e.hpk.x), y: 0, z: 0 } : { x: 0, y: Math.sign(e.hpk.y), z: 0 };
    e.bursts.push({ t: t1, s: { ...s }, r, d });
    if (e.bursts.length > MAX_BURSTS) e.bursts.shift();
  }
  e.swings.push({ t: t1, v: pk });
  e.hpk = { x: 0, y: 0 };
}
const PUSH_MOTIONS = (m: MotionPattern) => motionPushes(m).length > 0;
