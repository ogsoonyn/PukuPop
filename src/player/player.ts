/**
 * 埋め込み用の再生専用の部品(Player、Issue #127)。編集 UI を持たず、.pukupop のバイト列を受けて、渡されたキャンバスに揺れたまま描く。
 *
 * 埋め込み先を壊さないための約束:
 * - 渡されたキャンバスの外に触らない。window・document に受け口を付けず、キャンバスの親要素のクラス・スタイルも触らない
 *   (背景は WebGL の消去の色だけ)。CSS・service worker・IndexedDB・localStorage を使わない。
 *   大きさを追う ResizeObserver は、キャンバスの要素だけを見る。
 * - console へは失敗のときだけ出す。
 * - 読めないファイル・新しい版のファイルは、読み込み(storage/popstage.ts)のメッセージのまま、code 付きの PlayerError で失敗する。
 *   Player だけの読み込みの経路は作らない。
 * - 埋め込み先に見せるのは API(Player の型のメンバー)だけ。中身(描画・物理・プロジェクト)は返したオブジェクトから辿れない。
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
import { claimCanvas } from './context';
import { PlayerError, abortedError, loadError } from './errors';

export { PlayerError } from './errors';
export type { PlayerErrorCode } from './errors';

/** キャンバスの上で受ける操作。'none' は何も受けない(受け口を付けない)。'view' はドラッグで回し、Ctrl(⌘)+ホイールとピンチでズームする */
export type PlayerInteraction = 'none' | 'view';

export interface PlayerOptions {
  /**
   * 作ったらすぐ再生するか(既定 true)。記録があればループ再生し、無ければファイルの「自動で揺らす」の設定に従う
   * (切ってあるファイルは止まった絵のまま)。false なら最初の1フレームを描いて止まった状態で始め、play() で動き出す
   */
  autoplay?: boolean;
  /**
   * キャンバスの上で受ける操作(既定 'view')。'view' のときは、キャンバスに CSS の touch-action: none と cursor: grab を付ける
   * (1本指の縦の動きも回すのに使うので、キャンバスの上から指で縦にスクロールできなくなる。dispose() で元に戻す)
   */
  interaction?: PlayerInteraction;
  /**
   * キャンバスの大きさの変化を自動で追うか(既定 true)。キャンバスの要素だけを ResizeObserver で見て、描画の大きさ・縦横比を合わせる。
   * キャンバスの CSS の大きさは決して書かない。キャンバスの大きさは埋め込み先が CSS で決める(例: width: 100%; aspect-ratio: 4 / 3)。
   * CSS で決めていない(width・height の属性に任せた)キャンバスでも大きさは変わらずに動くが、画面の倍率を掛けた高精細では描かない。
   * false のときは、大きさが変わったら resize() を呼ぶ。大きさ 0(display: none など)のまま作った場合は、resize() を呼ぶまで正しく描けない
   */
  autoResize?: boolean;
  /**
   * 読み込みの取り消し。createPlayer の読み込み・デコードの間に abort されると、code 'aborted' の PlayerError で失敗する
   * (呼ぶ前から abort 済みなら何もせずに失敗する)。取り消したキャンバスは、そのまま次の createPlayer に使える
   * (React の StrictMode で effect が2回走っても、同じキャンバスで作り直せる)。
   * Player が返ったあとの abort は何もしない(返ったあとは dispose() で捨てる)
   */
  signal?: AbortSignal;
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
  /**
   * ファイルの中身の要約。凍結したオブジェクトで、中身が変わるとき(setFavorite)だけ別のオブジェクトに差し替わる
   * (変わっていなければ毎回同じオブジェクトなので、React の依存配列などにそのまま入れてよい)
   */
  readonly info: PlayerInfo;
  /**
   * 動かす状態か(pause() していないか。play() してから pause()・dispose() するまで true)。
   * 絵が実際に動いているかではない(自動で揺らすが切れていて記録も無いファイルでも、視点を回した勢いで揺れるので true のまま)
   */
  readonly playing: boolean;
  /** 動かす。止めていたなら、止めた姿の続きから動く(止めていた間の時間は進めない) */
  play(): void;
  /** その姿のまま止める(動画の一時停止と同じ)。止めている間は物理も描画も進めない(視点の操作と大きさの変化では1回描き直す) */
  pause(): void;
  /**
   * お気に入りの揺れ・動きに切り替える(レイヤーのポップ量・重ね方・揺れ、自動揺らし、記録、画角、視点)。
   * 再生していたときに残したお気に入りなら、記録をループ再生する。動いているか止めているかは変えない。
   * 知らない id なら何もせず false を返す
   */
  setFavorite(id: string): boolean;
  /**
   * キャンバスの大きさと画面の倍率(devicePixelRatio)を測り直す。CSS の大きさは書かない。
   * autoResize: false のときと、倍率だけが変わったとき(ウィンドウを別のモニターへ移したなど)に呼ぶ。止めているときは描き直す
   */
  resize(): void;
  /**
   * 描画を止め、受け口を外し、WebGL のコンテキストまで手放す。2回目以降と、そのあとのメソッドの呼び出しは何もしない。
   * 手放したキャンバスは使い回せない(次の createPlayer には新しい <canvas> を渡す。React なら <canvas key={id} /> など)
   */
  dispose(): void;
}

/** 表示用の画像の長い辺の上限(編集アプリと同じ) */
const DISPLAY_MAX = 4096;

/** 重ね表示・グリッドなどの編集のための表示は使わない */
const VIEW: ViewOptions = { overlay: false, overlayAll: false, grid: false, fade: false, flat: false, multi: false };

const IN_USE = 'このキャンバスはほかの Player が使っています。先に dispose() するか、新しい canvas を渡してください。';
const LOST = 'このキャンバスはもう使えません。新しい canvas を渡してください。';
const OTHER_USE = 'このキャンバスはほかの用途(2D の描画など)で使われています。新しい canvas を渡してください。';

/**
 * .pukupop のバイト列を読み、canvas に描く Player を作る。失敗したときは code 付きの PlayerError で失敗する
 * (作りかけの描画を解放し、キャンバスを使っている最中の印も外してから)。
 * キャンバスの大きさは CSS で決める(例: width: 100%; aspect-ratio: 4 / 3)。CSS で決めていないキャンバスでも動くが、高精細では描かない。
 *
 * await は読み込み(deserializeProject)と画像のデコードだけで、どちらも WebGL を作る前に済ませる。
 * WebGL を作ってから返すまでは await を挟まないので、取り消し・読み込みの失敗ではキャンバスは使えるまま残る
 */
export async function createPlayer(canvas: HTMLCanvasElement, bytes: Uint8Array | ArrayBuffer, options: PlayerOptions = {}): Promise<Player> {
  const { signal } = options;
  if (signal?.aborted) throw abortedError(signal.reason);
  // 印は最初の await より前に付ける(同じキャンバスで2つ目が読み込み中に始まっても重なりが分かるように。player/context.ts)
  const release = claimCanvas(canvas);
  if (!release) throw new PlayerError('canvas-unusable', IN_USE);
  // 取り消されたら、読み込みの終わりを待たずにすぐ印を外す(同じキャンバスですぐ次を作れるように)
  const onAbort = () => release();
  signal?.addEventListener('abort', onAbort, { once: true });
  const checkAbort = () => { if (signal?.aborted) throw abortedError(signal.reason); };
  let created = false;
  try {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // 読み込みは編集アプリと同じ(storage/popstage.ts の「読み込むファイルは信用しない」をそのまま守る)
    let project: Project;
    try {
      ({ project } = await deserializeProject(data, { decodeFallback: browserDecodeGray }));
    } catch (e) { checkAbort(); throw loadError(e); }
    checkAbort();
    const doc = project.documents[0];
    if (!doc) throw new PlayerError('invalid-file', 'プロジェクトに画像が入っていません');
    let image: HTMLCanvasElement;
    try {
      image = await decodeForDisplay(doc.image, DISPLAY_MAX);
    } catch (e) { checkAbort(); throw loadError(e); }
    checkAbort();
    // ここから返すまで await を挟まない(取り消しで WebGL を作りかけのまま捨てる道を無くす)
    const stage = createStage(canvas);
    try {
      const impl = new PlayerImpl(canvas, stage, project, doc, fitTexture(image, stage.maxTextureSize), options, release);
      created = true;
      return impl.api;
    } catch (e) {
      stage.dispose();
      throw e instanceof PlayerError ? e : new PlayerError('invalid-file', e instanceof Error && e.message ? e.message : 'ファイルを表示できませんでした', { cause: e });
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!created) release();
  }
}

/**
 * 描画(three.js の WebGLRenderer)を作る。コンテキストが失われているキャンバス(dispose() した・ほかのライブラリが手放した)は断る。
 * 先に自分で getContext を呼んで確かめると three.js と違う属性で作られてしまうので、作ってから確かめる
 */
function createStage(canvas: HTMLCanvasElement): Stage {
  let stage: Stage;
  // three.js は作るときに描画バッファ(属性)を倍率倍にする。大きさを属性に任せたキャンバスでは見た目の大きさまで変わり、
  // 最初に測る大きさ(PlayerImpl の measure)がずれるので、作ったら元の属性に戻す
  const attrs = [canvas.width, canvas.height];
  try {
    stage = new Stage(canvas);
    if (canvas.width !== attrs[0] || canvas.height !== attrs[1]) { canvas.width = attrs[0]; canvas.height = attrs[1]; }
  } catch (e) {
    throw unusableOrUnavailable(canvas, e);
  }
  if (stage.renderer.getContext().isContextLost()) {
    stage.dispose();
    throw new PlayerError('canvas-unusable', LOST);
  }
  return stage;
}

/**
 * three.js が投げたときに、このキャンバスが使えないのか、この環境で WebGL2 を作れないのかを見分ける。
 * - すでに WebGL2 のコンテキストがあり、失われている: 使えないキャンバス(ほかのライブラリが手放した)
 * - getContext('webgl2') が null: 2D・WebGL1 などほかの種類で使われているか、WebGL2 を作れない環境。
 *   文書につないでいない使い捨ての <canvas> で WebGL2 を作れるか確かめ、作れればこのキャンバスがほかの用途で使われている
 *   (使い捨ての canvas は文書に足さないので、キャンバスの外には触らない。作ったコンテキストはすぐ手放す)
 * ここでの getContext は、すでにコンテキストがあればそれを返すだけで、新しくは作らない(three.js が作れなかったキャンバスなので)
 */
function unusableOrUnavailable(canvas: HTMLCanvasElement, cause: unknown): PlayerError {
  const unavailable = new PlayerError('webgl-unavailable', 'WebGL2 を使えないため、表示できません。', { cause });
  let gl: WebGL2RenderingContext | null = null;
  try { gl = canvas.getContext('webgl2'); } catch { return unavailable; }
  if (gl) return gl.isContextLost() ? new PlayerError('canvas-unusable', LOST, { cause }) : unavailable;
  let probe: WebGL2RenderingContext | null = null;
  try { probe = canvas.ownerDocument.createElement('canvas').getContext('webgl2'); } catch { /* 作れない */ }
  if (!probe) return unavailable;
  probe.getExtension('WEBGL_lose_context')?.loseContext();
  return new PlayerError('canvas-unusable', OTHER_USE, { cause });
}

/** 表示用の画像を、この環境のテクスチャの上限に収める(上限は WebGL を作るまで分からないので、デコードは DISPLAY_MAX で済ませておく) */
function fitTexture(image: HTMLCanvasElement, max: number): HTMLCanvasElement {
  const s = max / Math.max(image.width, image.height);
  if (!(s < 1)) return image;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(image.width * s)); c.height = Math.max(1, Math.round(image.height * s));
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(image, 0, 0, c.width, c.height);
  return c;
}

/** 返した API から中身を引く(確認用のページの E2E だけが使う。入口 index.ts からは出さない) */
const internals = new WeakMap<Player, PlayerImpl>();

/**
 * 確認用のページ(demo.ts)と E2E のための、中身(描画・物理・プロジェクト・ループ再生)を覗く口。文書には載せず、入口からも出さない
 * @internal
 */
export function inspect(player: Player): unknown {
  return internals.get(player);
}

class PlayerImpl {
  /** 埋め込み先に返す API だけのオブジェクト */
  readonly api: Player;
  readonly world = new PhysicsWorld();
  readonly swing: StageSwing;
  readonly loop: LoopPlayback;
  private readonly unbind: (() => void) | null = null;
  private readonly observer: ResizeObserver | null = null;
  /** 描画ループの予約(動いている間)と、止めている間の1回だけの描き直しの予約 */
  private raf = 0;
  private redraw = 0;
  /** ResizeObserver の通知を受けて、次のフレームで大きさを当てる予約 */
  private fitRaf = 0;
  private prev = 0;
  private running = false;
  private disposed = false;
  /** 記録をループ再生するか(記録があれば作ったときは true。お気に入りを当てると、その印に合わせる) */
  private loopWanted: boolean;
  /** 描画ループの中の例外は、最初の1回だけ console に出す(毎フレーム溢れないように) */
  private reported = false;
  /** 今の info(凍結。作ったときと setFavorite のときだけ作り直す) */
  private infoNow!: PlayerInfo;
  /** 最後に描画へ当てた大きさ(CSS px)と倍率。変わっていなければ描き直さない */
  private size = { w: -1, h: -1, dpr: -1 };
  /** キャンバスの大きさが CSS でなく属性で決まっていると判断したか(measure)。true なら倍率を掛けずに描く */
  private attributeSized = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    readonly stage: Stage,
    readonly project: Project,
    readonly doc: Document,
    image: HTMLCanvasElement,
    options: PlayerOptions,
    /** キャンバスを使っている最中の印を外す(dispose で) */
    private readonly release: () => void,
  ) {
    this.swing = new StageSwing(stage, { doc, centers: new Map() });
    // 状態が変わった知らせを聞く部品は無い(Player は LoopPlayback を外に見せない)
    this.loop = new LoopPlayback(this.world, stage, () => project, { stateChanged: () => {}, viewChanged: () => {} });
    // 途中で投げたら、それまでに付けた受け口・ResizeObserver・キャンバスのスタイル・予約したフレームを外してから投げ直す
    // (描画の解放と印を外すのは createPlayer の側)
    try {
      // 編集アプリの applyDocument と同じ並び。背景はキャンバスの親要素に付けず、消去の色だけにする
      stage.setImage(image, doc.image.width, doc.image.height);
      stage.rebuildMesh(doc.meshDensity);
      stage.setTransform(doc);
      stage.setLayers(doc.layers);
      stage.setView(VIEW, []);
      stage.setBackground(project.background);
      preparePhysics(this.world, doc, this.swing.centerOf);
      this.measure();
      // 失われている間は描かない(frame が飛ばす)。戻ったら、止めているときも1回描き直す
      stage.onContextChange = lost => { if (!lost) this.requestRender(); };
      if (options.interaction !== 'none') this.unbind = bindViewInput(canvas, () => project.camera, () => this.requestRender());
      // 大きさはキャンバスの要素だけを見て追う(大きさ 0 で作っても、大きさが付いた時点で正しい縦横比で描く)。
      // 通知の中では大きさを当てず、次のフレームに回す(scheduleFit)。CSS の大きさは書かない
      if (options.autoResize !== false && typeof ResizeObserver === 'function') {
        this.observer = new ResizeObserver(() => this.scheduleFit());
        this.observer.observe(canvas);
      }
      this.loopWanted = !!project.take;
      this.makeInfo();
      // 最初の1フレームはすぐ描く(止めて始めるときも、絵が出ているように)
      if (this.loopWanted) this.loop.play();
      this.guarded(() => this.frame(0));
      if (options.autoplay !== false) this.play();

      const self = this;
      this.api = Object.freeze({
        get info() { return self.infoNow; },
        get playing() { return self.running; },
        play: () => this.play(),
        pause: () => this.pause(),
        setFavorite: (id: string) => this.setFavorite(id),
        resize: () => this.fit(),
        dispose: () => this.dispose(),
      });
      internals.set(this.api, this);
    } catch (e) {
      this.detach();
      throw e;
    }
  }

  private makeInfo(): void {
    const { project: p, doc } = this;
    this.infoNow = Object.freeze({
      width: doc.image.width, height: doc.image.height,
      takeSeconds: takeSeconds(p.take),
      favorites: Object.freeze(p.favorites.map(f => Object.freeze({ id: f.id, name: f.name }))),
    });
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
    this.makeInfo();
    this.requestRender();
    return true;
  }

  /**
   * ResizeObserver の通知を受けて、大きさを当てるのを次のフレームに回す(1フレームに1回にまとめる)。
   * 通知の中で描画バッファを変えると、幅だけ CSS で決めて高さを属性に任せたキャンバスでは CSS の高さが端数のぶん変わり、
   * その変化の通知がそのループで届かず、ブラウザが window に「ResizeObserver loop completed with undelivered notifications」の
   * error イベントを出す(埋め込み先の window.onerror に拾われうる)。フレームの中で当てれば、変化は次の通知で届くだけで済む
   */
  private scheduleFit(): void {
    if (this.disposed || this.fitRaf) return;
    this.fitRaf = requestAnimationFrame(() => { this.fitRaf = 0; this.fit(); });
  }

  /** 大きさと倍率を測り直し、変わっていれば描画へ当てて描き直す(止めているときも) */
  private fit(): void {
    if (this.disposed) return;
    if (!this.measure()) return;
    // 描画バッファの大きさを変えると中身が消えるので、待たずに描き直す(次のフレームまで透けて見えないように)。
    // 動いているときは、このフレームの描画が済んでいても描き直す(物理は進めない)
    if (this.redraw) { cancelAnimationFrame(this.redraw); this.redraw = 0; }
    this.guarded(() => this.frame(0));
  }

  /**
   * 今の大きさと倍率を描画へ当てる。変わったら true(大きさ 0 の間は当てない)。
   * 描画バッファ(canvas.width / height)だけを変え、CSS は書かない。ただし、キャンバスの CSS の大きさを埋め込み先が CSS で
   * 決めていない(属性に任せている)と、描画バッファを倍率倍にするとキャンバスの見た目の大きさも変わり、通知のたびに
   * 大きくなり続ける(倍率 2)・縮み続ける(倍率 0.9)。そこで、当てたあとに CSS の大きさを読み直し、自分の書き換えで 1px を
   * 超えて変わったら「大きさは属性で決まっている」と判断して、測った CSS の大きさをそのまま描画バッファにする(倍率を掛けない。
   * 高精細ではなくなるが、大きさは元のまま止まる)。一度そう判断したら、以後も倍率を掛けない。
   * 幅だけ CSS で決めて高さを属性に任せたキャンバスは、縦横比が保たれ、丸めの 1px 以内しか変わらないので、倍率を掛けたまま描く
   */
  private measure(): boolean {
    const c = this.canvas, w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1, s = this.size;
    if (w === s.w && h === s.h && dpr === s.dpr) return false;
    this.size = { w, h, dpr };
    if (!w || !h) return true; // 大きさ 0 の間は当てない(Stage.resize も何もしない)
    if (this.attributeSized) { this.stage.resize(1); return true; }
    this.stage.resize(); // renderer.setSize(w, h, false): 描画バッファを CSS の大きさ × 倍率にする
    if (Math.abs(c.clientWidth - w) > 1 || Math.abs(c.clientHeight - h) > 1) {
      this.attributeSized = true;
      // 属性を測った CSS の大きさに戻せば、見た目の大きさも元に戻る。three.js の側の大きさ・倍率も合わせる
      c.width = w; c.height = h;
      this.stage.resize(1);
    }
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.detach();
    this.stage.dispose();
    // コンテキストを手放したので、このキャンバスは印を外しても使えない(次の createPlayer は 'canvas-unusable' で断る)
    this.release();
  }

  /** 描画を止め、予約したフレームを取り消し、ResizeObserver とキャンバスの受け口・スタイルを外す(dispose と、作る途中の失敗で) */
  private detach(): void {
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.raf); cancelAnimationFrame(this.redraw); cancelAnimationFrame(this.fitRaf);
    this.raf = this.redraw = this.fitRaf = 0;
    this.observer?.disconnect();
    this.unbind?.();
    this.loop.discard();
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
