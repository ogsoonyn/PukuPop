/**
 * 指で触ったスライダーを、スクロールのつもりの指で動かさないようにする(スマホの配置でも、PC の配置でも)。
 * - 縦に動かしたらスクロールにし、横に動かしたときだけスライダーを動かす(向きは動き始めで決める)
 * - 触っただけでは値を変えない。横に引いた分だけ、今の値から動かす(つまみの位置へ跳ばない)
 * ブラウザのスライダーは触った所へ値が跳び、指を縦に動かしても横の位置に合わせて値が変わるので、指で使っている間
 * (html に touch-sliders)はスライダーが指を受けないようにし(style.css で pointer-events: none、スライダーの入れ物は
 * touch-action: pan-y)、ここで入れ物の上の指からスライダーを動かす。値を変えたら input、離したら change を送るので、
 * スライダーの処理はふつうに触ったときと同じものが動く。
 * マウスとペンではブラウザのスライダーのまま使う。指かどうかは最後に動いたポインタで決める(スマホの配置ではいつも指の扱い)。
 */

/** 向きを決めるまでの動き(px) */
const DECIDE = 8;
/** スライダーの上下にはみ出して触っても拾う幅(px) */
const SLOP = 4;
const CLASS = 'touch-sliders';

/** 指の位置にあるスライダー(はみ出しの幅を含む。重なるときは縦の中心がいちばん近いもの)。上に別の部品(ダイアログなど)が重なっていれば拾わない */
function sliderAt(x: number, y: number): HTMLInputElement | null {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  let best: HTMLInputElement | null = null, bestD = Infinity;
  for (const el of document.querySelectorAll<HTMLInputElement>('input[type=range]')) {
    if (el.disabled || !el.parentElement?.contains(hit)) continue;
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

/** mobile: スマホの配置か(そのときはマウスでもこの動きにする) */
export function bindTouchSliders(mobile: () => boolean): void {
  const root = document.documentElement;
  // 指で触れる端末では、指の扱いから始める(マウスを動かすとブラウザのスライダーに戻る)
  let touch = matchMedia('(any-pointer: coarse)').matches;
  const sync = () => root.classList.toggle(CLASS, touch || mobile());
  sync();
  // 指は pointerdown の前に pointerover が来るので、そこで切り替える(pointerdown では、触った所へ値が跳ぶのに間に合わない)
  for (const t of ['pointerover', 'pointerdown', 'pointermove'] as const) addEventListener(t, e => { touch = e.pointerType === 'touch'; sync(); }, true);
  // スマホと PC の配置が切り替わったとき(配置は resize で決まる。mobile() が先に変わるよう、次のフレームで見る)
  addEventListener('resize', () => requestAnimationFrame(sync));
  const active = () => root.classList.contains(CLASS);

  let g: { id: number; el: HTMLInputElement; x: number; y: number; v: number; w: number; range: number; on: boolean; sent: boolean; cur: number } | null = null;
  /**
   * マウスの後で初めて指で触ったときは、切り替えが間に合わず、ブラウザのスライダーが指を受けてしまう。
   * そのときは、ブラウザが送る input・change を止め、値をこちらで決めた値に戻す(この指を離すまでと、離した直後の change)
   */
  let swallow: { el: HTMLInputElement; value: number; until: number; id: number } | null = null;
  for (const t of ['input', 'change'] as const) addEventListener(t, e => {
    if (!e.isTrusted || !touch) return; // マウス・ペンで動かした分は止めない
    const el = g?.el ?? (swallow && performance.now() < swallow.until ? swallow.el : null);
    if (!el || e.target !== el) return;
    e.stopImmediatePropagation();
    el.value = String(g ? g.cur : swallow!.value);
  }, true);
  addEventListener('pointerdown', e => {
    if (!active() || g || !e.isPrimary || e.button !== 0) return;
    const t = e.target as Element | null;
    const el = t instanceof HTMLInputElement && t.type === 'range' && !t.disabled ? t : sliderAt(e.clientX, e.clientY);
    if (!el) return;
    const min = el.min === '' ? 0 : +el.min, max = el.max === '' ? 100 : +el.max;
    g = { id: e.pointerId, el, x: e.clientX, y: e.clientY, v: +el.value, w: Math.max(1, el.getBoundingClientRect().width), range: max - min, on: false, sent: false, cur: +el.value };
  });
  addEventListener('pointermove', e => {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (!g.on) {
      if (Math.hypot(dx, dy) < DECIDE) return;
      // 縦ならスクロールに任せる(ブラウザがスクロールを始めると pointercancel が来る)
      if (Math.abs(dy) >= Math.abs(dx)) {
        // ブラウザのスライダーが指を受けているときのため、離すまで値を戻し続ける
        swallow = { el: g.el, value: g.cur, until: Infinity, id: g.id };
        g = null;
        return;
      }
      g.on = true;
      g.x = e.clientX; // 向きを決めるまでの動きで値が跳ばないよう、ここから測る
      (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
      g.el.focus({ preventScroll: true });
      return;
    }
    e.preventDefault(); // マウスで引いたときに文字を選ばない
    // 比べるのは入れた後の値どうし(小数の刻みは計算の誤差で一致しないため)
    const prev = g.el.value;
    g.el.value = String(snap(g.el, g.v + dx / g.w * g.range));
    g.cur = +g.el.value;
    if (g.el.value === prev) return;
    g.sent = true;
    g.el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const end = (e: PointerEvent) => {
    if (!g && swallow?.until === Infinity && swallow.id === e.pointerId) {
      swallow.el.value = String(swallow.value);
      swallow.until = performance.now() + 500;
    }
    if (!g || e.pointerId !== g.id) return;
    const { el, sent, cur } = g;
    g = null;
    if (el.value !== String(cur)) el.value = String(cur);
    swallow = { el, value: cur, until: performance.now() + 500, id: e.pointerId };
    // input を送ったら、元の値に戻して離したときも change を送る(受け手は input の始まりから change までを1手にまとめるため)
    if (sent) el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
}
