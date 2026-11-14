/**
 * 操作の記録(テイク)。「記録」を押してから止めるまでの、つかむ・揺らす・移動・視点の操作を物理の刻みごとに覚え、
 * 画面上でループ再生したり、書き出したり、.pukupop に保存したりする。
 *
 * - 1件は物理の1刻み(1/120 秒)。中身は書き出しの「直前の操作を再生」と同じ RecordSample(物理の控えは持たない)。
 * - 止めたときに finalizeTake で整える: 初めの何もしていない所を詰め、終わりの何もしていない所は揺れがおさまる分だけ残し、
 *   長さを書き出しのコマにそろえ、終わりを初めの位置へなめらかに寄せて、ループの継ぎ目で視点が飛ばないようにする。
 * - DOM に依存しない。
 */
import { LIMITS, wrapAngle, type CameraState, type Vec3 } from '../model/project';
import { PHYSICS_DT } from './world';
import type { RecordSample } from './recorder';

export interface Take {
  readonly samples: readonly RecordSample[];
  /** キーフレームから作った記録なら、そのキーフレーム(作り直すときの初期値) */
  readonly keys?: readonly KeyFrame[];
}

/** 視点(回転・傾き・ズーム・注視点)。注視点を動かすと画像が画面上を動き、その勢いで揺れる */
export interface ViewKey { yaw: number; pitch: number; roll: number; zoom: number; target: Vec3 }
/** なめらか: そのフレームで止まらず、曲線で通り抜ける / 弾む: 同じ速さのまま来て、そのフレームで急に止まる(その勢いで揺れる) */
export type KeyMode = 'smooth' | 'bounce';
/** キーフレーム。seconds は次のフレームまでの時間(最後のフレームは最初のフレームへ戻るまで) */
export interface KeyFrame { view: ViewKey; seconds: number; mode: KeyMode }
/** 次のフレームまでの時間(秒)の範囲 */
export const KEY_SECONDS = { min: 0.1, max: 5, def: 1 };
/** キーフレームの数の上限(すべて最長の時間でも、1周が記録の最長 60 秒に収まる数) */
export const MAX_KEYS = 12;

/** 記録できる最長の長さ(秒) */
export const TAKE_MAX_SECONDS = 60;
/** これより短い記録は捨てる(秒) */
export const TAKE_MIN_SECONDS = 0.5;
/** 終わりの何もしていない所を残す長さ(秒)。揺れがおさまるまでの分 */
const TAIL_IDLE_SECONDS = 1;
/** 終わりを初めの位置へ寄せる時間(秒、全体の 1/3 まで) */
const BLEND_SECONDS = 0.5;
/** 長さをこの刻み数の倍数にそろえる(30fps・60fps の書き出しでちょうどのコマ数になるように) */
export const TAKE_STEP_MULTIPLE = 4;

export const takeSeconds = (t: Take | null | undefined): number => (t ? t.samples.length * PHYSICS_DT : 0);

const sameVec = (a: Vec3 | null | undefined, b: Vec3 | null | undefined) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z);
const sameCam = (a: CameraState, b: CameraState) =>
  a.yaw === b.yaw && a.pitch === b.pitch && a.roll === b.roll && a.zoom === b.zoom && sameVec(a.target, b.target);
/** a から b へ何も変わっていない(つかんでおらず、視点も注視点も同じ) */
function idle(a: RecordSample, b: RecordSample): boolean {
  return !a.grab && !b.grab && !b.viewCut && sameCam(a.camera, b.camera) && sameVec(a.viewTarget ?? a.camera.target, b.viewTarget ?? b.camera.target);
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpVec = (a: Vec3, b: Vec3, t: number): Vec3 => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) });

/** 記録したままの並びを、ループ再生できる形に整える。短すぎれば null */
export function finalizeTake(raw: readonly RecordSample[]): Take | null {
  let start = 0, end = raw.length;
  // 初めの何もしていない所を詰める(最後の1件は残す)
  while (start + 1 < end && idle(raw[start], raw[start + 1])) start++;
  // 終わりの何もしていない所は、揺れがおさまる分だけ残す
  let last = end - 1;
  while (last > start && idle(raw[last - 1], raw[last])) last--;
  end = Math.min(end, last + 1 + Math.round(TAIL_IDLE_SECONDS / PHYSICS_DT));
  let n = Math.min(end - start, Math.round(TAKE_MAX_SECONDS / PHYSICS_DT));
  n -= n % TAKE_STEP_MULTIPLE;
  if (n * PHYSICS_DT < TAKE_MIN_SECONDS - 1e-9) return null;
  const samples: RecordSample[] = raw.slice(start, start + n).map(s => ({
    grab: s.grab ? { ...s.grab } : null,
    grabGains: s.grabGains.map(([id, g]) => [id, g] as [string, number]),
    camera: { ...s.camera, target: { ...s.camera.target } },
    viewTarget: { ...(s.viewTarget ?? s.camera.target) },
    ...(s.viewCut ? { viewCut: true } : {}),
  }));
  // 最初の1件で視点を測り直す(再生の始まりと継ぎ目で、前の動きを持ち込まない)は再生側で行う。ここでは継ぎ目をならす
  blendTail(samples);
  return { samples };
}

/** 終わりを初めの視点・注視点・つかみへ寄せる */
function blendTail(s: RecordSample[]): void {
  const n = s.length, first = s[0];
  const F = Math.min(Math.round(BLEND_SECONDS / PHYSICS_DT), Math.floor(n / 3));
  if (F < 2) return;
  // 回転は1周ぶん違っても同じ向きなので、最後の向きにいちばん近い同じ向きへ寄せる(巻き戻して回らないように)
  const lastYaw = s[n - 1].camera.yaw, TAU = Math.PI * 2;
  const yawTo = first.camera.yaw + TAU * Math.round((lastYaw - first.camera.yaw) / TAU);
  for (let j = 0; j < F; j++) {
    const smp = s[n - F + j], t = smooth((j + 1) / (F + 1)), c = smp.camera;
    // 傾きは -π〜π でつながるので、近いほうの回り方で寄せる
    const roll = wrapAngle(c.roll + wrapAngle(first.camera.roll - c.roll) * t);
    smp.camera = {
      ...c, yaw: lerp(c.yaw, yawTo, t), pitch: lerp(c.pitch, first.camera.pitch, t), roll, zoom: lerp(c.zoom, first.camera.zoom, t),
      target: lerpVec(c.target, first.camera.target, t),
    };
    smp.viewTarget = lerpVec(smp.viewTarget!, first.viewTarget!, t);
    // つかみは両方つかんでいるときだけ寄せる(片方だけなら、継ぎ目で離す・つかむになる)
    if (smp.grab && first.grab) smp.grab = lerpVec(smp.grab, first.grab, t);
  }
}

/* ---------- キーフレームから作る ---------- */

/** 補間する値の並び: [yaw, pitch, log(zoom), tx, ty, tz, roll]。ズームは比で補間する(拡大・縮小の速さが見た目でそろう) */
const channels = (v: ViewKey): number[] => [v.yaw, v.pitch, Math.log(v.zoom), v.target.x, v.target.y, v.target.z, v.roll];
const ROLL = 6;

/** キーフレームの動きの曲線。at(t) は1周の始まりから t 秒の視点(0 ≦ t < total) */
export interface KeyCurve {
  readonly keys: readonly KeyFrame[];
  /** 1周の秒数 */
  readonly total: number;
  /** 各フレームを通る時刻(秒) */
  readonly starts: readonly number[];
  at(t: number): CameraState;
}

/**
 * キーフレームを順に通り、最後のフレームから最初のフレームへ戻る曲線(2フレーム以上。足りなければ null)。
 * 区間は3次エルミート曲線。各フレームの速さ(接線)は
 * - なめらか: 前後のフレームを結ぶ向き(時間で重み付けした Catmull-Rom)。止まらずに通り抜ける
 * - 弾む: 出ていく速さは 0。入ってくる区間は、出発の速さから加速し続ける2次の動きにして、着いた所で急に止める
 * 記録を作るのにも、画面に経路を描くのにも使う(描いた経路と実際の動きがずれないように)。
 */
export function keyCurve(input: readonly KeyFrame[], fov: number): KeyCurve | null {
  const keys = normalizeKeys(input);
  const n = keys.length;
  if (n < 2) return null;
  const P = keys.map(k => channels(k.view)), D = keys.map(k => k.seconds);
  const total = D.reduce((a, b) => a + b, 0);
  const at = (i: number) => (i + n) % n;
  // 傾きは -π〜π でつながるので、隣のフレームへは近いほうの回り方で進むよう、続けた値に直す。
  // 最後から最初へ戻る区間も近いほうで回るよう、1周で回った分(2π の倍数)を W に持ち、周の外のフレームに足し引きする
  for (let i = 1; i < n; i++) P[i][ROLL] = P[i - 1][ROLL] + wrapAngle(P[i][ROLL] - P[i - 1][ROLL]);
  const W = P[n - 1][ROLL] + wrapAngle(P[0][ROLL] - P[n - 1][ROLL]) - P[0][ROLL];
  /** i 番目のフレームの値(-1 は最初の1つ前 = 最後、n は最後の次 = 最初) */
  const pt = (i: number): number[] => {
    const p = P[at(i)];
    if (i >= 0 && i < n) return p;
    const q = [...p];
    q[ROLL] += i < 0 ? -W : W;
    return q;
  };
  // 各フレームの出ていく速さ(1秒あたり)。なめらかは前後を結ぶ向き、弾むは 0
  const out = P.map((p, i) => keys[i].mode === 'bounce' ? p.map(() => 0)
    : p.map((_, c) => (pt(i + 1)[c] - pt(i - 1)[c]) / (D[at(i - 1)] + D[i])));
  const starts: number[] = []; let acc = 0;
  for (const d of D) { starts.push(acc); acc += d; }
  return {
    keys, total, starts,
    at(t: number): CameraState {
      let seg = 0;
      while (seg < n - 1 && t >= starts[seg + 1]) seg++;
      const d = D[seg], u = Math.max(0, Math.min(1, (t - starts[seg]) / d)), a = P[seg], b = pt(seg + 1), next = keys[at(seg + 1)];
      const v = a.map((p0, c) => {
        const m0 = out[seg][c] * d, delta = b[c] - p0;
        // 着く側の速さ。弾むは出発の速さから加速して着く(2次の動き)、なめらかは次のフレームの速さ
        const m1 = next.mode === 'bounce' ? 2 * delta - m0 : out[at(seg + 1)][c] * d;
        const u2 = u * u, u3 = u2 * u;
        return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * b[c] + (u3 - u2) * m1;
      });
      return { fov, yaw: v[0], pitch: Math.max(-1.45, Math.min(1.45, v[1])), roll: wrapAngle(v[ROLL]), zoom: Math.exp(v[2]), target: { x: v[3], y: v[4], z: v[5] } };
    },
  };
}

/**
 * キーフレームを順に通り、最後のフレームから最初のフレームへ戻ってくり返す記録を作る(2フレーム以上)。動きは keyCurve。
 * 1周の刻み数は TAKE_STEP_MULTIPLE の倍数にそろえ、区間の時間はその比で少し伸び縮みさせる。
 */
export function takeFromKeys(input: readonly KeyFrame[], fov: number): Take | null {
  const curve = keyCurve(input, fov);
  // 短すぎる動きは保存すると読めないので作らない
  if (!curve || curve.total < TAKE_MIN_SECONDS - 1e-9) return null;
  const { keys, total } = curve;
  const steps = Math.max(TAKE_STEP_MULTIPLE, Math.round(total / PHYSICS_DT / TAKE_STEP_MULTIPLE) * TAKE_STEP_MULTIPLE);
  const samples: RecordSample[] = [];
  for (let s = 0; s < steps; s++) {
    const camera = curve.at((s / steps) * total);
    samples.push({ grab: null, grabGains: [], camera, viewTarget: { ...camera.target } });
  }
  return { samples, keys };
}

const keyOf = (v: unknown, def: ViewKey): ViewKey => {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<ViewKey>, t = (o.target ?? {}) as Partial<Vec3>;
  return {
    yaw: fin(o.yaw, -1e3, 1e3, def.yaw), pitch: fin(o.pitch, -1.5, 1.5, def.pitch), roll: wrapAngle(fin(o.roll, -1e3, 1e3, def.roll)), zoom: fin(o.zoom, 0.05, 20, def.zoom),
    target: { x: fin(t.x, -BIG, BIG), y: fin(t.y, -BIG, BIG), z: fin(t.z, -BIG, BIG) },
  };
};
/** 範囲外・知らない値を丸め、上限の数まで残す(読み込み・作る前に通す) */
export function normalizeKeys(v: unknown): KeyFrame[] {
  const def: ViewKey = { yaw: 0, pitch: 0, roll: 0, zoom: 1.5, target: { x: 0, y: 0, z: 0 } };
  return (Array.isArray(v) ? v : []).slice(0, MAX_KEYS).map(k => {
    const o = (k && typeof k === 'object' ? k : {}) as Partial<KeyFrame>;
    return { view: keyOf(o.view, def), seconds: fin(o.seconds, KEY_SECONDS.min, KEY_SECONDS.max, KEY_SECONDS.def), mode: o.mode === 'bounce' ? 'bounce' : 'smooth' };
  });
}

/**
 * from 番目のキーフレームを to 番目へ動かした並びを返す(元の配列は変えない)。
 * 動くのは視点と通り方で、フレームの間の秒数は場所に残す(一覧の秒数の行はドラッグしないので、見た目どおりにする)。
 */
export function moveKey(keys: readonly KeyFrame[], from: number, to: number): KeyFrame[] {
  const out = keys.map(k => ({ ...k }));
  if (from === to || !out[from] || to < 0 || to >= out.length) return out;
  const [k] = out.splice(from, 1);
  out.splice(to, 0, k);
  return out.map((k, i) => ({ ...k, seconds: keys[i].seconds }));
}

/* ---------- 保存の形(.pukupop の motion/take.json) ---------- */

/**
 * 1件を数の並びにする: [yaw, pitch, zoom, tx, ty, tz, vx, vy, vz, gx, gy, gz, gains, cut, roll]
 * つかんでいないときは gx・gy・gz が null。gains はつかみの効き具合の組(gainSets)の番号(無ければ -1)。cut は 1 で視点を測り直す。
 * roll(傾き)は後から足したので末尾に置く。無い記録(古いファイル)は 0 として読む。版(version)は上げない(古いアプリでも傾き以外は読める)。
 * 画角は記録しない(再生ではその時のプロジェクトの画角を使う)。
 */
export interface TakeJson { version: 1; dt: number; gainSets: [string, number][][]; samples: (number | null)[][]; keys?: KeyFrame[] }

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

export function takeToJson(take: Take): TakeJson {
  const sets: [string, number][][] = [], keys = new Map<string, number>();
  const samples = take.samples.map(s => {
    let gi = -1;
    if (s.grabGains.length) {
      const key = JSON.stringify(s.grabGains);
      gi = keys.get(key) ?? -1;
      if (gi < 0) { gi = sets.length; sets.push(s.grabGains.map(([id, g]) => [id, r6(g)])); keys.set(key, gi); }
    }
    const c = s.camera, v = s.viewTarget ?? c.target, g = s.grab;
    return [
      r6(c.yaw), r6(c.pitch), r6(c.zoom), r6(c.target.x), r6(c.target.y), r6(c.target.z), r6(v.x), r6(v.y), r6(v.z),
      g ? r6(g.x) : null, g ? r6(g.y) : null, g ? r6(g.z) : null, gi, s.viewCut ? 1 : 0, r6(c.roll),
    ];
  });
  return { version: 1, dt: PHYSICS_DT, gainSets: sets, samples, ...(take.keys ? { keys: [...take.keys] } : {}) };
}

const BIG = 1e6;
const fin = (v: unknown, min: number, max: number, def = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def;

/** 読み込み。形が違う・壊れているものは null(記録なしとして開く)。fov はその時のプロジェクトの画角 */
export function takeFromJson(v: unknown, fov: number): Take | null {
  if (!v || typeof v !== 'object') return null;
  const j = v as Partial<TakeJson>;
  if (j.version !== 1 || !Array.isArray(j.samples)) return null;
  if (typeof j.dt === 'number' && Math.abs(j.dt - PHYSICS_DT) > 1e-9) return null;
  const max = Math.round(TAKE_MAX_SECONDS / PHYSICS_DT);
  if (j.samples.length > max) return null;
  // つかみの効き具合の組。組の数はサンプル数まで、1組はレイヤーの上限の枚数まで。同じ組はサンプル間で共有する(書き換えない)
  const sets: [string, number][][] = Array.isArray(j.gainSets)
    ? j.gainSets.slice(0, j.samples.length).map(set => {
      const seen = new Set<string>(), out: [string, number][] = [];
      for (const e of Array.isArray(set) ? set : []) {
        if (out.length >= LIMITS.maxLayers) break;
        if (!Array.isArray(e) || typeof e[0] !== 'string' || e[0].length > 64 || seen.has(e[0])) continue;
        seen.add(e[0]); out.push([e[0], fin(e[1], 0, 1, 1)]);
      }
      return out;
    })
    : [];
  const samples: RecordSample[] = [];
  for (const a of j.samples) {
    if (!Array.isArray(a) || a.length < 14) return null;
    const n = (i: number, min = -BIG, max = BIG) => fin(a[i], min, max);
    const target = { x: n(3), y: n(4), z: n(5) };
    const grab = typeof a[9] === 'number' ? { x: n(9, -10, 10), y: n(10, -10, 10), z: n(11, -10, 10) } : null;
    const gi = a[12];
    samples.push({
      camera: { fov, yaw: n(0, -1e3, 1e3), pitch: n(1, -1.5, 1.5), roll: wrapAngle(n(14, -1e3, 1e3)), zoom: n(2, 0.05, 20) || 1, target },
      viewTarget: { x: n(6), y: n(7), z: n(8) },
      grab,
      grabGains: typeof gi === 'number' && Number.isInteger(gi) && sets[gi] ? sets[gi] : [],
      ...(a[13] === 1 ? { viewCut: true } : {}),
    });
  }
  // 長さは書き出しのコマにそろえる(手で直したファイルなどで端数があれば切り捨てる)
  samples.length -= samples.length % TAKE_STEP_MULTIPLE;
  if (samples.length * PHYSICS_DT < TAKE_MIN_SECONDS - 1e-9) return null;
  const keys = normalizeKeys(j.keys);
  return keys.length >= 2 ? { samples, keys } : { samples };
}
