/**
 * 画面の要素の一覧。index.html の id と要素の種類(タグ)を、ここ1か所で決める。
 * 起動時に initUI() でまとめて取り、無い・種類が違う要素があればその場で例外にする(使う所まで気づかない、を無くす)。
 * 名前を間違えると型チェックで分かり、index.html から消すと単体テスト(tests/unit/ui.test.ts)で分かる。
 */
export const UI_IDS = {
  // スマホの上のバー
  mTop: 'header', mTitle: 'button', mAuto: 'button',
  // メニューバー・ツールオプション
  docTabs: 'div', toolMenu: 'ul',
  brushSize: 'input', brushSizeO: 'output', brushStrength: 'input', brushStrengthO: 'output',
  brushHardness: 'input', brushHardnessO: 'output', brushPressure: 'select', toolHint: 'span',
  tInflKind: 'select', tInflProfile: 'select', tInflSoft: 'input', tInflSoftO: 'output', tInflAngle: 'input', tInflAngleO: 'output', tInflBlend: 'select',
  // ツールバー・3Dビュー
  toolNav: 'nav', stage: 'div', view: 'canvas', multiView: 'div', dropHint: 'div', keyPath: 'div', inflateFrame: 'div', takeCam: 'button',
  playBar: 'div', playStart: 'button', playStop: 'button', playPause: 'button', playTime: 'span', playTrack: 'div', playKeys: 'div', playLoop: 'span', playCam: 'button', mFine: 'button', busy: 'div', uiRestore: 'button', panelToggle: 'button', sidePanel: 'aside',
  // レイヤー一覧
  layerCount: 'span', layerList: 'ul',
  layerSelBar: 'div', layerSelText: 'span', layerSelAll: 'button', layerSelOne: 'button', layerSelDone: 'button',
  // 右パネル
  props: 'div', activeLayerName: 'span',
  pPop: 'input', pPopN: 'input', pBlend: 'select', pBlendDesc: 'p',
  pDensity: 'input', pDensityO: 'output', pOpacity: 'input', pOpacityO: 'output',
  pSwing: 'input', pPreset: 'select', pPresetDesc: 'p', physDetails: 'details', physSummary: 'span', pMotion: 'select', motionParams: 'div',
  pHard: 'input', pHardO: 'output', pMass: 'input', pMassO: 'output', pDamp: 'input', pDampO: 'output', pWeight: 'input', pWeightO: 'output',
  pAuto: 'input', pPeriod: 'input', pPeriodO: 'output', pAutoStr: 'input', pAutoStrO: 'output',
  takeInfo: 'span', takeRec: 'button', takePlay: 'button', takeClear: 'button',
  keySection: 'section', keyCount: 'span', keyPathShow: 'input', keyGhostShow: 'input', playBarShow: 'input', keyAdd: 'button', keyList: 'ol', keyMake: 'button', keyTotal: 'span',
  favCount: 'span', favAdd: 'button', favEmpty: 'p', favList: 'ol',
  vOverlayOff: 'input', vOverlaySel: 'input', vOverlayAll: 'input', vAutoOverlay: 'input', vAutoOverlayOff: 'input', setPopMax: 'input', vFade: 'input', vFlat: 'input', vPause: 'input', vMulti: 'input', vGrid: 'input',
  pFov: 'input', pFovO: 'output', pBgTransparent: 'input', pBgColor: 'input',
  // スマホのシート・下のバー
  mSheet: 'section', mGrip: 'div', mPresets: 'div', mPanes: 'div', mToolDesc: 'p', mBrushOpts: 'div', mInflOpts: 'div', mPaintMode: 'button',
  mModeBar: 'div', mTools: 'nav', mPaintDone: 'button',
  // ステータスバー
  sFps: 'span', sVerts: 'span', sZoom: 'span', sImage: 'span', sRec: 'span', sSave: 'span', sMem: 'div', sMemDetail: 'div',
  fileProject: 'input',
  // 書き出し
  exportDialog: 'dialog', exFormat: 'select', exW: 'input', exH: 'input', exSizePreset: 'select', exDur: 'input', exLoop: 'input',
  exBgColor: 'input', exBgAlphaLabel: 'label', exRecLen: 'span', exTakeLen: 'span', exNote: 'p', exProgress: 'progress',
  exStatus: 'p', exCancel: 'button', exStart: 'button',
  // 全体ぼかし
  blurDialog: 'dialog', blurTitle: 'h3', blurTarget: 'p', blurRadius: 'input', blurRadiusN: 'input', blurCancel: 'button', blurApply: 'button',
  // 膨らませる
  inflateDialog: 'dialog', inflTitle: 'h3', inflTarget: 'p', inflKind: 'select', inflW: 'input', inflH: 'input', inflHeight: 'input', inflHeightN: 'input',
  inflSoft: 'input', inflSoftN: 'input', inflAngle: 'input', inflAngleN: 'input', inflBlend: 'select', inflNote: 'p', inflCancel: 'button', inflApply: 'button',
  // 確認・数値入力
  askDialog: 'dialog', askTitle: 'h3', askBody: 'p', askInputWrap: 'div', askInputLabel: 'span', askInput: 'input', askNo: 'button', askYes: 'button',
  // 設定
  settingsDialog: 'dialog', setToolbarList: 'div', setToolbarReset: 'button', setHideFull: 'input', setHideFullRow: 'section',
  // 最近開いたファイル・ヘルプ・このアプリについて
  recentDialog: 'dialog', recentEmpty: 'p', recentList: 'ul', recentClear: 'button',
  // 開いている作業(タブ)の一覧(スマホ)
  tabDialog: 'dialog', tabList: 'ul', tabOpen: 'button',
  helpDialog: 'dialog', helpOps: 'div', helpKeys: 'div', aboutDialog: 'dialog', aboutUpdated: 'p',
  toasts: 'div',
} as const satisfies Record<string, keyof HTMLElementTagNameMap>;

type Ids = typeof UI_IDS;
export type UI = { readonly [K in keyof Ids]: HTMLElementTagNameMap[Ids[K]] };

/** 画面の要素。initUI() のあとに使う */
export const ui = {} as UI;

/** index.html から要素をまとめて取る。無い・種類が違う要素があれば、全部並べて例外にする */
export function initUI(root: Document = document): void {
  const bad: string[] = [];
  for (const [id, tag] of Object.entries(UI_IDS)) {
    const el = root.getElementById(id);
    if (!el) bad.push(`#${id} がありません`);
    else if (el.localName !== tag) bad.push(`#${id} は <${tag}> のはずが <${el.localName}> です`);
    else (ui as Record<string, HTMLElement>)[id] = el;
  }
  if (bad.length) throw new Error(`画面の要素が index.html と合いません:\n${bad.join('\n')}`);
}
