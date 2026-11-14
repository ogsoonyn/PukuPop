/**
 * スマホのシートの中のスライダーを、スクロールのつもりの指で動かさないようにする。
 * - 縦に動かしたらシートのスクロールにし、横に動かしたときだけスライダーを動かす(向きは動き始めで決める)
 * - 触っただけでは値を変えない。横に引いた分だけ、今の値から動かす(つまみの位置へ跳ばない)
 * ブラウザのスライダーは触った所へ値が跳び、縦の動きでも値が変わるので、シートの中のスライダーは指を受けないようにし
 * (style.css で pointer-events: none)、ここでシート(touch-action: pan-y)の上の指からスライダーを動かす。
 * 値を変えたら input、離したら change を送るので、スライダーの処理はふつうに触ったときと同じものが動く。
 */

/** 向きを決めるまでの動き(px) */
const DECIDE = 8;
/** スライダーの上下にはみ出して触っても拾う幅(px) */
const SLOP = 4;

/** 指の位置にあるスライダー(はみ出しの幅を含む。重なるときは縦の中心がいちばん近いもの) */
function sliderAt(root: HTMLElement, x: number, y: number): HTMLInputElement | null {
  let best: HTMLInputElement | null = null, bestD = Infinity;
  for (const el of root.querySelectorAll<HTMLInputElement>('input[type=range]')) {
    if (el.disabled) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || x < r.left || x > r.right || y < r.top - SLOP || y > r.bottom + SLOP) continue;
    const d = Math.abs(y - (r.top + r.bottom) / 2);
    if (d < bestD) { best = el; bestD = d; }
  }
  return best;
}

/** 値を刻みに合わせ、範囲に収める */
function snap(el: HTMLInputElement, v: number): number {
  const min = el.min === '' ? 0 : +el.min, max = el.max === '' ? 100 : +el.max;
  const step = el.step === 'any' ? 0 : el.step === '' ? 1 : +el.step;
  if (step > 0) v = min + Math.round((v - min) / step) * step;
  return Math.max(min, Math.min(max, v));
}

export function bindTouchSliders(root: HTMLElement, active: () => boolean): void {
  let g: { id: number; el: HTMLInputElement; x: number; y: number; v: number; w: number; range: number; on: boolean; sent: boolean } | null = null;

  root.addEventListener('pointerdown', e => {
    if (!active() || g || !e.isPrimary || e.button !== 0) return;
    const el = sliderAt(root, e.clientX, e.clientY);
    if (!el) return;
    const min = el.min === '' ? 0 : +el.min, max = el.max === '' ? 100 : +el.max;
    g = { id: e.pointerId, el, x: e.clientX, y: e.clientY, v: +el.value, w: Math.max(1, el.getBoundingClientRect().width), range: max - min, on: false, sent: false };
  });
  root.addEventListener('pointermove', e => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.on) {
      if (Math.hypot(dx, dy) < DECIDE) return;
      // 縦ならスクロールに任せる(ブラウザがスクロールを始めると pointercancel が来る)
      if (Math.abs(dy) >= Math.abs(dx)) { g = null; return; }
      g.on = true;
      g.x = e.clientX; // 向きを決めるまでの動きで値が跳ばないよう、ここから測る
      root.setPointerCapture(e.pointerId);
      g.el.focus({ preventScroll: true });
      return;
    }
    e.preventDefault(); // マウスで引いたときに文字を選ばない
    // 比べるのは入れた後の値どうし(小数の刻みは計算の誤差で一致しないため)
    const prev = g.el.value;
    g.el.value = String(snap(g.el, g.v + dx / g.w * g.range));
    if (g.el.value === prev) return;
    g.sent = true;
    g.el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const end = (e: PointerEvent) => {
    if (!g || e.pointerId !== g.id) return;
    const { el, sent } = g;
    g = null;
    // input を送ったら、元の値に戻して離したときも change を送る(受け手は input の始まりから change までを1手にまとめるため)
    if (sent) el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
}
