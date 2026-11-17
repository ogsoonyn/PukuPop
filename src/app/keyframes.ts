/**
 * キーフレームの下書きの編集(編集アプリだけの機能)。下書きはプロジェクト(project.keyframes。App の keyDraft)に置き、ファイルにも保存する。
 * 下書きの編集はアンドゥに積まず、記録を作るとき(makeTake)に1手として積む。作った記録の再生は src/playback/loopPlayback.ts。
 * App とは KeyframeHost の分だけでつながる。
 */
import type { Document, Project } from '../model/project';
import { takeFromKeys, TAKE_MIN_SECONDS, KEY_SECONDS, MAX_KEYS, normalizeKeys, moveKey as movedKeys, type ViewKey, type KeyFrame } from '../physics/take';
import { SetTake } from '../commands/commands';
import type { Command } from '../commands/history';
import type { TakeState } from './recording';

export interface KeyframeHost {
  /** 表に出ているタブの下書き(project.keyframes) */
  keyDraft: KeyFrame[];
  readonly project: Project;
  readonly doc: Document | undefined;
  readonly exporting: boolean;
  readonly takeState: TakeState;
  stopTake(): void;
  playTake(): void;
  /** 視点が飛んだ分では揺らさない(PhysicsWorld.cutView) */
  cutView(): void;
  /** アンドゥに1手として積んで実行する */
  execute(cmd: Command): void;
  /** 下書きが変わった(未保存にする) */
  draftChanged(): void;
  /** 視点を動かした */
  viewChanged(): void;
}

export class KeyframeEditor {
  constructor(private readonly host: KeyframeHost) {}

  private viewKey(): ViewKey {
    const c = this.host.project.camera;
    return { yaw: c.yaw, pitch: c.pitch, roll: c.roll, zoom: c.zoom, target: { ...c.target } };
  }

  /** 今の視点を末尾のキーフレームとして足す。時間とつなぎ方は1つ前のフレームに合わせる */
  add(): void {
    const h = this.host;
    if (h.keyDraft.length >= MAX_KEYS) return;
    h.stopTake();
    const prev = h.keyDraft.at(-1);
    h.keyDraft.push({ view: this.viewKey(), seconds: prev?.seconds ?? KEY_SECONDS.def, mode: prev?.mode ?? 'smooth' });
    h.draftChanged();
  }

  /** i 番目のキーフレームを今の視点で登録し直す */
  set(i: number): void {
    const h = this.host, k = h.keyDraft[i];
    if (!k) return;
    h.stopTake();
    k.view = this.viewKey();
    h.draftChanged();
  }

  remove(i: number): void {
    const h = this.host;
    if (!h.keyDraft[i]) return;
    h.keyDraft.splice(i, 1);
    h.draftChanged();
  }

  /** from 番目のキーフレームを to 番目へ動かす(秒数は場所に残す。physics/take.ts の moveKey) */
  move(from: number, to: number): void {
    const h = this.host, n = h.keyDraft.length;
    if (from === to || from < 0 || from >= n || to < 0 || to >= n) return;
    h.keyDraft = movedKeys(h.keyDraft, from, to);
    h.draftChanged();
  }

  /** 視点を i 番目のキーフレームへ動かす(確かめる用。その動きでは揺らさない) */
  goto(i: number): void {
    const h = this.host, k = h.keyDraft[i]?.view;
    if (!k) return;
    h.stopTake();
    const c = h.project.camera;
    c.yaw = k.yaw; c.pitch = k.pitch; c.roll = k.roll; c.zoom = k.zoom; c.target = { ...k.target };
    h.cutView();
    h.viewChanged();
  }

  setOption(i: number, patch: Partial<Pick<KeyFrame, 'seconds' | 'mode'>>): void {
    const h = this.host, k = h.keyDraft[i];
    if (!k) return;
    if (patch.seconds !== undefined) k.seconds = Math.max(KEY_SECONDS.min, Math.min(KEY_SECONDS.max, Math.round(patch.seconds * 10) / 10));
    if (patch.mode) k.mode = patch.mode;
    h.draftChanged();
  }

  /**
   * キーフレームの動きを再生できるか(2つ以上で1周が短すぎず、止まっているとき)。
   * 手で記録した操作があるときは、黙ってキーフレームの記録に入れ替えないよう使えなくする(キーフレームの「この並びで作る」で入れ替える)
   */
  get canPlay(): boolean {
    const h = this.host, n = h.keyDraft.length, total = h.keyDraft.reduce((a, k) => a + k.seconds, 0), take = h.project.take;
    return n >= 2 && total >= TAKE_MIN_SECONDS - 1e-9 && !!h.doc && !h.exporting && h.takeState === 'idle' && (!take || !!take.keys);
  }

  /** キーフレームの動きを再生する。一覧が今の記録と同じならそのまま再生し、違えば作り直す(元に戻せる) */
  play(): void {
    if (!this.canPlay) return;
    const h = this.host, take = h.project.take;
    if (take?.keys && JSON.stringify(take.keys) === JSON.stringify(normalizeKeys(h.keyDraft))) h.playTake();
    else this.makeTake();
  }

  /** キーフレームを順に通ってくり返す記録を作り(今の記録と入れ替え、アンドゥできる)、ループ再生する。一覧が今の動きと同じなら、作り直さずに再生する */
  makeTake(): void {
    const h = this.host;
    if (!h.doc || h.takeState === 'recording') return;
    // 一覧が今の動きと同じなら作り直さない(アンドゥに積まず、未保存にもしない)
    const cur = h.project.take;
    if (cur?.keys && JSON.stringify(cur.keys) === JSON.stringify(normalizeKeys(h.keyDraft))) { h.playTake(); return; }
    const take = takeFromKeys(h.keyDraft, h.project.camera.fov);
    if (!take) return;
    h.execute(new SetTake('キーフレームから動きを作る', h.project.take, take, h.keyDraft));
    h.playTake();
  }
}
