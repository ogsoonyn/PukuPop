/**
 * アプリ本体。モデル・コマンド・描画・物理・保存・書き出しをつなぐ。
 * 画面の部品(ui/)はここを経由して状態を読み書きする。
 * 機能ごとの中身は、再生のつなぎ(playback/。再生専用の部品と共有する)と、編集アプリだけの部品(app/)にあり、
 * App は同じ名前のメソッド・ゲッターからそこへ委ね、イベントは App が出す。
 */
import { Store, createProject, createDocument, createLayer, cloneLayer, meshSegments, alphaSpreadPx, frontCamera, wrapAngle, LIMITS, PRESETS, applyPreset, type PresetName, type CameraState, type Vec3, type OrthoView, type Project, type Document, type Layer } from './model/project';
import { projectDataBytes, sumMemory, type MemoryUsage, type TabMemory } from './model/memory';
import { History, emptyHistory } from './commands/history';
import type { Rect } from './model/weightmap';
import { InsertLayer, RemoveLayer, MoveLayer, WeightEdit, SetTake, SetFavorites, SetFov, PatchLayer, PatchProject, Batch, weightOperation } from './commands/commands';
import type { Command } from './commands/history';
import { captureFavorite, favoriteChanges, nextFavoriteName, applyView, FAVORITE_NAME_MAX } from './model/favorites';
import { Stage, type ViewOptions } from './stage/stage';
import { StageSwing, type BaseState } from './playback/stageSwing';
import { LoopPlayback } from './playback/loopPlayback';
import { preparePhysics, feedView, advanceSwing } from './playback/frame';
import { TakeRecording, type TakeState } from './app/recording';
import { KeyframeEditor } from './app/keyframes';
import { BlurPreview } from './app/blurPreview';
import { InflatePreview, type InflateArea, type InflateSettings, type InflateState } from './app/inflatePreview';
import { countLabel } from './app/labels';
import { createTab, tabName, suggestedName, trimHiddenHistory, MAX_TABS, TABS_FULL_NOTE, type Tab } from './app/tab';
import { TabAutosaver } from './app/autosave';
import { newImageDefaults } from './app/newImage';
import { PhysicsWorld } from './physics/world';
import { MotionRecorder } from './physics/recorder';
import { takeSeconds, type KeyFrame } from './physics/take';
import { Stroke, type PaintMode } from './paint/stroke';
import { serializeProject, deserializeProject, FILE_EXTENSION, type PngCacheEntry } from './storage/popstage';
import { requestPersistOnce } from './storage/persist';
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
export type { TakeState } from './app/recording';

export interface BrushOptions { size: number; strength: number; hardness: number; pressure: PressureMode }

export { INFLATE_ANGLE, type InflateArea, type InflateSettings, type InflateState } from './app/inflatePreview';
export { countLabel } from './app/labels';

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

export { MAX_TABS, TABS_FULL_NOTE, type Tab } from './app/tab';

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

  /** 起動したときは移動のツール(触っても絵を変えないので、開いてすぐ遊べる) */
  tool: Tool = 'pan';
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
  /** 物理の結果を Stage へ当てるつなぎ(src/playback。再生専用の部品と共有する) */
  private readonly swing: StageSwing;
  /** 画面に出している画像全体のずれ(ピストン)の状態(playback/stageSwing.ts)。画面の部品からは使わない(E2E が fix を読む) */
  get base(): Readonly<BaseState> { return this.swing.base; }
  private get centers(): Map<string, { x: number; y: number }> { return this.tab.centers; }
  /** まだ GPU へ送っていない、レイヤーごとの変わった矩形 */
  private pendingUploads = new Map<string, Rect>();
  private get pngCache(): Map<string, PngCacheEntry> { return this.tab.pngCache; }
  /** 直近の自動保存が失敗していればその理由 */
  get autosaveError(): string | null { return this.tab.autosaveError; }
  get autosaveQuota(): boolean { return this.tab.autosaveQuota; }
  exporting = false;
  get lastSaved(): Date | null { return this.tab.lastSaved; }
  get lastAutosave(): Date | null { return this.tab.lastAutosave; }

  /** 操作の記録の状態 */
  get takeState(): TakeState { return this.recording.active ? 'recording' : this.playback.playing ? 'playing' : 'idle'; }
  /** 操作の記録を取る側(app/recording.ts) */
  private readonly recording: TakeRecording;
  /**
   * 記録のループ再生(src/playback。再生専用の部品と共有する)。再生の状態は Tab に置かず、タブを切り替えると捨てる
   */
  private readonly playback: LoopPlayback;
  /**
   * キーフレームの下書き(画面だけ)。作った記録はそのキーフレームも持つので、
   * 記録が差し替わったら(開く・アンドゥなど)その記録のキーフレームに合わせる
   */
  get keyDraft(): KeyFrame[] { return this.tab.keyDraft; }
  set keyDraft(k: KeyFrame[]) { this.tab.keyDraft = k; }
  /** キーフレームの下書きの編集(app/keyframes.ts) */
  private readonly keys: KeyframeEditor;
  /** キーフレームの重ね表示(経路・ゴースト)。ブラウザに覚える(ui/keyPath.ts) */
  keyOverlay = { path: true, ghost: false };
  setKeyOverlay(key: 'path' | 'ghost', on: boolean): void {
    if (this.keyOverlay[key] === on) return;
    this.keyOverlay = { ...this.keyOverlay, [key]: on };
    this.emit('view', undefined);
  }

  /** タブごとの自動保存(app/autosave.ts) */
  private readonly autosaver: TabAutosaver;
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
    const app = this;
    this.swing = new StageSwing(this.stage, { get doc() { return app.doc; }, get centers() { return app.tab.centers; } });
    this.playback = new LoopPlayback(this.world, this.stage, () => this.project, {
      stateChanged: () => this.emit('take', this.takeState),
      viewChanged: () => this.emit('status', undefined),
      // 「直前の操作を再生」の書き出しのために、再生した刻みも記録に残す
      stepped: (sample, snapshot, seeked) => this.recorder.record(sample, snapshot, seeked),
    });
    this.recording = new TakeRecording({
      get doc() { return app.doc; }, get project() { return app.project; },
      get paused() { return app.paused; }, setPaused: on => this.setPaused(on),
      get playing() { return app.playback.playing; }, stopTake: () => this.stopTake(),
      execute: cmd => this.history.execute(cmd),
      stateChanged: () => this.emit('take', this.takeState),
    });
    this.autosaver = new TabAutosaver({
      get tabs() { return app.tabs; }, get activeTab() { return app.tab; },
      get unsettled() { return !!app.stroke || app.previewingBlur || app.previewingInflate; },
      get perf() { return app.perf; },
      statusChanged: () => this.emit('status', undefined),
    });
    this.blur = new BlurPreview(this.store, this.history);
    this.inflate = new InflatePreview({
      store: this.store, history: this.history,
      get inflateSettings() { return app.inflateSettings; }, set inflateSettings(v) { app.inflateSettings = v; },
      setActiveLayer: id => this.setActiveLayer(id),
      ended: () => this.emit('inflate', 'end'),
    });
    this.keys = new KeyframeEditor({
      get keyDraft() { return app.keyDraft; }, set keyDraft(k) { app.keyDraft = k; },
      get project() { return app.project; }, get doc() { return app.doc; },
      get exporting() { return app.exporting; }, get takeState() { return app.takeState; },
      stopTake: () => this.stopTake(), playTake: () => this.playTake(), cutView: () => this.world.cutView(),
      execute: cmd => this.history.execute(cmd),
      draftChanged: () => this.emit('take', this.takeState),
      viewChanged: () => this.emit('status', undefined),
    });
    this.stage.onContextChange = lost => this.onContextChange(lost);
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
    preparePhysics(this.world, doc, this.centerOf);
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
    if (!this.overlayAutoShown || PAINT_TOOLS.includes(this.tool) || this.blur.active) return;
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
  }

  /** 向きだけを正面に戻す。ズームと平行移動(画面の上下左右の位置)は保つ */
  resetRotation(): void {
    const c = this.project.camera;
    if (c.yaw === 0 && c.pitch === 0 && c.roll === 0 && c.target.z === 0) return;
    // 回した視点で平行移動すると奥行き(z)にもずれるので、正面から見て同じに見えるよう 0 に戻す。傾きも 0 に戻す
    this.project.camera = { ...c, yaw: 0, pitch: 0, roll: 0, target: { ...c.target, z: 0 } };
    this.world.cutView();
  }

  /**
   * 視点の傾き(ラジアン)をその場で変える。Alt+右ドラッグ・2本指のひねりから続けて呼ぶ。
   * 動かした勢いで揺らす(回転・ズームと同じ)
   */
  setRoll(r: number): void {
    this.project.camera.roll = wrapAngle(r);
    this.emit('status', undefined);
  }

  /** 視点の傾きを delta(ラジアン)だけ、なめらかに回す(← / →)。正で画像が時計回りに傾く */
  rollBy(delta: number): void { this.rollEase.add(delta); }
  private rollEase = smoothRoll({ get: () => this.project.camera.roll, set: r => this.setRoll(r), owner: () => this.project.camera });

  /** 視点の傾きだけを 0 に戻す(ステータスバーの角度を押したとき)。飛ぶだけなので揺らさない */
  resetRoll(): void {
    const c = this.project.camera;
    if (c.roll === 0) return;
    this.project.camera = { ...c, roll: 0, target: { ...c.target } };
    this.world.cutView();
    this.emit('status', undefined);
  }

  /* ---------- 読み込みとタブ ---------- */

  /** タブを置き換えて開くか(変更していないサンプル・空のタブ) */
  private get replaceable(): boolean { return this.tab.sample && !this.tab.dirty; }

  /** 新しく開けるか(タブの数が上限でも、今のタブを置き換えて開けるなら開ける)。開く系のメニュー・ボタンを使えなくするのに使う */
  get canOpenTab(): boolean { return this.replaceable || this.tabs.length < MAX_TABS; }

  /** タブの数が上限で、新しいタブを開けないか。開けないときは伝える(メニューは先に使えなくしてあるので、ここに来るのはドロップや貼り付けなど) */
  tabsFull(): boolean {
    if (this.canOpenTab) return false;
    toast(TABS_FULL_NOTE, 'warning', 5000);
    return true;
  }

  /** タブの見出し(ファイル名、無ければ画像の名前) */
  tabName(t: Tab): string { return tabName(t); }

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
    this.stopTake();
    t.history = this.history.take();
    t.imageCanvas = null;
  }

  /** タブを表に出す。canvas はデコード済みの表示用画像 */
  private enterTab(tab: Tab, canvas: HTMLCanvasElement): void {
    this.loading = true;
    try {
      // 記録中・再生中の操作は前の作業のものなので捨てる
      const was = this.takeState;
      this.recording.discard();
      this.playback.discard();
      if (was !== 'idle') this.emit('take', 'idle');
      this.world.grab = null; this.world.grabGains.clear(); this.shake = { x: 0, y: 0, z: 0 };
      this.swing.resetBase(); // 画像全体のずれは前の画像のピクセル単位なので持ち越さない
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
  private dropTabAutosave(t: Tab): void { this.autosaver.drop(t); }

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

  /** メモリの使用量の見積もり(ステータスバー)。全部のタブの分を数える。JS のヒープは Chrome 系だけ */
  memoryUsage(): MemoryUsage {
    const tabs: TabMemory[] = this.tabs.map(t => {
      const active = t === this.tab;
      let png = 0;
      for (const e of t.pngCache.values()) png += e.png.byteLength;
      const c = t.imageCanvas;
      return {
        name: this.tabName(t), active,
        data: projectDataBytes(t.project, png),
        history: active ? this.history.bytes : t.history.bytes,
        render: (c ? c.width * c.height * 4 : 0) + (active ? this.stage.gpuBytes : 0),
      };
    });
    const m = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    return sumMemory(tabs, m ? { used: m.usedJSHeapSize, limit: m.jsHeapSizeLimit } : null);
  }

  /** どれかのタブに保存していない変更があるか(ページを閉じるときの確認) */
  get anyDirty(): boolean { return this.tabs.some(t => t.dirty); }

  /**
   * 全部のタブのアンドゥの合計を、1つの作業の上限(history.options.maxBytes)に収める。
   * あふれたら、裏のタブのうち長く出していないものの古い手から捨てる(表のタブの積みは History が自分で収める)
   */
  private trimHiddenHistory(): void {
    trimHiddenHistory(this.history.options.maxBytes, this.history.bytes, this.tabs.filter(t => t !== this.tab));
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
    return newImageDefaults(this.project, prefs.get<Record<string, unknown>>('newImage'));
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

  suggestedName(tab: Tab = this.tab): string { return suggestedName(tab); }

  async save(saveAs = false): Promise<boolean> {
    if (!this.doc) return false;
    // 保存先を選んでいる間にタブを切り替えても、このタブに書き戻す
    const tab = this.tab;
    // 書き込みを待つ間に変更されたら、その変更は保存されていないので「未保存」のまま残す
    const thumb = await this.thumbnail();
    const revision = tab.revision;
    const bytes = serializeProject(tab.project, { thumbnail: thumb });
    const blob = new Blob([bytes as BlobPart], { type: 'application/zip' });
    try {
      const h = await saveFile(blob, this.suggestedName(tab), PROJECT_TYPES, saveAs ? null : tab.fileHandle);
      if (h === undefined) return false;
      tab.fileHandle = h;
      if (h) tab.fileName = h.name; else tab.fileName ??= this.suggestedName(tab);
      tab.lastSaved = new Date();
      tab.sample = false; // 保存したら、次に開いたファイルで置き換えない
      tab.autosaveError = null; tab.autosaveQuota = false; // ファイルに保存できたので、自動保存の失敗の案内は消す
      const settled = tab.revision === revision;
      if (settled) tab.dirty = false;
      this.autosaver.afterFileSave(tab, settled);
      this.emit('file', undefined);
      this.emit('tabs', undefined);
      toast(h ? `「${h.name}」に保存しました。` : `「${tab.fileName}」をダウンロードしました。`, 'success');
      void this.remember('project', tab.fileName ?? this.suggestedName(tab), bytes.byteLength, h, () => bytes, thumb);
      void requestPersistOnce();
      return true;
    } catch (e) {
      toast(`保存できませんでした: ${e instanceof Error ? e.message : e}`, 'error', 6000);
      return false;
    }
  }

  /** そのタブの自動保存を予約する。裏に回ったタブも中身は変わらないので、予約どおりに保存する(app/autosave.ts) */
  private scheduleAutosave(tab: Tab = this.tab): void { this.autosaver.schedule(tab); }

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

  /** 全体ぼかしのプレビュー(app/blurPreview.ts) */
  private readonly blur: BlurPreview;

  beginBlurPreview(): boolean {
    if (!this.blur.begin(this.selectedLayers)) return false;
    this.autoShowOverlay();
    this.emit('blur', 'begin');
    return true;
  }

  /** radius は元画像のピクセル単位。0 で元に戻した状態を表示する。 */
  previewBlur(radius: number): void { this.blur.preview(radius); }

  endBlurPreview(apply: boolean, radius: number): void {
    if (!this.blur.active) return;
    try { this.blur.end(apply, radius); } finally { this.emit('blur', 'end'); this.autoHideOverlay(); }
  }

  get previewingBlur(): boolean { return this.blur.active; }

  /* 膨らませる: 範囲(楕円・矩形)を、指定した高さと断面で一括して膨らませる。
     プレビューしながら数値を決め、適用で1手として記録する(app/inflatePreview.ts) */

  private readonly inflate: InflatePreview;

  get previewingInflate(): boolean { return this.inflate.active; }
  /** 全体ぼかし・膨らませるのプレビュー中か。プレビュー中のウェイトを元に戻したりしないよう、使える操作を絞る */
  get previewing(): boolean { return this.previewingBlur || this.previewingInflate; }
  get inflateState(): InflateState | null { return this.inflate.state; }

  /** 範囲を描き始める(ドラッグの最初の動きで呼ぶ) */
  beginInflateArea(area: InflateArea): boolean {
    const layer = this.activeLayer, doc = this.doc;
    if (this.previewingBlur) { toast('「全体をぼかす」を適用するかキャンセルしてから膨らませてください。', 'warning'); return false; }
    if (!layer || !doc || this.busy) return false;
    if (!layer.visible) { toast('非表示のレイヤーには塗れません。', 'warning'); return false; }
    this.inflate.begin(layer, doc, area);
    this.emit('inflate', 'begin');
    return true;
  }

  updateInflate(patch: { area?: Partial<InflateArea>; settings?: Partial<InflateSettings> }): void {
    if (!this.inflate.active) return;
    this.inflate.update(patch);
    this.emit('inflate', 'change');
  }

  /** 適用で1手として記録し、キャンセルで元に戻す。終えたら 'inflate' の 'end' を送る */
  endInflate(apply: boolean): void { this.inflate.end(apply); }

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
    const temp = this.inflate.tempLayerId;
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
    // 何をどう変えるかは model/favorites.ts で決め、ここではアンドゥのコマンドにして1手で積む
    const ch = favoriteChanges(f, this.project, doc), label = `お気に入り「${f.name}」`, cmds: Command[] = [];
    for (const { id: layerId, patch } of ch.layers) cmds.push(PatchLayer.from(this.store, layerId, patch, label));
    if (ch.autoSwing) cmds.push(PatchProject.from(this.store, { autoSwing: ch.autoSwing }, label));
    if (ch.take !== undefined) cmds.push(new SetTake(label, this.project.take, ch.take));
    if (ch.fov !== null) cmds.push(new SetFov(label, this.project.camera.fov, ch.fov));
    if (cmds.length) this.history.execute(new Batch(label, cmds));
    // 画角を変えると camera は新しいオブジェクトに差し替わるので、実行したあとの camera に当てる
    applyView(this.project.camera, ch.view);
    this.world.cutView(); // 視点が飛ぶだけなので揺らさない
    this.emit('status', undefined);
    if (ch.play && this.project.take) this.playTake();
    if (ch.missing) toast(`「${f.name}」にあったレイヤーのうち ${ch.missing} 枚は、もう無いので飛ばしました。`, 'info', 5000);
  }

  /* ---------- 物理と描画のループ ---------- */

  /** 揺れを Stage へ当てる(playback/stageSwing.ts。書き出しにも渡す) */
  get applySwing(): (world: PhysicsWorld, doc: Document) => void { return this.swing.applySwing; }

  /**
   * 静止画の書き出し用。画面の物理(今見えている揺れ)を Stage へ戻し、撮る視点を返す。
   * 画像全体の動き(ピストン)は、画面と同じく showBase でならした値にする。
   * ループ再生中は、記録の視点(playView)で撮る。画面は画像のほうを rig で動かして映しているが、renderFrame は rig を外して
   * 画像を元の置き場所に置くので、今の視点(project.camera)で撮ると画像が動いていない絵になる。見る視点を再生の基準の
   * 視点のまま動かしていなければ、記録の視点で撮った絵は画面と同じになる(縦横比が画面と同じとき。動かしていれば、ループ再生の書き出しと同じ撮影カメラの絵)
   */
  currentShot = (): CameraState => {
    const doc = this.doc;
    if (doc) this.swing.applyShown(this.world, doc);
    const c = this.playView ?? this.project.camera;
    return { ...c, target: { ...c.target } };
  };

  /** 物理に渡すレイヤーの重心(正規化座標)。回転で揺れる大きさを決める(playback/stageSwing.ts) */
  get centerOf(): (l: Layer) => { x: number; y: number } { return this.swing.centerOf; }

  private recordStep = (): void => {
    // ループ再生中は、記録どおりに物理へ入れる(playback/loopPlayback.ts)
    if (this.playback.step()) return;
    const w = this.world, c = this.project.camera;
    // 平行移動・回転・ズームでも、「揺らす」で振っても揺らす(playback/frame.ts。Player と共通)
    feedView(w, c, this.shake);
    this.recorder.record({
      viewCut: w.viewCut,
      viewTarget: { ...w.viewTarget },
      grab: w.grab ? { ...w.grab } : null,
      grabGains: [...w.grabGains],
      camera: { fov: c.fov, yaw: c.yaw, pitch: c.pitch, roll: c.roll, zoom: c.zoom, target: { ...c.target } },
    }, () => w.snapshot());
    // 記録中なら、操作の記録にも積む(app/recording.ts)
    this.recording.capture(w, c);
  };

  /* ---------- 操作の記録とループ再生 ---------- */

  /** 記録中なら記録した長さ、それ以外は保存してある記録の長さ(秒) */
  get takeLength(): number { return this.recording.active ? this.recording.seconds : takeSeconds(this.project.take); }
  /** ループ再生を一時停止しているか(シークバーの ⏸。揺れの一時停止とは別で、物理は進む) */
  get playPaused(): boolean { return this.playback.paused; }

  /** ループ再生を一時停止する・続ける(再生中だけ) */
  setPlayPaused(on: boolean): void { this.playback.setPaused(on); }

  /** ループ再生の位置を移す(秒。1周の中に丸める。playback/loopPlayback.ts) */
  seekTake(seconds: number): void { this.playback.seek(seconds); }

  /** ループ再生中の位置(秒) */
  get takePosition(): number { return this.playback.position; }

  /** ループ再生中の、画像から見た今の視点(記録の視点)。再生していなければ null */
  get playView(): CameraState | null { return this.playback.view; }

  /** 記録を始める。つかむ・揺らす・移動・視点の操作を、止めるまで(最長 60 秒)覚える(app/recording.ts) */
  startRecording(): void { this.recording.start(); }

  /** 記録を止めて、ループ再生できる形にして残す(アンドゥできる)。full は最長まで記録して止まったとき */
  stopRecording(full = false): void { this.recording.stop(full); }

  toggleRecording(): void { if (this.takeState === 'recording') this.stopRecording(); else this.startRecording(); }

  /** 記録した操作を初めからループ再生する。画面を触ると止まる */
  playTake(): void {
    const take = this.project.take;
    if (!take?.samples.length || !this.doc) return;
    if (this.takeState === 'recording') this.stopRecording();
    if (this.paused) this.setPaused(false);
    this.shake = { x: 0, y: 0, z: 0 };
    // 視点を記録の初めへ動かし、そこから記録どおりに画像を動かす(playback/loopPlayback.ts)
    this.playback.play(take);
  }

  /**
   * ループ再生をやめる(記録中なら何もしない)。画像は元の置き場所へ戻る。
   * 再生中に視点を動かしていなければ、視点を止めた所の記録の視点にする(画面はそのまま)。動かしていれば、その視点のまま
   */
  stopTake(): void { this.playback.stop(); }

  /** ループ再生中に、見る視点を再生の基準の視点(撮影カメラ。記録の初めの視点)へ戻す。再生は続ける */
  resetPlayView(): void { this.playback.resetView(); }

  togglePlay(): void { if (this.takeState === 'playing') this.stopTake(); else this.playTake(); }

  /* ---------- キーフレームから動きを作る ---------- */

  /** 記録がキーフレームから作ったものなら、そのキーフレームを下書きに入れる。reset なら、そうでなくても下書きを空にする */
  private syncKeyDraft(reset = false): void { this.keys.sync(reset); }

  /** 今の視点を末尾のキーフレームとして足す。時間とつなぎ方は1つ前のフレームに合わせる(app/keyframes.ts) */
  addKey(): void { this.keys.add(); }

  /** i 番目のキーフレームを今の視点で登録し直す */
  setKey(i: number): void { this.keys.set(i); }

  removeKey(i: number): void { this.keys.remove(i); }

  /** from 番目のキーフレームを to 番目へ動かす(秒数は場所に残す。physics/take.ts の moveKey) */
  moveKey(from: number, to: number): void { this.keys.move(from, to); }

  /** 視点を i 番目のキーフレームへ動かす(確かめる用。その動きでは揺らさない) */
  gotoKey(i: number): void { this.keys.goto(i); }

  setKeyOption(i: number, patch: Partial<Pick<KeyFrame, 'seconds' | 'mode'>>): void { this.keys.setOption(i, patch); }

  /**
   * キーフレームの動きを再生できるか(2つ以上で1周が短すぎず、止まっているとき)。
   * 手で記録した操作があるときは、黙ってキーフレームの記録に入れ替えないよう使えなくする(右パネルの「再生」で入れ替える)
   */
  get canPlayKeys(): boolean { return this.keys.canPlay; }

  /** キーフレームの動きを再生する。一覧が今の記録と同じならそのまま再生し、違えば作り直す(元に戻せる) */
  playKeys(): void { this.keys.play(); }

  /** キーフレームを順に通ってくり返す記録を作り(今の記録と入れ替え、アンドゥできる)、ループ再生する */
  makeKeyTake(): void { this.keys.makeTake(); }

  /** 記録を消す(アンドゥできる) */
  clearTake(): void {
    if (!this.project.take) return;
    this.stopTake();
    this.history.execute(new SetTake('操作の記録を消す', this.project.take, null));
  }

  private prev = 0;
  private frames = 0;
  private fpsTime = 0;

  /** 描画ループの中で出た例外の知らせ先。ループは止めずに続ける(main.ts が画面への知らせを結ぶ) */
  onFrameError: (e: unknown) => void = e => console.error(e);

  start(): void {
    this.loops++;
    const loop = (now: number) => {
      // 次のフレームを先に予約し、frame で例外が出てもループが止まらないようにする
      requestAnimationFrame(loop);
      try {
        this.perf?.frame(now);
        const raw = this.prev ? (now - this.prev) / 1000 : 0, dt = Math.min(raw, 0.1);
        // 物理は 0.1 秒で打ち切るので、その間の平行移動を 1 刻みの動きとして扱うと強く弾みすぎる。測り直す
        if (raw > 0.1) this.world.cutView();
        this.prev = now;
        this.frame(dt);
        this.frames++; this.fpsTime += dt;
        if (this.fpsTime >= 0.5) { this.fps = Math.round(this.frames / this.fpsTime); this.frames = 0; this.fpsTime = 0; this.emit('fps', this.fps); }
      } catch (e) { this.onFrameError(e); }
    };
    requestAnimationFrame(loop);
  }

  /**
   * 画像全体のずれ(ピストン)を画面上で止める / 戻す。塗りや膨らませる範囲のドラッグの間、当たり判定(pick)が
   * 画像の動きでずれないようにする(playback/stageSwing.ts)
   */
  holdImage(on: boolean): void { this.swing.holdImage(on); }

  /** 画像全体が画面上で元の位置からずれているか(ブラシの円を毎フレーム当て直すかの判断に使う) */
  get imageShifted(): boolean { return !this.view.flat && this.swing.shifted; }

  /** 溜まっているウェイトの変更を GPU へ送る(描画・書き出しの直前に呼ぶ) */
  flushWeights(): void {
    for (const [id, rect] of this.pendingUploads) {
      const f = this.store.findLayer(id);
      if (f) this.stage.uploadWeights(f.index, f.layer, rect);
    }
    this.pendingUploads.clear();
  }

  /**
   * WebGL のコンテキストが失われた・戻ったとき(スマホで裏に回した後、GPU のリセット、メモリ不足など)。
   * 失われている間は frame が描画(と物理)を止め、書き出しは失敗で終わる。全部のタブで共通の画面の状態なので Tab には置かない。
   * 戻ったときに送り直すものは無い: 画像・ウェイト・メッシュ・書き出し用の描画先は three.js が次の描画で CPU 側の中身から作り直し、
   * 背景色と部分転送の確認は Stage が戻す。溜めていたウェイトの変更(pendingUploads)は、次の flushWeights で全面転送になる
   */
  private onContextChange(lost: boolean): void {
    if (lost) toast('3Dビューの描画が止まりました。戻らないときは保存してから読み込み直してください。', 'warning', 8000);
    else toast('3Dビューの描画が戻りました。', 'success');
    this.emit('status', undefined);
  }

  frame(dt: number): void {
    const doc = this.doc;
    if (this.exporting || this.stage.contextLost || !doc || !this.stage.hasDocument) return;
    const p = this.perf;
    let t = p ? performance.now() : 0;
    // 物理を進めて揺れを Stage へ当てる(playback/frame.ts。Player と共通)
    advanceSwing(dt, this.world, this.swing, this.project.autoSwing, doc, this.recordStep);
    if (p) t = p.lap('physics', t, performance.now());
    this.flushWeights();
    if (p) t = p.lap('upload', t, performance.now());
    // ループ再生中は、視点の代わりに画像を動かす(画角は今のものにそろえる)
    this.playback.applyRig();
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
      return await runExport({ stage: this.stage, store: this.store, recorder: this.recorder, applySwing: this.applySwing, centerOf: this.centerOf, currentShot: this.currentShot }, s, onProgress, signal);
    } finally {
      this.stage.releaseExportBuffers();
      this.exporting = false;
      this.emit('status', undefined);
    }
  }
}

function nextLayerName(doc: Document): string {
  let n = doc.layers.length + 1;
  while (doc.layers.some(l => l.name === `レイヤー${n}`)) n++;
  return `レイヤー${n}`;
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** 1つならそのまま、複数なら1手にまとめる */
function batchOf(label: string, cmds: Command[]): Command { return cmds.length === 1 ? cmds[0] : new Batch(label, cmds); }
