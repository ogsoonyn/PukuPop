/**
 * マウス操作の書き方。ボタンを塗ったマウスの絵(ドラッグは横に十字の矢印、ホイールは上下の矢印)と、
 * 押しながらのキー、結果の短い言葉を並べる。上のツールオプションの欄のヒント(ui/tools.ts の hint)と、
 * ヘルプの操作方法(下の HELP_OPS)で使う。言葉の説明は、絵の aria-label とツールチップに置く。
 */

/** 左ドラッグ・右ドラッグ・中ドラッグ・ホイール・クリック・ダブルクリック */
export type Mouse = 'drag' | 'rdrag' | 'mdrag' | 'wheel' | 'click' | 'dbl';

/** 1つの操作。mods は押しながらのキー('Alt'、'Space' など。マウスが無ければキーだけの操作) */
export interface HintPart { mods?: string; mouse?: Mouse; text?: string }

const MOUSE_NAME: Record<Mouse, string> = {
  drag: '左ドラッグ', rdrag: '右ドラッグ', mdrag: '中ドラッグ', wheel: 'ホイール', click: 'クリック', dbl: 'ダブルクリック',
};

// マウスの体(幅 15、高さ 21)と、左右のボタン・ホイールの形。押すところはアクセントの色で塗る
const ON = 'fill="var(--color-primary, currentColor)" stroke="none"';
const BODY = '<rect x="1.5" y="1.5" width="15" height="21" rx="7.5"/><path d="M1.5 10.5h15M9 1.5v9"/>';
const LEFT = `<path d="M8.4 2.3A6.8 6.8 0 0 0 2.3 9v.9h6.1z" ${ON}/>`;
const RIGHT = `<path d="M9.6 2.3A6.8 6.8 0 0 1 15.7 9v.9H9.6z" ${ON}/>`;
const WHEEL_ON = `<rect x="7.2" y="3.5" width="3.6" height="6" rx="1.8" ${ON}/>`;
const WHEEL = '<rect x="7.4" y="3.8" width="3.2" height="5.4" rx="1.6" fill="var(--color-base-100, #fff)"/>';
const MOVE = '<path d="M24.5 7v10M19.5 12h10"/><path d="m22.8 8.7 1.7-1.7 1.7 1.7M22.8 15.3l1.7 1.7 1.7-1.7M21.2 10.3 19.5 12l1.7 1.7M27.8 10.3 29.5 12l-1.7 1.7"/>';
const UPDOWN = '<path d="M24.5 5v14"/><path d="m22.3 7.2 2.2-2.2 2.2 2.2M22.3 16.8l2.2 2.2 2.2-2.2"/>';
// ダブルクリックは「W」(ダブル)
const TWICE = '<text x="18.6" y="20.5" font-size="11" font-weight="700" fill="currentColor" stroke="none">W</text>';

/** マウスの絵の SVG */
export function mouseIcon(m: Mouse): string {
  const wide = m !== 'click';
  const parts = [
    BODY,
    m === 'drag' || m === 'click' || m === 'dbl' ? LEFT : '',
    m === 'rdrag' ? RIGHT : '',
    m === 'mdrag' || m === 'wheel' ? WHEEL_ON : WHEEL,
    m === 'drag' || m === 'rdrag' || m === 'mdrag' ? MOVE : '',
    m === 'wheel' ? UPDOWN : '',
    m === 'dbl' ? TWICE : '',
  ].join('');
  return `<svg class="mouse-ico${wide ? ' wide' : ''}" viewBox="0 0 ${wide ? 30 : 18} 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${parts}</svg>`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** 操作1つ分の HTML(キー + マウスの絵 + 言葉) */
function partHtml(p: HintPart): string {
  const name = [p.mods, p.mouse && MOUSE_NAME[p.mouse]].filter(Boolean).join(' + ');
  const keys = p.mods ? p.mods.split('+').map(k => `<kbd class="kbd kbd-xs">${esc(k)}</kbd>`).join('<span class="mh-plus">+</span>') : '';
  const plus = p.mods && p.mouse ? '<span class="mh-plus">+</span>' : '';
  const mouse = p.mouse ? `<span class="mh-mouse" role="img" aria-label="${esc(MOUSE_NAME[p.mouse])}" title="${esc(MOUSE_NAME[p.mouse])}">${mouseIcon(p.mouse)}</span>` : '';
  const text = p.text ? `<span class="mh-text">${esc(p.text)}</span>` : '';
  return `<span class="mh" title="${esc([name, p.text].filter(Boolean).join(': '))}">${keys}${plus}${mouse}${text}</span>`;
}

/** 操作を並べた HTML */
export function hintHtml(parts: readonly HintPart[]): string {
  return parts.map(partHtml).join('');
}

/** 操作を言葉だけで書いたもの(読み上げ・テスト用) */
export function hintText(parts: readonly HintPart[]): string {
  return parts.map(p => [[p.mods, p.mouse && MOUSE_NAME[p.mouse]].filter(Boolean).join(' + '), p.text].filter(Boolean).join(' ')).join(' / ');
}

/**
 * ヘルプの操作方法(PC)。ツールごとの操作は上の欄に出すので、ここにはツールを問わない操作と、見つけにくい操作だけを書く。
 * 3面図は視点を戻す操作だけ(ほかは主ビューと同じなので書かない)。浮いているパネルの動かし方も書かない(ユーザーの判断)
 */
export const HELP_OPS: readonly { label: string; parts: readonly HintPart[] }[] = [
  { label: '回転', parts: [{ mouse: 'rdrag' }] },
  { label: '傾ける', parts: [{ mods: 'Alt', mouse: 'rdrag' }] },
  { label: '平行移動', parts: [{ mouse: 'mdrag' }, { mods: 'Space', mouse: 'drag' }] },
  { label: 'ズーム', parts: [{ mouse: 'wheel' }] },
  { label: '押しながら動かすと 1/5 に', parts: [{ mods: 'Ctrl' }, { mods: 'Shift' }] },
  { label: 'Space+ドラッグ・自由角度を 1/5 に', parts: [{ mods: 'Ctrl' }] },
  { label: 'ブラシ中に消しゴム', parts: [{ mods: 'Alt', mouse: 'drag' }] },
  { label: '膨らみを正円・正方形に', parts: [{ mods: 'Shift', mouse: 'drag' }] },
  { label: '3面図の視点を戻す', parts: [{ mouse: 'dbl' }] },
  { label: '一覧でレイヤーを足す・外す', parts: [{ mods: 'Ctrl', mouse: 'click' }] },
  { label: '一覧でレイヤーを範囲で選ぶ', parts: [{ mods: 'Shift', mouse: 'click' }, { mods: 'Shift+↑↓' }] },
  { label: '一覧で離れたレイヤーを足す・外す', parts: [{ mods: 'Ctrl+↑↓' }, { mods: 'Ctrl+Space' }] },
];
