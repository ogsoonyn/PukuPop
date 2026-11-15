/**
 * Player の視点の操作(interaction: 'view')。受け口はすべて渡されたキャンバスに付け、外すときは1つの AbortController でまとめて外す。
 *   ドラッグ(マウスの左・右、1本指): 回す / Ctrl(⌘)+ホイール・タッチパッドのピンチ・2本指のピンチ: ズーム
 *   ただのホイールは preventDefault せず、埋め込み先のスクロールに任せる。平行移動・傾き(ロール)は入れない。
 * 回す感度・向き・上下の範囲・ズームの範囲は編集アプリ(ui/input.ts)と同じ(model/project.ts の orbitCamera・VIEW_LIMITS)。
 * 視点を動かした勢いで揺れるのは、刻みごとに視点を物理へ入れる処理(playback/frame.ts の feedView)が受け持つ。
 */
import { clampViewZoom, orbitCamera, VIEW_LIMITS, type CameraState } from '../model/project';
import { smoothZoom } from '../ui/smoothZoom';

/** ホイール1段あたりのズーム(拡大率の対数)。編集アプリのホイールと同じ */
const WHEEL_ZOOM = 0.0012;

/**
 * 視点の操作をキャンバスに付ける。camera は今の視点(お気に入りで差し替わるので毎回読む)、changed は視点を動かしたときに呼ぶ。
 * 返す関数で、付けた受け口と、キャンバスに付けたスタイル(touch-action・cursor)を元に戻す
 */
export function bindViewInput(canvas: HTMLCanvasElement, camera: () => CameraState, changed: () => void): () => void {
  const ac = new AbortController(), on = { signal: ac.signal };
  let live = true;
  // 1本指の縦の動きも回すのに使うので、キャンバスの上ではブラウザのスクロール・ズームをさせない(キャンバスの外は今までどおり)
  const before = { touchAction: canvas.style.touchAction, cursor: canvas.style.cursor };
  canvas.style.touchAction = 'none';
  canvas.style.cursor = 'grab';

  /** 押しているポインタ(マウスは1つ、指は2本まで)の最後の位置 */
  const pointers = new Map<number, { x: number; y: number }>();
  /** 2本指の間隔(ピンチ)。2本でないときは null */
  let pinch: number | null = null;
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) : 1;
  };

  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
    if (pointers.size >= 2 || (e.pointerType === 'mouse' && pointers.size)) return;
    // 文字の選択などを始めさせない(ドラッグはキャンバスの外へ出ても追う)
    e.preventDefault();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch { /* すでに離れたポインタ */ }
    pinch = pointers.size === 2 ? spread() : null;
    canvas.style.cursor = 'grabbing';
  }, on);

  canvas.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    const cam = camera();
    if (pinch !== null) {
      // 指を広げると近づく(zoom は小さいほど大きく見える)。編集アプリの2本指と同じ
      const d = spread();
      cam.zoom = clampViewZoom(cam.zoom * (pinch / d));
      pinch = d;
    } else orbitCamera(cam, dx, dy);
    changed();
  }, on);

  const end = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    // 2本から1本に減ったら、残った指で続けて回す(位置は残った指の最後の位置から)
    pinch = pointers.size === 2 ? spread() : null;
    if (!pointers.size) canvas.style.cursor = 'grab';
  };
  canvas.addEventListener('pointerup', end, on);
  canvas.addEventListener('pointercancel', end, on);
  canvas.addEventListener('lostpointercapture', end, on);
  // 右ドラッグで回すので、キャンバスの上ではメニューを出さない
  canvas.addEventListener('contextmenu', e => e.preventDefault(), on);

  // ズームは目標へなめらかに寄せる(編集アプリのホイールと同じ ui/smoothZoom.ts)。
  // Ctrl(⌘)を押しているときと、タッチパッドのピンチ(ブラウザが ctrlKey 付きのホイールとして送る)だけ
  const zoom = smoothZoom({
    get: () => camera().zoom,
    set: z => { if (!live) return; camera().zoom = z; changed(); },
    owner: () => camera(),
    min: VIEW_LIMITS.zoom.min, max: VIEW_LIMITS.zoom.max,
  });
  canvas.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    // Shift を押すとブラウザが横に回したことにするので、そのときは横の量を使う(編集アプリと同じ)
    const d = e.deltaY !== 0 ? e.deltaY : e.shiftKey ? e.deltaX : 0;
    zoom.add(d * WHEEL_ZOOM);
  }, { passive: false, signal: ac.signal });

  return () => {
    live = false;
    for (const id of pointers.keys()) { try { canvas.releasePointerCapture(id); } catch { /* 離れている */ } }
    pointers.clear();
    ac.abort();
    canvas.style.touchAction = before.touchAction;
    canvas.style.cursor = before.cursor;
  };
}
