/**
 * ツールの定義。左のツールバーのボタン・ショートカット・ヘルプ・ツールオプションのヒントは、すべてここから作る。
 * アイコンは ui/icons.ts の同じ名前のもの。スマホの下のバーも、アイコンと名前はここから取る(並びと説明は ui/mobile.ts)
 */
import type { Tool } from '../app';
import type { HintPart } from './mouseHint';

export interface ToolDef {
  id: Tool;
  /** ショートカット(1文字) */
  key: string;
  /** ボタンの名前 */
  label: string;
  /** ツールチップでの名前(ボタンの名前と違うときだけ) */
  name?: string;
  /** ツールチップでキーの後ろに足す補足 */
  keyNote?: string;
  /** ツールチップの説明 */
  desc?: string;
  /** ツールオプションの欄に出す操作のヒント(マウスの絵で出す。言葉は結果だけを短く) */
  hint: readonly HintPart[];
}

/** 左のツールバーの並び。まとまりの間に区切りを入れる */
export const TOOL_GROUPS: readonly (readonly ToolDef[])[] = [
  [
    { id: 'brush', key: 'B', label: 'ブラシ', hint: [{ mouse: 'drag', text: '塗る' }, { mods: 'Alt', mouse: 'drag', text: '消す' }, { mouse: 'rdrag', text: '回転' }, { mouse: 'wheel', text: 'ズーム' }] },
    { id: 'erase', key: 'E', label: '消しゴム', keyNote: '、ブラシ中は Alt', hint: [{ mouse: 'drag', text: '消す' }] },
    { id: 'smooth', key: 'S', label: 'ぼかし', hint: [{ mouse: 'drag', text: '段差をならす' }] },
    {
      id: 'inflate', key: 'I', label: '膨らみ', name: '膨らませる', desc: '範囲をドラッグして、指定した高さと断面で一括して膨らませる',
      hint: [{ mouse: 'drag', text: '範囲を膨らませる' }, { mods: 'Shift', mouse: 'drag', text: '正円・正方形' }, { text: '枠の辺・角で大きさ、中で移動、上の丸で回す' }],
    },
    { id: 'grab', key: 'G', label: 'つかむ', hint: [{ mouse: 'drag', text: '引っ張って離すと揺れる' }] },
    {
      id: 'shake', key: 'Y', label: '揺らす', desc: 'カメラを画像に付けたまま振る。画像は動かず、揺れだけが見える',
      hint: [{ mouse: 'drag', text: '振って揺らす' }, { mouse: 'mdrag', text: '画像を動かす' }, { mouse: 'rdrag', text: '回転' }],
    },
  ],
  [
    { id: 'view', key: 'V', label: '視点', hint: [{ mouse: 'drag', text: '回転' }, { mods: 'Alt', mouse: 'drag', text: '傾ける' }, { mods: 'Space', mouse: 'drag', text: '平行移動' }] },
    {
      id: 'pan', key: 'H', label: '移動', desc: '左ドラッグで画像を画面の上で動かす(中ドラッグ・Space+ドラッグと同じ。動かした勢いで揺れる)',
      hint: [{ mouse: 'drag', text: '動かして揺らす' }, { mouse: 'rdrag', text: '回転' }, { mouse: 'wheel', text: 'ズーム' }],
    },
  ],
];

export const TOOLS: readonly ToolDef[] = TOOL_GROUPS.flat();

export const toolDef = (t: Tool): ToolDef => TOOLS.find(d => d.id === t)!;

export const isTool = (v: unknown): v is Tool => TOOLS.some(d => d.id === v);
