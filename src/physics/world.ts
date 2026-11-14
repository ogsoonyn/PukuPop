/**
 * 揺れの物理(レイヤー単位のバネ・ダンパ)。DOM と Three.js に依存しない。
 *
 *   m s'' = -k (s - b) - c (s' - b') + F_inertia + F_gravity + F_grab
 *
 * b は自動揺らしで動かす土台(アンカー)の位置。揺らし方ごとの軌道は motion.ts にある。
 * 土台が急に動いたり止まったりすると、塗った部分が遅れて付いてきて弾む。
 * 視点を動かして画像が画面上を動いたときも、その加速度を慣性力として加える(F_inertia)。平行移動だけでなく、
 * 回転とズームも含む。カメラから見た各レイヤーの代表点(ウェイトの重心を、ポップ量だけ手前へ出した所)の
 * 加速度を求め、画像の向きへ戻して使う。回転の中心(注視点)から遠いほど、ふくらみが高いほど、回転でよく揺れる。
 * ズームはカメラが画像に近づく・離れる動きとして扱う(近づく量は拡大率の対数に比例させる)。
 * 揺らし方「ピストン」で画像全体が動くときも、その加速度を同じく慣性力として、揺れが有効なすべてのレイヤーに加える。
 * s は画像に対する変位なので、画面上の位置は「画像全体の位置(baseOffset)+ w·s」になる。
 * 塗った範囲を広げる揺らし方(motion.ts の SPREAD_MOTIONS)の広がり r(中心からの距離に対する割合)は、同じ材質のバネで土台(motionSpread)に付いてくる
 * 1次元のばねとして別に持つ。つかむ・平行移動・重さは効かない。
 * 単位は「画像の長辺 = 2」の正規化座標。描画側で (長辺 / 2) を掛けてピクセルへ直す。
 * 積分は半陰的オイラー法、刻みは 1/120 秒固定。
 */
import type { Layer, PhysicsParams, AutoSwing, Vec3 } from '../model/project';
import { motionAnchor, motionSpread, pistonOffset, pistonReach } from './motion';

export const PHYSICS_DT = 1 / 120;
const MAX_DISPLACEMENT = 1.2;
const GRAB_GAIN = 140;
const GRAB_LIMIT = 0.7;
/** 広がりの範囲。-1 より小さいと裏返るので手前で止める */
const SPREAD_MIN = -0.8, SPREAD_MAX = 1.5;
/** 視点の動きの速度をならす時定数(秒)。視点は描画フレームごとにしか動かないので、刻みごとのガタつきを消す */
const BASE_SMOOTH = 0.025;
/**
 * ズームでカメラが近づく・離れる量(正規化座標、拡大率の対数 1 あたり)。ホイール1段で、平行移動を少し振ったくらいに揺れる。
 * 本当のカメラの距離(画面の縦横比や画角で変わる)ではなく対数で決めるので、どの拡大率でも1段の揺れは同じで、
 * 記録の再生・書き出しでも同じ揺れになる。画角を変えても揺らさない
 */
const ZOOM_DEPTH = 1.2;

/** s, v: 変位と速度。r, rv: 塗った範囲の広がりとその速さ */
export interface SpringState { s: Vec3; v: Vec3; r: number; rv: number }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export function coefficients(p: PhysicsParams): { k: number; m: number; c: number; g: number } {
  return { k: lerp(20, 400, p.hardness), m: lerp(0.3, 3, p.mass), c: lerp(0.5, 12, p.damping), g: p.weight * 6 };
}

/** 物理に伝える視点(注視点は viewTarget で別に入れる)。画角は使わない */
export interface ViewAngles { yaw: number; pitch: number; roll: number; zoom: number }
/** 視点(注視点はワールド座標)。viewRig で使う */
export interface ViewPoint { target: Vec3; view: ViewAngles }
/** 1刻み前のカメラの位置と向き(正規化座標)と、レイヤーごとのならした速度(カメラから見た向き) */
interface BaseState { pose: Pose; vel: [string, Vec3][] }
export interface WorldSnapshot { time: number; acc: number; states: [string, SpringState][]; base?: BaseState | null }

export class PhysicsWorld {
  /** 物理の経過時間(秒)。自動揺らしの位相に使う。 */
  time = 0;
  paused = false;
  autoSwing: AutoSwing = { enabled: false, period: 2, strength: 0.5 };
  /** つかみ: ドラッグ開始点からのポインタ移動量(正規化座標) */
  grab: Vec3 | null = null;
  /** つかみの効き具合(レイヤーごと、0〜1) */
  grabGains = new Map<string, number>();
  /**
   * 視点の注視点(ワールド座標)。平行移動すると画像が画面上で逆向きに動くので、
   * 画像を手で動かしたのと同じように揺らす。刻みの前に毎回入れる。
   */
  viewTarget: Vec3 = v3();
  /** 視点の向きとズーム。回転とズームでも揺らす。刻みの前に毎回入れる */
  viewAngles: ViewAngles = { yaw: 0, pitch: 0, roll: 0, zoom: 1 };
  /**
   * 記録の再生中に画像のほうを動かすときの、画像の動き。画像から見た視点が from から to へ動いたのと同じだけ画像が動き、
   * それを viewTarget・viewAngles の視点(見る人の視点)から見る。null なら画像は動かない。
   * 見る人の視点が from のままなら、画像から見た視点は to とちょうど同じになる(今までの再生と同じ揺れ)
   */
  viewRig: { from: ViewPoint; to: ViewPoint } | null = null;
  /**
   * レイヤーのウェイトの重心(正規化座標、画像のローカル座標の x, y)。回転で揺れる大きさを決める。
   * 無ければ画像の中央とみなす
   */
  centerOf: ((layer: Layer) => { x: number; y: number }) | null = null;
  /** 正規化座標の 1 が何ピクセルか(画像の長辺 / 2)。ポップ量を正規化座標へ直すのに使う */
  unitPx = 1;

  private states = new Map<string, SpringState>();
  private acc = 0;
  private anchor = v3();
  private anchorPrev = v3();
  /** 1刻み前の視点と、レイヤーごとのならした速度。null は「次の刻みで今の視点から測り直す」 */
  private base: { pose: Pose; vel: Map<string, Vec3> } | null = null;
  private drive = v3();
  private piston = [v3(), v3(), v3()];

  state(layerId: string): SpringState {
    let s = this.states.get(layerId);
    if (!s) this.states.set(layerId, (s = { s: v3(), v: v3(), r: 0, rv: 0 }));
    return s;
  }

  displacement(layerId: string): Vec3 { return this.states.get(layerId)?.s ?? v3(); }

  /** 塗った範囲の広がり(中心からの距離に対する割合。広げる揺らし方は motion.ts の SPREAD_MOTIONS) */
  spread(layerId: string): number { return this.states.get(layerId)?.r ?? 0; }

  reset(): void { this.states.clear(); this.acc = 0; this.base = null; }

  /** 視点が飛んだ(視点のリセットなど)ことを知らせる。その動きでは揺らさない */
  cutView(): void { this.base = null; }
  /** 次の刻みで視点を測り直すか(操作の記録に残し、再生でも同じ所で測り直す) */
  get viewCut(): boolean { return this.base === null; }

  /** 実時間で進める(描画フレームから呼ぶ)。1フレームの上限は 0.1 秒。 */
  advance(dt: number, layers: readonly Layer[], beforeStep?: () => void): void {
    if (this.paused) { this.base = null; return; }
    this.acc = Math.min(this.acc + dt, 0.1);
    while (this.acc >= PHYSICS_DT) { beforeStep?.(); this.step(layers); this.acc -= PHYSICS_DT; }
  }

  /**
   * 画像全体の位置(正規化座標、画像のローカル座標)。揺らし方「ピストン」で動かす。
   * 画像は1枚なので、揺れが有効で表示中のレイヤーのうち、並びで最初(一覧の一番下)のピストンのレイヤーの設定で決める。
   * 自動揺らしが切れているとき・一時停止中は動かさない。t は物理の経過時間(省略時は今)。
   */
  baseOffset(layers: readonly Layer[], t = this.time, out: Vec3 = v3()): Vec3 {
    zero(out);
    const l = this.baseDriver(layers), auto = this.autoSwing;
    return l ? pistonOffset(t, auto.period, auto.strength, out, l.physics.motionParams) : out;
  }

  /** 画像全体の動きを決めるレイヤー(無ければ画像は動かない) */
  baseDriver(layers: readonly Layer[]): Layer | undefined {
    if (this.paused || !this.autoSwing.enabled) return undefined;
    return layers.find(l => l.visible && l.physics.enabled && l.physics.motion === 'piston');
  }

  /** 画像全体がいちばん上がったときのずれ(正規化座標)。3面図の図の大きさを決めるのに使う */
  baseReach(layers: readonly Layer[]): number {
    const l = this.baseDriver(layers);
    return l ? pistonReach(this.autoSwing.strength, l.physics.motionParams) : 0;
  }

  /** 固定刻みで1回進める。 */
  step(layers: readonly Layer[], dt = PHYSICS_DT): void {
    const view = this.viewMotion(), grab = this.grab, auto = this.autoSwing, on = auto.enabled;
    const b = this.anchor, bp = this.anchorPrev;
    // 画像全体の動き(ピストン)の加速度。前後の刻みの位置の2階差分で求めると、画面上の位置
    // (画像の位置 + 変位)が、動かない座標で同じ積分をしたものとちょうど一致する
    const [g0, g1, g2] = this.piston;
    this.baseOffset(layers, this.time - dt, g0); this.baseOffset(layers, this.time, g1); this.baseOffset(layers, this.time + dt, g2);
    const pax = (g2.x - 2 * g1.x + g0.x) / (dt * dt), pay = (g2.y - 2 * g1.y + g0.y) / (dt * dt), paz = (g2.z - 2 * g1.z + g0.z) / (dt * dt);
    for (const layer of layers) {
      const st = this.state(layer.id);
      if (!layer.physics.enabled || !layer.visible) { zero(st.s); zero(st.v); st.r = st.rv = 0; view?.vel.delete(layer.id); continue; }
      const drive = this.viewAccel(layer, view, dt);
      drive.x += pax; drive.y += pay; drive.z += paz;
      const { k, m, c, g } = coefficients(layer.physics);
      // 土台の位置と速度(速度は1刻み前との差から求める)
      if (on) {
        const pop = layer.pop / this.unitPx;
        motionAnchor(layer.physics.motion, this.time + dt, auto.period, auto.strength, b, pop, layer.physics.motionParams);
        motionAnchor(layer.physics.motion, this.time, auto.period, auto.strength, bp, pop, layer.physics.motionParams);
      } else { zero(b); zero(bp); }
      const bvx = (b.x - bp.x) / dt, bvy = (b.y - bp.y) / dt, bvz = (b.z - bp.z) / dt;
      const gain = grab ? (this.grabGains.get(layer.id) ?? 1) * GRAB_GAIN : 0;
      let gx = 0, gy = 0, gz = 0;
      if (grab) {
        const len = Math.hypot(grab.x, grab.y, grab.z), sc = len > GRAB_LIMIT ? GRAB_LIMIT / len : 1;
        gx = grab.x * sc; gy = grab.y * sc; gz = grab.z * sc;
      }
      const fx = -k * (st.s.x - b.x) - c * (st.v.x - bvx) - m * drive.x + gain * gx;
      const fy = -k * (st.s.y - b.y) - c * (st.v.y - bvy) - m * drive.y + gain * gy - g * m;
      const fz = -k * (st.s.z - b.z) - c * (st.v.z - bvz) - m * drive.z + gain * gz;
      st.v.x += (fx / m) * dt; st.v.y += (fy / m) * dt; st.v.z += (fz / m) * dt;
      st.s.x += st.v.x * dt; st.s.y += st.v.y * dt; st.s.z += st.v.z * dt;
      const len = Math.hypot(st.s.x, st.s.y, st.s.z);
      if (len > MAX_DISPLACEMENT) {
        const sc = MAX_DISPLACEMENT / len;
        st.s.x *= sc; st.s.y *= sc; st.s.z *= sc;
      }
      // 塗った範囲の広がり(土台が動かないレイヤーでは 0 に戻るだけ)
      const motion = layer.physics.motion, mp = layer.physics.motionParams;
      const rb = on ? motionSpread(motion, this.time + dt, auto.period, auto.strength, mp) : 0;
      const rbp = on ? motionSpread(motion, this.time, auto.period, auto.strength, mp) : 0;
      if (rb !== 0 || rbp !== 0 || st.r !== 0 || st.rv !== 0) {
        st.rv += ((-k * (st.r - rb) - c * (st.rv - (rb - rbp) / dt)) / m) * dt;
        st.r = Math.max(SPREAD_MIN, Math.min(SPREAD_MAX, st.r + st.rv * dt));
      }
    }
    // 消したレイヤーの速度は捨てる
    if (view) for (const id of view.vel.keys()) if (!layers.some(l => l.id === id)) view.vel.delete(id);
    this.time += dt;
  }

  /**
   * 視点の動きを測る準備。1刻み前の視点を返し、今の視点を次の刻みのために残す。
   * 測り直しのときは null(この刻みでは視点の動きで揺らさない)
   */
  private viewMotion(): { from: Pose; to: Pose; vel: Map<string, Vec3>; still: boolean } | null {
    const u = this.unitPx || 1, rig = this.viewRig;
    const at = (t: Vec3, a: ViewAngles) => pose(v3(t.x / u, t.y / u, t.z / u), a);
    let to = at(this.viewTarget, this.viewAngles);
    if (rig) to = rigPose(at(rig.from.target, rig.from.view), at(rig.to.target, rig.to.view), to);
    const b = this.base;
    this.base = { pose: to, vel: b?.vel ?? new Map() };
    if (!b) return null;
    const p = b.pose, still = sameVec(p.e, to.e) && sameVec(p.r, to.r) && sameVec(p.u, to.u) && sameVec(p.b, to.b);
    return { from: p, to, vel: b.vel, still };
  }

  /**
   * 視点の動きによる、レイヤーの代表点の見かけの加速度(画像の向き)。
   * 代表点をカメラから見た位置で測り、速度をならしてから、1刻みでの変化を加速度にして画像の向きへ戻す。
   * 代表点は前後の刻みで同じものを使うので、ポップ量や塗りを変えても揺れない
   */
  private viewAccel(layer: Layer, view: ReturnType<PhysicsWorld['viewMotion']>, dt: number): Vec3 {
    const a = this.drive;
    zero(a);
    // 測り直した刻みでは、速さ 0 から測り始める(この後に動けば、動き出しとして揺らす)
    if (!view) { this.base?.vel.set(layer.id, v3()); return a; }
    let vel = view.vel.get(layer.id);
    // 視点が止まっていて速さも残っていなければ、加速度は 0(重心を求めずに済ませる)。止まっているので速さは 0 で測り始めてよい
    if (view.still && (!vel || Math.abs(vel.x) + Math.abs(vel.y) + Math.abs(vel.z) < 1e-9)) { view.vel.set(layer.id, vel ? (zero(vel), vel) : v3()); return a; }
    const c = this.centerOf?.(layer) ?? { x: 0, y: 0 }, p = this.point;
    p.x = c.x; p.y = c.y; p.z = layer.pop / (this.unitPx || 1);
    const q0 = inCamera(view.from, p, this.q0), q1 = inCamera(view.to, p, this.q1);
    if (!vel) {
      // 視点が動いている途中で揺れが有効・表示になったレイヤーは、今の速さから測り始める(0 から急に動き出したとみなして弾ませない)
      view.vel.set(layer.id, v3((q1.x - q0.x) / dt, (q1.y - q0.y) / dt, (q1.z - q0.z) / dt));
      return a;
    }
    const k = 1 - Math.exp(-dt / BASE_SMOOTH);
    const nx = vel.x + ((q1.x - q0.x) / dt - vel.x) * k;
    const ny = vel.y + ((q1.y - q0.y) / dt - vel.y) * k;
    const nz = vel.z + ((q1.z - q0.z) / dt - vel.z) * k;
    // カメラから見た向きの加速度を、今の視点の向きで画像の向きへ戻す
    const ax = (nx - vel.x) / dt, ay = (ny - vel.y) / dt, az = (nz - vel.z) / dt, { r, u, b } = view.to;
    a.x = r.x * ax + u.x * ay + b.x * az;
    a.y = r.y * ax + u.y * ay + b.y * az;
    a.z = r.z * ax + u.z * ay + b.z * az;
    vel.x = nx; vel.y = ny; vel.z = nz;
    return a;
  }
  private point = v3();
  private q0 = v3();
  private q1 = v3();

  snapshot(): WorldSnapshot {
    const b = this.base;
    return {
      time: this.time, acc: this.acc,
      states: [...this.states].map(([id, s]) => [id, { s: { ...s.s }, v: { ...s.v }, r: s.r, rv: s.rv }]),
      base: b ? { pose: copyPose(b.pose), vel: [...b.vel].map(([id, v]) => [id, { ...v }]) } : null,
    };
  }

  restore(snap: WorldSnapshot): void {
    this.time = snap.time; this.acc = snap.acc;
    this.states = new Map(snap.states.map(([id, s]) => [id, { s: { ...s.s }, v: { ...s.v }, r: s.r ?? 0, rv: s.rv ?? 0 }]));
    const b = snap.base;
    this.base = b ? { pose: copyPose(b.pose), vel: new Map(b.vel.map(([id, v]) => [id, { ...v }])) } : null;
  }
}

function zero(v: Vec3): void { v.x = v.y = v.z = 0; }
const sameVec = (a: Vec3, b: Vec3) => a.x === b.x && a.y === b.y && a.z === b.z;

/** カメラの位置と向き。r, u, b は画面の右・上・手前(画像の向きで表す)。e はカメラの位置 */
export interface Pose { e: Vec3; r: Vec3; u: Vec3; b: Vec3 }

/**
 * 視点からカメラの位置と向きを求める(stage.ts の applyCamera と同じ向き)。注視点からの距離は ZOOM_DEPTH で決める。
 * 回転の揺れは距離によらない(カメラから見た位置の、距離の分は奥行きが一定なだけ)ので、距離はズームの変化だけを表せばよい
 */
export function pose(target: Vec3, view: ViewAngles): Pose {
  const sy = Math.sin(view.yaw), cy = Math.cos(view.yaw), sp = Math.sin(view.pitch), cp = Math.cos(view.pitch);
  const b = v3(sy * cp, sp, cy * cp), d = ZOOM_DEPTH * Math.log(Math.max(1e-3, view.zoom));
  // 傾き(ロール)は、画面の右・上を手前の軸のまわりに回す(stage.ts の applyCamera の rotateZ と同じ向き)
  const r0 = v3(cy, 0, -sy), u0 = v3(-sy * sp, cp, -cy * sp), sr = Math.sin(view.roll ?? 0), cr = Math.cos(view.roll ?? 0);
  const r = v3(r0.x * cr + u0.x * sr, r0.y * cr + u0.y * sr, r0.z * cr + u0.z * sr);
  const u = v3(u0.x * cr - r0.x * sr, u0.y * cr - r0.y * sr, u0.z * cr - r0.z * sr);
  return { e: v3(target.x + d * b.x, target.y + d * b.y, target.z + d * b.z), r, u, b };
}

const copyPose = (p: Pose): Pose => ({ e: { ...p.e }, r: { ...p.r }, u: { ...p.u }, b: { ...p.b } });

/**
 * 画像から見たカメラが from から to へ動いたのと同じだけ画像を動かしたとき、カメラ v を画像から見た位置と向き。
 * from を to へ重ねる動き(回転と平行移動)を v にかける。v が from なら to になる。向きは傾き(ロール)を含んでよい
 */
export function rigPose(from: Pose, to: Pose, v: Pose): Pose {
  // from の向きから見た成分に直してから、to の向きで戻す
  const map = (d: Vec3): Vec3 => {
    const x = from.r.x * d.x + from.r.y * d.y + from.r.z * d.z;
    const y = from.u.x * d.x + from.u.y * d.y + from.u.z * d.z;
    const z = from.b.x * d.x + from.b.y * d.y + from.b.z * d.z;
    return v3(to.r.x * x + to.u.x * y + to.b.x * z, to.r.y * x + to.u.y * y + to.b.y * z, to.r.z * x + to.u.z * y + to.b.z * z);
  };
  const d = map(v3(v.e.x - from.e.x, v.e.y - from.e.y, v.e.z - from.e.z));
  return { e: v3(to.e.x + d.x, to.e.y + d.y, to.e.z + d.z), r: map(v.r), u: map(v.u), b: map(v.b) };
}

/** 点 p をカメラから見た位置(画面の右・上・手前の成分) */
function inCamera(c: Pose, p: Vec3, out: Vec3): Vec3 {
  const dx = p.x - c.e.x, dy = p.y - c.e.y, dz = p.z - c.e.z;
  out.x = c.r.x * dx + c.r.y * dy + c.r.z * dz;
  out.y = c.u.x * dx + c.u.y * dy + c.u.z * dz;
  out.z = c.b.x * dx + c.b.y * dy + c.b.z * dz;
  return out;
}
