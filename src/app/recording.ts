/**
 * 操作の記録を取る側(編集アプリだけの機能)。つかむ・揺らす・移動・視点の操作を物理の刻みごとに覚え、
 * 止めたらループ再生できる形(finalizeTake)にして、1手として記録に入れる。再生は src/playback/loopPlayback.ts。
 * App とは RecordingHost の分だけでつながる。
 */
import type { CameraState, Document, Project } from '../model/project';
import { PHYSICS_DT, type PhysicsWorld } from '../physics/world';
import type { RecordSample } from '../physics/recorder';
import { finalizeTake, takeSeconds, TAKE_MAX_SECONDS, TAKE_MIN_SECONDS } from '../physics/take';
import { SetTake } from '../commands/commands';
import type { Command } from '../commands/history';
import { toast } from '../ui/dom';

/** 操作の記録の状態。記録中・ループ再生中・どちらでもない */
export type TakeState = 'idle' | 'recording' | 'playing';

export interface RecordingHost {
  readonly doc: Document | undefined;
  readonly project: Project;
  /** 揺れを一時停止しているか */
  readonly paused: boolean;
  setPaused(on: boolean): void;
  /** ループ再生中か */
  readonly playing: boolean;
  stopTake(): void;
  /** アンドゥに1手として積んで実行する */
  execute(cmd: Command): void;
  /** 記録中かどうかが変わった */
  stateChanged(): void;
}

/** 記録できる刻みの数の上限 */
const MAX_STEPS = Math.round(TAKE_MAX_SECONDS / PHYSICS_DT);

export class TakeRecording {
  /** 記録中か */
  active = false;
  /** 記録中の操作(止めたときに finalizeTake で整える) */
  private raw: RecordSample[] = [];

  constructor(private readonly host: RecordingHost) {}

  /** 記録した長さ(秒) */
  get seconds(): number { return this.raw.length * PHYSICS_DT; }

  /** 記録を始める。つかむ・揺らす・移動・視点の操作を、止めるまで(最長 60 秒)覚える */
  start(): void {
    const h = this.host;
    if (!h.doc || this.active) return;
    if (h.playing) h.stopTake();
    if (h.paused) h.setPaused(false); // 一時停止中は物理が進まず、記録もされない
    this.raw = [];
    this.active = true;
    h.stateChanged();
  }

  /** 記録を止めて、ループ再生できる形にして残す(アンドゥできる)。full は最長まで記録して止まったとき */
  stop(full = false): void {
    if (!this.active) return;
    const h = this.host, take = finalizeTake(this.raw);
    this.raw = [];
    this.active = false;
    h.stateChanged();
    if (!take) { toast(`記録が短すぎます。「記録」を押したあと、${TAKE_MIN_SECONDS} 秒以上動かしてください。`, 'warning'); return; }
    h.execute(new SetTake('操作の記録', h.project.take, take));
    const sec = takeSeconds(take).toFixed(1);
    toast(full ? `最長の ${sec} 秒まで記録したので止めました。` : `${sec} 秒の操作を記録しました。アニメーションの「再生」でくり返し再生できます。`, 'success');
  }

  /** 記録中の操作を黙って捨てる(別の作業に切り替えるとき。知らせは呼ぶ側がまとめて出す) */
  discard(): void { this.raw = []; this.active = false; }

  /** 物理の1刻みの直前に、物理へ入れた操作を覚える(記録中だけ)。world.viewTarget は入れ終えたものを渡す */
  capture(w: PhysicsWorld, c: CameraState): void {
    if (!this.active) return;
    // 1フレームで何刻みも進むことがあるので、最長に達したあとの刻みは積まない
    if (this.raw.length < MAX_STEPS) this.raw.push({
      grab: w.grab ? { ...w.grab } : null, grabGains: [...w.grabGains], viewTarget: { ...w.viewTarget }, viewCut: w.viewCut || undefined,
      camera: { fov: c.fov, yaw: c.yaw, pitch: c.pitch, roll: c.roll, zoom: c.zoom, target: { ...c.target } },
    });
    // 最長まで記録したら止める(物理を進めている途中なので、止めるのは刻みのあと)
    if (this.raw.length >= MAX_STEPS) queueMicrotask(() => this.stop(true));
  }
}
