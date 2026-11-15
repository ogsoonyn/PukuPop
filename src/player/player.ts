/**
 * 埋め込み用の再生専用の部品(Player、Issue #127)。編集 UI を持たず、.pukupop のバイト列を受けて、渡されたキャンバスに揺れたまま描く。
 *
 * 埋め込み先を壊さないための約束:
 * - 渡されたキャンバスの外に触らない。window・document に受け口を付けず、キャンバスの親要素のクラス・スタイルも触らない
 *   (背景は WebGL の消去の色だけ)。CSS・service worker・IndexedDB・localStorage を使わない。
 * - console へは失敗のときだけ出す。
 * - 読めないファイル・新しい版のファイルは、読み込み(storage/popstage.ts)のメッセージのまま理由付きで失敗する。Player だけの読み込みの経路は作らない。
 *
 * 物理 → 描画と、記録のループ再生は編集アプリと同じ src/playback を使う(1フレームの並びは playback/frame.ts)。
 * 編集アプリの部品(App・src/app・アンドゥ・書き出し・src/ui の画面の部品)は使わない。
 */
import { Stage, type ViewOptions } from '../stage/stage';
import { PhysicsWorld } from '../physics/world';
import { takeSeconds } from '../physics/take';
import { deserializeProject } from '../storage/popstage';
import { decodeForDisplay, browserDecodeGray } from '../ui/imageio';
import { applyFavoriteChanges, favoriteChanges } from '../model/favorites';
import type { Document, Project } from '../model/project';
import { StageSwing } from '../playback/stageSwing';
import { LoopPlayback } from '../playback/loopPlayback';
import { advanceSwing, feedView, preparePhysics } from '../playback/frame';
import { bindViewInput } from './viewInput';
import { loseExtension, reclaim, willRelease } from './context';

/** キャンバスの上で受ける操作。'none' は何も受けない(受け口を付けない)。'view' はドラッグで回し、Ctrl(⌘)+ホイールとピンチでズームする */
export type PlayerInteraction = 'none' | 'view';

export interface PlayerOptions {
  /**
   * 作ったらすぐ再生するか(既定 true)。記録があればループ再生し、無ければファイルの「自動で揺らす」の設定に従う
   * (切ってあるファイルは止まった絵のまま)。false なら最初の1フレームを描いて止まった状態で始め、play() で動き出す
   */
  autoplay?: boolean;
  /** キャンバスの上で受ける操作(既定 'view') */
  interaction?: PlayerInteraction;
}

export interface PlayerFavorite {
  readonly id: string;
  readonly name: string;
}

export interface PlayerInfo {
  /** 元画像の大きさ(ピクセル) */
  readonly width: number;
  readonly height: number;
  /** 記録(ループ再生する動き)の長さ(秒)。記録が無ければ 0。setFavorite で記録が入れ替わると変わる */
  readonly takeSeconds: number;
  /** ファイルに入っているお気に入り(揺れと動きの組み合わせ)。setFavorite に id を渡す */
  readonly favorites: readonly PlayerFavorite[];
}

export interface Player {
  /** ファイルの中身の要約。読むたびに今の値で作り直す */
  readonly info: PlayerInfo;
  /** 動いているか(play してから pause・dispose するまで true) */
  readonly playing: boolean;
  /** 動かす。止めていたなら、止めた姿の続きから動く(止めていた間の時間は進めない) */
  play(): void;
  /** その姿のまま止める(動画の一時停止と同じ)。止めている間は物理も描画も進めない */
  pause(): void;
  /**
   * お気に入りの揺れ・動きに切り替える(レイヤーのポップ量・重ね方・揺れ、自動揺らし、記録、画角、視点)。
   * 再生していたときに残したお気に入りなら、記録をループ再生する。動いているか止めているかは変えない。
   * 知らない id なら何もせず false を返す
   */
  setFavorite(id: string): boolean;
  /**
   * キャンバスの大きさが変わったら呼ぶ。引数があればキャンバスの CSS の大きさ(px)をその値にし、無ければ今の大きさを読み直す。
   * 画面の倍率(devicePixelRatio)もここで読み直す。止めているときは描き直す
   */
  resize(width?: number, height?: number): void;
  /** 描画を止め、受け口を外し、WebGL のコンテキストまで手放す。2回目以降と、そのあとのメソッドの呼び出しは何もしない */
  dispose(): void;
}

/** 表示用の画像の長い辺の上限(編集アプリと同じ) */
const DISPLAY_MAX = 4096;

/** 重ね表示・グリッドなどの編集のための表示は使わない */
const VIEW: ViewOptions = { overlay: false, overlayAll: false, grid: false, fade: false, flat: false, multi: false };

/**
 * .pukupop のバイト列を読み、canvas に描く Player を作る。読めないファイル・新しい版のファイルは理由付きで失敗する
 * (失敗したときは、作りかけの描画を解放してから失敗する)
 */
export async function createPlayer(canvas: HTMLCanvasElement, bytes: Uint8Array | ArrayBuffer, options: PlayerOptions = {}): Promise<Player> {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // 読み込みは編集アプリと同じ(storage/popstage.ts の「読み込むファイルは信用しない」をそのまま守る)
  const { project } = await deserializeProject(data, { decodeFallback: browserDecodeGray });
  const doc = project.documents[0];
  if (!doc) throw new Error('プロジェクトに画像が入っていません');
  await reclaim(canvas);
  const stage = new Stage(canvas);
  const ext = loseExtension(stage.renderer.getContext());
  try {
    const image = await decodeForDisplay(doc.image, Math.min(DISPLAY_MAX, stage.maxTextureSize));
    return new PlayerImpl(canvas, stage, ext, project, doc, image, options);
  } catch (e) {
    willRelease(canvas, ext);
    stage.dispose();
    throw e;
  }
}

class PlayerImpl implements Player {
  private readonly world = new PhysicsWorld();
  private readonly swing: StageSwing;
  private readonly loop: LoopPlayback;
  private readonly unbind: (() => void) | null = null;
  /** 描画ループの予約(動いている間)と、止めている間の1回だけの描き直しの予約 */
  private raf = 0;
  private redraw = 0;
  private prev = 0;
  private running = false;
  private disposed = false;
  /** 記録をループ再生するか(記録があれば作ったときは true。お気に入りを当てると、その印に合わせる) */
  private loopWanted: boolean;
  /** 描画ループの中の例外は、最初の1回だけ console に出す(毎フレーム溢れないように) */
  private reported = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly stage: Stage,
    private readonly ext: WEBGL_lose_context | null,
    private readonly project: Project,
    private readonly doc: Document,
    image: HTMLCanvasElement,
    options: PlayerOptions,
  ) {
    this.swing = new StageSwing(stage, { doc, centers: new Map() });
    // 状態が変わった知らせを聞く部品は無い(Player は LoopPlayback を外に見せない)
    this.loop = new LoopPlayback(this.world, stage, () => project, { stateChanged: () => {}, viewChanged: () => {} });
    // 編集アプリの applyDocument と同じ並び。背景はキャンバスの親要素に付けず、消去の色だけにする
    stage.setImage(image, doc.image.width, doc.image.height);
    stage.rebuildMesh(doc.meshDensity);
    stage.setTransform(doc);
    stage.setLayers(doc.layers);
    stage.setView(VIEW, []);
    stage.setBackground(project.background);
    preparePhysics(this.world, doc, this.swing.centerOf);
    stage.resize();
    // 失われている間は描かない(frame が飛ばす)。戻ったら、止めているときも1回描き直す
    stage.onContextChange = lost => { if (!lost) this.requestRender(); };
    if (options.interaction !== 'none') this.unbind = bindViewInput(canvas, () => project.camera, () => this.requestRender());
    this.loopWanted = !!project.take;
    // 最初の1フレームはすぐ描く(止めて始めるときも、絵が出ているように)
    if (this.loopWanted) this.loop.play();
    this.guarded(() => this.frame(0));
    if (options.autoplay !== false) this.play();
  }

  get info(): PlayerInfo {
    const { project: p, doc } = this;
    return {
      width: doc.image.width, height: doc.image.height,
      takeSeconds: takeSeconds(p.take),
      favorites: p.favorites.map(f => ({ id: f.id, name: f.name })),
    };
  }

  get playing(): boolean { return this.running; }

  play(): void {
    if (this.disposed || this.running) return;
    if (this.loopWanted && this.project.take && !this.loop.playing) this.loop.play();
    this.running = true;
    // 止めていた間の時間は1刻みの動きにしない。止めている間に回した視点の飛びでも弾ませない
    this.prev = 0;
    this.world.cutView();
    if (this.redraw) { cancelAnimationFrame(this.redraw); this.redraw = 0; }
    this.raf = requestAnimationFrame(this.tick);
  }

  pause(): void {
    if (this.disposed || !this.running) return;
    // 物理の状態・ループ再生の位置はそのまま残す(揺れの途中の姿で止まり、play で続きから動く)
    this.running = false;
    cancelAnimationFrame(this.raf); this.raf = 0;
  }

  setFavorite(id: string): boolean {
    if (this.disposed) return false;
    const { project, doc } = this, f = project.favorites.find(x => x.id === id);
    if (!f) return false;
    // 編集アプリの applyFavorite と同じ: 再生をやめ、同じ関数で求めた差分を当て(アンドゥは通さない)、視点が飛ぶだけなので揺らさない
    this.loop.stop();
    const ch = favoriteChanges(f, project, doc);
    for (const layerId of applyFavoriteChanges(project, doc, ch)) {
      const i = doc.layers.findIndex(l => l.id === layerId);
      if (i >= 0) this.stage.setLayerParams(i, doc.layers[i]);
    }
    this.world.cutView();
    this.loopWanted = ch.play && !!project.take;
    if (this.loopWanted) this.loop.play();
    this.requestRender();
    return true;
  }

  resize(width?: number, height?: number): void {
    if (this.disposed) return;
    const px = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? `${v}px` : null);
    const w = px(width), h = px(height);
    if (w !== null) this.canvas.style.width = w;
    if (h !== null) this.canvas.style.height = h;
    this.stage.resize();
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.raf); cancelAnimationFrame(this.redraw);
    this.raf = this.redraw = 0;
    this.unbind?.();
    this.loop.discard();
    // 同じキャンバスで作り直せるよう、手放す前に控える(player/context.ts)
    willRelease(this.canvas, this.ext);
    this.stage.dispose();
  }

  /** 止めているときに、物理を進めず1回だけ描き直す(視点を動かした・大きさが変わった・お気に入りを当てたなど)。動いている間は次のフレームで描かれる */
  private requestRender(): void {
    if (this.disposed || this.running || this.redraw) return;
    this.redraw = requestAnimationFrame(() => { this.redraw = 0; this.guarded(() => this.frame(0)); });
  }

  private tick = (now: number): void => {
    // 次のフレームを先に予約し、例外が出てもループが止まらないようにする(編集アプリと同じ)
    this.raf = requestAnimationFrame(this.tick);
    this.guarded(() => {
      const raw = this.prev ? (now - this.prev) / 1000 : 0, dt = Math.min(raw, 0.1);
      // 物理は 0.1 秒で打ち切るので、その間の視点の動きを1刻みの動きとして扱うと強く弾みすぎる。測り直す
      if (raw > 0.1) this.world.cutView();
      this.prev = now;
      this.frame(dt);
    });
  };

  private guarded(f: () => void): void {
    try { f(); } catch (e) {
      if (!this.reported) { this.reported = true; console.error(e); }
    }
  }

  /** 刻みごとの入力。ループ再生中は記録どおりに、そうでなければ今の視点を物理へ入れる */
  private step = (): void => { if (!this.loop.step()) feedView(this.world, this.project.camera); };

  /** 1フレーム(playback/frame.ts の並び)。dt が 0 なら物理は進まず、今の姿を描き直す */
  private frame(dt: number): void {
    if (this.disposed || this.stage.contextLost) return;
    advanceSwing(dt, this.world, this.swing, this.project.autoSwing, this.doc, this.step);
    this.loop.applyRig();
    this.stage.render(this.project.camera);
  }
}
