/**
 * 記録した操作のループ再生。記録どおりにつかみを物理へ入れ、視点の代わりに画像を動かす(Stage の rig)。
 * 編集アプリ(App)と、編集 UI を持たない再生専用の部品(Issue #127)で共有するため、App・アンドゥ・タブ・DOM には依存しない。
 * 今の視点と記録は LoopSource で受け、状態が変わったことは LoopHooks で知らせる。
 * 「直前の操作を再生」の書き出しのための記録(MotionRecorder)は編集アプリの機能なので、ここでは持たず、刻みごとのフック(stepped)で渡す。
 */
import type { CameraState, Project } from '../model/project';
import { PHYSICS_DT, type PhysicsWorld, type WorldSnapshot } from '../physics/world';
import { applySample, type RecordSample } from '../physics/recorder';
import type { PlaybackStage } from './stageApi';

/** 再生が読む外の世界。今の視点(camera。差し替わることがあるので毎回読む)と記録 */
export type LoopSource = Pick<Project, 'camera' | 'take'>;

export interface LoopHooks {
  /** 再生している・していない、一時停止しているかが変わった */
  stateChanged(): void;
  /** 再生の都合で視点(camera)を動かした */
  viewChanged(): void;
  /**
   * 再生で物理を1刻み進める直前。sample は記録の視点で残す1件(見る視点を動かした分は入らない)、
   * snapshot はその時点の物理の状態を返す関数、seeked はシークで揺れを消した直後か(控えを取る印)
   */
  stepped?(sample: RecordSample, snapshot: () => WorldSnapshot, seeked: boolean): void;
}

/** 視点(回転・ズーム・注視点)が同じか。画角は見ない */
export function sameView(a: CameraState, b: CameraState): boolean {
  return a.yaw === b.yaw && a.pitch === b.pitch && a.roll === b.roll && a.zoom === b.zoom && a.target.x === b.target.x && a.target.y === b.target.y && a.target.z === b.target.z;
}

const angles = (a: CameraState) => ({ yaw: a.yaw, pitch: a.pitch, roll: a.roll, zoom: a.zoom });

export class LoopPlayback {
  /** ループ再生中か */
  playing = false;
  /** ループ再生を一時停止しているか(シークバーの ⏸。揺れの一時停止とは別で、物理は進む) */
  paused = false;
  /** ループ再生で次に入れる記録の位置 */
  index = 0;
  /**
   * ループ再生では視点の代わりに画像を動かし、視点は自由に動かせるようにする。
   * from は再生を始めたときの視点(記録の初めの視点)で、画像はここから見て記録どおりに映るように動く。
   * cam は今の刻みの記録の視点。見る視点が from のままなら、画面は記録の視点で見たのと同じになる
   */
  from: CameraState | null = null;
  cam: CameraState | null = null;
  /** シークで揺れを消した直後か(次の刻みで操作の記録に控えを取る) */
  private seeked = false;

  constructor(
    private readonly world: PhysicsWorld,
    private readonly stage: PlaybackStage,
    private readonly source: () => LoopSource,
    private readonly hooks: LoopHooks,
  ) {}

  /**
   * 記録した操作を初めからループ再生する。記録が無ければ何もしない。
   * take は視点を動かす先(記録の初め)を取る記録で、省くと今の記録。刻みごとに入れるのは、そのときの今の記録
   */
  play(take = this.source().take): void {
    const c = this.source().camera;
    if (!take?.samples.length) return;
    this.index = 0;
    this.paused = false;
    // 視点を記録の初めへ動かし、そこを画像を動かす基準にする(始めは画像が元の置き場所にある)
    const s0 = take.samples[0].camera;
    c.yaw = s0.yaw; c.pitch = s0.pitch; c.roll = s0.roll; c.zoom = s0.zoom; c.target = { ...s0.target };
    this.from = { ...c, target: { ...c.target } };
    this.cam = { ...this.from, target: { ...c.target } };
    this.world.cutView(); // 今の視点から記録の初めへ飛ぶ分では揺らさない
    this.world.grab = null; this.world.grabGains.clear();
    if (!this.playing) { this.playing = true; this.hooks.stateChanged(); }
    this.hooks.viewChanged();
  }

  /**
   * ループ再生をやめる。画像は元の置き場所へ戻る。
   * 再生中に視点を動かしていなければ、視点を止めた所の記録の視点にする(画面はそのまま)。動かしていれば、その視点のまま
   */
  stop(): void {
    if (!this.playing) return;
    const c = this.source().camera, from = this.from, at = this.cam;
    if (from && at && sameView(c, from)) { c.yaw = at.yaw; c.pitch = at.pitch; c.roll = at.roll; c.zoom = at.zoom; c.target = { ...at.target }; }
    this.from = this.cam = null;
    this.paused = false;
    this.world.viewRig = null;
    this.stage.setRig(null);
    // 画面を触って止めたときは、すぐ後の当たり判定(pick)が今の視点で行われるようにする
    this.stage.applyCamera(c);
    this.world.grab = null; this.world.grabGains.clear();
    this.world.cutView(); // 物理に伝える注視点が記録の値から今の視点へ戻る分では揺らさない
    this.playing = false;
    this.hooks.stateChanged();
    this.hooks.viewChanged();
  }

  /** 再生の状態を黙って捨てる(別の作業に切り替えるとき。知らせは呼ぶ側がまとめて出す) */
  discard(): void {
    this.index = 0; this.paused = false; this.playing = false;
    this.from = this.cam = null; this.world.viewRig = null; this.stage.setRig(null);
  }

  /** ループ再生を一時停止する・続ける(再生中だけ) */
  setPaused(on: boolean): void {
    if (!this.playing || this.paused === on) return;
    this.paused = on;
    this.hooks.stateChanged();
  }

  /**
   * ループ再生の位置を移す(秒。1周の中に丸める)。跳んだ先の揺れは落ち着いた状態から始める
   * (記録に揺れの途中の状態は残っていないため)。視点が飛ぶ分でも揺らさない
   */
  seek(seconds: number): void {
    const n = this.source().take?.samples.length ?? 0;
    if (!this.playing || !n || !Number.isFinite(seconds)) return;
    const i = Math.round(seconds / PHYSICS_DT);
    this.index = ((i % n) + n) % n;
    this.world.reset();
    this.seeked = true;
    // 位置はバーが描画のたびに追うので、ここでは知らせない(ドラッグの間、ほかの部品を描き直さない)
  }

  /** ループ再生中の位置(秒) */
  get position(): number {
    const n = this.source().take?.samples.length ?? 0;
    return this.playing && n ? (this.index % n) * PHYSICS_DT : 0;
  }

  /** ループ再生中の、画像から見た今の視点(記録の視点)。再生していなければ null */
  get view(): CameraState | null { return this.playing ? this.cam : null; }

  /** ループ再生中に、見る視点を再生の基準の視点(撮影カメラ。記録の初めの視点)へ戻す。再生は続ける */
  resetView(): void {
    const from = this.from;
    if (!this.playing || !from) return;
    const c = this.source().camera;
    c.yaw = from.yaw; c.pitch = from.pitch; c.roll = from.roll; c.zoom = from.zoom; c.target = { ...from.target };
    this.world.cutView(); // 視点が飛ぶだけなので揺らさない
    this.hooks.viewChanged();
  }

  /**
   * 物理の1刻みの直前に呼ぶ(PhysicsWorld.advance の刻みごとの関数から)。再生中なら記録の1件を物理へ入れて true を返す。
   * 再生していない(記録が空の)ときは何もせず false を返し、呼ぶ側が自分の入力を物理へ入れる
   */
  step(): boolean {
    const w = this.world, { camera: c, take } = this.source();
    if (!this.playing || !take?.samples.length) return false;
    // ループ再生: 記録どおりにつかみを物理へ入れ、視点の代わりに画像を動かす(画角は今のまま)。
    // 揺れは、動く画像を今の視点(見る人が動かしてよい)から見た動きで決める
    const i = this.index % take.samples.length, smp = take.samples[i], from = this.from!;
    applySample(w, smp);
    w.viewRig = { from: { target: { ...from.target }, view: angles(from) }, to: { target: { ...(smp.viewTarget ?? smp.camera.target) }, view: angles(smp.camera) } };
    w.viewTarget = { ...c.target };
    w.viewAngles = angles(c);
    const cam = this.cam = { ...smp.camera, fov: c.fov, target: { ...smp.camera.target } };
    // 一時停止中(シークバーで止めた・ドラッグしている間)は同じ所にとどまる。揺れはそのまま落ち着いていく
    if (!this.paused) this.index = i + 1;
    // 「直前の操作を再生」の書き出しには、記録の視点で残す(見る視点を動かした分は入らない)
    // 見る視点を動かしていれば、控えの「1刻み前の視点」は見る視点のものなので、測り直す印にして残す(書き出しの初めで弾まないように)
    // シークで跳んだ刻みは、揺れを消して視点を測り直したことも残す(書き出しで跳んだ分が揺れにならないように)
    const moved = !sameView(c, from), seeked = this.seeked;
    this.seeked = false;
    this.hooks.stepped?.({ ...smp, ...(w.viewCut ? { viewCut: true } : {}), camera: { ...cam, target: { ...cam.target } } }, () => {
      const snap = w.snapshot();
      if (moved) snap.base = null;
      return snap;
    }, seeked);
    return true;
  }

  /**
   * 描画の直前に呼ぶ。ループ再生中は、視点の代わりに画像を動かす。
   * 画角は今のものにそろえる(再生中に画角を変えても、画像が近づいたり離れたりしないように)
   */
  applyRig(): void {
    const fov = this.source().camera.fov;
    if (this.playing && this.from && this.cam) this.stage.setRig({ ...this.from, fov }, { ...this.cam, fov });
    else this.stage.setRig(null);
  }
}
