/**
 * 書き出し。実時間の画面録画ではなく、1フレームずつ物理を進めて描画した画像を連結する。
 * PC の負荷に関係なく、常に指定 fps でコマ落ちの無い動画になる。
 */
import type { Stage } from '../stage/stage';
import type { Store, CameraState, Document, Layer } from '../model/project';
import { PhysicsWorld, PHYSICS_DT } from '../physics/world';
import { applySample, type MotionRecorder, type RecordSample } from '../physics/recorder';
import { createEncoder, FORMAT_INFO, even, type ExportFormat } from './encoders';

/** auto: 自動揺らし / replay: 直前の操作を再生 / loop: 記録した操作をループ再生 */
export type MotionSource = 'auto' | 'replay' | 'loop';

export interface ExportSettings {
  format: ExportFormat;
  width: number;
  height: number;
  fps: 60 | 30;
  duration: number;           // 秒
  background: string | null;  // null で透過
  motion: MotionSource;
}

export interface ExportContext {
  stage: Stage;
  store: Store;
  recorder: MotionRecorder;
  /** 現在のスイングを Stage へ反映する関数(App と同じ処理) */
  applySwing: (world: PhysicsWorld, doc: Document) => void;
  /** レイヤーの重心(正規化座標。App と同じ値) */
  centerOf: (layer: Layer) => { x: number; y: number };
  /**
   * 静止画(still)用。画面の物理(今見えている揺れ)を Stage へ戻し、撮る視点を返す(App の currentShot)。
   * 書き出し専用の物理は慣らさず、今の姿をそのまま撮る
   */
  currentShot?: () => CameraState;
}

export interface ExportResult { blob: Blob; filename: string; frames: number }

/** 自動揺らしを定常状態まで慣らす時間(秒) */
const WARMUP_SECONDS = 20;
/** 記録のループ再生を慣らす時間(秒、最低2周)。1周目の初めは揺れが無いので、継ぎ目が揃うまで回してから撮る */
const LOOP_WARMUP_SECONDS = 6;

const CONTEXT_LOST_MESSAGE = '3Dビューの描画が止まったため、書き出しを中止しました。描画が戻ってからもう一度お試しください。';

export async function runExport(
  ctx: ExportContext, s: ExportSettings,
  onProgress: (done: number, total: number) => void, signal: AbortSignal,
): Promise<ExportResult> {
  const doc = ctx.store.doc;
  if (!doc) throw new Error('書き出す画像がありません');
  if (ctx.stage.contextLost) throw new Error(CONTEXT_LOST_MESSAGE);
  // 途中で一度でも失われたら、その間のコマは描けていないので失敗にする(すぐ戻っても続けない)
  const losses = ctx.stage.contextLosses;
  const checkContext = () => { if (ctx.stage.contextLost || ctx.stage.contextLosses !== losses) throw new Error(CONTEXT_LOST_MESSAGE); };
  const width = even(s.width), height = even(s.height);
  const total = Math.max(1, Math.round(s.duration * s.fps));
  const stepsPerFrame = Math.round(1 / s.fps / PHYSICS_DT);
  const info = FORMAT_INFO[s.format];
  const background = info.alpha ? s.background : (s.background ?? '#ffffff');
  const project = ctx.store.project;

  if (s.format === 'still') return exportStill(ctx, width, height, background, doc.name);

  // 書き出し専用の物理。画面側の状態には触れない
  const world = new PhysicsWorld();
  world.unitPx = Math.max(doc.image.width, doc.image.height) / 2;
  world.centerOf = ctx.centerOf;
  let samples: readonly RecordSample[] | null = null;
  /** 記録の終わりまで来たら初めに戻るか(ループ再生)。戻らないときは最後の1件のまま */
  let wrap = false;
  let camera: CameraState = structuredClone(project.camera);

  if (s.motion === 'replay') {
    const rec = ctx.recorder.lastSeconds(s.duration);
    if (!rec || rec.samples.length < 2) throw new Error('再生できる操作の記録がありません。「つかむ」か「揺らす」で揺らしてから書き出してください。');
    world.restore(rec.start);
    world.autoSwing = { ...project.autoSwing };
    for (const smp of rec.warmup) { applySample(world, smp); world.step(doc.layers); }
    samples = rec.samples;
  } else if (s.motion === 'loop') {
    const take = project.take;
    if (!take || take.samples.length < 2) throw new Error('ループ再生する操作の記録がありません。「記録」を押して操作を記録してから書き出してください。');
    samples = take.samples; wrap = true;
    world.autoSwing = { ...project.autoSwing };
    const n = samples.length, loops = Math.max(2, Math.ceil(LOOP_WARMUP_SECONDS / (n * PHYSICS_DT)));
    for (let i = 0; i < loops * n; i++) { applySample(world, samples[i % n]); world.step(doc.layers); }
  } else {
    world.autoSwing = { ...project.autoSwing, enabled: true };
    // 周期の頭から始まるように、周期の整数倍だけ慣らす
    const T = world.autoSwing.period, warm = Math.ceil(WARMUP_SECONDS / T) * T;
    for (let i = 0, n = Math.round(warm / PHYSICS_DT); i < n; i++) world.step(doc.layers);
  }

  const at = (i: number) => (wrap ? i % samples!.length : Math.min(samples!.length - 1, i));
  const encoder = createEncoder(s.format, { width, height, fps: s.fps, transparent: info.alpha && background === null });
  const frame = new Uint8ClampedArray(width * height * 4);
  try {
    for (let f = 0; f < total; f++) {
      if (signal.aborted) throw new DOMException('書き出しを中止しました', 'AbortError');
      if (samples) {
        const smp = samples[at(f * stepsPerFrame)];
        // ループ再生の記録は画角を持たないので、今の画角で描く
        camera = wrap ? { ...smp.camera, fov: project.camera.fov } : smp.camera;
      }
      ctx.applySwing(world, doc);
      try { ctx.stage.renderFrame(width, height, camera, background, frame); }
      catch (e) { checkContext(); if ((e as Error).name === 'ContextLostError') throw new Error(CONTEXT_LOST_MESSAGE); throw e; }
      checkContext();
      await encoder.addFrame(frame, f);
      for (let k = 0; k < stepsPerFrame; k++) {
        if (samples) applySample(world, samples[at(f * stepsPerFrame + k)]);
        world.step(doc.layers);
      }
      onProgress(f + 1, total);
      if (f % 4 === 3) await new Promise(r => setTimeout(r, 0));
    }
    checkContext();
    const blob = await encoder.finish();
    return { blob, filename: fileName(doc.name, info.ext), frames: total };
  } catch (e) {
    await encoder.cancel();
    throw e;
  }
}

const fileName = (name: string, ext: string) => `${(name || 'pukupop').replace(/\.[^.]+$/, '')}.${ext}`;

/** 今の視点・今画面に出ている揺れの状態を1枚の PNG にする。長さ・fps・動きの元は使わない */
async function exportStill(ctx: ExportContext, width: number, height: number, background: string | null, name: string): Promise<ExportResult> {
  if (!ctx.currentShot) throw new Error('静止画を書き出せません');
  const camera = ctx.currentShot();
  const encoder = createEncoder('still', { width, height, fps: 1, transparent: background === null });
  let rgba: Uint8ClampedArray;
  try { rgba = ctx.stage.renderFrame(width, height, camera, background); }
  catch (e) { if ((e as Error).name === 'ContextLostError') throw new Error(CONTEXT_LOST_MESSAGE); throw e; }
  await encoder.addFrame(rgba, 0);
  return { blob: await encoder.finish(), filename: fileName(name, FORMAT_INFO.still.ext), frames: 1 };
}
