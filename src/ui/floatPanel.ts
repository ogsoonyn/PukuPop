/**
 * 膨らませる・全体ぼかしのパネル(.float-panel)を、見出しをつかんで動かせるようにする。
 * 最初は画面の右下に出す(位置は style.css)。右パネルや3面図にはかぶってよい(絵を隠さないことを優先する)。
 * 動かした位置は、画面の右下の角からの距離としてブラウザに覚え、2つのパネルで共通にする(どちらも絵をよける場所は同じなので)。
 * 右下からの距離で置くので、開いている間に高さが伸びても(説明を開いたときなど)上へ伸び、ボタンが画面の下へ出ない。
 * 見出しのダブルクリックで右下に戻す。画面の外へは出さない。
 * スマホでは動かさない(膨らませるはシートの中、ぼかしは画面幅いっぱいに出すため)。
 */
import { prefs } from '../storage/prefs';

const KEY = 'floatPanelPos';
/** 画面の端から空ける幅(px) */
const MARGIN = 8;
/** これだけ動いてからドラッグとみなす(押しただけのぶれで位置を覚えないよう) */
const DRAG_START = 3;

/**
 * 右下の角からの距離(right・bottom)を、幅 w・高さ h のパネルが画面(vw×vh)の中に収まるように直す。
 * 収まらないときは、左上(見出し)が見えるほうを優先する
 */
export function clampPanelPos(right: number, bottom: number, w: number, h: number, vw: number, vh: number): { right: number; bottom: number } {
  const fit = (v: number, size: number, view: number) => Math.round(Math.min(Math.max(MARGIN, v), view - size - MARGIN));
  return { right: fit(right, w, vw), bottom: fit(bottom, h, vh) };
}

export function bindFloatPanels(panels: { dialog: HTMLDialogElement; handle: HTMLElement }[]): void {
  const root = document.documentElement;
  const isMobile = () => root.classList.contains('mobile');
  const saved = () => {
    const v = prefs.get<{ right?: unknown; bottom?: unknown } | null>(KEY);
    return v && typeof v.right === 'number' && typeof v.bottom === 'number' && Number.isFinite(v.right) && Number.isFinite(v.bottom)
      ? { right: v.right, bottom: v.bottom } : null;
  };

  for (const { dialog: dlg, handle } of panels) {
    const clear = () => { dlg.style.left = dlg.style.top = dlg.style.right = dlg.style.bottom = ''; };
    const moveTo = (right: number, bottom: number) => {
      const r = dlg.getBoundingClientRect();
      const p = clampPanelPos(right, bottom, r.width, r.height, window.innerWidth, window.innerHeight);
      Object.assign(dlg.style, { left: 'auto', top: 'auto', right: `${p.right}px`, bottom: `${p.bottom}px` });
      return p;
    };
    /** 開いたとき・大きさが変わったときに、覚えている位置(無ければ右下)へ置き直す */
    const restore = () => {
      const p = isMobile() ? null : saved();
      if (p) moveTo(p.right, p.bottom); else clear();
    };
    // show() はイベントを出さないので、open の属性の変化で開いたことを知る
    new MutationObserver(() => { if (dlg.open) restore(); }).observe(dlg, { attributes: true, attributeFilter: ['open'] });
    new MutationObserver(() => { if (dlg.open) restore(); }).observe(root, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', () => { if (dlg.open) restore(); });
    // 高さが伸びて上の端が画面から出たら、収め直す(覚えている位置はそのまま)
    new ResizeObserver(() => { if (dlg.open && !drag) restore(); }).observe(dlg);

    handle.classList.add('float-handle');
    let drag: { id: number; x: number; y: number; right: number; bottom: number; moved: boolean } | null = null;
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 || isMobile() || (e.target as Element).closest('button, input, select')) return;
      const r = dlg.getBoundingClientRect();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom, moved: false };
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
      if (drag?.id !== e.pointerId || isMobile()) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_START) return;
      drag.moved = true;
      moveTo(drag.right - dx, drag.bottom - dy);
    });
    const end = (e: PointerEvent) => {
      if (drag?.id !== e.pointerId) return;
      const { moved } = drag;
      drag = null;
      // 押しただけ(ダブルクリックを含む)のとき、スマホに替わったとき、ドラッグ中に閉じたとき(大きさが 0 になる)は覚えない
      if (!moved || isMobile() || !dlg.open) return;
      const r = dlg.getBoundingClientRect();
      prefs.set(KEY, { right: Math.round(window.innerWidth - r.right), bottom: Math.round(window.innerHeight - r.bottom) });
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    // ドラッグ中に閉じたときなど、pointerup が届かなくても終える
    handle.addEventListener('lostpointercapture', end);
    handle.addEventListener('dblclick', e => { if (isMobile() || (e.target as Element).closest('button, input, select')) return; prefs.set(KEY, null); clear(); });
  }
}
