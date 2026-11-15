/**
 * アプリの中のタブ(作業)1枚分の中身と、その作り方(編集アプリだけの機能)。
 * 表に出す・裏へ回す・開く・閉じるの流れは App が受け持つ(読み込みの追い越しなど App の状態と絡むため)。
 */
import { defaultOrthoView, type OrthoView, type Project } from '../model/project';
import { emptyHistory, shrinkHistory, type HistoryState } from '../commands/history';
import type { KeyFrame } from '../physics/take';
import { FILE_EXTENSION, type PngCacheEntry } from '../storage/popstage';

/** 一度に開いておけるタブの数 */
export const MAX_TABS = 5;
/** タブが上限のときの案内(開く系のメニューの注意書きと、開こうとしたときの知らせで共通) */
export const TABS_FULL_NOTE = `タブは ${MAX_TABS} 枚までです。開くには、どれかのタブを閉じてください。`;

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
  /** 直近の自動保存の失敗が、ブラウザの保存領域の容量不足か(文言ではなくこれで見分ける) */
  autosaveQuota: boolean;
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
export function createTab(project: Project, init: Partial<Pick<Tab, 'id' | 'order' | 'sample' | 'fileName' | 'fileHandle' | 'dirty'>> = {}): Tab {
  const seq = tabSeq++;
  return {
    id: init.id ?? `tab-${Date.now().toString(36)}-${seq.toString(36)}`,
    order: init.order ?? Date.now() + seq,
    project, history: emptyHistory(), shownAt: 0, sample: init.sample ?? false,
    fileHandle: init.fileHandle ?? null, fileName: init.fileName ?? null, dirty: init.dirty ?? false, revision: 0,
    lastSaved: null, lastAutosave: null, autosaveError: null, autosaveQuota: false, autosaving: Promise.resolve(), autosaveTimer: 0,
    activeLayerId: null, selectedLayerIds: new Set(),
    // 記録がキーフレームから作ったものなら、そのキーフレームを下書きに入れて始める
    keyDraft: project.take?.keys ? structuredClone([...project.take.keys]) : [],
    multiOrtho: defaultOrthoView(), imageCanvas: null, pngCache: new Map(), centers: new Map(),
  };
}

/** タブの見出し(ファイル名、無ければ画像の名前) */
export function tabName(t: Tab): string { return t.fileName ?? t.project.documents[0]?.name ?? ''; }

/** 保存するときの名前の候補(ファイル名、無ければ画像の名前に拡張子を付けたもの) */
export function suggestedName(tab: Tab): string {
  if (tab.fileName) return tab.fileName;
  const base = (tab.project.documents[0]?.name ?? 'untitled').replace(/\.[^.]+$/, '');
  return `${base}${FILE_EXTENSION}`;
}

/**
 * 全部のタブのアンドゥの合計を、1つの作業の上限(limit)に収める。activeBytes は表のタブの積みの大きさ。
 * あふれたら、裏のタブ(hidden)のうち長く出していないものの古い手から捨てる(表のタブの積みは History が自分で収める)
 */
export function trimHiddenHistory(limit: number, activeBytes: number, hidden: Tab[]): void {
  let total = activeBytes + hidden.reduce((a, t) => a + t.history.bytes, 0);
  for (const t of hidden.sort((a, b) => a.shownAt - b.shownAt)) {
    if (total <= limit) break;
    total -= shrinkHistory(t.history, t.history.bytes - (total - limit));
  }
}
