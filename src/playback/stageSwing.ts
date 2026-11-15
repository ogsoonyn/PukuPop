/**
 * 物理の結果を描画(Stage)へ当てるつなぎ。レイヤーごとの揺れ・塗った範囲の広がり・画像全体のずれ(ピストン)を入れる。
 * 編集アプリ(App)と、編集 UI を持たない再生専用の部品(Issue #127)で共有するため、App・アンドゥ・タブ・DOM には依存しない。
 * 今のドキュメントと重心の控えの置き場所は、PlaybackScene で受ける(App ではタブごとに持つ)。
 */
import type { Document, Layer, Vec3 } from '../model/project';
import type { PhysicsWorld } from '../physics/world';
import type { PlaybackStage } from './stageApi';

/** 画像全体のずれ(ピストン)の飛びをならす時定数(秒)。自動揺らしの切り替えや、塗り終わりで止めていた画像を戻すとき */
export const BASE_EASE = 0.05;

/** つなぎが読む外の世界。今のドキュメントと、レイヤーごとの重心の控え */
export interface PlaybackScene {
  readonly doc: Document | undefined;
  /** レイヤーごとのウェイトの重心(元画像のピクセル、塗った範囲の広がりの中心)。ウェイトが変わったら持ち主が捨てる */
  readonly centers: Map<string, { x: number; y: number }>;
}

/** 画面に出している画像全体のずれの状態 */
export interface BaseState {
  /** 画面に出している値(元画像のピクセル) */
  shown: Vec3;
  /** 物理から求めた、ならす前の値 */
  live: Vec3;
  /** 設定の切り替えで飛んだ分。BASE_EASE で 0 へ戻していく */
  fix: Vec3;
  /** 飛びを見分ける印(動かすレイヤーとその設定・自動揺らしの周期と強さ) */
  key: string;
  /** 止めている間の値(holdImage) */
  held: Vec3 | null;
}

export function freshBase(): BaseState {
  return { shown: { x: 0, y: 0, z: 0 }, live: { x: 0, y: 0, z: 0 }, fix: { x: 0, y: 0, z: 0 }, key: '', held: null };
}

export class StageSwing {
  /**
   * 画面に出している画像全体のずれ(ピストン、元画像のピクセル)。ライブ表示だけの値で、物理と書き出しには関わらない。
   * 塗り・膨らませる範囲のドラッグ中は止めて(held)、当たり判定がずれないようにする。設定の切り替えで飛ぶ分は fix でならす
   */
  base: BaseState = freshBase();

  constructor(private readonly stage: PlaybackStage, private readonly scene: PlaybackScene) {}

  /** 画像全体のずれを初めからにする(画像全体のずれは前の画像のピクセル単位なので、別の画像へ持ち越さない) */
  resetBase(): void { this.base = freshBase(); }

  /** 揺れを Stage へ当てる。書き出しでも、書き出し専用の物理を渡して同じ処理を使う */
  applySwing = (world: PhysicsWorld, doc: Document): void => {
    const k = Math.max(doc.image.width, doc.image.height) / 2;
    doc.layers.forEach((l, i) => {
      const s = world.displacement(l.id), on = l.visible && l.physics.enabled;
      this.stage.setSwing(i, { x: s.x * k, y: s.y * k, z: s.z * k }, on);
      // 塗った範囲の広がり(ためて膨らむ2 など、physics/motion.ts の SPREAD_MOTIONS)。重心はウェイトが変わったときだけ求め直す
      const r = world.spread(l.id);
      this.stage.setSpread(i, r ? this.layerCenter(doc, l) : { x: 0, y: 0 }, r, on);
    });
    // 画像全体の動き(揺らし方「ピストン」)。一時停止中・自動揺らしが切れているときは 0
    const g = world.baseOffset(doc.layers);
    this.stage.setBaseOffset({ x: g.x * k, y: g.y * k, z: g.z * k });
  };

  /** 物理に渡すレイヤーの重心(正規化座標)。回転で揺れる大きさを決める */
  centerOf = (l: Layer): { x: number; y: number } => {
    const doc = this.scene.doc;
    if (!doc) return { x: 0, y: 0 };
    const c = this.layerCenter(doc, l), k = Math.max(doc.image.width, doc.image.height) / 2;
    return { x: c.x / k, y: c.y / k };
  };

  /** レイヤーのウェイトの重心(画像のローカル座標、元画像のピクセル) */
  layerCenter(doc: Document, l: Layer): { x: number; y: number } {
    const centers = this.scene.centers;
    let c = centers.get(l.id);
    if (!c) {
      const { u, v } = l.weights.centroidUV();
      centers.set(l.id, (c = { x: (u - 0.5) * doc.image.width, y: (v - 0.5) * doc.image.height }));
    }
    return c;
  }

  /** 静止画の書き出し用。今見えている揺れを Stage へ戻す。画像全体の動き(ピストン)は、画面と同じく showBase でならした値にする */
  applyShown(world: PhysicsWorld, doc: Document): void {
    this.applySwing(world, doc);
    this.stage.setBaseOffset(this.base.shown);
  }

  /**
   * 画像全体のずれ(ピストン)を画面上で止める / 戻す。塗りや膨らませる範囲のドラッグの間、当たり判定(pick)が
   * 画像の動きでずれないようにする。物理はそのまま進む。戻すときは、止めていた所から BASE_EASE でならして動きに戻す
   */
  holdImage(on: boolean): void {
    const b = this.base;
    if (on) { b.held ??= { ...b.shown }; return; }
    if (!b.held) return;
    b.fix = { x: b.held.x - b.live.x, y: b.held.y - b.live.y, z: b.held.z - b.live.z };
    b.held = null;
  }

  /** 画像全体が画面上で元の位置からずれているか(平らに表示しているかは見ない。それは持ち主が見る) */
  get shifted(): boolean { const s = this.base.shown; return s.x !== 0 || s.y !== 0 || s.z !== 0; }

  /** ライブ表示の画像全体のずれを決めて Stage へ入れる(applySwing の後に呼ぶ) */
  showBase(dt: number, world: PhysicsWorld, doc: Document): void {
    const w = world, b = this.base, k = Math.max(doc.image.width, doc.image.height) / 2, g = w.baseOffset(doc.layers);
    const live = { x: g.x * k, y: g.y * k, z: g.z * k };
    // 自動揺らし・一時停止・周期・強さ・動かすレイヤーとその設定が変わると、画像が飛ぶ。その差を fix に入れてならす
    const d = w.baseDriver(doc.layers), a = w.autoSwing;
    const key = d ? `${d.id}|${a.period}|${a.strength}|${JSON.stringify(d.physics.motionParams)}` : '';
    if (key !== b.key) { b.fix.x += b.live.x - live.x; b.fix.y += b.live.y - live.y; b.fix.z += b.live.z - live.z; b.key = key; }
    const e = Math.exp(-dt / BASE_EASE);
    b.fix.x *= e; b.fix.y *= e; b.fix.z *= e;
    if (Math.abs(b.fix.x) + Math.abs(b.fix.y) + Math.abs(b.fix.z) < 0.05) b.fix = { x: 0, y: 0, z: 0 };
    b.live = live;
    b.shown = b.held ? { ...b.held } : { x: live.x + b.fix.x, y: live.y + b.fix.y, z: live.z + b.fix.z };
    this.stage.setBaseOffset(b.shown);
    this.stage.setBaseReach(w.baseReach(doc.layers) * k);
  }
}
