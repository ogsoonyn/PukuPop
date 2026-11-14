/**
 * 視点の傾き(Q / E)をなめらかに回す。一瞬で 15° 跳ぶと、その勢いで揺れが大きく跳ねるため。
 * 目標の角度だけを動かし、実際の角度は毎フレーム、目標との差に比例した速さで寄せる(ui/smoothZoom.ts と同じ考え方)。
 * 続けて押すと目標が先へ延びる。角度は -π〜π でつながるので、寄せる途中は続けた値で持ち、書くときに丸める。
 * 寄せている途中でほかの操作(リセット・ドラッグ・再生など)が角度を変えたら、寄せるのをやめてそちらに任せる。
 */
import { wrapAngle } from '../model/project';

/** 目標との差が 1/e になるまでの時間(秒)。3倍のおよそ 0.15 秒でほぼ着く */
export const ROLL_EASE = 0.05;
/** 目標との差(ラジアン)がこれより小さくなったら、目標に合わせて止める */
const DONE = 1e-4;

export interface SmoothRollTarget {
  /** 今の角度(-π〜π) */
  get(): number;
  set(r: number): void;
  /** 角度を持つオブジェクト。差し替わったら、ほかの操作が視点を飛ばしたとみなす */
  owner(): object;
}

export interface SmoothRoll {
  /** 目標の角度を delta だけ回す */
  add(delta: number): void;
}

export function smoothRoll(t: SmoothRollTarget, raf: (cb: (now: number) => void) => number = requestAnimationFrame): SmoothRoll {
  let goal: number | null = null;
  /** 寄せている途中の角度(続けた値)と、最後に自分で書いた値 */
  let pos = 0, written = NaN;
  let owner: object | null = null;
  let id = 0, prev = 0;

  const alive = () => goal !== null && t.get() === written && t.owner() === owner;

  const step = (now: number) => {
    id = 0;
    if (!alive()) { goal = null; return; }
    const dt = prev ? Math.min(0.1, (now - prev) / 1000) : 1 / 60;
    prev = now;
    const rest = goal! - pos;
    pos = Math.abs(rest) < DONE ? goal! : pos + rest * (1 - Math.exp(-dt / ROLL_EASE));
    t.set(wrapAngle(pos));
    written = t.get();
    if (pos === goal) { goal = null; return; }
    id = raf(step);
  };

  return {
    add(delta) {
      // 寄せている途中なら、目標から先へ延ばす(続けて押した分を取りこぼさない)
      if (!alive()) { pos = t.get(); goal = pos; written = pos; owner = t.owner(); }
      goal! += delta;
      if (!id) { prev = 0; id = raf(step); }
    },
  };
}
