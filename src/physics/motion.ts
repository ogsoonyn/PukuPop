/**
 * 揺らし方(自動揺らしの動きのパターン)。塗った部分を支える土台(アンカー)の位置を時刻の関数で返す。
 * 塗った部分はバネ・ダンパで土台に繋がっていて、土台が急に動いたり止まったりすると遅れて付いてきて弾む。
 *
 * - 単位は「画像の長辺 = 2」の正規化座標。y が上、z が手前。
 * - どのパターンも周期 T で元に戻る(T の整数倍の長さで書き出せばループする)。
 * - 振れ幅は strength(0〜1)に比例する。「ためて膨らむ」「ためて膨らむ2」「一瞬膨らむ」の手前への動きはポップ量にも比例する(pop は正規化座標)。
 * - 揺らし方ごとの固有設定は params(キーは「揺らし方.項目」)。未設定は MOTION_PARAMS の既定値。
 * - 塗った範囲を広げる揺らし方(SPREAD_MOTIONS)は、土台の動き(motionAnchor)に加えて、塗った範囲の広がりの土台を motionSpread で返す。
 * - ピストンだけは土台を動かさず(motionAnchor は 0)、画像全体の位置を pistonOffset で返す。
 *   塗った部分はその加速度を慣性力として受けて、遅れて付いてくる(world.ts)。
 */
import { motionParam, type MotionPattern, type Vec3 } from '../model/project';

const TAU = Math.PI * 2;

/** 中心 c・幅 w の山(0〜1、両端で 0)。phase / c / w は周期に対する割合。 */
function bump(phase: number, c: number, w: number): number {
  const d = phase - c;
  return Math.abs(d) < w / 2 ? 0.5 * (1 + Math.cos((TAU * d) / w)) : 0;
}

/** 放物線の跳躍。start から air の間だけ、高さ h の山を描く。 */
function hop(phase: number, start: number, air: number, h: number): number {
  const v = (phase - start) / air;
  return v > 0 && v < 1 ? 4 * h * v * (1 - v) : 0;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** ためて膨らむの離す瞬間の押し出しにかける時間(周期に対する割合) */
const KICK = 0.08;
/** ためて膨らむの形。time までに -depth へゆっくり縮め、離した瞬間に一度だけ kick の山で押し出す */
function chargeCurve(u: number, depth: number, time: number, kick: number): number {
  return u < time ? -depth * smooth(u / time) : kick * bump(u, time + KICK / 2, KICK);
}

/** ふわっと膨らむの上がる山(周期の頭から time の前半)。上下の動きと横の広がりで同じ形を使い、同時に動かす */
const puffRise = (u: number, time: number) => bump(u, time / 4, time / 2);
/** 一瞬膨らむの山(周期の頭から time の間)。手前への動きと横の広がりで同じ形を使い、同時に動かす */
const pulseBump = (u: number, time: number) => bump(u, time / 2, time);

export function motionAnchor(
  pattern: MotionPattern, t: number, period: number, strength: number,
  out: Vec3 = { x: 0, y: 0, z: 0 }, pop = 0, params?: Record<string, number>,
): Vec3 {
  out.x = out.y = out.z = 0;
  if (strength <= 0 || pattern === 'none') return out;
  const T = Math.max(0.05, period), u = (((t % T) + T) % T) / T, s = strength, th = TAU * u;
  const P = (key: string) => motionParam(params, pattern, key);
  // 係数は、固有設定が既定値のときに以前と同じ動きになるよう合わせてある
  switch (pattern) {
    case 'jiggle': { // 下へ、少しおいて上へ、と軽くつつく
      const a = 0.12 * s * P('amp'), w = P('width');
      out.y = a * (-bump(u, 0.1 + w, w) + P('second') * bump(u, 0.55 + w, w));
      break;
    }
    case 'jump': { // 沈み込み → 跳ぶ → 着地で急に止まる → 静止
      const h = 0.3 * s * P('height'), crouch = 0.12, air = Math.min(P('air'), 0.98 - crouch);
      out.y = (u < crouch ? -P('crouch') * h * Math.sin((Math.PI * u) / crouch) : 0) + hop(u, crouch, air, h);
      break;
    }
    case 'bounce': { // 接地を短くして、小さく跳び続ける
      const ground = P('ground');
      out.y = hop(u, ground / 2, 1 - ground, 0.12 * s * P('height'));
      break;
    }
    case 'shiver': { // 周期の整数倍の周波数を重ねて、不規則に見える細かい震え
      const n = Math.max(1, Math.round(P('freq') * T)), wave = P('wave'), env = 1 - wave + wave * Math.sin(th);
      out.x = 0.08 * s * P('amp') * env * Math.sin(n * th);
      out.y = (0.05 / 0.6) * s * P('amp') * P('vertical') * env * Math.sin((n + 3) * th + 1.3);
      break;
    }
    case 'float': // 8の字にゆっくり漂う
      out.y = 0.08 * s * P('amp') * Math.sin(th);
      out.x = 0.075 * s * P('amp') * P('side') * Math.sin(2 * th);
      break;
    case 'sway':
      out.x = 0.12 * s * P('amp') * Math.sin(th);
      break;
    case 'shake': { // 右へ、左へと短く振る
      const a = 0.1 * s * P('amp'), w = P('width'), b1 = bump(u, 0.25, w), b2 = bump(u, 0.75, w);
      out.x = a * (b1 - b2);
      out.y = a * P('hop') * (b1 + b2);
      break;
    }
    case 'circle': { // 原点から始まる円(中心は少し下)
      const r = 0.08 * s * P('radius');
      out.x = r * Math.sin(th) * (P('dir') < 0 ? -1 : 1);
      out.y = r * (Math.cos(th) - 1);
      break;
    }
    case 'heartbeat': // ドクン、ドクン、と手前にふくらむ
      out.z = 0.22 * s * P('amp') * (bump(u, 0.06, 0.1) + P('second') * bump(u, 0.06 + P('gap'), 0.1));
      break;
    case 'charge': case 'charge2': // ポップ量をゆっくり平らに近づけてから、ぱっと戻し、さらに押し出す
      out.z = pop * chargeCurve(u, Math.min(1, P('depth') * 2 * s), P('time'), P('bulge') * 2 * s);
      break;
    case 'piston': // 土台は動かさない。画像全体を動かす(pistonOffset)
      break;
    case 'stretch': { // ゆっくり引き伸ばして、ぱっと離す
      const time = P('time'), v = u < time ? 0.2 * s * P('amp') * smooth(u / time) : 0;
      const dir = P('dir');
      if (dir === 1) out.y = -v; else if (dir === 2) out.x = -v; else if (dir === 3) out.x = v; else if (dir === 4) out.z = v; else out.y = v;
      break;
    }
    case 'puff': { // 周期の頭で一度だけ、ふわっと上がって少し下がる。あとは止まって余韻だけ
      const time = P('time');
      out.y = 0.1 * s * P('height') * (puffRise(u, time) - P('down') * bump(u, (time * 3) / 4, time / 2));
      break;
    }
    case 'pulse': // 周期の頭で一度だけ、手前に少し膨らんですぐ戻る
      out.z = pop * P('bulge') * 2 * s * pulseBump(u, P('time'));
      break;
  }
  return out;
}

/**
 * ピストンの、画像全体の位置(画像のローカル座標)。下で止まっている所から、上がる → 上で止まる → 下がる → 下で止まる。
 * 鋭さが 100% のときは同じ速さで動いて急に止まり、0% のときは cos でなめらかに動き出して止まる。
 * 周期 T で元に戻り、動き出しと止まりの所で速さが変わる(その加速度で塗った部分が弾む)。
 */
export function pistonOffset(
  t: number, period: number, strength: number, out: Vec3 = { x: 0, y: 0, z: 0 }, params?: Record<string, number>,
): Vec3 {
  out.x = out.y = out.z = 0;
  if (strength <= 0) return out;
  const T = Math.max(0.05, period), u = (((t % T) + T) % T) / T;
  const P = (key: string) => motionParam(params, 'piston', key);
  let up = P('up'), top = P('top'), down = P('down');
  // 上がる・止まる・下がるで周期を使い切らないよう、下で止まる時間を少し残す
  const sum = up + top + down;
  if (sum > 0.95) { const k = 0.95 / sum; up *= k; top *= k; down *= k; }
  const sharp = P('sharp'), ease = (v: number) => sharp * v + (1 - sharp) * 0.5 * (1 - Math.cos(Math.PI * v));
  const y = u < up ? ease(u / up) : u < up + top ? 1 : u < up + top + down ? 1 - ease((u - up - top) / down) : 0;
  out.y = PISTON_STROKE * strength * P('height') * y;
  return out;
}

/** ピストンのストローク(正規化座標)。強さ 100%・ストローク 100% のときの上下の幅 */
const PISTON_STROKE = 0.2;
/** ピストンで画像全体がいちばん上がったときのずれ(正規化座標) */
export function pistonReach(strength: number, params?: Record<string, number>): number {
  return Math.max(0, PISTON_STROKE * strength * motionParam(params, 'piston', 'height'));
}

/** 塗った範囲を広げる揺らし方。ほかの揺らし方では motionSpread はいつも 0 */
export const SPREAD_MOTIONS: ReadonlySet<MotionPattern> = new Set<MotionPattern>(['charge2', 'puff', 'pulse']);

/**
 * 塗った範囲の広がりの土台(中心からの距離に対する割合。0 で元の大きさ、0.1 で 1 割外へ)。周期 T で元に戻る。
 * - ためて膨らむ2: 手前への動きと同じ時刻に、ためている間は内へ縮め、離した瞬間に外へ押し広げる。
 * - ふわっと膨らむ: 上がるのと同時に外へ広げる。
 * - 一瞬膨らむ: 手前に膨らむのと同時に外へ広げる。
 * ほかの揺らし方は 0(広げない)。
 */
export function motionSpread(pattern: MotionPattern, t: number, period: number, strength: number, params?: Record<string, number>): number {
  if (!SPREAD_MOTIONS.has(pattern) || strength <= 0) return 0;
  const T = Math.max(0.05, period), u = (((t % T) + T) % T) / T;
  const P = (key: string) => motionParam(params, pattern, key), a = P('spread') * 2 * strength;
  if (pattern === 'puff') return a * puffRise(u, P('time'));
  if (pattern === 'pulse') return a * pulseBump(u, P('time'));
  return chargeCurve(u, a * P('pinch'), P('time'), a);
}

/**
 * 揺らし方が手前・外へ押し出し始める時刻(周期に対する割合、0 以上 1 未満)。膨らんだ瞬間のエフェクト(physics/effect.ts)を出す目安にする。
 * 押し出す時刻の無い揺らし方(左右に振る・漂うなど)は空。鼓動は2拍なので2つ。
 */
export function motionPushes(pattern: MotionPattern, params?: Record<string, number>): number[] {
  const P = (key: string) => motionParam(params, pattern, key);
  switch (pattern) {
    case 'heartbeat': return [0.01, Math.min(0.99, 0.01 + P('gap'))]; // bump(u, 0.06, 0.1) の立ち上がり
    case 'charge': case 'charge2': return [P('time')]; // ためた所から離す瞬間
    case 'puff': case 'pulse': return [0]; // 周期の頭で一度だけ膨らむ
    default: return [];
  }
}

/** 膨らんだ瞬間のエフェクトを使える揺らし方か */
export const hasPush = (pattern: MotionPattern): boolean => motionPushes(pattern).length > 0;
