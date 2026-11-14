/**
 * コマンド(メニュー・ボタン・ショートカットで使う操作)と、左のツールバー。
 * 左のツールバーは、押すと選んだ状態になる「ツール」と、押すとその場で効く「操作」を見た目で分ける
 * (ツールは塗りつぶしのボタン、操作は見出し付きの枠に入れた枠なしのボタン)。
 * 名前・ショートカット・使える条件はこの表だけに書き、メニューの <kbd>・ボタンのツールチップ・aria-keyshortcuts・
 * ヘルプのショートカット一覧・キーの処理は、すべて表から作る。
 */
import { TABS_FULL_NOTE, type App } from '../app';
import { ui } from './ids';
import { toast } from './dom';
import { isTyping } from './input';
import { TOOL_GROUPS, TOOLS } from './tools';
import { icon, ICONS, type IconName } from './icons';
import { LIMITS } from '../model/project';
import { HELP_OPS, hintHtml } from './mouseHint';

export interface Action {
  /** ツールチップ・ヘルプでの名前 */
  label: string;
  /** ツールチップに足す説明 */
  desc?: string;
  /** ショートカット('Ctrl+Shift+Z' の形。Ctrl は Mac の ⌘ も含む)。最初のものをメニューとツールチップに出す */
  keys?: string[];
  run: () => unknown;
  enabled?: () => boolean;
  /** 全体ぼかし・膨らませるのプレビュー中も使えるか(表示の切り替えなど、ウェイトにも履歴にも触れないもの) */
  duringPreview?: boolean;
  /** ヘルプでの名前(名前と違うときだけ) */
  helpLabel?: string;
  /** ヘルプで同じ行にまとめる(キーは / でつなぐ) */
  helpRow?: string;
  /** ヘルプに出さない */
  hidden?: boolean;
  /** 使えないときの理由(ショートカットで押したときに知らせ、ボタンのツールチップに足す)。理由を出すほどでないときは null */
  blocked?: () => string | null;
}

/** 画面の部品のうち、コマンドから開くもの */
export interface ActionDeps {
  openProject: () => unknown;
  openRecent: () => unknown;
  openExport: () => unknown;
  openBlur: () => unknown;
  openSettings: () => unknown;
  /** キーフレームの部品(右パネルの「アニメーション」タブ)を出す */
  showKeyFrames: () => unknown;
  togglePerf: () => unknown;
}

/** マウス・指を押しているか(ドラッグの途中にキーでタブを替えると、続きの操作が別のタブに効いてしまう) */
let pointerHeld = false;

function defineActions(app: App, d: ActionDeps) {
  const layer = () => !!app.activeLayer;
  const tabsFree = () => !app.busy && !pointerHeld;
  // タブが上限なら開く系は使えなくする(ファイルを選んだ後で断るのではなく、選ぶ前に分かるように)
  const roomForTab = () => app.canOpenTab;
  const tabsFull = () => (app.canOpenTab ? null : TABS_FULL_NOTE);
  const brushStep = (dir: 1 | -1) => () => {
    const el = ui.brushSize, step = Math.max(2, Math.round(app.brush.size * 0.15));
    el.value = String(app.brush.size + dir * step);
    el.dispatchEvent(new Event('input'));
  };
  return {
    // ファイル
    // プロジェクト(.pukupop)も画像も同じ「開く」で開く(中身で見分ける)。Ctrl+Shift+O は前の「画像を開く」のキー
    open: { label: '開く', desc: 'プロジェクト(.pukupop)か画像を開く', keys: ['Ctrl+O', 'Ctrl+Shift+O'], run: d.openProject, enabled: roomForTab, blocked: tabsFull },
    recent: { label: '最近開いたファイル', run: d.openRecent, enabled: roomForTab, blocked: tabsFull },
    save: { label: '保存', keys: ['Ctrl+S'], run: () => app.save(false), enabled: () => !!app.doc },
    saveAs: { label: '名前を付けて保存', keys: ['Ctrl+Shift+S'], run: () => app.save(true), enabled: () => !!app.doc },
    export: { label: '書き出し', keys: ['Ctrl+E'], run: d.openExport, enabled: () => !!app.doc },
    sample: { label: 'サンプルを開く', run: () => app.whileOpening(() => app.loadSample()), enabled: () => !app.busy && roomForTab(), blocked: tabsFull },
    // タブ。Ctrl+W・Ctrl+Tab はブラウザが使うので Alt と組み合わせる
    closeTab: { label: 'タブを閉じる', keys: ['Alt+W'], run: () => app.closeTab(), enabled: tabsFree },
    nextTab: { label: '次のタブ', keys: ['Alt+PageDown'], run: () => app.stepTab(1), enabled: () => app.tabs.length > 1 && tabsFree(), helpRow: '次のタブ・前のタブ' },
    prevTab: { label: '前のタブ', keys: ['Alt+PageUp'], run: () => app.stepTab(-1), enabled: () => app.tabs.length > 1 && tabsFree(), helpRow: '次のタブ・前のタブ' },
    // 編集
    undo: { label: '元に戻す', keys: ['Ctrl+Z'], run: () => app.history.undo(), enabled: () => app.history.canUndo && !app.stroking },
    redo: { label: 'やり直す', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], run: () => app.history.redo(), enabled: () => app.history.canRedo && !app.stroking },
    smoothAll: { label: '全体をぼかす(ガウス)', desc: '選んでいるレイヤー全体にガウスぼかしをかける', run: d.openBlur, enabled: layer },
    normalize: { label: '正規化', desc: '選んでいるレイヤーの最大値が100%になるよう全体を拡大', run: () => app.weightOp('正規化', wm => wm.normalize()), enabled: layer },
    invert: { label: '反転', desc: '選んでいるレイヤーのウェイトを反転', run: () => app.weightOp('反転', wm => wm.invert()), enabled: layer },
    fromAlpha: { label: 'アルファから生成', desc: '画像の不透明な所を塗る。横から見ても輪郭が伸びないよう、メッシュ1マス分だけ外へ広げる(後でメッシュ密度を下げたら、生成し直す)', run: () => app.fromAlpha(), enabled: layer },
    clearWeights: { label: '全消去', run: () => app.weightOp('全消去', wm => wm.clear()), enabled: layer },
    brushSmaller: { label: 'ブラシを小さく', keys: ['['], run: brushStep(-1), duringPreview: true, helpRow: 'ブラシを小さく・大きく' },
    brushLarger: { label: 'ブラシを大きく', keys: [']'], run: brushStep(1), duringPreview: true, helpRow: 'ブラシを小さく・大きく' },
    // 表示
    toggleOverlay: { label: 'ウェイトの表示切替', helpLabel: 'ウェイトの重ね表示', keys: ['W'], desc: '押すたびに OFF → 選択中 → 全レイヤー', run: () => app.cycleOverlay(), duringPreview: true },
    toggleFade: { label: '画像を薄く', keys: ['Shift+W'], run: () => app.setViewOption('fade', !app.view.fade), duringPreview: true },
    toggleFlat: { label: 'ポップを一時OFF', keys: ['F'], run: () => app.setViewOption('flat', !app.view.flat), duringPreview: true },
    togglePause: { label: '揺れを一時停止', keys: ['P'], run: () => app.setPaused(!app.paused), duringPreview: true },
    toggleMulti: { label: '3面図', keys: ['M'], run: () => app.setViewOption('multi', !app.view.multi), duringPreview: true },
    toggleGrid: { label: 'グリッド', keys: ['Shift+G'], run: () => app.setViewOption('grid', !app.view.grid), duringPreview: true },
    toggleTransparent: {
      label: '背景を透過', desc: '3Dビューと書き出しの背景を透過にする・背景色で塗る(色は右パネルの「カメラと背景」で選ぶ)',
      run: () => app.setBackgroundTransparent(app.project.background !== null), duringPreview: true, // ウェイトに触れないので、右パネルと同じくプレビュー中も使える
    },
    cleanView: {
      label: '編集表示クリア', keys: ['C'], run: () => app.clearEditView(), duringPreview: true, helpLabel: '表示クリア',
      desc: '見栄えを確かめるため、編集用の表示をまとめて切る(ウェイトの重ね表示・画像を薄く・ポップを一時OFF・揺れを一時停止・グリッド)。押すたびに切るだけで、元には戻さない',
    },
    resetView: { label: '視点リセット(正面)', helpLabel: '視点を正面に戻す', keys: ['Home'], run: () => app.resetView(), duringPreview: true, desc: '向き・ズーム・位置をすべて正面の初めの視点に戻す' },
    togglePanel: {
      label: '右パネル', helpLabel: '右パネルを開く・閉じる', keys: ['Shift+P'], desc: '右のパネル(レイヤー・アニメーション・画像と表示)を閉じて3Dビューを広げる。3Dビューの右上のボタンでも開閉できる',
      run: () => app.setPanelClosed(!app.panelClosed), duringPreview: true,
      // スマホと UIを隠している間は右パネルが見えないので、気付かないうちに閉じた状態を覚えないよう止める
      enabled: () => !document.documentElement.classList.contains('mobile') && !app.uiHidden,
    },
    resetRotation: {
      label: '回転だけリセット', keys: ['Ctrl+Home'], run: () => app.resetRotation(), duringPreview: true,
      desc: 'ズームと位置はそのままで、向きだけを正面に戻す',
    },
    toggleUi: {
      label: 'UIを隠す', helpLabel: 'UIを隠す・戻す', keys: ['Tab'], desc: '3Dビューのほかを隠して、画面いっぱいに見せる。もう一度押すか Esc で戻す',
      run: () => app.setUiHidden(!app.uiHidden), duringPreview: true,
      // スマホでは膨らませるのパネルが下のシートの中にあり、隠すと適用・キャンセルを押せなくなる
      enabled: () => !(app.previewing && document.documentElement.classList.contains('mobile')),
    },
    // アニメーション
    toggleAutoSwing: {
      label: '自動で揺らす', desc: '周期的に自動で揺らす・止める(周期と強さは右パネルの「アニメーション」で決める)',
      run: () => app.setAutoSwing(!app.project.autoSwing.enabled), enabled: () => !!app.activeLayer, duringPreview: true, // 右パネル・スマホと同じくプレビュー中も使える
    },
    toggleRecording: {
      label: '操作の記録', helpLabel: '記録の開始・停止', keys: ['R'], desc: 'つかむ・揺らす・移動・視点の操作を覚える(最長 60 秒)',
      run: () => app.toggleRecording(), enabled: () => !!app.doc && !app.exporting,
    },
    togglePlay: {
      label: 'ループ再生', helpLabel: 'ループ再生・停止', keys: ['L'], desc: '画面を触ると止まる',
      run: () => app.togglePlay(), enabled: () => !!app.project.take && app.takeState !== 'recording' && !app.exporting,
    },
    resetPlayView: {
      label: 'カメラを戻す', helpLabel: '再生中のカメラを戻す', keys: ['Shift+Home'], desc: 'ループ再生中に動かした視点を、再生を始めた視点(記録の初めの視点。キーフレームなら1番の視点)へ戻す。再生は続ける',
      run: () => app.resetPlayView(), enabled: () => app.takeState === 'playing',
    },
    togglePlayPause: {
      label: '一時停止', helpLabel: '再生の一時停止・再開', keys: ['Shift+L'], desc: 'ループ再生を一時停止する・続ける(揺れはそのまま落ち着いていく)',
      run: () => app.setPlayPaused(!app.playPaused), enabled: () => app.takeState === 'playing',
    },
    stopPlay: { label: '停止', helpLabel: 'ループ再生を止める', desc: 'ループ再生を止める', run: () => app.stopTake(), enabled: () => app.takeState === 'playing' },
    toggleKeyPlay: {
      label: 'キーフレームの再生・停止', desc: 'キーフレームの動きをループ再生する。再生中は止める(手で記録した操作の再生も止める)',
      run: () => { if (app.takeState === 'playing') app.stopTake(); else app.playKeys(); },
      enabled: () => (app.takeState === 'playing' && !app.exporting) || app.canPlayKeys,
    },
    toggleKeyPath: {
      label: 'キーフレームの経路', desc: '各フレームの枠と経路を3Dビューに重ねる',
      run: () => { const on = !app.keyOverlay.path; app.setKeyOverlay('path', on); if (on) d.showKeyFrames(); }, duringPreview: true,
    },
    toggleKeyGhost: {
      label: 'キーフレームのゴースト', desc: '各フレームの画像を半透明で重ねる',
      run: () => { const on = !app.keyOverlay.ghost; app.setKeyOverlay('ghost', on); if (on) d.showKeyFrames(); }, duringPreview: true,
    },
    clearTake: { label: '記録を消す', desc: '元に戻せる', run: () => app.clearTake(), enabled: () => !!app.project.take && app.takeState !== 'recording' },
    // レイヤー
    addLayer: { label: '新規レイヤー', run: () => app.addLayer(), enabled: () => !!app.doc },
    duplicateLayer: { label: '複製', run: () => app.duplicateLayer(), enabled: layer },
    deleteLayer: { label: '削除', run: () => app.deleteLayer(), enabled: () => (app.doc?.layers.length ?? 0) > 1 },
    // 並べ替えは1枚ずつ(複数を選んでいるときは使えない)
    layerUp: { label: '上へ', run: () => app.moveLayer(1), enabled: () => !app.multiSelected && app.activeIndex >= 0 && app.activeIndex < (app.doc?.layers.length ?? 0) - 1 },
    layerDown: { label: '下へ', run: () => app.moveLayer(-1), enabled: () => !app.multiSelected && app.activeIndex > 0 },
    selectAllLayers: { label: 'すべてのレイヤーを選ぶ', keys: ['Ctrl+A'], run: () => app.selectAllLayers(), enabled: () => (app.doc?.layers.length ?? 0) > 1 },
    // Esc はほかの役(ダイアログ・膨らませる/ぼかすの途中・UIを隠す・メニュー・文字の入力)を先にする。使えないときは Esc を横取りしない
    selectOneLayer: {
      label: '選択を1枚に戻す', keys: ['Esc'], desc: '複数選んだレイヤーを、塗りの先の1枚だけにする',
      run: () => { if (app.activeLayerId) app.setActiveLayer(app.activeLayerId); }, enabled: () => app.multiSelected && !app.uiHidden,
    },
    // お気に入り
    addFavorite: {
      label: 'お気に入りに追加', keys: ['K'], desc: '今の揺れと動きの組み合わせをお気に入りに追加する(画像とウェイトは入れない)',
      run: () => app.addFavorite(), enabled: () => app.canEditFavorites && app.project.favorites.length < LIMITS.favorites,
    },
    // ヘルプ・その他
    settings: { label: '設定', desc: 'ツール全体の設定(筆圧・左のツールバーに出すボタンなど)', run: d.openSettings, duringPreview: true },
    help: { label: '操作方法', run: () => ui.helpDialog.showModal(), duringPreview: true },
    about: {
      label: 'PukuPop について', duringPreview: true,
      run: () => { ui.aboutUpdated.textContent = updatedText(); ui.aboutDialog.showModal(); },
    },
    togglePerf: { label: 'パフォーマンスのデバッグ表示', keys: ['Ctrl+Shift+Alt+P'], run: d.togglePerf, duringPreview: true, hidden: true },
  } satisfies Record<string, Action>;
}

type CommandName = keyof ReturnType<typeof defineActions>;

/** 「PukuPop について」に出す、最後のコミットの日時(ビルドのときに埋め込む。git が無い所でビルドしたときは出さない) */
function updatedText(): string {
  const d = new Date(__COMMIT_DATE__);
  if (!__COMMIT_DATE__ || Number.isNaN(d.getTime())) return '';
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `最終更新 ${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** 切り替えの入・切(メニューの data-check と、左のツールバーの aria-pressed に映す)。transparent と autoSwing はファイルに入る設定 */
type ViewCheck = 'overlay' | 'grid' | 'fade' | 'flat' | 'multi' | 'pause' | 'transparent' | 'panel' | 'keyPath' | 'keyGhost' | 'autoSwing';

/**
 * 左のツールバーの、その場で効く操作のまとまり(よく使うものを、いちばん押しやすい所にも置く)。
 * check を持つものは切り替えで、入・切を aria-pressed で示す。name は、ボタンの文言を幅に合わせて縮めたときの読み上げ用の名前
 */
type NavGroup = { label: string; title: string; items: readonly { cmd: CommandName; icon: IconName; text: string; check?: ViewCheck; name?: string; defaultHidden?: boolean }[] };

/**
 * ツールの下に置く、その場で効く操作のまとまり。まとまりの並びと中の並びは、上のメニュー(ファイル・編集・表示・アニメーション)に合わせる
 */
const NAV_ACTIONS: readonly NavGroup[] = [
  // 開く・保存・書き出しはメニューとショートカットでも使えるので、既定では隠す(設定で出せる。出すと低い画面ではツールバーがスクロールする)
  {
    label: 'ファイル', title: 'ファイルの操作',
    items: [
      { cmd: 'open', icon: 'open', text: '開く', defaultHidden: true },
      { cmd: 'recent', icon: 'recent', text: '最近', name: '最近開いたファイル' },
      { cmd: 'save', icon: 'save', text: '保存', defaultHidden: true },
      { cmd: 'export', icon: 'export', text: '書き出し', defaultHidden: true },
    ],
  },
  {
    label: '編集', title: '選んでいるレイヤーに効く操作',
    items: [{ cmd: 'smoothAll', icon: 'smoothAll', text: '全体ぼかし…' }, { cmd: 'normalize', icon: 'normalize', text: '正規化' }, { cmd: 'invert', icon: 'invert', text: '反転' }],
  },
  {
    label: '表示', title: '表示に効く操作',
    items: [
      { cmd: 'toggleOverlay', icon: 'overlay', text: 'ウェイト', check: 'overlay', name: 'ウェイトの重ね表示' },
      { cmd: 'toggleFade', icon: 'fade', text: '画像を薄く', check: 'fade' },
      { cmd: 'toggleMulti', icon: 'multi', text: '3面図', check: 'multi' },
      { cmd: 'toggleGrid', icon: 'grid', text: 'グリッド', check: 'grid' },
      { cmd: 'toggleTransparent', icon: 'transparent', text: '透過', check: 'transparent', name: '背景を透過' },
      { cmd: 'cleanView', icon: 'cleanView', text: '表示クリア' },
      { cmd: 'resetView', icon: 'resetView', text: '正面', name: '視点リセット(正面)' },
      { cmd: 'resetRotation', icon: 'resetRotation', text: '回転リセット', name: '回転だけリセット' },
    ],
  },
  {
    label: 'アニメ', title: 'アニメーションの操作',
    items: [
      { cmd: 'toggleAutoSwing', icon: 'autoSwing', text: '自動揺れ', check: 'autoSwing', name: '自動で揺らす' },
      // 再生中は「停止」に変わる(下の refresh)
      { cmd: 'toggleKeyPlay', icon: 'play', text: '再生', name: 'キーフレームを再生' },
      { cmd: 'toggleKeyPath', icon: 'keyPath', text: '経路', check: 'keyPath', name: 'キーフレームの経路' },
      { cmd: 'toggleKeyGhost', icon: 'keyGhost', text: 'ゴースト', check: 'keyGhost', name: 'キーフレームのゴースト' },
      // 揺らしながら試している最中に、いい動きをすぐ残せるように
      { cmd: 'addFavorite', icon: 'favorite', text: 'お気に入り' },
    ],
  },
];

/**
 * 左のツールバーのボタンの一覧(並びのとおり)。設定で出す・隠すを選ぶのに使う。
 * id はボタンの data-nav と同じ(ツールはツールの id、操作はコマンドの名前)
 */
export const TOOLBAR_ITEMS: readonly { group: string; items: readonly { id: string; label: string; defaultHidden?: boolean }[] }[] = [
  { group: 'ツール', items: TOOL_GROUPS.flat().map(t => ({ id: t.id as string, label: t.name ?? t.label })) },
  ...NAV_ACTIONS.map(g => ({ group: g.label, items: g.items.map(it => ({ id: it.cmd as string, label: it.name ?? it.text, defaultHidden: it.defaultHidden })) })),
];
{
  // ツールの id とコマンドの名前は同じ data-nav に入るので、重なると1つのチェックで2つのボタンが隠れる
  const ids = TOOLBAR_ITEMS.flatMap(g => g.items.map(it => it.id));
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`左のツールバーのボタン「${dup}」が重なっています`);
}

/** キーの押し方を 'Ctrl+Shift+Z' の形にする */
export function keyString(e: KeyboardEvent): string {
  // 日本語入力がオンのときは key が 'Process'、Mac の Option は別の文字になるので、キーの位置(code)から読む
  let k = (e.key === 'Process' || e.altKey) && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : e.key;
  if (k.length === 1) k = k.toUpperCase();
  if (k === 'Escape') k = 'Esc';
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.shiftKey && 'Shift', e.altKey && 'Alt', k].filter(Boolean).join('+');
}

/** スライダーにフォーカスがあるときは、スライダーを動かすキーをショートカットに使わない */
const SLIDER_KEYS = new Set(['Home', 'End', 'PageUp', 'PageDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

/**
 * Tab を「UIを隠す・戻す」に使わず、ふつうにフォーカスを移すときか。キーボードで移ってきた部品にいるとき(:focus-visible)。
 * 文字を打つ欄は、この前に isTyping で除いている。マウス・指で押した部品(ボタン・スライダー・3Dビュー)や、どこにもフォーカスが無いときは
 * 隠す・戻すほうに使う。スライダーや、押すとスクリプトでフォーカスを移す3Dビューは、直前にキーを押していると押しても
 * :focus-visible になるので、押して付いたフォーカスかを自分で覚えておく。Shift+Tab はいつもフォーカスを戻すのに使える
 */
let viaPointer = false, pointerFocused: EventTarget | null = null;
/** 押して付いたフォーカスかを覚え始める(bindActions から1回呼ぶ) */
function watchPointerFocus(): void {
  addEventListener('pointerdown', () => { viaPointer = true; pointerHeld = true; }, true);
  for (const t of ['pointerup', 'pointercancel'] as const) addEventListener(t, () => { pointerHeld = false; }, true);
  addEventListener('keydown', () => { viaPointer = false; }, true);
  addEventListener('focusin', e => { pointerFocused = viaPointer ? e.target : null; }, true);
}
function keyboardFocus(): boolean {
  const el = document.activeElement;
  if (!el || el === document.body || el === pointerFocused) return false;
  return el.matches(':focus-visible');
}

const ariaKeys = (keys: string[]) => keys.map(k => k.replace(/\bCtrl\b/g, 'Control').replace(/\bEsc\b/g, 'Escape')).join(' ');

const TOOL_BTN = 'tool relative btn btn-sm w-[4.5rem] flex-col h-auto py-1 gap-0.5 whitespace-nowrap';
const ACT_BTN = 'nav-act relative btn btn-xs btn-ghost w-[4.5rem] flex-col h-auto py-1 gap-0.5 whitespace-nowrap font-normal';

export function bindActions(app: App, deps: ActionDeps): void {
  const table: Record<string, Action> = defineActions(app, deps);
  for (const t of TOOLS) {
    table[`tool.${t.id}`] = {
      label: t.name ?? t.label, keys: [t.key], desc: t.desc, run: () => app.setTool(t.id),
      // ツールのキーはボタンに書いてあるので、ヘルプのキー一覧には出さない
      hidden: true,
    };
  }

  const enabled = (name: string): boolean => {
    const a = table[name];
    if (!a) return false;
    if (app.previewing && !a.duringPreview) return false;
    return !a.enabled || a.enabled();
  };
  const run = (name: string): void => {
    if (!enabled(name)) {
      const why = !app.previewing && table[name]?.blocked?.();
      if (why) toast(why, 'warning', 5000);
      return;
    }
    void Promise.resolve(table[name].run()).catch(e => { console.error(e); toast(String(e instanceof Error ? e.message : e), 'error'); });
  };
  /** ツールチップ: 「名前 (キー補足): 説明」 */
  const tooltip = (a: Action, keyNote = '') => `${a.label}${a.keys ? ` (${a.keys[0]}${keyNote})` : ''}${a.desc ? `: ${a.desc}` : ''}`;

  /* ---------- 左のツールバーを作る(ツール → 区切り → その場で効く操作のまとまり) ---------- */
  const navItems: Node[] = [];
  const divider = () => Object.assign(document.createElement('div'), { className: 'divider my-0' });
  /** アイコン・名前・キーの3段のボタン */
  const navButton = (className: string, ico: IconName, label: string, key = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.innerHTML = `${icon(ico, 'nav-ico')}<span class="nav-label"></span><kbd class="tool-key" aria-hidden="true"></kbd>`;
    b.querySelector('.nav-label')!.textContent = label;
    b.querySelector('.tool-key')!.textContent = key;
    return b;
  };
  /** 見出し付きの枠に入れた、その場で効く操作のまとまり */
  const actionGroup = (g: NavGroup) => {
    const box = document.createElement('div');
    box.className = 'nav-group';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', g.title);
    const head = Object.assign(document.createElement('span'), { className: 'nav-group-label', textContent: g.label, title: g.title });
    head.setAttribute('aria-hidden', 'true');
    box.append(head);
    for (const it of g.items) {
      const b = navButton(ACT_BTN, it.icon, it.text);
      b.dataset.cmd = it.cmd; // 結び付け・キーの表記・ツールチップは、下の data-cmd の処理で付ける
      b.dataset.nav = it.cmd;
      if (it.check) b.dataset.pressed = it.check;
      if (it.name) b.setAttribute('aria-label', it.name);
      // 重ね表示が全レイヤーのときの印(押すたびに OFF → 選択中 → 全レイヤー)
      if (it.check === 'overlay') b.append(Object.assign(document.createElement('span'), { className: 'nav-badge', textContent: '全', hidden: true }));
      box.append(b);
    }
    return box;
  };
  for (const group of TOOL_GROUPS) {
    for (const t of group) {
      const b = navButton(TOOL_BTN, t.id, t.label, t.key);
      b.dataset.tool = t.id;
      b.dataset.nav = t.id;
      b.title = tooltip(table[`tool.${t.id}`], t.keyNote);
      b.setAttribute('aria-keyshortcuts', t.key);
      b.addEventListener('click', () => run(`tool.${t.id}`));
      navItems.push(b);
    }
    navItems.push(divider());
  }
  for (const g of NAV_ACTIONS) navItems.push(actionGroup(g));
  ui.toolNav.replaceChildren(...navItems);

  /* ---------- 上のメニューの「ツール」(左のツールバーと同じ並び。まとまりの間に区切りを入れる) ---------- */
  ui.toolMenu.replaceChildren(...TOOL_GROUPS.flatMap((group, gi) => {
    const items = group.map(t => {
      const li = document.createElement('li'), b = document.createElement('button');
      b.dataset.cmd = `tool.${t.id}`; // キーの表記と結び付けは、下の data-cmd の処理で付ける
      b.append(t.name ?? t.label, Object.assign(document.createElement('span'), { className: 'ml-auto' }));
      b.lastElementChild!.setAttribute('data-tool-check', t.id);
      li.append(b);
      return li;
    });
    return gi ? [Object.assign(document.createElement('li'), { className: 'menu-sep' }), ...items] : items;
  }));

  /* ---------- data-cmd の部品に、キーの表記・ツールチップを付けて結び付ける ---------- */
  const cmdButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-cmd]')];
  for (const b of cmdButtons) {
    const name = b.dataset.cmd!, a = table[name];
    if (!a) throw new Error(`コマンド「${name}」がありません`);
    if (a.keys) {
      b.setAttribute('aria-keyshortcuts', ariaKeys(a.keys));
      const tk = b.querySelector('kbd.tool-key');
      // ボタンの右上は狭いので、Shift は ⇧ と短く書き、Ctrl の付くキーは出さない(ツールチップには出る)
      if (tk) {
        tk.textContent = a.keys[0].includes('Ctrl+') ? '' : a.keys[0].replace('Shift+', '⇧');
        // 2文字以上の表記は、低い画面で名前と重なるので隠す(style.css)
        b.classList.toggle('key-wide', tk.textContent.length > 1);
      }
      // キーの表記は PC のメニューにだけ付ける(スマホの上のメニューにはキーボードが無い)
      if (b.closest('.menu') && !b.closest('.m-only') && !b.querySelector('kbd')) {
        const kbd = document.createElement('kbd');
        kbd.className = b.querySelector('[data-check], [data-tool-check]') ? 'kbd kbd-xs' : 'kbd kbd-xs ml-auto';
        kbd.textContent = a.keys[0];
        b.append(kbd);
      }
    }
    // スマホの部品とメニューは文字で分かるので、ツールチップは PC のボタンにだけ付ける
    if (!b.closest('.menu, .m-only')) { b.title = tooltip(a); b.dataset.tip = b.title; }
    const inDropdown = !!b.closest('.dropdown');
    b.addEventListener('click', () => {
      // ドロップダウンの中ならフォーカスを外して閉じる。ほかのボタンはキーボードで続けて押せるようフォーカスを残す
      if (inDropdown) (document.activeElement as HTMLElement | null)?.blur();
      run(name);
    });
  }

  /* ---------- ヘルプのマウス操作とショートカットの一覧 ---------- */
  {
    ui.helpOps.replaceChildren(...HELP_OPS.flatMap(r => {
      const op = Object.assign(document.createElement('span'), { className: 'help-op', innerHTML: hintHtml(r.parts) });
      return [Object.assign(document.createElement('span'), { textContent: r.label }), op];
    }));
    const rows = new Map<string, string[]>();
    for (const a of Object.values(table)) {
      if (!a.keys || a.hidden) continue;
      const row = a.helpRow ?? a.helpLabel ?? a.label;
      rows.set(row, [...(rows.get(row) ?? []), ...a.keys]);
    }
    // キーもマウスの操作と同じ書き方(キーの札)で出す
    ui.helpKeys.replaceChildren(...[...rows].flatMap(([label, keys]) => [
      Object.assign(document.createElement('span'), { textContent: label }),
      Object.assign(document.createElement('span'), { className: 'help-op', innerHTML: hintHtml(keys.map(k => ({ mods: k }))) }),
    ]));
  }

  /* ---------- キー ---------- */
  const byKey = new Map<string, string>();
  for (const [name, a] of Object.entries(table)) for (const k of a.keys ?? []) {
    if (byKey.has(k)) throw new Error(`ショートカット ${k} が「${byKey.get(k)}」と「${name}」で重なっています`);
    byKey.set(k, name);
  }
  /** 画面を覆うダイアログ(確認・書き出しなど)が開いているか。膨らませるのパネルのように画面を覆わないものは含めない */
  const modalOpen = () => !!document.querySelector('dialog[open]:modal');
  watchPointerFocus();
  window.addEventListener('keydown', e => {
    // 膨らませるのパネルを開いている間も、表示の切り替えなどは効かせる(できない操作は enabled で止める)
    if (isTyping(e) || modalOpen()) return;
    if (e.target instanceof HTMLInputElement && e.target.type === 'range' && SLIDER_KEYS.has(e.key) && !e.ctrlKey && !e.metaKey) return;
    if (e.key === 'Tab' && keyboardFocus()) return;
    const name = byKey.get(keyString(e));
    if (!name) return;
    // Esc はほかの部品も使うので、すでに使われたときと、いま使えないときは触らない
    if (e.key === 'Escape' && (e.defaultPrevented || !enabled(name))) return;
    e.preventDefault();
    run(name);
  });

  /* ---------- 状態 → 画面 ---------- */
  const undoLabel = document.querySelector('[data-label=undo]')!, redoLabel = document.querySelector('[data-label=redo]')!;
  const checks = [...document.querySelectorAll<HTMLElement>('[data-check]')];
  /** 使えない理由の注意書き(data-blocked にコマンドの名前。メニューやダイアログの中に置き、使えない間だけ出す) */
  const blockedNotes = [...document.querySelectorAll<HTMLElement>('[data-blocked]')];
  for (const el of blockedNotes) if (!table[el.dataset.blocked!]?.blocked) throw new Error(`コマンド「${el.dataset.blocked}」に使えない理由がありません`);
  const pressables = [...ui.toolNav.querySelectorAll<HTMLElement>('[data-pressed]')];
  const keyPlayButtons = [...ui.toolNav.querySelectorAll<HTMLElement>('[data-cmd=toggleKeyPlay]')];
  const overlayBadges = [...ui.toolNav.querySelectorAll<HTMLElement>('[data-pressed=overlay] .nav-badge')];
  /** 'status' でも呼ぶ(0.5 秒ごと)ので、変わったときだけ書く */
  const setText = (el: Element, text: string) => { if (el.textContent !== text) el.textContent = text; };
  function refresh(): void {
    for (const b of cmdButtons) {
      const off = !enabled(b.dataset.cmd!);
      if (b.disabled !== off) b.disabled = off;
      // ツールチップのあるボタンは、使えない理由を足す
      if (b.dataset.tip !== undefined) {
        const why = off ? table[b.dataset.cmd!].blocked?.() : null;
        const tip = why ? `${b.dataset.tip}\n${why}` : b.dataset.tip;
        if (b.title !== tip) b.title = tip;
      }
    }
    for (const el of blockedNotes) {
      const why = enabled(el.dataset.blocked!) ? null : table[el.dataset.blocked!].blocked!();
      el.hidden = !why;
      setText(el, why ?? '');
    }
    setText(undoLabel, app.history.undoLabel ? `(${app.history.undoLabel})` : '');
    setText(redoLabel, app.history.redoLabel ? `(${app.history.redoLabel})` : '');
    const on: Record<ViewCheck, boolean> = {
      overlay: app.view.overlay, grid: app.view.grid, fade: app.view.fade, flat: app.view.flat, multi: app.view.multi, pause: app.paused,
      transparent: app.project.background === null, panel: !app.panelClosed, keyPath: app.keyOverlay.path, keyGhost: app.keyOverlay.ghost,
      autoSwing: app.project.autoSwing.enabled,
    };
    // 重ね表示は3つの状態なので、左のツールバーには全レイヤーのときだけ印を付ける(メニューには状態を出さない。幅が変わるため)
    const mode = app.overlayMode;
    for (const el of checks) setText(el, on[el.dataset.check as ViewCheck] ? '✓' : '');
    for (const el of overlayBadges) {
      el.hidden = mode !== 'all';
      // 読み上げでも3つの状態を区別できるようにする
      const b = el.parentElement!, name = mode === 'all' ? 'ウェイトの重ね表示(全レイヤー)' : 'ウェイトの重ね表示';
      if (b.getAttribute('aria-label') !== name) b.setAttribute('aria-label', name);
    }
    // キーフレームの再生ボタンは、再生中は停止のボタンにする
    const playing = app.takeState === 'playing';
    for (const b of keyPlayButtons) {
      if (b.dataset.playing === String(playing)) continue;
      b.dataset.playing = String(playing);
      b.querySelector('svg')!.innerHTML = ICONS[playing ? 'stop' : 'play'];
      b.querySelector('.nav-label')!.textContent = playing ? '停止' : '再生';
      b.setAttribute('aria-label', playing ? '再生を止める' : 'キーフレームを再生');
    }
    for (const el of pressables) {
      const v = String(on[el.dataset.pressed as ViewCheck]);
      if (el.getAttribute('aria-pressed') !== v) el.setAttribute('aria-pressed', v);
    }
  }
  app.history.on('change', refresh);
  app.on('active', refresh);
  app.on('view', refresh);
  app.on('inflate', refresh);
  app.on('blur', refresh);
  app.on('take', refresh);
  app.on('tabs', refresh);
  app.on('file', refresh); // 「未保存」になると、置き換えて開けたサンプルのタブが置き換えられなくなる
  app.on('status', refresh); // 書き出しの始まり・終わりなど(fps の更新は別のイベントなので、ここでは拾わない)
  app.store.on('layers', refresh);
  app.store.on('replace', refresh);
  app.store.on('project', ({ keys }) => { if (keys.includes('take') || keys.includes('background') || keys.includes('autoSwing')) refresh(); });

  /* ---------- ツールの表示(ツールオプションの欄は ui/toolOptions.ts) ---------- */
  const toolButtons = [...ui.toolNav.querySelectorAll<HTMLButtonElement>('.tool')];
  const toolChecks = [...ui.toolMenu.querySelectorAll<HTMLElement>('[data-tool-check]')];
  function refreshTool(): void {
    for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === app.tool));
    for (const el of toolChecks) setText(el, el.dataset.toolCheck === app.tool ? '✓' : '');
  }
  app.on('tool', refreshTool);

  refresh(); refreshTool();
}
