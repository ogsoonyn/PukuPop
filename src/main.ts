import './style.css';
import { App, MAX_TABS } from './app';
import { initUI, ui } from './ui/ids';
import { bindStageInput } from './ui/input';
import { bindPanels } from './ui/panels';
import { bindActions } from './ui/actions';
import { bindExportDialog } from './ui/exportDialog';
import { bindBlurDialog } from './ui/blurDialog';
import { bindInflateDialog } from './ui/inflateDialog';
import { bindFloatPanels } from './ui/floatPanel';
import { bindToolOptions } from './ui/toolOptions';
import { bindMenus } from './ui/menus';
import { bindMultiView } from './ui/multiView';
import { bindRecentDialog } from './ui/recentDialog';
import { bindSettingsDialog } from './ui/settingsDialog';
import { bindMobileLayout } from './ui/mobile';
import { bindTakeControls } from './ui/take';
import { bindPlayBar } from './ui/playBar';
import { bindHideUi } from './ui/hideUi';
import { bindSidePanel } from './ui/sidePanel';
import { bindKeyPath } from './ui/keyPath';
import { clampPopMax } from './ui/popSlider';
import { bindInflateFrame } from './ui/inflateFrame';
import { bindFavoriteControls } from './ui/favorites';
import { isTool } from './ui/tools';
import { bindHelp } from './ui/help';
import { bindDocTabs } from './ui/docTabs';
import { FILE_EXTENSION, LEGACY_FILE_EXTENSION } from './storage/popstage';
import { ask, toast, retryWithClick } from './ui/dom';
import { autosave } from './storage/autosave';
import { prefs, persistControls } from './storage/prefs';
import { isImageFile, isProjectFile } from './ui/imageio';

// 画面の要素をまとめて取る(index.html と ui/ids.ts の一覧が合わなければ、ここで止まる)
initUI();
bindHelp();
const canvas = ui.view;
let app: App;
try {
  app = new App(canvas);
} catch (e) {
  ui.stage.innerHTML = '<p class="p-6 text-error">WebGL2 を初期化できませんでした。Chrome / Edge / Firefox の最新版でお試しください。</p>';
  throw e;
}
const params = new URLSearchParams(location.search);
const e2e = params.has('e2e');
/** E2E で自動保存の復元を試すときだけ、?e2e&restore で復元の確認を出す */
const checkRestore = !e2e || params.has('restore');
(window as unknown as { popstage: App }).popstage = app;

/** パフォーマンスのデバッグ表示(?debug か Ctrl+Shift+Alt+P)。使うときだけ読み込む */
const togglePerf = () => void import('./debug/perfOverlay').then(m => m.togglePerfOverlay(app)).catch(e => console.error(e));
if (params.has('debug')) togglePerf();
// ステータスバーの fps と頂点数も、開発向けなので ?debug のときだけ出す
ui.sFps.hidden = ui.sVerts.hidden = !params.has('debug');

bindStageInput(app, canvas);
const multiView = bindMultiView(app, canvas);
bindPanels(app);
bindTakeControls(app);
bindPlayBar(app);
bindHideUi(app);
bindSidePanel(app);
bindKeyPath(app);
bindInflateFrame(app);
bindFavoriteControls(app);

/* ---------- 右のパネルのタブ(レイヤー・アニメーション・画像と表示)。選んだタブはブラウザに覚える ---------- */
const selectPanelTab = (() => {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('#pTabs [data-ptab]')];
  const select = (t: string) => {
    if (!tabs.some(b => b.dataset.ptab === t)) t = 'layer'; // 知らない値(前の版の「編集」タブなど)は「レイヤー」で始める
    for (const b of tabs) { const on = b.dataset.ptab === t; b.setAttribute('aria-selected', String(on)); b.classList.toggle('tab-active', on); }
    for (const p of ui.props.querySelectorAll<HTMLElement>('[data-ppane]')) p.hidden = p.dataset.ppane !== t;
    prefs.set('panelTab', t);
  };
  for (const b of tabs) b.addEventListener('click', () => select(b.dataset.ptab!));
  select(prefs.get<string>('panelTab') ?? 'layer');
  return select;
})();

/* ---------- 設定をブラウザに覚える(ファイルには書かない) ---------- */
persistControls('brush', [ui.brushSize, ui.brushStrength, ui.brushHardness, ui.brushPressure]);
// 「ポップを一時OFF」「揺れを一時停止」は一時的な切り替えなので覚えない
{
  // キー・メニュー・チェックボックスのどれで切り替えても覚えるよう、アプリの表示の状態から覚える
  const saved = prefs.get<Record<string, unknown>>('view') ?? {};
  for (const k of ['overlay', 'overlayAll', 'grid', 'fade', 'multi'] as const) if (typeof saved[k] === 'boolean') app.view[k] = saved[k] as boolean;
  if (!app.view.overlay) app.view.overlayAll = false;
  if (typeof saved.autoOverlay === 'boolean') app.autoOverlay = saved.autoOverlay;
  if (typeof saved.autoOverlayOff === 'boolean') app.autoOverlayOff = saved.autoOverlayOff;
  const popMax = prefs.get<number>('popMax');
  if (typeof popMax === 'number') app.popMax = clampPopMax(popMax);
  app.overlayAutoShown = app.view.overlay && app.autoOverlay && saved.overlayAuto === true;
  app.syncView();
  app.on('view', () => { const v = app.view; prefs.set('view', { overlay: v.overlay, overlayAll: v.overlayAll, grid: v.grid, fade: v.fade, multi: v.multi, autoOverlay: app.autoOverlay, autoOverlayOff: app.autoOverlayOff, overlayAuto: app.overlayAutoShown }); });
}
{
  const t = prefs.get<string>('tool');
  // 前回OFFにして閉じた重ね表示を、ツールを戻すだけで入れ直さない
  if (isTool(t)) app.setTool(t, false);
  app.on('tool', t => prefs.set('tool', t));
}
// 背景・自動揺らし・画角は、変えたら「新しい画像を開いたときの既定」として覚える。透過にしても背景色は残す(bgColor)
{
  // bgColor を覚える前の版では、透過でないときの background だけが色を持っていた
  const d = prefs.get<Record<string, unknown>>('newImage') ?? {};
  const c = [d.bgColor, d.background].find(v => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v));
  if (c) app.bgColor = c as string;
}
app.store.on('project', ({ keys }) => {
  if (!keys.some(k => k === 'background' || k === 'autoSwing' || k === 'camera')) return;
  const p = app.project;
  prefs.set('newImage', { background: p.background, bgColor: app.bgColor, autoSwing: { ...p.autoSwing }, fov: p.camera.fov });
});
const exportDialog = bindExportDialog(app);
const blurDialog = bindBlurDialog(app);
const recentDialog = bindRecentDialog(app);
bindInflateDialog(app);
bindFloatPanels([{ dialog: ui.blurDialog, handle: ui.blurTitle }, { dialog: ui.inflateDialog, handle: ui.inflTitle }]);
bindToolOptions(app);

/* ---------- ファイルを開く ---------- */

const { fileProject } = ui;
fileProject.addEventListener('change', () => { const f = fileProject.files?.[0]; fileProject.value = ''; if (f) void app.openFile(f); });

const IMAGE_ACCEPT = { 'image/*': ['.png', '.jpg', '.jpeg', '.webp'] };

/** Chrome 系はファイルの場所(ハンドル)ごと受け取る。最近開いたファイルから開き直すのに使う */
async function pickAndOpen(types: FilePickerAcceptType[], fallback: HTMLInputElement): Promise<void> {
  if (window.showOpenFilePicker) {
    try {
      const r = await retryWithClick(() => window.showOpenFilePicker!({ types }), 'ファイルを選ぶ…');
      if (!r) return;
      const [h] = r;
      await app.openFile(await h.getFile(), h);
    } catch (e) { if ((e as DOMException).name !== 'AbortError') toast(String(e), 'error'); }
  } else fallback.click();
}

const openAny = () => pickAndOpen([{ description: 'PukuPop プロジェクト / 画像', accept: { 'application/zip': [FILE_EXTENSION, LEGACY_FILE_EXTENSION], ...IMAGE_ACCEPT } }], fileProject);

/* ---------- コマンド(メニュー・ボタン・ショートカット共通。定義は ui/actions.ts) ---------- */
// メニューやボタンを結び付けるので、data-cmd の部品をスマホのシートへ移す前に呼ぶ(移しても結び付けは残る)
bindActions(app, {
  openProject: openAny,
  openRecent: () => recentDialog.open(),
  openExport: () => exportDialog.open(),
  openBlur: () => blurDialog.open(),
  openSettings: () => settingsDialog.open(),
  // キーフレームの重ね表示は「アニメーション」タブを開いている間だけ出るので、左のツールバーなどで入れたらタブを開く
  showKeyFrames: () => { app.setPanelClosed(false); selectPanelTab('anim'); },
  togglePerf,
});
bindMenus();
bindDocTabs(app, { open: openAny });
// 左のツールバーを作ったあとに、隠すボタンを映す
const settingsDialog = bindSettingsDialog();
// スマホの配置。右パネルなどの部品を移すので、ほかの部品を結び付けたあとに呼ぶ
bindMobileLayout(app);

/* ---------- ドラッグ&ドロップ ---------- */

const anyDialogOpen = () => !!document.querySelector('dialog[open]');
let dragDepth = 0;
const showDrop = (on: boolean) => { ui.dropHint.classList.toggle('hidden', !on); ui.dropHint.classList.toggle('flex', on); };
window.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; showDrop(true); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) showDrop(false); });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; showDrop(false);
  const files = [...(e.dataTransfer?.files ?? [])], f = files.find(f => isImageFile(f) || isProjectFile(f));
  // ダイアログ(確認・書き出しなど)の表示中は、裏で別のファイルを開かない
  if (f && anyDialogOpen()) { toast('ダイアログを閉じてから、もう一度ドロップしてください。', 'warning'); return; }
  // Chrome 系はドロップでもファイルの場所を受け取れる(イベントの中で呼ぶ必要がある)
  const items = [...(e.dataTransfer?.items ?? [])].filter(i => i.kind === 'file');
  const handle = f ? items[files.indexOf(f)]?.getAsFileSystemHandle?.() : undefined;
  if (f) void (async () => {
    let h: FileSystemFileHandle | undefined;
    try { const x = await handle; if (x?.kind === 'file') h = x as FileSystemFileHandle; } catch { /* 場所が取れなければコピーで覚える */ }
    await app.openFile(f, h);
  })();
  else if (e.dataTransfer?.files.length) toast('PNG / JPEG / WebP の画像か、.pukupop ファイルをドロップしてください。', 'warning');
});

/* ---------- ステータスバーとタイトル ---------- */

function refreshStatus(): void {
  const d = app.doc;
  if (!ui.sFps.hidden) {
    ui.sFps.textContent = `${app.fps} fps`;
    ui.sVerts.textContent = `${app.stage.vertexCount.toLocaleString()} 頂点`;
  }
  ui.sZoom.textContent = `ズーム ${Math.round(100 / app.project.camera.zoom)}%`;
  const roll = app.project.camera.roll;
  if (ui.sRoll.hidden !== !roll) ui.sRoll.hidden = !roll;
  if (roll) ui.sRoll.textContent = `↻ ${Math.round((roll * 180) / Math.PI)}°`;
  ui.sImage.textContent = d ? `${d.image.width}×${d.image.height}px・ウェイト ${d.layers[0]?.weights.width ?? 0}×${d.layers[0]?.weights.height ?? 0}` : '-';
  if (!app.exporting) ui.sRec.textContent = [app.view.flat && 'ポップOFF', app.paused && '揺れ一時停止中'].filter(Boolean).join('・');
  ui.sSave.textContent = app.autosaveError ? `自動保存に失敗しました(${app.autosaveError})。こまめに保存してください。` : app.dirty ? (app.lastAutosave ? `未保存の変更あり(${app.lastAutosave.toLocaleTimeString()} に自動保存)` : '未保存の変更あり') : app.lastSaved ? `保存済み ${app.lastSaved.toLocaleTimeString()}` : '';
}
function refreshTitle(): void {
  const name = app.tabName(app.activeTab);
  document.title = `${app.dirty ? '* ' : ''}${name ? name + ' - ' : ''}PukuPop`;
  refreshStatus();
}
ui.sRoll.addEventListener('click', () => app.resetRoll());
app.on('status', refreshStatus);
app.on('fps', refreshStatus); // ズームの表示など、イベントの無い変化もここで拾う(ステータスバーだけを書き直す)
app.on('view', refreshStatus);
app.on('file', refreshTitle);
app.on('tabs', refreshTitle);

window.addEventListener('beforeunload', e => { if (app.anyDirty) e.preventDefault(); });
new ResizeObserver(() => { app.stage.resize(); multiView.layout(); }).observe(canvas);

/* ---------- 起動 ---------- */

async function boot(): Promise<void> {
  app.stage.resize();
  app.start();
  if (checkRestore && await restoreAutosaves()) return;
  await app.loadSample();
  if (e2e) app.setPaused(true);
}

/**
 * 前回の作業(タブごとの自動保存)を戻す。1つでも戻せたら true。
 * タブの上限より多く残っていれば、新しく保存したものから上限まで戻し、残りは次の起動に回す
 */
async function restoreAutosaves(): Promise<boolean> {
  const all = await autosave.loadAll();
  if (!all.length) return false;
  const newest = [...all].sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_TABS);
  const saved = all.filter(e => newest.includes(e)), rest = all.length - saved.length;
  const when = (t: number) => new Date(t).toLocaleString();
  const r = await ask({
    title: '前回の作業を復元しますか?',
    body: (saved.length === 1
      ? `「${saved[0].name}」(${when(saved[0].savedAt)} に自動保存)が残っています。`
      : `${saved.length} 件の作業が残っています: ${saved.map(e => `「${e.name}」`).join('')}(最後の自動保存 ${when(Math.max(...saved.map(e => e.savedAt)))})。それぞれタブで開きます。`)
      + (rest ? `ほかに古い ${rest} 件があります(タブは ${MAX_TABS} 枚までなので、次回の起動時に聞きます)。` : ''),
    yes: '復元する', no: '破棄して新しく始める',
  });
  // 消すのは聞いた分だけ(残りや、別のブラウザのタブで開いている作業の分は消さない)
  if (!r.ok) { for (const e of saved) await autosave.clear(e.key); return false; }
  // 復元している間にドロップされたファイルを開かない(開くと、復元の失敗と取り違えてサンプルで上書きしてしまう)
  const failed: string[] = [];
  let restored = 0;
  await app.whileOpening(async () => {
    for (const e of saved) {
      if (await app.openProjectBytes(e.bytes, null, null, true, { tabId: e.key, order: e.order, name: e.name })) restored++;
      else failed.push(e.key);
    }
  });
  if (failed.length) {
    // 壊れた自動保存を残すかは本人に決めてもらう
    const keep = await ask({
      title: failed.length === saved.length ? '前回の作業を復元できませんでした' : `${failed.length} 件の作業を復元できませんでした`,
      body: '復元できなかった自動保存のデータを削除しますか? 残しておくと、次回の起動時にもう一度復元を試します。',
      yes: '削除する', no: '残しておく',
    });
    if (keep.ok) for (const k of failed) await autosave.clear(k);
  }
  if (restored) refreshTitle();
  return restored > 0;
}
void boot();

/* ---------- ホーム画面に追加したとき、電波がなくても起動できるようにする ---------- */
// 開発中(vite dev)と E2E では入れない。キャッシュが古い画面を返して確認の邪魔になるため
if (import.meta.env.PROD && !e2e && 'serviceWorker' in navigator) {
  addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(e => console.warn('service worker を登録できませんでした', e)); });
}
