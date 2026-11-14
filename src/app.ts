/**
 * アプリ本体。モデル・コマンド・描画・物理・保存・書き出しをつなぐ。
 * 画面の部品(ui/)はここを経由して状態を読み書きする。
 */
import { Store, createProject, createDocument, createLayer, cloneLayer, meshSegments, alphaSpreadPx, frontCamera, wrapAngle, defaultOrthoView, LIMITS, PRESETS, applyPreset, type PresetName, type CameraState, type Vec3, type OrthoView, type Project, type Document, type Layer } from './model/project';
import { History, emptyHistory, shrinkHistory, type HistoryState } from './commands/history';
import type { Rect } from './model/weightmap';
import { InsertLayer, RemoveLayer, MoveLayer, WeightEdit, SetTake, SetFavorites, SetFov, PatchLayer, PatchProject, Batch, weightOperation, diffTiles } from './commands/commands';
import type { Command } from './commands/history';
import { captureFavorite, copyPhysics, sameLayer, nextFavoriteName, applyView, FAVORITE_NAME_MAX } from './model/favorites';
import { Stage, type ViewOptions } from './stage/stage';
import { PhysicsWorld, PHYSICS_DT } from './physics/world';
import { MotionRecorder, applySample, type RecordSample } from './physics/recorder';
import { finalizeTake, takeFromKeys, takeSeconds, TAKE_MAX_SECONDS, TAKE_MIN_SECONDS, KEY_SECONDS, MAX_KEYS, normalizeKeys, type ViewKey, type KeyFrame } from './physics/take';
import { Stroke, type PaintMode } from './paint/stroke';
import { inflateShape, type InflateProfile, type InflateBlend } from './paint/inflate';
import { serializeProject, serializeProjectBlob, deserializeProject, FILE_EXTENSION, type PngCacheEntry } from './storage/popstage';
import { autosave } from './storage/autosave';
import { recent, type RecentKind } from './storage/recent';
import { prefs } from './storage/prefs';
import { runExport, type ExportSettings } from './export/exporter';
import { Emitter } from './util/emitter';
import { decodeForDisplay, canvasAlpha, browserDecodeGray, fileToAsset, rgbaToPng, isProjectFile, isImageFile } from './ui/imageio';
import { createSampleDocument } from './ui/sample';
import { POP_MAX_SETTING, clampPopMax } from './ui/popSlider';
import { ask, saveFile, setBusy, toast } from './ui/dom';
import { smoothRoll } from './ui/smoothRoll';

export type Tool = 'brush' | 'erase' | 'smooth' | 'inflate' | 'grab' | 'shake' | 'view' | 'pan';
/** ウェイトを塗るツール */
export const PAINT_TOOLS: readonly Tool[] = ['brush', 'erase', 'smooth', 'inflate'];
export type PressureMode = 'strength' | 'size' | 'none';
/** 操作の記録の状態。記録中・ループ再生中・どちらでもない */
export type TakeState = 'idle' | 'recording' | 'playing';

export interface BrushOptions { size: number; strength: number; hardness: number; pressure: PressureMode }

/** 「膨らませる」の範囲。中心と幅・縦は元画像のピクセル単位(中心が原点、y は上向き) */
export interface InflateArea { x: number; y: number; w: number; h: number }
export interface InflateSettings {
  shape: 'ellipse' | 'rect';
  /** 頂上の高さ(元画像のピクセル)。null はレイヤーのポップ量と同じ */
  height: number | null;
  softness: number; // 0〜1
  /** 形の傾き(度、-90〜90)。正で時計回り */
  angle: number;
  profile: InflateProfile;
  blend: InflateBlend;
}
/** 形の傾きの範囲(度) */
export const INFLATE_ANGLE = { min: -90, max: 90 };
export interface InflateState {
  /** 範囲を描いたレイヤー */
  readonly layerId: string;
  readonly area: InflateArea;
  readonly settings: InflateSettings & { height: number };
  /** 範囲を描いたレイヤーのポップ量(プレビュー中は変えない) */
  readonly sourcePop: number;
  /** 高さがポップ量を超えるので新しいレイヤーに作るときの、そのレイヤーの名前とポップ量 */
  readonly newLayer: { readonly name: string; readonly pop: number } | null;
  /** 高さがポップ量を超えるが、レイヤーが上限の枚数なので新しいレイヤーを作れない(ポップ量の高さで止まる) */
  readonly limited: boolean;
}

type AppEvents = {
  tool: Tool;
  active: string | null;
  view: void;
  /** 画像・保存の状態・書き出し中かなど、ステータスバーや使えるかの表示に関わる変化(fps は含めない) */
  status: void;
  /** fps を測り直した(0.5 秒ごと) */
  fps: number;
  file: void;
  /** 膨らませるプレビューの開始・変更・終了 */
  inflate: 'begin' | 'change' | 'end';
  /** 全体ぼかしのプレビューの開始・終了 */
  blur: 'begin' | 'end';
  /** 描画ループで1フレーム描いた(画像全体が動いている間に、ブラシの円を当て直すのに使う) */
  frame: void;
  /** 操作の記録の状態(記録中・ループ再生中)が変わった */
  take: TakeState;
  /** タブの開く・閉じる・切り替え */
  tabs: void;
};

/** 一度に開いておけるタブの数 */
export const MAX_TABS = 5;

/**
 * アプリの中のタブ1枚分の作業(プロジェクトと、それに付く画面の状態)。描画・物理・画面の部品は1つを使い回し、
 * タブを切り替えるときは、ここに預けた中身を丸ごと入れ替える。
 * 表に出ているタブの値は App のゲッター・セッター(fileName など)から読み書きする。作業ごとの値を App に足すときは、ここに足す
 */
export interface Tab {
  /** 自動保存のキーにも使う */
  readonly id: string;
  /** 並び(自動保存から戻すときの順) */
  readonly order: number;
  project: Project;
  /** 裏にいる間のアンドゥの積み(表に出ている間は App.history が持つ) */
  history: HistoryState;
  /** 最後に表に出した時刻。全部のタブのアンドゥが上限を超えたら、古いタブの積みから捨てる */
  shownAt: number;
  /** サンプルか空で始めたタブ。変更していなければ、次に開いたファイルで置き換える */
  sample: boolean;
  fileHandle: FileSystemFileHandle | null;
  fileName: string | null;
  dirty: boolean;
  /** 変更のたびに増える番号。保存中に変更があったかを見分けるのに使う */
  revision: number;
  lastSaved: Date | null;
  lastAutosave: Date | null;
  /** 直近の自動保存が失敗していればその理由 */
  autosaveError: string | null;
  /** 実行中の自動保存(終わるのを待ってから自動保存を消すため) */
  autosaving: Promise<void>;
  autosaveTimer: number;
  activeLayerId: string | null;
  selectedLayerIds: Set<string>;
  keyDraft: KeyFrame[];
  multiOrtho: OrthoView;
  /** 表示用にデコードした画像。裏に回すと捨て(メモリのため)、表に出すときにデコードし直す */
  imageCanvas: HTMLCanvasElement | null;
  /** 自動保存用に、変わっていないレイヤーのウェイト PNG を使い回す(手動の保存では使わない) */
  pngCache: Map<string, PngCacheEntry>;
  /** レイヤーごとのウェイトの重心(元画像のピクセル、塗った範囲の広がりの中心)。ウェイトが変わったら捨てる */
  centers: Map<string, { x: number; y: number }>;
}

let tabSeq = 0;
function createTab(project: Project, init: Partial<Pick<Tab, 'id' | 'order' | 'sample' | 'fileName' | 'fileHandle' | 'dirty'>> = {}): Tab {
  const seq = tabSeq++;
  return {
    id: init.id ?? `tab-${Date.now().toString(36)}-${seq.toString(36)}`,
    order: init.order ?? Date.now() + seq,
    project, history: emptyHistory(), shownAt: 0, sample: init.sample ?? false,
    fileHandle: init.fileHandle ?? null, fileName: init.fileName ?? null, dirty: init.dirty ?? false, revision: 0,
    lastSaved: null, lastAutosave: null, autosaveError: null, autosaving: Promise.resolve(), autosaveTimer: 0,
    activeLayerId: null, selectedLayerIds: new Set(),
    // 記録がキーフレームから作ったものなら、そのキーフレームを下書きに入れて始める
    keyDraft: project.take?.keys ? structuredClone([...project.take.keys]) : [],
    multiOrtho: defaultOrthoView(), imageCanvas: null, pngCache: new Map(), centers: new Map(),
  };
}

/** 画像全体のずれ(ピストン)の飛びをならす時定数(秒)。自動揺らしの切り替えや、塗り終わりで止めていた画像を戻すとき */
const BASE_EASE = 0.05;

/**
 * 動作の重さの計測の受け口。デバッグ表示(?debug、debug/perfOverlay.ts)を開いたときだけ付く。
 * 付いていないときは null の確認だけで済むので、ふだんの負荷は増えない。
 */
export interface PerfProbe {
  /** requestAnimationFrame の時刻でフレームの始まりを知らせる */
  frame(now: number): void;
  /** t0 から now までを、その処理の時間として今のフレームに足す。now を返す */
  lap(section: 'physics' | 'upload' | 'render', t0: number, now: number): number;
  /** 自動保存などの単発の処理 */
  event(e: { t: number; d: number; kind: string; detail?: string }): void;
}

const PROJECT_TYPES: FilePickerAcceptType[] = [{ description: 'PukuPop プロジェクト', accept: { 'application/zip': [FILE_EXTENSION] } }];
const AUTOSAVE_DELAY = 2000;

export type OverlayMode = 'off' | 'selected' | 'all';

/** 全レイヤー表示で、選んでいないレイヤーを重ねる濃さ(選んだレイヤーを 1 として) */
const OVERLAY_DIM = 0.4;

export class App extends Emitter<AppEvents> {
  readonly store = new Store();
  readonly history = new History(this.store);
  readonly world = new PhysicsWorld();
  readonly recorder = new MotionRecorder();
  readonly stage: Stage;

  /** 開いているタブ(並びのとおり) */
  readonly tabs: Tab[] = [];
  /** 表に出ているタブ */
  private tab: Tab = this.addFirstTab();
  private addFirstTab(): Tab { const t = createTab(this.store.project, { sample: true }); this.tabs.push(t); return t; }
  get activeTab(): Tab { return this.tab; }

  tool: Tool = 'brush';
  get activeLayerId(): string | null { return this.tab.activeLayerId; }
  set activeLayerId(id: string | null) { this.tab.activeLayerId = id; }
  /**
   * 選んでいるレイヤー(一覧で Ctrl / Shift で足したもの)。activeLayerId はその中の「最後に押したレイヤー」で、塗りや膨らみの先になる。
   * 画面だけの状態で、アンドゥにも保存にも入れない
   */
  get selectedLayerIds(): Set<string> { return this.tab.selectedLayerIds; }
  set selectedLayerIds(s: Set<string>) { this.tab.selectedLayerIds = s; }
  view: ViewOptions = { overlay: true, overlayAll: false, grid: false, fade: false, flat: false, multi: false };
  /** 3面図の「自由角度」の視点。project.multiCamera に置き、ファイルにも保存する */
  get multiCam(): CameraState { return this.project.multiCamera; }
  set multiCam(c: CameraState) { this.project.multiCamera = c; }
  /** 3面図の正面・右から・下からの拡大率と平行移動(3つで共有。画面だけの設定で保存しない) */
  get multiOrtho(): OrthoView { return this.tab.multiOrtho; }
  set multiOrtho(v: OrthoView) { this.tab.multiOrtho = v; }
  paused = false;
  /** 背景を透過しないときに塗る色(最後に使った背景色)。透過にしても忘れず、新しい画像の既定と一緒にブラウザに覚える(main.ts) */
  bgColor = '#ffffff';
  /** UIを隠して3Dビューを画面いっぱいに出しているか(ui/hideUi.ts)。画面だけの状態で、覚えない */
  uiHidden = false;
  /** 塗るツール(ブラシ・消しゴム・ぼかし・膨らみ)や「全体をぼかす」を使い始めたら、重ね表示を自動で入れる。ブラウザに覚える設定 */
  autoOverlay = true;
  /** 自動で入れた重ね表示を、塗るツールから離れたり「全体をぼかす」を閉じたりしたときに切る。ブラウザに覚える設定 */
  autoOverlayOff = true;
  /** ポップ量・膨らませる高さのスライダーの右端(px)。ブラウザに覚える設定(ui/popSlider.ts) */
  popMax: number = POP_MAX_SETTING.def;
  /** 今の重ね表示を自動で入れたか。重ね表示を手で変えたら false にし、手で入れた表示は自動で切らない。開き直しても続くよう prefs に覚える */
  overlayAutoShown = false;
  /**
   * 「揺らす」ツールで画像を振った量(ワールド座標)。カメラは画像に付いて動くので画面上の位置は
   * 変わらないが、物理には平行移動と同じ動きとして伝える。画面だけの値で保存しない
   */
  shake: Vec3 = { x: 0, y: 0, z: 0 };
  brush: BrushOptions = { size: 64, strength: 0.3, hardness: 0, pressure: 'strength' };
  /** 前回の「膨らませる」の設定(次に範囲を描いたときの初期値) */
  inflateSettings: InflateSettings = { shape: 'ellipse', height: null, softness: 1, angle: 0, profile: 'dome', blend: 'max' };
  get imageCanvas(): HTMLCanvasElement | null { return this.tab.imageCanvas; }
  /** 表示用の画像の一辺の上限 */
  private get displaySize(): number { return Math.min(4096, this.stage.maxTextureSize); }

  get fileHandle(): FileSystemFileHandle | null { return this.tab.fileHandle; }
  set fileHandle(h: FileSystemFileHandle | null) { this.tab.fileHandle = h; }
  get fileName(): string | null { return this.tab.fileName; }
  set fileName(n: string | null) { this.tab.fileName = n; }
  get dirty(): boolean { return this.tab.dirty; }
  set dirty(on: boolean) { this.tab.dirty = on; }
  /**
   * 画面に出している画像全体のずれ(ピストン、元画像のピクセル)。ライブ表示だけの値で、物理と書き出しには関わらない。
   * 塗り・膨らませる範囲のドラッグ中は止めて(held)、当たり判定がずれないようにする。設定の切り替えで飛ぶ分は fix でならす
   */
  private base = freshBase();
  private get centers(): Map<string, { x: number; y: number }> { return this.tab.centers; }
  /** まだ GPU へ送っていない、レイヤーごとの変わった矩形 */
  private pendingUploads = new Map<string, Rect>();
  private get pngCache(): Map<string, PngCacheEntry> { return this.tab.pngCache; }
  /** 直近の自動保存が失敗していればその理由 */
  get autosaveError(): string | null { return this.tab.autosaveError; }
  exporting = false;
  get lastSaved(): Date | null { return this.tab.lastSaved; }
  get lastAutosave(): Date | null { return this.tab.lastAutosave; }

  /** 操作の記録の状態 */
  takeState: TakeState = 'idle';
  /** 記録中の操作(止めたときに finalizeTake で整える) */
  private takeRaw: RecordSample[] = [];
  /** ループ再生で次に入れる記録の位置 */
  private playIndex = 0;
  /**
   * ループ再生では視点の代わりに画像を動かし、視点は自由に動かせるようにする。
   * playFrom は再生を始めたときの視点(記録の初めの視点)で、画像はここから見て記録どおりに映るように動く。
   * playCam は今の刻みの記録の視点。見る視点が playFrom のままなら、画面は記録の視点で見たのと同じになる
   */
  private playFrom: CameraState | null = null;
  private playCam: CameraState | null = null;
  /**
   * キーフレームの下書き(画面だけ)。作った記録はそのキーフレームも持つので、
   * 記録が差し替わったら(開く・アンドゥなど)その記録のキーフレームに合わせる
   */
  get keyDraft(): KeyFrame[] { return this.tab.keyDraft; }
  set keyDraft(k: KeyFrame[]) { this.tab.keyDraft = k; }
  /** キーフレームの重ね表示(経路・ゴースト)。ブラウザに覚える(ui/keyPath.ts) */
  keyOverlay = { path: true, ghost: false };
  setKeyOverlay(key: 'path' | 'ghost', on: boolean): void {
    if (this.keyOverlay[key] === on) return;
    this.keyOverlay = { ...this.keyOverlay, [key]: on };
    this.emit('view', undefined);
  }

  private loading = false;
  /** タブを表に出している最中(Store の差し替えで、そのタブの控えを捨てない) */
  private switching = false;
  private stroke: { stroke: Stroke; layerId: string; label: string } | null = null;
  private syncToken = 0;
  fps = 0;
  /** 計測(デバッグ表示を開いたときだけ) */
  perf: PerfProbe | null = null;
  /** 描画ループを始めた回数。1 より多ければループが重なっている */
  loops = 0;

  constructor(canvas: HTMLCanvasElement) {
    super();
    this.stage = new Stage(canvas);
    this.wireStore();
    this.history.on('change', () => this.trimHiddenHistory());
  }

  get doc(): Document | undefined { return this.store.doc; }
  get project(): Project { return this.store.project; }
  get activeLayer(): Layer | undefined { return this.activeLayerId ? this.store.findLayer(this.activeLayerId)?.layer : undefined; }
  get activeIndex(): number { return this.activeLayerId ? this.store.findLayer(this.activeLayerId)?.index ?? -1 : -1; }
  /** 選んでいるレイヤー(一覧の下から順)。レイヤータブの変更や、ウェイトの一括処理の対象 */
  get selectedLayers(): Layer[] { return this.doc?.layers.filter(l => this.selectedLayerIds.has(l.id)) ?? []; }
  get multiSelected(): boolean { return this.selectedLayerIds.size > 1; }
  /** ウェイトの重ね表示: OFF / 選んでいるレイヤー / 全レイヤー */
  get overlayMode(): OverlayMode { return !this.view.overlay ? 'off' : this.view.overlayAll ? 'all' : 'selected'; }
  get imageLong(): number { const d = this.doc; return d ? Math.max(d.image.width, d.image.height) : 1; }

  /* ---------- Store → Stage ---------- */

  private wireStore(): void {
    const s = this.store;
    s.on('document', ({ keys }) => {
      const doc = this.doc; if (!doc) return;
      if (keys.includes('meshDensity')) this.stage.rebuildMesh(doc.meshDensity);
      if (keys.some(k => k === 'position' || k === 'rotation' || k === 'scale' || k === 'opacity' || k === 'meshDensity')) this.stage.setTransform(doc);
      this.emit('status', undefined);
    });
    s.on('layer', ({ layerId, keys }) => {
      const f = s.findLayer(layerId); if (!f) return;
      if (keys.includes('pop') || keys.includes('visible') || keys.includes('blend')) this.stage.setLayerParams(f.index, f.layer);
      if (keys.includes('visible') && this.view.overlayAll) this.syncView(); // 全レイヤー表示では、隠したレイヤーを重ねない
    });
    // タブを表に出すとき(enterTab)は、そのタブが預けていた PNG・重心・キーフレームの下書きをそのまま使う(裏にいる間は中身が変わらないため)
    s.on('replace', () => { if (this.switching) return; this.pngCache.clear(); this.centers.clear(); this.syncKeyDraft(true); });
    s.on('layers', () => {
      const doc = this.doc; if (!doc) return;
      // 並べ替え・追加・削除ではウェイトは変わらないので、PNG は作り直さない(無くなったレイヤーの分だけ捨てる)
      const ids = new Set(doc.layers.map(l => l.id));
      for (const id of this.pngCache.keys()) if (!ids.has(id)) this.pngCache.delete(id);
      for (const id of this.centers.keys()) if (!ids.has(id)) this.centers.delete(id);
      const t = performance.now();
      this.stage.setLayers(doc.layers);
      this.perf?.event({ t, d: performance.now() - t, kind: 'layers', detail: 'レイヤー構成の変更(ウェイトの全面転送)' });
      this.pendingUploads.clear(); // 全レイヤーを送り直したので、溜めていた分は要らない
      if (!this.activeLayerId || !s.findLayer(this.activeLayerId)) this.setActiveLayer(doc.layers[0]?.id ?? null);
      else {
        // 消えたレイヤーを選択から外す(アンドゥで足し直したレイヤーは選び直さない)
        const before = this.selectedLayerIds.size;
        for (const id of [...this.selectedLayerIds]) if (!s.findLayer(id)) this.selectedLayerIds.delete(id);
        this.syncView();
        if (this.selectedLayerIds.size !== before) this.emit('active', this.activeLayerId);
      }
    });
    s.on('weights', ({ layerId, rect }) => {
      this.pngCache.delete(layerId);
      // 広がりの中心は、塗っている間は動かさない(塗った範囲全体がずれて見えないように)。塗り終わりで求め直す
      if (this.stroke?.layerId !== layerId) this.centers.delete(layerId);
      // GPU への転送は、変わった矩形をまとめて描画の直前に1回だけ行う
      const prev = this.pendingUploads.get(layerId);
      this.pendingUploads.set(layerId, prev ? unionRect(prev, rect) : { ...rect });
    });
    s.on('project', ({ keys }) => {
      if (keys.includes('background')) this.applyBackground();
      // アンドゥなどで記録が消えたら再生をやめる。差し替わったら初めから再生する
      if (keys.includes('take') && this.takeState === 'playing') {
        if (this.project.take) this.playTake(); else this.stopTake();
      }
      if (keys.includes('take')) this.syncKeyDraft();
      this.emit('status', undefined);
    });
    s.on('change', () => {
      if (this.loading) return;
      const t = this.tab;
      t.revision++;
      t.lastAutosave = null;
      if (!t.dirty) { t.dirty = true; this.emit('file', undefined); }
      this.scheduleAutosave(t);
    });
  }

  /** ドキュメント全体を Stage へ反映する(読み込み時など)。canvas はデコード済みの表示用画像。 */
  private applyDocument(canvas: HTMLCanvasElement): void {
    const doc = this.doc;
    if (!doc) return;
    this.tab.imageCanvas = canvas;
    this.stage.setImage(canvas, doc.image.width, doc.image.height);
    this.stage.rebuildMesh(doc.meshDensity);
    this.stage.setTransform(doc);
    this.stage.setLayers(doc.layers);
    this.pendingUploads.clear();
    this.world.unitPx = Math.max(doc.image.width, doc.image.height) / 2;
    this.world.centerOf = this.centerOf;
    this.applyBackground();
    this.syncView();
    this.emit('status', undefined);
  }

  /**
   * 背景を透過する・しない。しないときは最後に使った背景色(bgColor)で塗る。1手として記録する
   */
  setBackgroundTransparent(on: boolean): void {
    if ((this.project.background === null) === on) return;
    this.history.execute(PatchProject.from(this.store, { background: on ? null : this.bgColor }, on ? '背景を透過' : '背景を塗る'));
  }

  private applyBackground(): void {
    const bg = this.project.background;
    if (bg) this.bgColor = bg;
    this.stage.setBackground(bg);
    const el = this.stage.canvas.parentElement!;
    el.classList.toggle('solid', !!bg);
    if (bg) el.style.setProperty('--stage-bg', bg);
  }

  syncView(): void {
    const layers = this.doc?.layers ?? [], mode = this.overlayMode, all = this.selectedLayerIds.size >= layers.length;
    // 選択中: 選んだレイヤーだけ(隠していても塗れるので出す)。全レイヤー: 表示中のものを全部出し、選んだもの以外を薄くする
    const show = layers.map(l => {
      const sel = this.selectedLayerIds.has(l.id);
      if (mode === 'selected') return sel ? 1 : 0;
      if (mode === 'all') return !l.visible ? 0 : sel || all ? 1 : OVERLAY_DIM;
      return 0;
    });
    this.stage.setView(this.view, show);
    this.emit('view', undefined);
  }

  /* ---------- 状態の切り替え ---------- */

  /** auto を false にすると、重ね表示を自動で入れも切りもしない(起動時に前回のツールを戻すとき、スマホと PC の幅を行き来するとき) */
  setTool(t: Tool, auto = true): void {
    const changed = t !== this.tool;
    this.tool = t;
    this.emit('tool', t);
    // auto が false(起動時の復元・スマホの幅に入るとき)は切らない。PC の幅に戻ってブラシにしたとき、表示が消えたままになるため
    if (auto && changed && !PAINT_TOOLS.includes(t)) this.autoHideOverlay();
    // 選び直しでは入れない(手で切った重ね表示を戻さない)。受け手が別のツールに戻したときも入れない(スマホで画像を開いたとき)
    if (auto && changed && this.tool === t && PAINT_TOOLS.includes(t)) this.autoShowOverlay();
  }

  setAutoOverlay(on: boolean): void {
    this.autoOverlay = on;
    if (!on) this.overlayAutoShown = false; // 自動でONを切ったら、OFFの設定も効かない(画面でも押せなくなる)
    this.emit('view', undefined);
  }
  setAutoOverlayOff(on: boolean): void { this.autoOverlayOff = on; this.emit('view', undefined); }
  setPopMax(v: number): void { this.popMax = clampPopMax(v); this.emit('view', undefined); if (this.inflateState) this.emit('inflate', 'change'); }

  /** 塗りが見えるよう重ね表示を入れる。入れたことを覚え、塗り終えたら autoHideOverlay で切る */
  private autoShowOverlay(): void {
    if (!this.autoOverlay || this.view.overlay) return;
    this.setOverlayMode('selected');
    this.overlayAutoShown = true;
    this.emit('view', undefined); // 自動で入れたことも覚える
  }

  /** 自動で入れた重ね表示を切る。塗るツールのままか「全体をぼかす」の途中なら、まだ切らない */
  private autoHideOverlay(): void {
    if (!this.overlayAutoShown || PAINT_TOOLS.includes(this.tool) || this.blurPreview) return;
    this.overlayAutoShown = false;
    if (this.autoOverlayOff) this.setOverlayMode('off');
  }

  /** そのレイヤーだけを選ぶ */
  setActiveLayer(id: string | null): void {
    this.activeLayerId = id;
    this.selectedLayerIds = new Set(id ? [id] : []);
    this.syncView();
    this.emit('active', id);
  }

  /**
   * 複数のレイヤーを選ぶ。primary は最後に押したレイヤー(塗りの先)で、ids に入っていなければ足す。
   * 無いレイヤーの id は無視する
   */
  selectLayers(ids: Iterable<string>, primary: string): void {
    if (!this.store.findLayer(primary)) return;
    const set = new Set([...ids].filter(id => this.store.findLayer(id)));
    set.add(primary);
    this.activeLayerId = primary;
    this.selectedLayerIds = set;
    this.syncView();
    this.emit('active', primary);
  }

  /** 全レイヤーを選ぶ(最後に押したレイヤーはそのまま) */
  selectAllLayers(): void {
    const doc = this.doc; if (!doc || !this.activeLayerId) return;
    this.selectLayers(doc.layers.map(l => l.id), this.activeLayerId);
  }

  setOverlayMode(mode: OverlayMode): void {
    this.overlayAutoShown = false; // 手で変えた表示は自動では切らない(自動で入れるときは、この後で立て直す)
    this.view.overlay = mode !== 'off';
    this.view.overlayAll = mode === 'all';
    this.syncView();
  }

  /** W キーと左のツールバーのボタン: OFF → 選択中 → 全レイヤー → OFF */
  cycleOverlay(): void {
    const next: Record<OverlayMode, OverlayMode> = { off: 'selected', selected: 'all', all: 'off' };
    this.setOverlayMode(next[this.overlayMode]);
  }

  setViewOption(key: keyof ViewOptions, on: boolean): void {
    this.view[key] = on;
    if (key === 'overlay' || key === 'fade') this.overlayAutoShown = false;
    // 画像を薄くするのは塗りを見るためなので、重ね表示も合わせて入れる
    if (key === 'fade' && on) this.view.overlay = true;
    // 重ね表示を切ったら、次に入れたときは「選択中」から
    if (!this.view.overlay) this.view.overlayAll = false;
    this.syncView();
  }

  /** 見栄えの確認用に、編集のための表示(重ね表示・画像を薄く・ポップ一時OFF・揺れ一時停止・グリッド)をまとめて切る */
  clearEditView(): void {
    Object.assign(this.view, { overlay: false, overlayAll: false, fade: false, flat: false, grid: false });
    this.overlayAutoShown = false;
    this.syncView();
    if (this.paused) this.setPaused(false);
  }

  setPaused(on: boolean): void {
    // 一時停止中は物理が進まず、記録も再生も止まってしまうので、先に終える
    if (on) { this.stopTake(); this.stopRecording(); }
    this.paused = on;
    this.world.paused = on;
    if (on) this.world.reset();
    this.emit('view', undefined);
  }

  /** 右パネルを閉じて3Dビューを広げているか(PC の幅だけ。ui/sidePanel.ts)。ブラウザに覚える */
  panelClosed = false;
  setPanelClosed(on: boolean): void {
    if (this.panelClosed === on) return;
    this.panelClosed = on;
    this.emit('view', undefined);
  }

  /** UIを隠す・戻す。隠している間は3面図も出さない(app.view.multi はそのまま残し、戻すと出る) */
  setUiHidden(on: boolean): void {
    if (this.uiHidden === on) return;
    this.uiHidden = on;
    this.emit('view', undefined);
  }

  /** 視点を正面へ戻す。ループ再生中でも止めない(見る視点だけを戻す) */
  resetView(): void {
    this.project.camera = frontCamera(this.project.camera.fov);
    this.world.cutView(); // 視点が飛ぶだけなので揺らさない
    this.cameraChanged();
  }

  /** 向きだけを正面に戻す。ズームと平行移動(画面の上下左右の位置)は保つ */
  resetRotation(): void {
    const c = this.project.camera;
    if (c.yaw === 0 && c.pitch === 0 && c.roll === 0 && c.target.z === 0) return;
    // 回した視点で平行移動すると奥行き(z)にもずれるので、正面から見て同じに見えるよう 0 に戻す。傾きも 0 に戻す
    this.project.camera = { ...c, yaw: 0, pitch: 0, roll: 0, target: { ...c.target, z: 0 } };
    this.world.cutView();
    this.cameraChanged();
  }

  /**
   * 視点の傾き(ラジアン)をその場で変える。Alt+右ドラッグ・2本指のひねりから続けて呼ぶ。
   * 動かした勢いで揺らす(回転・ズームと同じ)。保存の予約は cameraChanged が間引く
   */
  setRoll(r: number): void {
    this.project.camera.roll = wrapAngle(r);
    this.cameraChanged();
    this.emit('status', undefined);
  }

  /** 視点の傾きを delta(ラジアン)だけ、なめらかに回す(Q / E)。正で画像が時計回りに傾く */
  rollBy(delta: number): void { this.rollEase.add(delta); }
  private rollEase = smoothRoll({ get: () => this.project.camera.roll, set: r => this.setRoll(r), owner: () => this.project.camera });

  /** 視点の傾きだけを 0 に戻す(ステータスバーの角度を押したとき)。飛ぶだけなので揺らさない */
  resetRoll(): void {
    const c = this.project.camera;
    if (c.roll === 0) return;
    this.project.camera = { ...c, roll: 0, target: { ...c.target } };
    this.world.cutView();
    this.cameraChanged();
    this.emit('status', undefined);
  }

  /**
   * 視点(回転・平行移動・ズーム)を変えたことを知らせる。視点は保存される項目なので「未保存」にして
   * 自動保存を予約するが、アンドゥには積まない。ホイールのように続けて来るものは間引く。
   */
  cameraChanged(): void {
    clearTimeout(this.cameraTimer);
    this.cameraTimer = window.setTimeout(() => { this.cameraTimer = 0; this.store.emit('change', undefined); }, 300);
  }
  private cameraTimer = 0;

  /* ---------- 読み込みとタブ ---------- */

  /** タブを置き換えて開くか(変更していないサンプル・空のタブ) */
  private get replaceable(): boolean { return this.tab.sample && !this.tab.dirty; }

  /** タブの数が上限で、新しいタブを開けないか。開けないときは伝える */
  tabsFull(): boolean {
    if (this.replaceable || this.tabs.length < MAX_TABS) return false;
    toast(`タブは ${MAX_TABS} 枚まで開けます。どれかを閉じてから開いてください。`, 'warning', 5000);
    return true;
  }

  /** タブの見出し(ファイル名、無ければ画像の名前) */
  tabName(t: Tab): string { return t.fileName ?? t.project.documents[0]?.name ?? ''; }

  /**
   * プロジェクトを読み込む。先に画像をデコードし、成功してから状態を一度に差し替える。
   * デコードに失敗したら例外を投げ、今の状態には何も触れない。
   * 後から始まった別の読み込みに追い越されたときや、タブの数が上限のときは何もせず false を返す。
   * 今のタブが変更していないサンプルなら置き換え、そうでなければ新しいタブで開く(今のタブはそのまま裏に残る)。
   */
  async loadProject(project: Project, opts: { fileName?: string | null; handle?: FileSystemFileHandle | null; dirty?: boolean; canvas?: HTMLCanvasElement; sample?: boolean; replace?: boolean; tabId?: string; order?: number } = {}): Promise<boolean> {
    const doc = project.documents[0];
    if (!doc) throw new Error('プロジェクトに画像が入っていません');
    const token = ++this.syncToken;
    // 呼び出し側でデコード済みなら、それを使う(同じ画像を2回デコードしない)
    const canvas = opts.canvas ?? await decodeForDisplay(doc.image, this.displaySize);
    // デコード中に別の読み込みが始まっていたら、こちらは捨てる
    if (token !== this.syncToken) return false;
    const replace = opts.replace || this.replaceable;
    if (!replace && this.tabsFull()) return false;
    const old = this.tab;
    if (replace) {
      // 前の作業の視点変更を、新しく開いた作業の変更として数えない
      clearTimeout(this.cameraTimer); this.cameraTimer = 0;
      // 置き換える作業の自動保存はもう要らない
      this.dropTabAutosave(old);
    } else this.leaveTab();
    // 並び: 置き換えなら同じ位置、新しいタブなら今のタブの右隣(自動保存から戻すときもこの並びにする)
    const i = this.tabs.indexOf(old), right = this.tabs[i + 1];
    const order = opts.order ?? (replace ? old.order : right ? (old.order + right.order) / 2 : Math.max(Date.now(), old.order + 1));
    const tab = createTab(project, { id: opts.tabId, order, sample: opts.sample, fileName: opts.fileName ?? null, fileHandle: opts.handle ?? null, dirty: !!opts.dirty });
    if (replace) this.tabs.splice(i, 1, tab); else this.tabs.splice(i + 1, 0, tab);
    this.enterTab(tab, canvas);
    return true;
  }

  /**
   * 表のタブを裏へ回す。記録・再生を止め、間引き中の視点の変更を数え、アンドゥの積みを預ける。
   * 表示用の画像はメモリを空けるため捨てる(表に出すときにデコードし直す)
   */
  private leaveTab(): void {
    const t = this.tab;
    this.stopRecording();
    // 再生を止めると視点が止めた所の記録の視点に移るが、それは作業の変更として数えない(切り替えただけで「未保存」にしない)
    const pending = this.cameraTimer !== 0;
    this.stopTake();
    if (!pending) { clearTimeout(this.cameraTimer); this.cameraTimer = 0; }
    if (this.cameraTimer) { clearTimeout(this.cameraTimer); this.cameraTimer = 0; this.store.emit('change', undefined); }
    t.history = this.history.take();
    t.imageCanvas = null;
  }

  /** タブを表に出す。canvas はデコード済みの表示用画像 */
  private enterTab(tab: Tab, canvas: HTMLCanvasElement): void {
    this.loading = true;
    try {
      // 記録中・再生中の操作は前の作業のものなので捨てる
      this.takeRaw = []; this.playIndex = 0; this.playPaused = false;
      if (this.takeState !== 'idle') { this.takeState = 'idle'; this.emit('take', 'idle'); }
      this.world.grab = null; this.world.grabGains.clear(); this.shake = { x: 0, y: 0, z: 0 };
      this.playFrom = this.playCam = null; this.world.viewRig = null; this.stage.setRig(null);
      this.base = freshBase(); // 画像全体のずれは前の画像のピクセル単位なので持ち越さない
      this.tab = tab;
      tab.shownAt = Date.now();
      this.switching = true;
      try { this.store.replace(tab.project); } finally { this.switching = false; }
      this.history.restore(tab.history);
      tab.history = emptyHistory();
      this.world.reset();
      this.recorder.clear();
      // 選んでいたレイヤーを選び直す(初めて出すタブは、いちばん下のレイヤー)
      const first = tab.project.documents[0]?.layers[0]?.id ?? null;
      if (tab.activeLayerId && this.store.findLayer(tab.activeLayerId)) this.selectLayers(tab.selectedLayerIds, tab.activeLayerId);
      else this.setActiveLayer(first);
      this.applyDocument(canvas);
    } finally { this.loading = false; }
    this.emit('take', this.takeState);
    this.emit('file', undefined);
    this.emit('tabs', undefined);
  }

  /** タブの自動保存を取り消して消す(実行中のものは終わってから消す) */
  private dropTabAutosave(t: Tab): void {
    clearTimeout(t.autosaveTimer); t.autosaveTimer = 0;
    void t.autosaving.then(() => autosave.clear(t.id));
  }

  /** タブを表に出す。切り替えたら true */
  async switchTab(id: string): Promise<boolean> {
    const to = this.tabs.find(t => t.id === id);
    if (!to || to === this.tab) return false;
    if (this.busy) { toast('いまはタブを切り替えられません。処理が終わってからもう一度お試しください。', 'warning'); return false; }
    return this.whileOpening(() => this.switchTabNow(to));
  }

  private async switchTabNow(to: Tab): Promise<boolean> {
    const token = ++this.syncToken;
    let canvas: HTMLCanvasElement;
    // 裏のタブは表示用の画像を捨ててあるので、デコードし直す(大きな画像では少しかかる)
    if (!to.imageCanvas) setBusy(true);
    try { canvas = to.imageCanvas ?? await decodeForDisplay(to.project.documents[0].image, this.displaySize); } catch (e) {
      toast(`タブを開けませんでした: ${e instanceof Error ? e.message : e}`, 'error', 6000);
      return false;
    } finally { setBusy(false); }
    if (token !== this.syncToken || !this.tabs.includes(to)) return false;
    this.leaveTab();
    this.enterTab(to, canvas);
    return true;
  }

  /** 隣のタブへ(dir: +1 で右、-1 で左。端からは反対の端へ) */
  stepTab(dir: 1 | -1): void {
    const n = this.tabs.length; if (n < 2) return;
    const i = this.tabs.indexOf(this.tab);
    void this.switchTab(this.tabs[(i + dir + n) % n].id);
  }

  /**
   * タブを閉じる。保存していない変更があれば確かめる。表のタブを閉じたら右隣(無ければ左隣)を出し、
   * 最後の1枚ならサンプルに置き換える。閉じたら true
   */
  async closeTab(id: string = this.tab.id): Promise<boolean> {
    const t = this.tabs.find(x => x.id === id);
    if (!t) return false;
    // 変更していないサンプルが1枚だけなら、閉じても同じものに戻るだけなので何もしない
    if (this.tabs.length === 1 && this.replaceable) return false;
    if (this.busy) { toast('いまはタブを閉じられません。処理が終わってからもう一度お試しください。', 'warning'); return false; }
    if (t.dirty) {
      const r = await ask({ title: `「${this.tabName(t)}」は保存されていません`, body: '変更を破棄してタブを閉じますか?', yes: '破棄して閉じる' });
      if (!r.ok || !this.tabs.includes(t)) return false;
    }
    if (t === this.tab) {
      const i = this.tabs.indexOf(t), next = this.tabs[i + 1] ?? this.tabs[i - 1];
      if (next) { if (!(await this.switchTab(next.id))) return false; } else {
        // 最後の1枚はサンプルに置き換える(置き換えるタブの自動保存は loadProject が消す)
        if (!(await this.whileOpening(() => this.loadSample({ replace: true })))) return false;
        return true;
      }
    }
    this.tabs.splice(this.tabs.indexOf(t), 1);
    this.dropTabAutosave(t);
    t.history = emptyHistory(); t.imageCanvas = null;
    this.trimHiddenHistory();
    this.emit('tabs', undefined);
    return true;
  }

  /** どれかのタブに保存していない変更があるか(ページを閉じるときの確認) */
  get anyDirty(): boolean { return this.tabs.some(t => t.dirty); }

  /**
   * 全部のタブのアンドゥの合計を、1つの作業の上限(history.options.maxBytes)に収める。
   * あふれたら、裏のタブのうち長く出していないものの古い手から捨てる(表のタブの積みは History が自分で収める)
   */
  private trimHiddenHistory(): void {
    const limit = this.history.options.maxBytes, hidden = this.tabs.filter(t => t !== this.tab);
    let total = this.history.bytes + hidden.reduce((a, t) => a + t.history.bytes, 0);
    for (const t of hidden.sort((a, b) => a.shownAt - b.shownAt)) {
      if (total <= limit) break;
      total -= shrinkHistory(t.history, t.history.bytes - (total - limit));
    }
  }

  async loadSample(opts: { replace?: boolean } = {}): Promise<boolean> {
    if (!opts.replace && this.tabsFull()) return false;
    const doc = await createSampleDocument();
    const p = createProject(doc);
    return this.loadProject(p, { sample: true, replace: opts.replace });
  }

  /** 書き出し・塗り・ぼかしのプレビュー・別のファイルの読み込みの最中は、ファイルを開かない */
  get busy(): boolean { return this.exporting || this.stroking || this.previewingBlur || this.previewingInflate || this.opening; }
  private opening = false;

  async openFile(file: File, handle?: FileSystemFileHandle): Promise<void> {
    if (this.busy) { toast('いまはファイルを開けません。処理が終わってからもう一度お試しください。', 'warning'); return; }
    const t = performance.now();
    await this.whileOpening(() => this.openFileNow(file, handle));
    this.perf?.event({ t, d: performance.now() - t, kind: 'open', detail: `${file.name}(${(file.size / 1e6).toFixed(1)}MB)` });
  }

  /** ファイルを開いている間は、ほかのファイルを開かせない(起動時の復元・タブの切り替えにも使う) */
  async whileOpening<T>(fn: () => Promise<T>): Promise<T> {
    this.opening = true;
    try { return await fn(); } finally { this.opening = false; }
  }

  /** そのファイルを開けるか(開いているタブを出すだけなら開ける)。開けないときは伝える */
  async roomFor(handle?: FileSystemFileHandle): Promise<boolean> {
    return !!(await this.tabOf(handle)) || !this.tabsFull();
  }

  /** 同じ場所のファイルを開いているタブ(ファイルの場所を受け取れる Chrome 系だけ分かる) */
  private async tabOf(handle: FileSystemFileHandle | undefined): Promise<Tab | undefined> {
    if (!handle) return undefined;
    for (const t of this.tabs) {
      try { if (t.fileHandle && await t.fileHandle.isSameEntry(handle)) return t; } catch { /* 比べられなければ別のファイルとして開く */ }
    }
    return undefined;
  }

  private async openFileNow(file: File, handle: FileSystemFileHandle | undefined): Promise<void> {
    const project = isProjectFile(file);
    if (!project && !isImageFile(file)) { toast('PNG / JPEG / WebP の画像か、.pukupop ファイルを選んでください。', 'warning'); return; }
    // 開いているプロジェクトなら、そのタブを出す(同じ作業を2つのタブで別々に変えないように)
    const same = project ? await this.tabOf(handle) : undefined;
    if (same) {
      if (same !== this.tab) await this.switchTabNow(same);
      toast(`「${file.name}」はもう開いています。`, 'info');
      return;
    }
    if (this.tabsFull()) return;
    if (project) {
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(await file.arrayBuffer()); } catch (e) {
        toast(`「${file.name}」を読めませんでした: ${e instanceof Error ? e.message : e}`, 'error', 6000);
        return;
      }
      // 一覧への記録は待たない(記録が遅れたり失敗したりしても、次のファイルを開けるように)
      if (await this.openProjectBytes(bytes, file.name, handle ?? null)) void this.remember('project', file.name, file.size, handle, () => bytes);
    } else if (await this.openImage(file)) void this.remember('image', file.name, file.size, handle, async () => new Uint8Array(await file.arrayBuffer()));
  }

  /**
   * 最近開いたファイルの一覧に足す。縮小画像は今の視点で描く。
   * 一覧に入れられなくても、開く・保存するのは止めない。
   */
  private async remember(kind: RecentKind, name: string, size: number, handle: FileSystemFileHandle | null | undefined, bytes: () => Promise<Uint8Array> | Uint8Array, thumbPng?: Uint8Array): Promise<void> {
    const png = thumbPng ?? await this.thumbnail();
    const thumb = png ? new Blob([png as BlobPart], { type: 'image/png' }) : undefined;
    await recent.add({ name, kind, size, thumb, handle, bytes });
  }

  /**
   * 新しい画像に使う背景・自動揺らし・画角。最後に変えた値をブラウザに覚えてあれば、それを使う
   * (main.ts で覚える)。無ければ今の作業の値を引き継ぐ。
   */
  private newImageDefaults(): Pick<Project, 'background' | 'autoSwing'> & { fov: number } {
    const prev = this.project, d = prefs.get<Record<string, unknown>>('newImage') ?? {};
    const num = (v: unknown, lim: { min: number; max: number }, def: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lim.min, Math.min(lim.max, v)) : def);
    const a = (d.autoSwing && typeof d.autoSwing === 'object' ? d.autoSwing : {}) as Record<string, unknown>;
    const bg = d.background === null || (typeof d.background === 'string' && /^#[0-9a-f]{6}$/i.test(d.background)) ? d.background as string | null : prev.background;
    return {
      background: 'background' in d ? bg : prev.background,
      autoSwing: {
        enabled: typeof a.enabled === 'boolean' ? a.enabled : prev.autoSwing.enabled,
        period: num(a.period, LIMITS.period, prev.autoSwing.period),
        strength: num(a.strength, { min: 0, max: 1 }, prev.autoSwing.strength),
      },
      fov: num(d.fov, LIMITS.fov, prev.camera.fov),
    };
  }

  /** 開けたら true */
  async openImage(file: File): Promise<boolean> {
    setBusy(true);
    try {
      const { asset, canvas } = await fileToAsset(file, this.displaySize);
      const p = createProject(createDocument(asset, file.name)), d = this.newImageDefaults();
      p.background = d.background;
      p.autoSwing = d.autoSwing;
      p.camera.fov = d.fov;
      if (!(await this.loadProject(p, { canvas }))) return false;
      this.setTool('brush');
      toast(`「${file.name}」を開きました。動かしたい所を塗ってください。`, 'success');
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : '画像を読み込めませんでした。', 'error');
      return false;
    } finally { setBusy(false); }
  }

  /**
   * 開けたら true。開けなければ理由を伝えて false を返し、今の状態は変えない。
   * restore は自動保存から戻すときの、そのタブの id(自動保存のキー)・並び・見出し
   */
  async openProjectBytes(bytes: Uint8Array, name: string | null, handle: FileSystemFileHandle | null, dirty = false, restore?: { tabId: string; order: number; name: string }): Promise<boolean> {
    setBusy(true);
    try {
      const { project } = await deserializeProject(bytes, { decodeFallback: browserDecodeGray });
      if (!(await this.loadProject(project, { fileName: name ?? restore?.name ?? null, handle, dirty, tabId: restore?.tabId, order: restore?.order }))) return false;
      if (name) toast(`「${name}」を開きました。`, 'success');
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'プロジェクトを開けませんでした。', 'error', 6000);
      return false;
    } finally { setBusy(false); }
  }

  /* ---------- 保存 ---------- */

  async thumbnail(): Promise<Uint8Array | undefined> {
    if (!this.doc) return undefined;
    this.flushWeights();
    try {
      const w = 320, h = 240, t = performance.now();
      const px = this.stage.renderFrame(w, h, this.project.camera, this.project.background);
      this.perf?.event({ t, d: performance.now() - t, kind: 'thumbnail' });
      return await rgbaToPng(px, w, h);
    } catch { return undefined; }
  }

  serialize(thumbnail?: Uint8Array): Uint8Array { return serializeProject(this.project, { thumbnail }); }

  suggestedName(tab: Tab = this.tab): string {
    if (tab.fileName) return tab.fileName;
    const base = (tab.project.documents[0]?.name ?? 'untitled').replace(/\.[^.]+$/, '');
    return `${base}${FILE_EXTENSION}`;
  }

  async save(saveAs = false): Promise<boolean> {
    if (!this.doc) return false;
    // 保存先を選んでいる間にタブを切り替えても、このタブに書き戻す
    const tab = this.tab;
    // 書き込みを待つ間に変更されたら、その変更は保存されていないので「未保存」のまま残す
    const thumb = await this.thumbnail();
    // 間引き中の視点の変更は、これから保存する内容に含まれるので、ここで通知を取り消す
    const cameraPending = tab === this.tab && this.cameraTimer !== 0;
    if (cameraPending) { clearTimeout(this.cameraTimer); this.cameraTimer = 0; }
    const revision = tab.revision;
    const bytes = serializeProject(tab.project, { thumbnail: thumb });
    const blob = new Blob([bytes as BlobPart], { type: 'application/zip' });
    try {
      const h = await saveFile(blob, this.suggestedName(tab), PROJECT_TYPES, saveAs ? null : tab.fileHandle);
      if (h === undefined) { if (cameraPending) this.cameraUnsaved(tab); return false; }
      tab.fileHandle = h;
      if (h) tab.fileName = h.name; else tab.fileName ??= this.suggestedName(tab);
      tab.lastSaved = new Date();
      tab.sample = false; // 保存したら、次に開いたファイルで置き換えない
      tab.autosaveError = null; // ファイルに保存できたので、自動保存の失敗の案内は消す
      if (tab.revision === revision) {
        tab.dirty = false;
        // 予約中の自動保存は取り消し、実行中のものがあれば終わってから消す(古い内容が後から書き込まれないように)
        clearTimeout(tab.autosaveTimer);
        void tab.autosaving.then(() => { if (!tab.dirty) return autosave.clear(tab.id); });
      } else {
        this.scheduleAutosave(tab);
      }
      this.emit('file', undefined);
      this.emit('tabs', undefined);
      toast(h ? `「${h.name}」に保存しました。` : `「${tab.fileName}」をダウンロードしました。`, 'success');
      void this.remember('project', tab.fileName ?? this.suggestedName(tab), bytes.byteLength, h, () => bytes, thumb);
      return true;
    } catch (e) {
      if (cameraPending) this.cameraUnsaved(tab); // 保存できなかったので、視点の変更は未保存のまま
      toast(`保存できませんでした: ${e instanceof Error ? e.message : e}`, 'error', 6000);
      return false;
    }
  }

  /** 保存できなかったときに、取り消していた視点の変更を「未保存」に戻す。待つ間にタブを切り替えていたら、そのタブに付ける */
  private cameraUnsaved(tab: Tab): void {
    if (tab === this.tab) { this.cameraChanged(); return; }
    tab.revision++;
    tab.lastAutosave = null;
    tab.dirty = true;
    this.scheduleAutosave(tab);
    this.emit('tabs', undefined);
  }

  /** そのタブの自動保存を予約する。裏に回ったタブも中身は変わらないので、予約どおりに保存する */
  private scheduleAutosave(tab: Tab = this.tab): void {
    clearTimeout(tab.autosaveTimer);
    /** 表のタブの塗りの最中・ぼかしのプレビュー中は、確定していない状態を保存しないよう後に回す */
    const unsettled = () => tab === this.tab && (!!this.stroke || this.previewingBlur || this.previewingInflate);
    const live = () => this.tabs.includes(tab) && tab.dirty && !!tab.project.documents[0];
    tab.autosaveTimer = window.setTimeout(() => {
      tab.autosaveTimer = 0;
      if (!live()) return;
      if (unsettled()) { this.scheduleAutosave(tab); return; }
      const fail = (e: unknown) => {
        console.warn('autosave failed', e);
        tab.autosaveError = e instanceof Error ? e.message : String(e);
        // 裏のタブの失敗はステータスバーに出ないので、その場で知らせる
        if (tab !== this.tab) toast(`「${this.tabName(tab)}」の自動保存に失敗しました(${tab.autosaveError})。そのタブを保存してください。`, 'error', 8000);
        this.emit('status', undefined);
      };
      // 直列化は重いので、操作の合間(アイドル時間)に行う
      idle(() => {
        if (!live()) return;
        if (unsettled()) { this.scheduleAutosave(tab); return; }
        try {
          const t = performance.now();
          const bytes = serializeProjectBlob(tab.project, { pngCache: tab.pngCache });
          const t1 = performance.now();
          const run = autosave.save(tab.id, { savedAt: Date.now(), name: this.suggestedName(tab), bytes, order: tab.order })
            .then(() => {
              tab.lastAutosave = new Date(); tab.autosaveError = null; this.emit('status', undefined);
              // 書き込んでいる間にタブを閉じたら、書いた分を消す
              if (!this.tabs.includes(tab)) return autosave.clear(tab.id);
            }, fail);
          if (this.perf) {
            const p = this.perf;
            p.event({ t, d: t1 - t, kind: 'autosave', detail: `${(bytes.size / 1e6).toFixed(1)}MB を直列化(メインスレッド)` });
            void run.then(() => p.event({ t: t1, d: performance.now() - t1, kind: 'autosave-write', detail: 'IndexedDB への書き込み完了まで(非同期)' }));
          }
          tab.autosaving = tab.autosaving.then(() => run);
        } catch (e) { fail(e); }
      });
    }, AUTOSAVE_DELAY);
  }

  /* ---------- 塗り ---------- */

  /** ストロークを始める。x, y は元画像のローカル座標(ピクセル、中心が原点)。 */
  beginStroke(mode: PaintMode, x: number, y: number, pressure: number): boolean {
    const doc = this.doc, layer = this.activeLayer;
    if (!doc || !layer) return false;
    if (!layer.visible) { toast('非表示のレイヤーには塗れません。', 'warning'); return false; }
    if (this.previewingInflate) { toast('「膨らませる」を適用するかキャンセルしてから塗ってください。', 'warning'); return false; }
    if (this.previewingBlur) { toast('「全体をぼかす」を適用するかキャンセルしてから塗ってください。', 'warning'); return false; }
    const wm = layer.weights, k = wm.width / doc.image.width;
    this.stroke = {
      stroke: new Stroke(wm, mode, { size: this.brush.size * k, strength: this.brush.strength, hardness: this.brush.hardness }),
      layerId: layer.id,
      label: { brush: 'ブラシ', erase: '消しゴム', smooth: 'ぼかし' }[mode],
    };
    this.strokeTo(x, y, pressure);
    return true;
  }

  strokeTo(x: number, y: number, pressure: number): void {
    const st = this.stroke, doc = this.doc; if (!st || !doc) return;
    const wm = st.stroke.map, px = (x / doc.image.width + 0.5) * wm.width, py = (0.5 - y / doc.image.height) * wm.height;
    const p = this.brush.pressure;
    const rect = st.stroke.addPoint(px, py, p === 'size' ? pressure : 1, p === 'strength' ? pressure : 1);
    if (rect) this.store.weightsChanged(st.layerId, rect, false);
  }

  endStroke(): void {
    const st = this.stroke; if (!st) return;
    this.stroke = null;
    this.centers.delete(st.layerId);
    const tiles = st.stroke.finish();
    if (tiles.length) {
      this.history.push(new WeightEdit(st.label, st.layerId, tiles));
      this.store.emit('change', undefined);
    }
  }

  /** ストロークを取り消す(スマホで2本目の指が置かれたとき)。塗った分を元に戻し、アンドゥには積まない */
  cancelStroke(): void {
    const st = this.stroke; if (!st) return;
    this.stroke = null;
    this.centers.delete(st.layerId);
    const tiles = st.stroke.finish(), wm = this.store.findLayer(st.layerId)?.layer.weights;
    if (!wm || !tiles.length) return;
    // 塗る前に戻すだけなので、「未保存」にも自動保存の予約にもしない(weightsChanged の persistent = false)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of tiles) {
      const r = wm.tileRect(t.tx, t.ty);
      wm.writeRect(r, t.before);
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    }
    this.store.weightsChanged(st.layerId, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, false);
  }

  get stroking(): boolean { return !!this.stroke; }

  /* ---------- ウェイトの一括処理 ---------- */

  /** 選んでいるレイヤーそれぞれにかける。複数のときもまとめて1手 */
  weightOp(label: string, op: (wm: Layer['weights']) => void): void {
    const layers = this.selectedLayers; if (!layers.length) return;
    const cmds = layers.map(l => weightOperation(this.store, l.id, label, op)).filter((c): c is WeightEdit => !!c);
    if (!cmds.length) { toast('変化はありませんでした。'); return; }
    this.history.push(cmds.length === 1 && layers.length === 1 ? cmds[0] : new Batch(countLabel(label, layers.length), cmds));
  }

  /* 全体をぼかす(ガウス): プレビューしながら半径を決め、適用で1手として記録する */

  /** ぼかしているレイヤー(選んでいるレイヤー全部)と、それぞれの元のウェイト */
  private blurPreview: { layers: { layerId: string; original: Uint8Array }[] } | null = null;

  beginBlurPreview(): boolean {
    const layers = this.selectedLayers; if (!layers.length || this.blurPreview) return false;
    this.blurPreview = { layers: layers.map(l => ({ layerId: l.id, original: l.weights.data.slice() })) };
    this.autoShowOverlay();
    this.emit('blur', 'begin');
    return true;
  }

  /** radius は元画像のピクセル単位。0 で元に戻した状態を表示する。 */
  previewBlur(radius: number): void {
    const p = this.blurPreview, doc = this.doc; if (!p || !doc) return;
    for (const e of p.layers) {
      const layer = this.store.findLayer(e.layerId)?.layer; if (!layer) continue;
      const wm = layer.weights;
      wm.data.set(e.original);
      if (radius > 0) wm.gaussianBlur(radius * (wm.width / doc.image.width));
      this.store.weightsChanged(e.layerId, wm.fullRect, false);
    }
  }

  endBlurPreview(apply: boolean, radius: number): void {
    const p = this.blurPreview; if (!p) return;
    this.blurPreview = null;
    try { this.finishBlur(p, apply, radius); } finally { this.emit('blur', 'end'); this.autoHideOverlay(); }
  }

  private finishBlur(p: NonNullable<App['blurPreview']>, apply: boolean, radius: number): void {
    const label = `全体をぼかす(半径 ${radius}px)`, cmds: WeightEdit[] = [];
    for (const e of p.layers) {
      const layer = this.store.findLayer(e.layerId)?.layer; if (!layer) continue;
      const wm = layer.weights;
      if (!apply) { wm.data.set(e.original); this.store.weightsChanged(e.layerId, wm.fullRect, false); continue; }
      const tiles = diffTiles(e.original, wm);
      if (tiles.length) cmds.push(new WeightEdit(label, e.layerId, tiles));
    }
    if (!apply) return;
    if (!cmds.length) { toast('変化はありませんでした。'); return; }
    this.history.push(p.layers.length === 1 ? cmds[0] : new Batch(countLabel(label, p.layers.length), cmds));
    this.store.emit('change', undefined);
  }

  get previewingBlur(): boolean { return !!this.blurPreview; }

  /* 膨らませる: 範囲(楕円・矩形)を、指定した高さと断面で一括して膨らませる。
     プレビューしながら数値を決め、適用で1手として記録する。
     高さが範囲を描いたレイヤーのポップ量を超えるときは、そのレイヤーには触れず、ポップ量 = 高さの新しいレイヤーに作る
     (今の塗りを縮めてポップ量を上げると、揺れも小さくなり、8 ビットのウェイトの階調も粗くなるため)。
     新しいレイヤーはプレビューの間だけ仮に挿入し、アンドゥにも「未保存」にも数えない */

  private inflateSession: {
    layerId: string; original: Uint8Array; area: InflateArea; settings: InflateSettings & { height: number };
    sourcePop: number;
    /** プレビュー中に仮に挿入している新しいレイヤー(同じレイヤーに作るときは null) */
    newLayer: Layer | null;
    /** 新しいレイヤーに作るときの名前(仮に挿入していなくても決めておく) */
    newName: string;
    limited: boolean;
  } | null = null;

  get previewingInflate(): boolean { return !!this.inflateSession; }
  /** 全体ぼかし・膨らませるのプレビュー中か。プレビュー中のウェイトを元に戻したりしないよう、使える操作を絞る */
  get previewing(): boolean { return this.previewingBlur || this.previewingInflate; }
  get inflateState(): InflateState | null {
    const s = this.inflateSession; if (!s) return null;
    return { layerId: s.layerId, area: s.area, settings: s.settings, sourcePop: s.sourcePop, limited: s.limited, newLayer: s.newLayer && { name: s.newLayer.name, pop: s.newLayer.pop } };
  }

  /** 範囲を描き始める(ドラッグの最初の動きで呼ぶ) */
  beginInflateArea(area: InflateArea): boolean {
    const layer = this.activeLayer, doc = this.doc;
    if (this.previewingBlur) { toast('「全体をぼかす」を適用するかキャンセルしてから膨らませてください。', 'warning'); return false; }
    if (!layer || !doc || this.busy) return false;
    if (!layer.visible) { toast('非表示のレイヤーには塗れません。', 'warning'); return false; }
    const st = this.inflateSettings;
    this.inflateSession = {
      layerId: layer.id, original: layer.weights.data.slice(), area: { ...area },
      // 高さの初期値は前回の値、初めてならポップ量と同じ(ポップ量が 0 なら既定のポップ量)
      // 前回の高さは引き継ぐが、このレイヤーのポップ量は超えない(いきなり新しいレイヤーに作らない)
      settings: { ...st, height: layer.pop > 0 ? Math.min(st.height ?? layer.pop, layer.pop) : (st.height ?? LIMITS.pop.def) },
      sourcePop: layer.pop, newLayer: null, newName: nextInflateLayerName(doc), limited: false,
    };
    this.renderInflate();
    this.emit('inflate', 'begin');
    return true;
  }

  updateInflate(patch: { area?: Partial<InflateArea>; settings?: Partial<InflateSettings> }): void {
    const s = this.inflateSession; if (!s) return;
    if (patch.area) s.area = { ...s.area, ...patch.area };
    if (patch.settings) s.settings = { ...s.settings, ...patch.settings, height: patch.settings.height ?? s.settings.height };
    this.renderInflate();
    this.emit('inflate', 'change');
  }

  /**
   * プレビュー用の新しいレイヤーを、範囲を描いたレイヤーのすぐ上に仮に入れる / 外す。
   * 構成が変わったことだけを知らせ(GPU への全面転送とレイヤー一覧の更新)、変更としては数えない
   */
  private setPreviewLayer(on: boolean): void {
    const s = this.inflateSession, doc = this.doc; if (!s || !doc) return;
    if (on && !s.newLayer) {
      const f = this.store.findLayer(s.layerId); if (!f) return;
      const layer = createLayer(doc, s.newName);
      // 揺れ方は元のレイヤーにそろえる(同じ物の一部として揺れるように)
      layer.physics = { ...f.layer.physics, motionParams: { ...f.layer.physics.motionParams } };
      doc.layers.splice(f.index + 1, 0, layer);
      s.newLayer = layer;
      this.store.emit('layers', { docId: doc.id });
    } else if (!on && s.newLayer) {
      const i = doc.layers.indexOf(s.newLayer);
      if (i >= 0) doc.layers.splice(i, 1);
      s.newLayer = null;
      this.store.emit('layers', { docId: doc.id });
    }
  }

  private renderInflate(): void {
    const s = this.inflateSession, doc = this.doc; if (!s || !doc) return;
    const source = this.store.findLayer(s.layerId)?.layer; if (!source) return;
    const st = s.settings;
    // 仮のレイヤーは数えずに、もう1枚足せるか
    const layerCount = doc.layers.length - (s.newLayer ? 1 : 0);
    const over = st.height > s.sourcePop, useNew = over && layerCount < LIMITS.maxLayers;
    s.limited = over && !useNew;
    // 範囲を描いたレイヤーは、新しいレイヤーに作るときは元のまま、そうでなければ元の上に重ねる
    source.weights.data.set(s.original);
    this.store.weightsChanged(s.layerId, source.weights.fullRect, false);
    this.setPreviewLayer(useNew);
    const target = s.newLayer ?? source, wm = target.weights;
    if (s.newLayer) {
      wm.data.fill(0);
      const pop = Math.min(LIMITS.pop.max, Math.ceil(st.height));
      if (s.newLayer.pop !== pop) { s.newLayer.pop = pop; this.store.emit('layer', { layerId: s.newLayer.id, keys: ['pop'] }); }
    }
    const base = s.newLayer ? wm.data.slice() : s.original;
    const a = s.area, kx = wm.width / doc.image.width, ky = wm.height / doc.image.height;
    const level = target.pop > 0 ? Math.min(1, st.height / target.pop) : 0;
    inflateShape(wm, base, {
      kind: st.shape, cx: (a.x / doc.image.width + 0.5) * wm.width, cy: (0.5 - a.y / doc.image.height) * wm.height, rx: a.w / 2 * kx, ry: a.h / 2 * ky,
      angle: st.angle * Math.PI / 180,
    }, { level, softness: st.softness, profile: st.profile, blend: st.blend });
    this.store.weightsChanged(target.id, wm.fullRect, false);
  }

  endInflate(apply: boolean): void {
    const s = this.inflateSession, doc = this.doc; if (!s) return;
    const source = this.store.findLayer(s.layerId)?.layer, newLayer = s.newLayer;
    if (!apply || !doc || !source) {
      this.setPreviewLayer(false);
      if (source) { source.weights.data.set(s.original); this.store.weightsChanged(s.layerId, source.weights.fullRect, false); }
      this.inflateSession = null;
      this.emit('inflate', 'end');
      return;
    }
    this.inflateSession = null;
    const st = s.settings;
    this.inflateSettings = { ...st }; // 次に描くときも同じ設定で始める
    const shape = `${st.shape === 'ellipse' ? '楕円' : '矩形'} ${Math.round(s.area.w)}×${Math.round(s.area.h)}px${st.angle ? `・${st.angle}°` : ''}`;
    if (newLayer && !newLayer.weights.data.some(v => v > 0)) {
      // 範囲がすべて画像の外などで何も膨らまなかったときは、空のレイヤーを残さない
      this.inflateSession = s;
      this.endInflate(false);
      toast('変化はありませんでした。');
      return;
    }
    if (newLayer) {
      // 仮に入れたレイヤーをそのまま正式に追加する。戻すとレイヤーごと消え、元のレイヤーは触れていないので元どおり
      const index = doc.layers.indexOf(newLayer);
      this.history.push(new InsertLayer(`膨らませる(${shape}・高さ ${st.height}px・新しいレイヤー「${newLayer.name}」)`, doc.id, newLayer, index));
      this.store.emit('change', undefined);
      this.setActiveLayer(newLayer.id);
    } else {
      const tiles = diffTiles(s.original, source.weights);
      const height = s.limited ? s.sourcePop : st.height; // 上限の枚数で新しいレイヤーを作れないときは、ポップ量で止まる
      if (!tiles.length) toast('変化はありませんでした。');
      else {
        this.history.push(new WeightEdit(`膨らませる(${shape}・高さ ${height}px)`, s.layerId, tiles));
        this.store.emit('change', undefined);
      }
    }
    this.emit('inflate', 'end');
  }

  fromAlpha(): void {
    const c = this.imageCanvas, layer = this.activeLayer, doc = this.doc; if (!c || !layer || !doc) return;
    const alpha = canvasAlpha(c, layer.weights.width, layer.weights.height);
    if (alpha.every(a => a === 255)) { toast('この画像には透明な部分がありません(画像全体が塗られます)。', 'warning', 5000); }
    // 輪郭の外へ1マス分広げ、境目の斜面を透明な所へ追い出す。輪郭ちょうどで切ると、横から見たとき輪郭が斜面で伸びて見えるため
    const spread = alphaSpreadPx(layer.weights.width, layer.weights.height, meshSegments(doc.image.width, doc.image.height, doc.meshDensity));
    this.weightOp('アルファから生成', wm => { wm.setFromAlpha(alpha, wm.width, wm.height); wm.dilate(spread); });
  }

  /* ---------- レイヤー構成 ---------- */

  addLayer(): void {
    const doc = this.doc; if (!doc) return;
    if (doc.layers.length >= LIMITS.maxLayers) { toast(`レイヤーは最大 ${LIMITS.maxLayers} 枚です。`, 'warning'); return; }
    const layer = createLayer(doc, nextLayerName(doc));
    const index = this.activeIndex >= 0 ? this.activeIndex + 1 : doc.layers.length;
    this.history.execute(new InsertLayer('レイヤーを追加', doc.id, layer, index));
    this.setActiveLayer(layer.id);
  }

  /** 選んでいるレイヤーを、それぞれのすぐ上に複製する。複製したものを選ぶ */
  duplicateLayer(): void {
    const doc = this.doc, src = this.selectedLayers; if (!doc || !src.length) return;
    if (doc.layers.length + src.length > LIMITS.maxLayers) { toast(`レイヤーは最大 ${LIMITS.maxLayers} 枚です。`, 'warning'); return; }
    const cmds: Command[] = [], ids: string[] = [];
    let primary = '';
    // 上から順に入れると、下のレイヤーの位置がずれない
    for (const l of [...src].reverse()) {
      const copy = cloneLayer(l, `${l.name} のコピー`);
      cmds.push(new InsertLayer('レイヤーを複製', doc.id, copy, doc.layers.indexOf(l) + 1));
      ids.push(copy.id);
      if (l.id === this.activeLayerId) primary = copy.id;
    }
    this.history.execute(cmds.length === 1 ? cmds[0] : new Batch(countLabel('レイヤーを複製', cmds.length), cmds));
    this.selectLayers(ids, primary || ids[0]);
  }

  /** 選んでいるレイヤーを消す。1枚は残す */
  deleteLayer(): void {
    const doc = this.doc, layers = this.selectedLayers; if (!doc || !layers.length) return;
    if (doc.layers.length - layers.length < 1) { toast(doc.layers.length <= 1 ? '最後のレイヤーは削除できません。' : 'すべてのレイヤーは削除できません。1枚は残してください。', 'warning'); return; }
    // 消したあとは、最後に押したレイヤーのすぐ上に残るレイヤー(無ければいちばん上)を選ぶ
    const i = this.activeIndex, rest = doc.layers.filter(l => !this.selectedLayerIds.has(l.id));
    const next = rest.find(l => doc.layers.indexOf(l) > i) ?? rest[rest.length - 1];
    const cmds = layers.map(l => new RemoveLayer(this.store, l.id));
    // 上から消すと、残りのレイヤーの位置がずれない(元に戻すときは下から入れ直す)
    this.history.execute(cmds.length === 1 ? cmds[0] : new Batch(countLabel('レイヤーを削除', cmds.length), cmds.reverse()));
    this.setActiveLayer(next.id);
  }

  /** 一覧の上を手前(配列の後ろ)として並べ替える。dir: +1 で上へ */
  moveLayer(dir: 1 | -1): void {
    const doc = this.doc, layer = this.activeLayer; if (!doc || !layer) return;
    const from = this.activeIndex, to = from + dir;
    if (to < 0 || to >= doc.layers.length) return;
    this.history.execute(new MoveLayer(layer.id, from, to));
  }

  /* ---------- 揺れの切り替えとプリセット(右パネル・レイヤー一覧の行・左のツールバー・メニュー・スマホのどこから変えても、ここを通す) ---------- */

  /** 選択中のレイヤー(ids を渡したときはそのレイヤーだけ。レイヤー一覧の行のアイコン)を揺らすか */
  setLayerSwing(on: boolean, ids?: readonly string[]): void {
    const targets = ids ? (this.doc?.layers ?? []).filter(l => ids.includes(l.id)) : this.selectedLayers;
    const ls = targets.filter(l => l.physics.enabled !== on);
    if (!ls.length) return;
    const label = countLabel('揺れの切替', targets.length);
    this.history.execute(batchOf(label, ls.map(l => PatchLayer.from(this.store, l.id, { physics: { ...l.physics, enabled: on } }, label))));
  }

  /** 周期的に自動で揺らすか */
  setAutoSwing(on: boolean): void {
    if (this.project.autoSwing.enabled === on) return;
    this.history.execute(PatchProject.from(this.store, { autoSwing: { ...this.project.autoSwing, enabled: on } }, '自動揺らしの切替'));
  }

  /**
   * 選択中のレイヤーに揺れのプリセットを当てる。材質と揺らし方を変える。
   * 自動揺らしの周期はプロジェクト全体の設定なので、揺れているレイヤーがこのレイヤーだけのときだけ、おすすめの値にする
   * (ほかのレイヤーの揺れ方まで変えないように)。変えるときはまとめて1手
   */
  setPreset(name: PresetName): void {
    const ls = this.selectedLayers.filter(l => l.physics.preset !== name), n = this.selectedLayerIds.size;
    if (!ls.length) return;
    if (name === 'custom') {
      const label = countLabel('プリセット', n);
      this.history.execute(batchOf(label, ls.map(l => PatchLayer.from(this.store, l.id, { physics: { ...l.physics, preset: 'custom' } }, label))));
      return;
    }
    const pr = PRESETS[name], label = countLabel(`プリセット「${pr.label}」`, n);
    // 選んでいないレイヤーで揺れているもの(表示中・揺れがオン・塗ってある)があるか。膨らませるのプレビューで仮に入れたレイヤーは数えない
    const temp = this.inflateSession?.newLayer?.id;
    const others = this.doc?.layers.some(o => !this.selectedLayerIds.has(o.id) && o.id !== temp && o.visible && o.physics.enabled && o.weights.data.some(v => v > 0)) ?? false;
    const changePeriod = !others && this.project.autoSwing.period !== pr.period;
    this.history.execute(new Batch(label, [
      ...ls.map(l => PatchLayer.from(this.store, l.id, { physics: applyPreset(l.physics, name) }, label)),
      ...(changePeriod ? [PatchProject.from(this.store, { autoSwing: { ...this.project.autoSwing, period: pr.period } }, label)] : []),
    ]));
    const self = n > 1 ? '選んだレイヤー' : 'このレイヤー';
    if (others && this.project.autoSwing.period !== pr.period) {
      toast(`ほかにも揺れているレイヤーがあるので、自動揺らしの周期は変えていません(このプリセットのおすすめは ${pr.period.toFixed(1)} 秒。「アニメーション」タブで変えられます)。`, 'info', 6000);
    } else if (!this.project.autoSwing.enabled) toast('「自動で揺らす」がオフなので、自動では動きません。「つかむ」「揺らす」で揺らすか、自動揺らしをオンにしてください。', 'info', 5000);
    else if (this.selectedLayers.every(l => !l.physics.enabled)) toast(`${self}は「揺れ」がオフです。`, 'info');
  }

  /* ---------- お気に入り(揺れと動きの組み合わせ。右パネル・メニュー・左のツールバー・キーのどこからも、ここを通す) ---------- */

  /** お気に入りを今触れるか(記録中・書き出し中・プレビュー中は、残す中身が定まらないので触らせない) */
  get canEditFavorites(): boolean {
    return !!this.doc && this.takeState !== 'recording' && !this.exporting && !this.previewing && !this.stroking;
  }

  /** 今の揺れと動きの組み合わせを、お気に入りの末尾に残す(アンドゥできる) */
  addFavorite(): void {
    const doc = this.doc, list = this.project.favorites;
    if (!doc || !this.canEditFavorites) return;
    if (list.length >= LIMITS.favorites) { toast(`お気に入りは ${LIMITS.favorites} 件までです。要らないものを消してから追加してください。`, 'warning'); return; }
    const f = captureFavorite(this.project, doc, { name: nextFavoriteName(list), playing: this.takeState === 'playing' });
    this.history.execute(new SetFavorites(`お気に入りに追加「${f.name}」`, list, [...list, f]));
    toast(`「${f.name}」を追加しました。`, 'success', 2000);
  }

  /** お気に入りを今の状態で上書きする(名前と並びはそのまま) */
  overwriteFavorite(id: string): void {
    const doc = this.doc, list = this.project.favorites, i = list.findIndex(f => f.id === id);
    if (!doc || i < 0 || !this.canEditFavorites) return;
    const old = list[i];
    const f = captureFavorite(this.project, doc, { name: old.name, id: old.id, createdAt: new Date().toISOString(), playing: this.takeState === 'playing' });
    this.history.execute(new SetFavorites(`お気に入りを上書き「${old.name}」`, list, list.map((x, j) => (j === i ? f : x))));
    toast(`「${old.name}」を今の状態で上書きしました。`, 'success', 2000);
  }

  renameFavorite(id: string, name: string): void {
    const list = this.project.favorites, i = list.findIndex(f => f.id === id), v = name.trim().slice(0, FAVORITE_NAME_MAX);
    if (i < 0 || !v || v === list[i].name || !this.canEditFavorites) return;
    this.history.execute(new SetFavorites('お気に入りの名前の変更', list, list.map((x, j) => (j === i ? { ...x, name: v } : x))));
  }

  removeFavorite(id: string): void {
    const list = this.project.favorites, f = list.find(x => x.id === id);
    if (!f || !this.canEditFavorites) return;
    this.history.execute(new SetFavorites(`お気に入りを消す「${f.name}」`, list, list.filter(x => x !== f)));
  }

  /**
   * お気に入りの組み合わせを当てる。レイヤー(ポップ量・重ね方・揺れ)・自動揺らし・記録・画角は1手にまとめてアンドゥでき、
   * 視点(回転・ズーム・位置)はほかの視点の操作と同じくアンドゥには積まない。残したときに再生していたら、再生を始める。
   * お気に入りにあって今は無いレイヤーは飛ばし、後から足したレイヤーはそのままにする。
   */
  applyFavorite(id: string): void {
    const doc = this.doc, f = this.project.favorites.find(x => x.id === id);
    if (!doc || !f || !this.canEditFavorites) return;
    this.stopTake();
    const label = `お気に入り「${f.name}」`, cam = this.project.camera, cmds: Command[] = [];
    let missing = 0;
    for (const fl of f.layers) {
      const l = doc.layers.find(x => x.id === fl.id);
      if (!l) { missing++; continue; }
      if (!sameLayer(fl, l)) cmds.push(PatchLayer.from(this.store, l.id, { pop: fl.pop, blend: fl.blend, physics: copyPhysics(fl.physics) }, label));
    }
    const a = f.autoSwing, b = this.project.autoSwing;
    if (a.enabled !== b.enabled || a.period !== b.period || a.strength !== b.strength) cmds.push(PatchProject.from(this.store, { autoSwing: { ...a } }, label));
    if (f.take !== this.project.take) cmds.push(new SetTake(label, this.project.take, f.take));
    if (f.camera.fov !== cam.fov) cmds.push(new SetFov(label, cam.fov, f.camera.fov));
    if (cmds.length) this.history.execute(new Batch(label, cmds));
    // 画角を変えると camera は新しいオブジェクトに差し替わるので、実行したあとの camera に当てる
    applyView(this.project.camera, f.camera);
    this.world.cutView(); // 視点が飛ぶだけなので揺らさない
    this.cameraChanged();
    this.emit('status', undefined);
    if (f.playing && this.project.take) this.playTake();
    if (missing) toast(`「${f.name}」にあったレイヤーのうち ${missing} 枚は、もう無いので飛ばしました。`, 'info', 5000);
  }

  /* ---------- 物理と描画のループ ---------- */

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
    const doc = this.doc;
    if (!doc) return { x: 0, y: 0 };
    const c = this.layerCenter(doc, l), k = Math.max(doc.image.width, doc.image.height) / 2;
    return { x: c.x / k, y: c.y / k };
  };

  /** レイヤーのウェイトの重心(画像のローカル座標、元画像のピクセル) */
  private layerCenter(doc: Document, l: Layer): { x: number; y: number } {
    let c = this.centers.get(l.id);
    if (!c) {
      const { u, v } = l.weights.centroidUV();
      this.centers.set(l.id, (c = { x: (u - 0.5) * doc.image.width, y: (v - 0.5) * doc.image.height }));
    }
    return c;
  }

  private recordStep = (): void => {
    const w = this.world, c = this.project.camera, take = this.project.take;
    if (this.takeState === 'playing' && take?.samples.length) {
      // ループ再生: 記録どおりにつかみを物理へ入れ、視点の代わりに画像を動かす(画角は今のまま)。
      // 揺れは、動く画像を今の視点(見る人が動かしてよい)から見た動きで決める
      const i = this.playIndex % take.samples.length, smp = take.samples[i], from = this.playFrom!;
      applySample(w, smp);
      const angles = (a: CameraState) => ({ yaw: a.yaw, pitch: a.pitch, roll: a.roll, zoom: a.zoom });
      w.viewRig = { from: { target: { ...from.target }, view: angles(from) }, to: { target: { ...(smp.viewTarget ?? smp.camera.target) }, view: angles(smp.camera) } };
      w.viewTarget = { ...c.target };
      w.viewAngles = angles(c);
      this.playCam = { ...smp.camera, fov: c.fov, target: { ...smp.camera.target } };
      // 一時停止中(シークバーで止めた・ドラッグしている間)は同じ所にとどまる。揺れはそのまま落ち着いていく
      if (!this.playPaused) this.playIndex = i + 1;
      // 「直前の操作を再生」の書き出しには、記録の視点で残す(見る視点を動かした分は入らない)
      // 見る視点を動かしていれば、控えの「1刻み前の視点」は見る視点のものなので、測り直す印にして残す(書き出しの初めで弾まないように)
      // シークで跳んだ刻みは、揺れを消して視点を測り直したことも残す(書き出しで跳んだ分が揺れにならないように)
      const moved = !sameView(c, from), seeked = this.playSeeked;
      this.playSeeked = false;
      this.recorder.record({ ...smp, ...(w.viewCut ? { viewCut: true } : {}), camera: { ...this.playCam, target: { ...this.playCam.target } } }, () => {
        const snap = w.snapshot();
        if (moved) snap.base = null;
        return snap;
      }, seeked);
      return;
    }
    // 平行移動・回転・ズームでも、「揺らす」で振っても揺らす
    const s = this.shake;
    w.viewTarget = { x: c.target.x + s.x, y: c.target.y + s.y, z: c.target.z + s.z };
    w.viewAngles = { yaw: c.yaw, pitch: c.pitch, roll: c.roll, zoom: c.zoom };
    this.recorder.record({
      viewCut: w.viewCut,
      viewTarget: { ...w.viewTarget },
      grab: w.grab ? { ...w.grab } : null,
      grabGains: [...w.grabGains],
      camera: { fov: c.fov, yaw: c.yaw, pitch: c.pitch, roll: c.roll, zoom: c.zoom, target: { ...c.target } },
    }, () => w.snapshot());
    if (this.takeState === 'recording') {
      // 1フレームで何刻みも進むことがあるので、最長に達したあとの刻みは積まない
      if (this.takeRaw.length < Math.round(TAKE_MAX_SECONDS / PHYSICS_DT)) this.takeRaw.push({
        grab: w.grab ? { ...w.grab } : null, grabGains: [...w.grabGains], viewTarget: { ...w.viewTarget }, viewCut: w.viewCut || undefined,
        camera: { fov: c.fov, yaw: c.yaw, pitch: c.pitch, roll: c.roll, zoom: c.zoom, target: { ...c.target } },
      });
      // 最長まで記録したら止める(物理を進めている途中なので、止めるのは刻みのあと)
      if (this.takeRaw.length >= Math.round(TAKE_MAX_SECONDS / PHYSICS_DT)) queueMicrotask(() => this.stopRecording(true));
    }
  };

  /* ---------- 操作の記録とループ再生 ---------- */

  /** 記録中なら記録した長さ、それ以外は保存してある記録の長さ(秒) */
  get takeLength(): number { return this.takeState === 'recording' ? this.takeRaw.length * PHYSICS_DT : takeSeconds(this.project.take); }
  /** ループ再生を一時停止しているか(シークバーの ⏸。揺れの一時停止とは別で、物理は進む) */
  playPaused = false;
  /** シークで揺れを消した直後か(次の刻みで操作の記録に控えを取る) */
  private playSeeked = false;

  /** ループ再生を一時停止する・続ける(再生中だけ) */
  setPlayPaused(on: boolean): void {
    if (this.takeState !== 'playing' || this.playPaused === on) return;
    this.playPaused = on;
    this.emit('take', this.takeState);
  }

  /**
   * ループ再生の位置を移す(秒。1周の中に丸める)。跳んだ先の揺れは落ち着いた状態から始める
   * (記録に揺れの途中の状態は残っていないため)。視点が飛ぶ分でも揺らさない
   */
  seekTake(seconds: number): void {
    const n = this.project.take?.samples.length ?? 0;
    if (this.takeState !== 'playing' || !n || !Number.isFinite(seconds)) return;
    const i = Math.round(seconds / PHYSICS_DT);
    this.playIndex = ((i % n) + n) % n;
    this.world.reset();
    this.playSeeked = true;
    // 位置はバーが描画のたびに追うので、ここでは 'take' を送らない(ドラッグの間、ほかの部品を描き直さない)
  }

  /** ループ再生中の位置(秒) */
  get takePosition(): number {
    const n = this.project.take?.samples.length ?? 0;
    return this.takeState === 'playing' && n ? (this.playIndex % n) * PHYSICS_DT : 0;
  }

  /** ループ再生中の、画像から見た今の視点(記録の視点)。再生していなければ null */
  get playView(): CameraState | null { return this.takeState === 'playing' ? this.playCam : null; }

  private setTakeState(s: TakeState): void { this.takeState = s; this.emit('take', s); }

  /** 記録を始める。つかむ・揺らす・移動・視点の操作を、止めるまで(最長 60 秒)覚える */
  startRecording(): void {
    if (!this.doc || this.takeState === 'recording') return;
    if (this.takeState === 'playing') this.stopTake();
    if (this.paused) this.setPaused(false); // 一時停止中は物理が進まず、記録もされない
    this.takeRaw = [];
    this.setTakeState('recording');
  }

  /** 記録を止めて、ループ再生できる形にして残す(アンドゥできる)。full は最長まで記録して止まったとき */
  stopRecording(full = false): void {
    if (this.takeState !== 'recording') return;
    const take = finalizeTake(this.takeRaw);
    this.takeRaw = [];
    this.setTakeState('idle');
    if (!take) { toast(`記録が短すぎます。「記録」を押したあと、${TAKE_MIN_SECONDS} 秒以上動かしてください。`, 'warning'); return; }
    this.history.execute(new SetTake('操作の記録', this.project.take, take));
    const sec = takeSeconds(take).toFixed(1);
    toast(full ? `最長の ${sec} 秒まで記録したので止めました。` : `${sec} 秒の操作を記録しました。「ループ再生」でくり返し再生できます。`, 'success');
  }

  toggleRecording(): void { if (this.takeState === 'recording') this.stopRecording(); else this.startRecording(); }

  /** 記録した操作を初めからループ再生する。画面を触ると止まる */
  playTake(): void {
    const take = this.project.take;
    if (!take?.samples.length || !this.doc) return;
    if (this.takeState === 'recording') this.stopRecording();
    if (this.paused) this.setPaused(false);
    this.playIndex = 0;
    this.playPaused = false;
    // 視点を記録の初めへ動かし、そこを画像を動かす基準にする(始めは画像が元の置き場所にある)
    const c = this.project.camera, s0 = take.samples[0].camera;
    c.yaw = s0.yaw; c.pitch = s0.pitch; c.roll = s0.roll; c.zoom = s0.zoom; c.target = { ...s0.target };
    this.playFrom = { ...c, target: { ...c.target } };
    this.playCam = { ...this.playFrom, target: { ...c.target } };
    this.world.cutView(); // 今の視点から記録の初めへ飛ぶ分では揺らさない
    this.world.grab = null; this.world.grabGains.clear();
    this.shake = { x: 0, y: 0, z: 0 };
    if (this.takeState !== 'playing') this.setTakeState('playing');
    this.emit('status', undefined);
  }

  /**
   * ループ再生をやめる(記録中なら何もしない)。画像は元の置き場所へ戻る。
   * 再生中に視点を動かしていなければ、視点を止めた所の記録の視点にする(画面はそのまま)。動かしていれば、その視点のまま
   */
  stopTake(): void {
    if (this.takeState !== 'playing') return;
    const c = this.project.camera, from = this.playFrom, at = this.playCam;
    if (from && at && sameView(c, from)) { c.yaw = at.yaw; c.pitch = at.pitch; c.roll = at.roll; c.zoom = at.zoom; c.target = { ...at.target }; }
    this.playFrom = this.playCam = null;
    this.playPaused = false;
    this.world.viewRig = null;
    this.stage.setRig(null);
    // 画面を触って止めたときは、すぐ後の当たり判定(pick)が今の視点で行われるようにする
    this.stage.applyCamera(c);
    this.world.grab = null; this.world.grabGains.clear();
    this.world.cutView(); // 物理に伝える注視点が記録の値から今の視点へ戻る分では揺らさない
    this.setTakeState('idle');
    this.emit('status', undefined);
    this.cameraChanged();
  }

  /** ループ再生中に、見る視点を再生の基準の視点(撮影カメラ。記録の初めの視点)へ戻す。再生は続ける */
  resetPlayView(): void {
    const from = this.playFrom;
    if (this.takeState !== 'playing' || !from) return;
    const c = this.project.camera;
    c.yaw = from.yaw; c.pitch = from.pitch; c.roll = from.roll; c.zoom = from.zoom; c.target = { ...from.target };
    this.world.cutView(); // 視点が飛ぶだけなので揺らさない
    this.emit('status', undefined);
    this.cameraChanged();
  }

  togglePlay(): void { if (this.takeState === 'playing') this.stopTake(); else this.playTake(); }

  /* ---------- キーフレームから動きを作る ---------- */

  /** 記録がキーフレームから作ったものなら、そのキーフレームを下書きに入れる。reset なら、そうでなくても下書きを空にする */
  private syncKeyDraft(reset = false): void {
    const k = this.project.take?.keys;
    if (k) this.keyDraft = structuredClone([...k]);
    else if (reset) this.keyDraft = [];
    else return;
    this.emit('take', this.takeState);
  }

  private viewKey(): ViewKey {
    const c = this.project.camera;
    return { yaw: c.yaw, pitch: c.pitch, roll: c.roll, zoom: c.zoom, target: { ...c.target } };
  }

  /** 今の視点を末尾のキーフレームとして足す。時間とつなぎ方は1つ前のフレームに合わせる */
  addKey(): void {
    if (this.keyDraft.length >= MAX_KEYS) return;
    this.stopTake();
    const prev = this.keyDraft.at(-1);
    this.keyDraft.push({ view: this.viewKey(), seconds: prev?.seconds ?? KEY_SECONDS.def, mode: prev?.mode ?? 'smooth' });
    this.emit('take', this.takeState);
  }

  /** i 番目のキーフレームを今の視点で登録し直す */
  setKey(i: number): void {
    const k = this.keyDraft[i];
    if (!k) return;
    this.stopTake();
    k.view = this.viewKey();
    this.emit('take', this.takeState);
  }

  removeKey(i: number): void {
    if (!this.keyDraft[i]) return;
    this.keyDraft.splice(i, 1);
    this.emit('take', this.takeState);
  }

  /** 視点を i 番目のキーフレームへ動かす(確かめる用。その動きでは揺らさない) */
  gotoKey(i: number): void {
    const k = this.keyDraft[i]?.view;
    if (!k) return;
    this.stopTake();
    const c = this.project.camera;
    c.yaw = k.yaw; c.pitch = k.pitch; c.roll = k.roll; c.zoom = k.zoom; c.target = { ...k.target };
    this.world.cutView();
    this.cameraChanged();
    this.emit('status', undefined);
  }

  setKeyOption(i: number, patch: Partial<Pick<KeyFrame, 'seconds' | 'mode'>>): void {
    const k = this.keyDraft[i];
    if (!k) return;
    if (patch.seconds !== undefined) k.seconds = Math.max(KEY_SECONDS.min, Math.min(KEY_SECONDS.max, Math.round(patch.seconds * 10) / 10));
    if (patch.mode) k.mode = patch.mode;
    this.emit('take', this.takeState);
  }

  /**
   * キーフレームの動きを再生できるか(2つ以上で1周が短すぎず、止まっているとき)。
   * 手で記録した操作があるときは、黙ってキーフレームの記録に入れ替えないよう使えなくする(右パネルの「再生」で入れ替える)
   */
  get canPlayKeys(): boolean {
    const n = this.keyDraft.length, total = this.keyDraft.reduce((a, k) => a + k.seconds, 0), take = this.project.take;
    return n >= 2 && total >= TAKE_MIN_SECONDS - 1e-9 && !!this.doc && !this.exporting && this.takeState === 'idle' && (!take || !!take.keys);
  }

  /** キーフレームの動きを再生する。一覧が今の記録と同じならそのまま再生し、違えば作り直す(元に戻せる) */
  playKeys(): void {
    if (!this.canPlayKeys) return;
    const take = this.project.take;
    if (take?.keys && JSON.stringify(take.keys) === JSON.stringify(normalizeKeys(this.keyDraft))) this.playTake();
    else this.makeKeyTake();
  }

  /** キーフレームを順に通ってくり返す記録を作り(今の記録と入れ替え、アンドゥできる)、ループ再生する */
  makeKeyTake(): void {
    if (!this.doc || this.takeState === 'recording') return;
    const take = takeFromKeys(this.keyDraft, this.project.camera.fov);
    if (!take) return;
    this.history.execute(new SetTake('キーフレームから動きを作る', this.project.take, take));
    this.playTake();
  }

  /** 記録を消す(アンドゥできる) */
  clearTake(): void {
    if (!this.project.take) return;
    this.stopTake();
    this.history.execute(new SetTake('操作の記録を消す', this.project.take, null));
  }

  private prev = 0;
  private frames = 0;
  private fpsTime = 0;

  start(): void {
    this.loops++;
    const loop = (now: number) => {
      this.perf?.frame(now);
      const raw = this.prev ? (now - this.prev) / 1000 : 0, dt = Math.min(raw, 0.1);
      // 物理は 0.1 秒で打ち切るので、その間の平行移動を 1 刻みの動きとして扱うと強く弾みすぎる。測り直す
      if (raw > 0.1) this.world.cutView();
      this.prev = now;
      this.frame(dt);
      this.frames++; this.fpsTime += dt;
      if (this.fpsTime >= 0.5) { this.fps = Math.round(this.frames / this.fpsTime); this.frames = 0; this.fpsTime = 0; this.emit('fps', this.fps); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
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

  /** 画像全体が画面上で元の位置からずれているか(ブラシの円を毎フレーム当て直すかの判断に使う) */
  get imageShifted(): boolean { const s = this.base.shown; return !this.view.flat && (s.x !== 0 || s.y !== 0 || s.z !== 0); }

  /** ライブ表示の画像全体のずれを決めて Stage へ入れる(applySwing の後に呼ぶ) */
  private showBase(dt: number, doc: Document): void {
    const w = this.world, b = this.base, k = this.imageLong / 2, g = w.baseOffset(doc.layers);
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

  /** 溜まっているウェイトの変更を GPU へ送る(描画・書き出しの直前に呼ぶ) */
  flushWeights(): void {
    for (const [id, rect] of this.pendingUploads) {
      const f = this.store.findLayer(id);
      if (f) this.stage.uploadWeights(f.index, f.layer, rect);
    }
    this.pendingUploads.clear();
  }

  frame(dt: number): void {
    const doc = this.doc;
    if (this.exporting || !doc || !this.stage.hasDocument) return;
    const p = this.perf;
    let t = p ? performance.now() : 0;
    this.world.autoSwing = this.project.autoSwing;
    this.world.advance(dt, doc.layers, this.recordStep);
    this.applySwing(this.world, doc);
    this.showBase(dt, doc);
    if (p) t = p.lap('physics', t, performance.now());
    this.flushWeights();
    if (p) t = p.lap('upload', t, performance.now());
    // ループ再生中は、視点の代わりに画像を動かす
    // 画角は今のものにそろえる(再生中に画角を変えても、画像が近づいたり離れたりしないように)
    const fov = this.project.camera.fov;
    if (this.takeState === 'playing' && this.playFrom && this.playCam) this.stage.setRig({ ...this.playFrom, fov }, { ...this.playCam, fov });
    else this.stage.setRig(null);
    this.stage.render(this.project.camera, this.multiCam, this.multiOrtho);
    if (p) p.lap('render', t, performance.now());
    this.emit('frame', undefined);
  }

  /* ---------- 書き出し ---------- */

  async exportMedia(s: ExportSettings, onProgress: (done: number, total: number) => void, signal: AbortSignal) {
    this.exporting = true;
    this.flushWeights();
    this.emit('status', undefined);
    try {
      return await runExport({ stage: this.stage, store: this.store, recorder: this.recorder, applySwing: this.applySwing, centerOf: this.centerOf }, s, onProgress, signal);
    } finally {
      this.exporting = false;
      this.emit('status', undefined);
    }
  }
}

function freshBase() {
  return { shown: { x: 0, y: 0, z: 0 }, live: { x: 0, y: 0, z: 0 }, fix: { x: 0, y: 0, z: 0 }, key: '', held: null as Vec3 | null };
}

/** 視点(回転・ズーム・注視点)が同じか。画角は見ない */
function sameView(a: CameraState, b: CameraState): boolean {
  return a.yaw === b.yaw && a.pitch === b.pitch && a.roll === b.roll && a.zoom === b.zoom && a.target.x === b.target.x && a.target.y === b.target.y && a.target.z === b.target.z;
}

/** 膨らませるで作るレイヤーの名前(膨らみ1, 膨らみ2, …のうち、まだ無いもの) */
function nextInflateLayerName(doc: Document): string {
  let n = 1;
  while (doc.layers.some(l => l.name === `膨らみ${n}`)) n++;
  return `膨らみ${n}`;
}

function nextLayerName(doc: Document): string {
  let n = doc.layers.length + 1;
  while (doc.layers.some(l => l.name === `レイヤー${n}`)) n++;
  return `レイヤー${n}`;
}

/** ブラウザが暇なときに実行する(requestIdleCallback が無ければすぐ後に) */
function idle(fn: () => void): void {
  if ('requestIdleCallback' in window) window.requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 0);
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** 複数のレイヤーにまとめてかけた操作の名前(履歴とアンドゥのメニューに出す) */
export function countLabel(label: string, n: number): string { return n > 1 ? `${label}(${n}枚)` : label; }

/** 1つならそのまま、複数なら1手にまとめる */
function batchOf(label: string, cmds: Command[]): Command { return cmds.length === 1 ? cmds[0] : new Batch(label, cmds); }
