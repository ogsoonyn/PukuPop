/**
 * Player の視点の操作(interaction: 'view')。受け口はすべて渡されたキャンバスに付け、外すときは1つの AbortController でまとめて外す。
 *   マウス・ペン: 左ドラッグで平行移動、右ドラッグで回す
 *   指: 1本指で回す、2本指で平行移動とピンチのズーム
 *   Ctrl(⌘)+ホイール・タッチパッドのピンチ: ズーム
 *   ダブルクリック・ダブルタップ: 視点を戻す(戻す先は呼ぶ側が決める)
 *   ただのホイールは preventDefault せず、埋め込み先のスクロールに任せる。傾き(ロール)は入れない。
 * 左で平行移動・右で回すのは、編集アプリの「UIを隠す」の間の操作(ui/input.ts)と同じ。
 * 回す感度・向き・上下の範囲・ズームの範囲・平行移動の量も編集アプリと同じ(model/project.ts の orbitCamera・panBy・VIEW_LIMITS)。
 * 視点を動かした勢いで揺れるのは、刻みごとに視点を物理へ入れる処理(playback/frame.ts の feedView)が受け持つ。
 */
import { clampViewZoom, orbitCamera, panBy, type CameraState, type Vec3 } from '../model/project';

/** ホイールの量 1 あたりのズーム(拡大率の対数)。編集アプリのホイールと同じ感度 */
const WHEEL_ZOOM = 0.0012;
/** ダブルクリック・ダブルタップの判定: 1回の押して離すまでの時間・動いてよい量と、2回の間の時間・間の距離(編集アプリのダブルタップと同じ) */
const TAP_MS = 300, TAP_MOVE = 10, DOUBLE_MS = 350, DOUBLE_DIST = 32;

export interface ViewInputHost {
  /** 今の視点(お気に入りで差し替わるので毎回読む) */
  camera(): CameraState;
  /** 平行移動の量: 画面の 1px がワールドで何単位か(k)と、画面の右・上の向き(Stage の pixelToWorld・screenAxes) */
  panAxes(cam: CameraState): { k: number; right: Vec3; up: Vec3 };
  /** 視点を動かした */
  changed(): void;
  /** ダブルクリック・ダブルタップで視点を戻す */
  reset(): void;
}

/**
 * 視点の操作をキャンバスに付ける。
 * 返す関数で、付けた受け口と、キャンバスに付けたスタイル(touch-action・cursor)を元に戻す
 */
export function bindViewInput(canvas: HTMLCanvasElement, host: ViewInputHost): () => void {
  const ac = new AbortController(), on = { signal: ac.signal };
  // 1本指の縦の動きも回すのに使うので、キャンバスの上ではブラウザのスクロール・ズームをさせない(キャンバスの外は今までどおり)
  const before = { touchAction: canvas.style.touchAction, cursor: canvas.style.cursor };
  canvas.style.touchAction = 'none';
  canvas.style.cursor = 'grab';

  /** 押しているポインタ(マウス・ペンは1つ、指は2本まで)の最後の位置 */
  const pointers = new Map<number, { x: number; y: number }>();
  /** マウス・ペンのドラッグが平行移動か(左ボタン)。回す(右ボタン)なら false */
  let mousePan = false;
  /** 2本指の間隔と中心(ピンチと平行移動)。2本でないときは null */
  let pinch: { d: number; x: number; y: number } | null = null;
  /** 触り始めてから全部を離すまでの記録(ダブルクリック・ダブルタップの判定) */
  let tap: { t: number; x: number; y: number; moved: number; n: number; ok: boolean } | null = null;
  let lastTap: { t: number; x: number; y: number } | null = null;
  const two = () => {
    const [a, b] = [...pointers.values()];
    return a && b ? { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
  };
  const pan = (dx: number, dy: number) => {
    const cam = host.camera(), { k, right, up } = host.panAxes(cam);
    panBy(cam.target, dx, dy, k, { right, up });
  };

  canvas.addEventListener('pointerdown', e => {
    const touch = e.pointerType === 'touch';
    if (!touch && e.button !== 0 && e.button !== 2) return;
    if (pointers.size >= 2 || (!touch && pointers.size)) return;
    // 文字の選択などを始めさせない(ドラッグはキャンバスの外へ出ても追う)
    e.preventDefault();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch { /* すでに離れたポインタ */ }
    if (!touch) mousePan = e.button === 0;
    pinch = pointers.size === 2 ? two() : null;
    // ダブルクリックは左ボタンだけ(右ボタンは回すのに使う)
    if (pointers.size === 1) tap = { t: performance.now(), x: e.clientX, y: e.clientY, moved: 0, n: 1, ok: touch || e.button === 0 };
    else if (tap) tap.n = pointers.size;
    canvas.style.cursor = !touch && mousePan ? 'move' : 'grabbing';
  }, on);

  canvas.addEventListener('pointermove', e => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (tap && pointers.size === 1) tap.moved = Math.max(tap.moved, Math.hypot(e.clientX - tap.x, e.clientY - tap.y));
    const cam = host.camera();
    if (pinch) {
      // 指を広げると近づく(zoom は小さいほど大きく見える)。2本の中心が動いた分は平行移動。編集アプリの2本指と同じ
      const g = two();
      if (!g) return;
      cam.zoom = clampViewZoom(cam.zoom * (pinch.d / g.d));
      pan(g.x - pinch.x, g.y - pinch.y);
      pinch = g;
    } else if (e.pointerType !== 'touch' && mousePan) pan(dx, dy);
    else orbitCamera(cam, dx, dy);
    host.changed();
  }, on);

  const end = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    // 2本から1本に減ったら、残った指で続けて回す(位置は残った指の最後の位置から)
    pinch = pointers.size === 2 ? two() : null;
    if (pointers.size) return;
    canvas.style.cursor = 'grab';
    const t = tap; tap = null;
    if (e.type !== 'pointerup' || !t || !t.ok || t.n > 1 || t.moved > TAP_MOVE || performance.now() - t.t > TAP_MS) { lastTap = null; return; }
    const now = performance.now();
    if (lastTap && now - lastTap.t < DOUBLE_MS && Math.hypot(lastTap.x - t.x, lastTap.y - t.y) < DOUBLE_DIST) {
      lastTap = null;
      host.reset();
    } else lastTap = { t: now, x: t.x, y: t.y };
  };
  canvas.addEventListener('pointerup', end, on);
  canvas.addEventListener('pointercancel', end, on);
  canvas.addEventListener('lostpointercapture', end, on);
  // 右ドラッグで回すので、キャンバスの上ではメニューを出さない
  canvas.addEventListener('contextmenu', e => e.preventDefault(), on);

  // Ctrl(⌘)を押しているときと、タッチパッドのピンチ(ブラウザが ctrlKey 付きのホイールとして送る)だけズームする。
  // 編集アプリはピンチをその場で変え、マウスの Ctrl+ホイールはなめらかに寄せるが、Player は window に受け口を付けられず
  // 2つを見分けられない。ピンチが指に遅れないほうを取り、どちらもその場で変える(マウスの Ctrl+ホイールでは段が出る)
  canvas.addEventListener('wheel', e => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    // Shift を押すとブラウザが横に回したことにするので、そのときは横の量を使う(編集アプリと同じ)
    const d = e.deltaY !== 0 ? e.deltaY : e.shiftKey ? e.deltaX : 0;
    if (!d) return;
    const cam = host.camera();
    cam.zoom = clampViewZoom(cam.zoom * Math.exp(d * WHEEL_ZOOM));
    host.changed();
  }, { passive: false, signal: ac.signal });

  return () => {
    for (const id of pointers.keys()) { try { canvas.releasePointerCapture(id); } catch { /* 離れている */ } }
    pointers.clear();
    ac.abort();
    canvas.style.touchAction = before.touchAction;
    canvas.style.cursor = before.cursor;
  };
}
