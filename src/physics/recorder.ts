/**
 * 「直前の操作を再生」用に、つかみ操作とカメラ操作を時刻付きで記録する。
 * 物理の刻みごとに1件記録し、直近 MAX_SECONDS 秒ぶんだけ保持する。
 * 1秒ごとに物理状態の控えを持たせ、そこから記録どおりに進め直して再生の開始状態を作る。
 */
import type { CameraState, Vec3 } from '../model/project';
import type { PhysicsWorld, WorldSnapshot } from './world';
import { PHYSICS_DT } from './world';

export interface RecordSample {
  grab: Vec3 | null;
  grabGains: [string, number][];
  camera: CameraState;
  /** 物理に伝えた注視点(視点の注視点 + 「揺らす」で振った量) */
  viewTarget?: Vec3;
  /** この刻みで視点を測り直したか(視点のリセットなどで飛んだ所) */
  viewCut?: boolean;
  snap?: WorldSnapshot;
}

/** 記録した1件を物理へ入れる(再生の書き出しで、刻みの前に呼ぶ) */
export function applySample(world: PhysicsWorld, smp: RecordSample): void {
  world.grab = smp.grab;
  world.grabGains = new Map(smp.grabGains);
  // 物理に伝える注視点(「揺らす」で振った量を含む)。古い記録には無いので視点の注視点で代える
  world.viewTarget = smp.viewTarget ?? smp.camera.target;
  // 視点の向きとズーム(回転・ズームでも揺らす)
  const c = smp.camera;
  world.viewAngles = { yaw: c.yaw, pitch: c.pitch, roll: c.roll, zoom: c.zoom };
  if (smp.viewCut) world.cutView();
}

const MAX_SECONDS = 60;
const SNAP_EVERY = 120;

export class MotionRecorder {
  private samples: RecordSample[] = [];
  private counter = 0;

  get seconds(): number { return this.samples.length * PHYSICS_DT; }

  clear(): void { this.samples = []; this.counter = 0; }

  /** 物理を1刻み進める直前に呼ぶ。snap はその時点の物理状態を返す関数。force なら間隔によらず控えを取る(揺れを消したときなど) */
  record(sample: RecordSample, snap: () => WorldSnapshot, force = false): void {
    if (force || this.samples.length === 0 || this.counter % SNAP_EVERY === 0) sample.snap = snap();
    this.counter++;
    this.samples.push(sample);
    const max = Math.round(MAX_SECONDS / PHYSICS_DT);
    if (this.samples.length > max + SNAP_EVERY) {
      let j = 1;
      while (j < this.samples.length && !this.samples[j].snap) j++;
      this.samples.splice(0, j);
    }
  }

  /** 直近 seconds 秒ぶんの記録。warmup は控えから開始点までの記録。 */
  lastSeconds(seconds: number): { start: WorldSnapshot; warmup: RecordSample[]; samples: RecordSample[] } | null {
    if (!this.samples.length) return null;
    const n = Math.min(this.samples.length, Math.round(seconds / PHYSICS_DT));
    const startIdx = this.samples.length - n;
    let base = startIdx;
    while (base > 0 && !this.samples[base].snap) base--;
    return { start: this.samples[base].snap!, warmup: this.samples.slice(base, startIdx), samples: this.samples.slice(startIdx) };
  }
}
