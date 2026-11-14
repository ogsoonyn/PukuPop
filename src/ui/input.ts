/**
 * 3Dビュー上のポインタ操作。
 *   右ドラッグ: 回転 / 中ドラッグ・Space+左ドラッグ・「移動」の左ドラッグ: 平行移動 / ホイール: ズーム
 *   (平行移動で画像が画面上を動くと、塗った部分がその勢いで揺れる。physics/world.ts)
 *   左ドラッグ: 選択中のツール(ブラシ中に Alt で一時的に消しゴム。膨らませるでは範囲を描き、Shift で正円・正方形)
 *   「揺らす」の左ドラッグ: カメラを画像に付けたまま振る。画面上は動かず、平行移動と同じ揺れだけが出る
 *   Ctrl(⌘)か Shift を押している間は、回転・平行移動・ズーム・つかむ・揺らすの動きを 1/5 にする(ui/fine.ts)
 *   揺らし方「ピストン」で画像全体が動いている間は、塗り・膨らませる範囲のドラッグ中だけ画像を止め(app.holdImage)、
 *   止まっているポインタの下のブラシの円は毎フレーム当て直す
 * 指(タッチ)では、1本指は選択中のツール(画像の外では回転)、2本指は平行移動とピンチでズーム。
 *   2本目の指を置くと、1本目で始めた塗り・範囲・つかむは取り消す。2本指タップで戻す、3本指タップでやり直す、
 *   画像の外のダブルタップで視点を戻す
 */
import type { App } from '../app';
import type { PaintMode } from '../paint/stroke';
import { fineFactor, wheelFineFactor, wheelDelta, isPinchWheel, FINE, isFineLocked } from './fine';
import { smoothZoom } from './smoothZoom';
import { toast } from './dom';
import { wrapAngle as wrapRad } from '../model/project';
import { hitFrame, frameCursor, setRotSide, type FrameHit } from './inflateFrame';
import { moveArea as shiftArea, resizeArea, roundArea, turnBetween, flippedAt, wrapAngle, type Area } from '../paint/areaEdit';

/** 主ビューの拡大率の範囲(ホイール・ピンチ共通) */
const ZOOM_MIN = 0.05, ZOOM_MAX = 10;
const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
/** 2本指のひねりで傾け始める角度(15°)と、0° に吸い付く範囲(3°) */
const TWIST_START = Math.PI / 12, ROLL_SNAP = Math.PI / 60;
/** Alt+ドラッグで傾けるとき、画面の中央からこれより近い所(px)は使わない */
const ROLL_DEAD = 12;

type DragMode = 'orbit' | 'roll' | 'pan' | 'shake' | 'grab' | 'paint' | 'area' | 'frame' | null;

export function bindStageInput(app: App, canvas: HTMLCanvasElement): { isSpaceDown: () => boolean } {
  /** gx, gy: つかんだまま動かした量(px、Ctrl・Shift で細かくした分を含む) */
  const drag = { mode: null as DragMode, id: -1, lx: 0, ly: 0, sx: 0, sy: 0, gx: 0, gy: 0 };
  /** 膨らませる範囲を描き始めた点(元画像のローカル座標) */
  let areaStart: { x: number; y: number } | null = null;
  /** 膨らませるの枠のハンドルで範囲を直している間の、掴んだもの・掴んだ点(元画像のローカル座標)・掴んだときの範囲と角度 */
  /** 回すときは、前の点(prev)と、掴んでから回した量(turn、度、回り込む前)も持つ */
  let frameDrag: { hit: FrameHit; start: { x: number; y: number }; area: Area; angle: number; cursor: string; prev: { x: number; y: number }; turn: number } | null = null;
  let space = false, alt = false, hover: { x: number; y: number; inside: boolean } | null = null;
  /** ポインタがキャンバスの上にあるか。Space の平行移動はフォーカスの場所ではなくこれで決める */
  let pointerInside = false;
  /** 最後のポインタの位置(画像が動いたときに当て直す)と、前のフレームで画像がずれていたか */
  let last: { x: number; y: number } | null = null, shifted = false;

  const isPaintTool = () => app.tool === 'brush' || app.tool === 'erase' || app.tool === 'smooth';
  const paintMode = (): PaintMode => (app.tool === 'brush' && alt ? 'erase' : (app.tool as PaintMode));
  const pressureOf = (e: PointerEvent) => (e.pointerType === 'pen' ? Math.max(0.05, e.pressure || 0) : 1);

  const updateCursor = () => {
    const showBrush = isPaintTool() && !space && (drag.mode === null || drag.mode === 'paint');
    app.stage.setBrush(showBrush ? hover : null, app.brush.size / 2);
    canvas.style.cursor = space || drag.mode === 'pan' ? 'move'
      : drag.mode === 'orbit' || drag.mode === 'roll' ? 'grabbing'
      : app.tool === 'grab' || app.tool === 'shake' ? (drag.mode === 'grab' || drag.mode === 'shake' ? 'grabbing' : 'grab')
      // ブラシの円は画像の上にしか描けないので、画像の外では十字のカーソルを出して見失わないようにする
      : app.tool === 'view' || app.tool === 'pan' ? 'move' : showBrush && hover?.inside ? 'none' : frameHover() ?? 'crosshair';
  };
  /** 膨らませるのプレビュー中に、ポインタの下の枠のハンドルに合わせたカーソル(枠の外なら null) */
  function frameHover(): string | null {
    if (frameDrag) return frameDrag.cursor;
    if (app.tool !== 'inflate' || !app.previewingInflate || drag.mode || !last) return null;
    const hit = hitFrame(app, last.x, last.y, false);
    return hit ? frameCursor(app, hit, false) : null;
  }
  app.on('tool', updateCursor);

  canvas.addEventListener('contextmenu', e => e.preventDefault());

  /* ---------- 指(タッチ)の操作 ---------- */
  const touches = new Map<number, { x: number; y: number }>();
  /**
   * 2本以上の指を置いている間の、指の中心と間隔と、最初の2本を結ぶ向き(a)。
   * ひねり(傾き)は、ピンチや平行移動のつもりで少し回ったくらいでは傾かないよう、ひねった量(twist)が TWIST_START を越えてから効かせる。
   * 効かせ始めたら(rolling)、傾きを続けた値(raw)で持ち、0° の近く(ROLL_SNAP)では 0° に吸い付ける
   */
  let gesture: { x: number; y: number; d: number; a: number; twist: number; rolling: boolean; raw: number } | null = null;
  const newGesture = () => ({ ...touchCenter(), d: touchSpread(), a: touchAngle(), twist: 0, rolling: false, raw: 0 });
  /** 触り始めてから全部の指を離すまでの記録(タップの判定に使う) */
  let tap: { t: number; n: number; moved: number; x: number; y: number; orbit: boolean } | null = null;
  /** 指ごとの置いた位置(タップかどうかは、それぞれの指が置いた所からどれだけ動いたかで決める) */
  const touchStart = new Map<number, { x: number; y: number }>();
  let lastTap: { t: number; x: number; y: number } | null = null;
  /** このドラッグで膨らませるのプレビューを始めたか(2本目の指で取り消すときは、始めたプレビューごと捨てる) */
  let areaBegan = false;
  /** プレビュー中の範囲を描き直し始めたときの範囲(2本目の指で描き直しをやめたら、これに戻す) */
  let areaBefore: { x: number; y: number; w: number; h: number } | null = null;
  const touchCenter = () => {
    let x = 0, y = 0;
    for (const p of touches.values()) { x += p.x; y += p.y; }
    return { x: x / touches.size, y: y / touches.size };
  };
  const touchSpread = () => {
    const [a, b] = [...touches.values()];
    return a && b ? Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) : 1;
  };
  const touchAngle = () => {
    const [a, b] = [...touches.values()];
    return a && b ? Math.atan2(b.y - a.y, b.x - a.x) : 0;
  };
  /** 1本指で始めた操作をやめる(塗りと範囲は無かったことにする) */
  function cancelDrag(): void {
    if (drag.mode === 'paint') { app.cancelStroke(); app.holdImage(false); }
    else if (drag.mode === 'area') {
      areaStart = null; app.holdImage(false);
      if (areaBegan && app.previewingInflate) app.endInflate(false);
      else if (areaBefore && app.previewingInflate) app.updateInflate({ area: areaBefore });
    } else if (drag.mode === 'frame') {
      // 枠で直している途中なら、掴む前の範囲と角度に戻す
      const f = frameDrag; frameDrag = null; app.holdImage(false);
      if (f && app.previewingInflate) app.updateInflate({ area: f.area, settings: { angle: f.angle } });
    } else if (drag.mode === 'grab') { app.world.grab = null; app.world.grabGains.clear(); }
    else if (drag.mode === 'orbit' || drag.mode === 'roll' || drag.mode === 'pan') app.cameraChanged();
    drag.mode = null; drag.id = -1;
  }
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    // 新しく触り始めた(最初の指)ときは、離した所がキャンバスの外で届かなかった指の記録を捨てる
    if (e.isPrimary) { touches.clear(); touchStart.clear(); gesture = null; tap = null; }
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    touchStart.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = performance.now();
    if (!tap) tap = { t: now, n: 0, moved: 0, x: e.clientX, y: e.clientY, orbit: false };
    tap.n = Math.max(tap.n, touches.size);
    if (touches.size < 2) return;
    // 2本目からは視点の操作にする。下の(1本指の)処理には渡さない
    e.stopImmediatePropagation();
    canvas.setPointerCapture(e.pointerId);
    if (drag.mode) cancelDrag();
    gesture = newGesture();
    updateCursor();
  });
  canvas.addEventListener('pointermove', e => {
    const t = touches.get(e.pointerId); if (!t) return;
    t.x = e.clientX; t.y = e.clientY;
    const s0 = touchStart.get(e.pointerId);
    if (tap && s0) tap.moved = Math.max(tap.moved, Math.hypot(e.clientX - s0.x, e.clientY - s0.y));
    if (!gesture || touches.size < 2) return;
    e.stopImmediatePropagation();
    const c = touchCenter(), d = touchSpread(), f = isFineLocked() ? FINE : 1;
    const dx = (c.x - gesture.x) * f, dy = (c.y - gesture.y) * f;
    const cam = app.project.camera, k = app.stage.pixelToWorld(cam), { right, up } = app.stage.screenAxes();
    // 平行移動は中ドラッグと同じ(画像が画面上を動くので、その勢いで揺れる)
    cam.target.x += -dx * k * right.x + dy * k * up.x;
    cam.target.y += -dx * k * right.y + dy * k * up.y;
    cam.target.z += -dx * k * right.z + dy * k * up.z;
    // 指を広げると近づく(zoom は小さいほど大きく見える)
    cam.zoom = clampZoom(cam.zoom * Math.pow(gesture.d / d, f));
    // ひねると傾く(画面の y は下向きなので、時計回りにひねると角度が増え、画像も時計回りに傾く)
    const a = touchAngle(), da = wrapRad(a - gesture.a);
    if (!gesture.rolling) {
      gesture.twist += da;
      if (Math.abs(gesture.twist) > TWIST_START) {
        // 越えた分だけ傾ける(しきい値の分で跳ばないように)
        gesture.rolling = true;
        gesture.raw = cam.roll + (gesture.twist - Math.sign(gesture.twist) * TWIST_START) * f;
      }
    } else gesture.raw += da * f;
    if (gesture.rolling) cam.roll = Math.abs(wrapRad(gesture.raw)) < ROLL_SNAP ? 0 : wrapRad(gesture.raw);
    gesture.x = c.x; gesture.y = c.y; gesture.d = d; gesture.a = a;
    app.emit('status', undefined);
  });
  const touchEnd = (e: PointerEvent) => {
    touchStart.delete(e.pointerId);
    if (!touches.delete(e.pointerId)) return;
    if (gesture) {
      if (touches.size >= 2) gesture = newGesture();
      else { gesture = null; app.cameraChanged(); }
    }
    if (touches.size > 0 || !tap) return;
    const t = tap; tap = null;
    const quick = performance.now() - t.t < 300;
    if (t.n >= 2) {
      // 全体ぼかし・膨らませるのプレビュー中は、プレビュー中のウェイトに履歴を書き戻さないよう止める
      if (!quick || t.moved > 16 || app.stroking || app.previewing) return;
      if (t.n === 2 ? app.history.undo() : app.history.redo()) toast(t.n === 2 ? '元に戻しました' : 'やり直しました');
      return;
    }
    // 画像の外のダブルタップで視点を戻す
    if (!t.orbit || !quick || t.moved > 10) { lastTap = null; return; }
    const now = performance.now();
    if (lastTap && now - lastTap.t < 350 && Math.hypot(lastTap.x - t.x, lastTap.y - t.y) < 32) { lastTap = null; app.resetView(); }
    else lastTap = { t: now, x: t.x, y: t.y };
  };

  canvas.addEventListener('pointerdown', e => {
    // 指では、画像の外をなぞると回転する(右ドラッグの代わり)。ループ再生中は動いている画像で決める
    // 膨らませるの枠のハンドル(大きさ・回す)は、画像の外にはみ出していても掴めるようにする(枠の中を触るのは、画像の外なら今までどおり回転)
    const outside = e.pointerType === 'touch' && app.tool !== 'pan' && !app.stage.pick(e.clientX, e.clientY)?.inside
      && !(app.tool === 'inflate' && app.previewingInflate && (hitFrame(app, e.clientX, e.clientY, true)?.kind ?? 'move') !== 'move');
    const orbit = e.button === 2 || (e.button === 0 && (app.tool === 'view' || outside) && !space);
    const pan = !orbit && (e.button === 1 || (e.button === 0 && (space || app.tool === 'pan')));
    // ループ再生中に画面を触ったら、再生をやめて手の操作を優先する。視点の操作(回転・平行移動)は再生したまま動かせる
    if (!orbit && !pan) app.stopTake();
    if (drag.mode || !app.doc) return;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(e.pointerId);
    drag.id = e.pointerId; drag.lx = drag.sx = e.clientX; drag.ly = drag.sy = e.clientY;
    alt = e.altKey;
    // Alt を押しながらの回転(右ドラッグ、「視点」ツールの左ドラッグ)は、画面の中央のまわりに円を描くように傾ける
    if (orbit) drag.mode = e.altKey && e.pointerType !== 'touch' ? 'roll' : 'orbit';
    else if (pan) { drag.mode = 'pan'; e.preventDefault(); }
    // 振る向きは主ビューの画面の向きで決まるので、主ビューの中から始めたときだけ振る
    else if (e.button === 0 && app.tool === 'shake') { if (app.stage.inMainView(e.clientX, e.clientY)) drag.mode = 'shake'; }
    else if (e.button === 0 && app.tool === 'grab') startGrab(e);
    else if (e.button === 0 && app.tool === 'inflate') startArea(e);
    else if (e.button === 0 && isPaintTool()) {
      const p = app.stage.pick(e.clientX, e.clientY);
      if (p && app.beginStroke(paintMode(), p.x, p.y, pressureOf(e))) { drag.mode = 'paint'; app.holdImage(true); }
    }
    // 画像の外のダブルタップで視点を戻すのに使う(「移動」では画像の外も平行移動だが、ダブルタップは同じく効かせる)
    if (tap && e.pointerType === 'touch') tap.orbit = drag.mode === 'orbit' || (app.tool === 'pan' && !app.stage.pick(e.clientX, e.clientY)?.inside);
    updateCursor();
  });

  // 画像全体が動いている間(ピストン)は、ポインタが止まっていても、その下の画像の位置でブラシの円を描き直す
  app.on('frame', () => {
    const now = app.imageShifted;
    if ((now || shifted) && pointerInside && last && !drag.mode) {
      const p = app.stage.pick(last.x, last.y);
      hover = p ? { x: p.x, y: p.y, inside: p.inside } : null;
      updateCursor();
    }
    shifted = now;
  });

  canvas.addEventListener('pointermove', e => {
    const p = app.stage.pick(e.clientX, e.clientY);
    hover = p ? { x: p.x, y: p.y, inside: p.inside } : null;
    last = { x: e.clientX, y: e.clientY };
    if (drag.mode && e.pointerId === drag.id) {
      // 回転・平行移動・揺らす・つかむは、Ctrl か Shift を押している間だけ細かく動かす(押し直しても跳ばない)
      const f = fineFactor(e), dx = (e.clientX - drag.lx) * f, dy = (e.clientY - drag.ly) * f, px = drag.lx, py = drag.ly;
      drag.lx = e.clientX; drag.ly = e.clientY;
      const cam = app.project.camera;
      if (drag.mode === 'orbit') {
        // 傾けているときも画面の向きどおりに回るよう、ドラッグの向きを傾きの分だけ戻してから向きに入れる
        const c = Math.cos(cam.roll), s = Math.sin(cam.roll), ox = dx * c + dy * s, oy = dy * c - dx * s;
        cam.yaw -= ox * 0.008;
        cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + oy * 0.008));
      } else if (drag.mode === 'roll') {
        // 主ビューの中央(注視点)から見た向きの変わり分だけ傾ける。中央のすぐ近くは向きが暴れるので使わない
        const r = canvas.getBoundingClientRect(), m = app.stage.mainView(), cx = r.left + m.x + m.w / 2, cy = r.top + m.y + m.h / 2;
        if (Math.hypot(px - cx, py - cy) > ROLL_DEAD && Math.hypot(e.clientX - cx, e.clientY - cy) > ROLL_DEAD) {
          cam.roll = wrapRad(cam.roll + wrapRad(Math.atan2(e.clientY - cy, e.clientX - cx) - Math.atan2(py - cy, px - cx)) * f);
        }
      } else if (drag.mode === 'pan' || drag.mode === 'shake') {
        // 「揺らす」はカメラを画像に付けたまま振る。画面上の位置は変えず、物理にだけ平行移動と同じ動きを伝える
        const k = app.stage.pixelToWorld(cam), { right, up } = app.stage.screenAxes();
        const t = drag.mode === 'pan' ? cam.target : app.shake;
        t.x += -dx * k * right.x + dy * k * up.x;
        t.y += -dx * k * right.y + dy * k * up.y;
        t.z += -dx * k * right.z + dy * k * up.z;
      } else if (drag.mode === 'grab') {
        drag.gx += dx; drag.gy += dy;
        moveGrab();
      } else if (drag.mode === 'area') {
        moveArea(e);
      } else if (drag.mode === 'frame') {
        moveFrame(e);
      } else if (drag.mode === 'paint') {
        // 速い動きでも線が途切れないよう、まとめられたイベントも使う
        const events = e.getCoalescedEvents?.() ?? [e];
        for (const ce of events.length ? events : [e]) {
          const q = app.stage.pick(ce.clientX, ce.clientY);
          if (q) app.strokeTo(q.x, q.y, pressureOf(ce));
        }
      }
    }
    updateCursor();
  });

  const end = (e: PointerEvent) => {
    if (e.pointerId !== drag.id) return;
    if (drag.mode === 'paint') app.endStroke();
    if (drag.mode === 'grab') { app.world.grab = null; app.world.grabGains.clear(); }
    if (drag.mode === 'area') areaStart = null;
    if (drag.mode === 'frame') frameDrag = null;
    if (drag.mode === 'paint' || drag.mode === 'area' || drag.mode === 'frame') app.holdImage(false);
    if ((drag.mode === 'orbit' || drag.mode === 'roll' || drag.mode === 'pan') && (e.clientX !== drag.sx || e.clientY !== drag.sy)) app.cameraChanged();
    drag.mode = null; drag.id = -1;
    updateCursor();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerup', touchEnd);
  canvas.addEventListener('pointercancel', touchEnd);
  canvas.addEventListener('lostpointercapture', end); // pointerup が来ないまま捕捉が外れても、ドラッグ(と止めた画像)を終える
  canvas.addEventListener('pointerenter', () => { pointerInside = true; });
  canvas.addEventListener('pointerleave', () => { pointerInside = false; hover = null; last = null; updateCursor(); });

  // ホイールのズームは目標へなめらかに寄せる(ui/smoothZoom.ts)。タッチパッドのピンチは細かく続けて来るので、その場で変える
  const setZoom = (z: number) => {
    app.project.camera.zoom = z;
    app.emit('status', undefined);
    app.cameraChanged();
  };
  const wheelZoom = smoothZoom({ get: () => app.project.camera.zoom, set: setZoom, owner: () => app.project.camera, min: ZOOM_MIN, max: ZOOM_MAX });
  // ズームはループ再生中でも止めない(見る視点だけを動かす)
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const d = wheelDelta(e) * 0.0012 * wheelFineFactor(e);
    if (isPinchWheel(e)) setZoom(clampZoom(app.project.camera.zoom * Math.exp(d)));
    else wheelZoom.add(d);
  }, { passive: false });

  function startGrab(e: PointerEvent): void {
    const doc = app.doc!, p = app.stage.pick(e.clientX, e.clientY);
    // つかんだ位置のウェイトが大きいレイヤーほど強く引っ張る。どこにも塗りが無ければ全レイヤー
    const gains = new Map<string, number>();
    let max = 0;
    for (const l of doc.layers) {
      const w = p && p.inside ? l.weights.sampleUV(p.u, p.v) : 0;
      gains.set(l.id, w); max = Math.max(max, w);
    }
    for (const [id, w] of gains) gains.set(id, max < 0.05 ? 1 : Math.max(0.15, w / max));
    app.world.grabGains = gains;
    app.world.grab = { x: 0, y: 0, z: 0 };
    drag.gx = drag.gy = 0;
    drag.mode = 'grab';
  }

  function moveGrab(): void {
    const cam = app.project.camera, k = app.stage.pixelToWorld(cam), { right, up } = app.stage.screenAxes();
    const dx = drag.gx * k, dy = -drag.gy * k, norm = 2 / app.imageLong;
    app.world.grab = {
      x: (right.x * dx + up.x * dy) * norm,
      y: (right.y * dx + up.y * dy) * norm,
      z: (right.z * dx + up.z * dy) * norm,
    };
  }

  /**
   * 膨らませる: ドラッグした矩形(Shift で正方形)に収まる楕円・矩形を描く。
   * プレビュー中は、枠のハンドル・枠の中を掴むと範囲を直し(ui/inflateFrame.ts)、枠の外なら描き直す
   */
  function startArea(e: PointerEvent): void {
    const p = app.stage.pick(e.clientX, e.clientY);
    if (!p) return;
    const s = app.inflateState, hit = s ? hitFrame(app, e.clientX, e.clientY, e.pointerType === 'touch') : null;
    if (s && hit) {
      frameDrag = { hit, start: { x: p.x, y: p.y }, area: { ...s.area }, angle: s.settings.angle, cursor: frameCursor(app, hit, true), prev: { x: p.x, y: p.y }, turn: 0 };
      drag.mode = 'frame';
      app.holdImage(true);
      return;
    }
    areaStart = { x: p.x, y: p.y };
    areaBegan = false;
    const prev = app.inflateState?.area;
    areaBefore = prev ? { x: prev.x, y: prev.y, w: prev.w, h: prev.h } : null;
    drag.mode = 'area';
    app.holdImage(true);
  }

  // Esc などでプレビューが終わったら、描いている途中の範囲も捨てる(次に動かしたときに始め直さない)
  app.on('inflate', phase => {
    if (phase === 'end' && (drag.mode === 'area' || drag.mode === 'frame')) { drag.mode = null; areaStart = null; frameDrag = null; app.holdImage(false); }
    // パネルで大きさや角度を変えて枠がポインタの下へ来た・離れたときも、カーソルを合わせ直す
    updateCursor();
  });
  // 枠を直している途中の Esc は、そのドラッグだけをやめて掴む前に戻す(プレビューは残す。パネルの Esc より先に受ける)
  window.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || drag.mode !== 'frame') return;
    e.preventDefault(); e.stopImmediatePropagation();
    cancelDrag(); updateCursor();
  }, true);

  /** 枠のハンドルで範囲を直す。大きさは Shift で縦横比を保ち、Alt で中心を止める。回すときは Shift で 15° ごと */
  function moveFrame(e: PointerEvent): void {
    const f = frameDrag, p = app.stage.pick(e.clientX, e.clientY);
    if (!f || !p || !app.previewingInflate) return;
    if (f.hit.kind === 'rotate') {
      // 回した量を足していき、回り込む前の角度で、回す丸を付ける辺(形の上か下か)を決める
      f.turn += turnBetween(f.area, f.prev, p); f.prev = { x: p.x, y: p.y };
      let raw = f.angle + f.turn;
      if (e.shiftKey) raw = Math.round(raw / 15) * 15;
      const angle = wrapAngle(Math.round(raw));
      setRotSide(flippedAt(raw) ? -1 : 1, angle);
      app.updateInflate({ settings: { angle } });
    }
    else if (f.hit.kind === 'move') app.updateInflate({ area: shiftArea(f.area, f.start, p) });
    else {
      const fromCenter = e.altKey || alt, h = f.hit.handle;
      app.updateInflate({ area: roundArea(resizeArea(f.area, f.angle, h, f.start, p, { keepAspect: e.shiftKey, fromCenter }), f.angle, h, fromCenter) });
    }
  }

  function moveArea(e: PointerEvent): void {
    const p = app.stage.pick(e.clientX, e.clientY);
    if (!p || !areaStart) return;
    const dx = p.x - areaStart.x, dy = p.y - areaStart.y;
    // 形を傾けているときは、始点と今の点を傾いた形の対角の角にする(画像の座標は y が上向きなので、時計回りは -θ)
    const st = app.inflateState?.settings ?? app.inflateSettings, t = st.angle * Math.PI / 180, c = Math.cos(t), n = Math.sin(t);
    const lu = dx * c - dy * n, lv = dx * n + dy * c;
    let w = Math.abs(lu), h = Math.abs(lv);
    if (e.shiftKey) w = h = Math.max(w, h);
    if (w < 2 || h < 2) return;
    const hu = Math.sign(lu || 1) * w / 2, hv = Math.sign(lv || 1) * h / 2;
    const area = { x: areaStart.x + hu * c + hv * n, y: areaStart.y - hu * n + hv * c, w: Math.round(w), h: Math.round(h) };
    if (app.previewingInflate) app.updateInflate({ area });
    else if (app.beginInflateArea(area)) areaBegan = true;
    else { drag.mode = null; areaStart = null; app.holdImage(false); }
  }

  window.addEventListener('keydown', e => {
    if (e.key === 'Alt') { alt = true; e.preventDefault(); }
    // ボタンなどにフォーカスが残っていても、ポインタがキャンバス上にあれば平行移動にする。
    // キャンバスの外では Space をボタンの押下などに使えるよう、横取りしない
    // 画面を覆うダイアログの表示中は、ボタンなどを Space で押せるよう横取りしない(膨らませるのパネルは除く)
    const dialogOpen = !!document.querySelector('dialog[open]:modal');
    if (e.code === 'Space' && !isTextEntry(e) && !dialogOpen && (space || pointerInside || drag.mode !== null || e.target === canvas || e.target === document.body)) {
      if (!space) { space = true; updateCursor(); }
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', e => {
    if (e.key === 'Alt') { alt = false; e.preventDefault(); }
    if (e.code === 'Space' && space) {
      space = false; updateCursor();
      e.preventDefault(); // フォーカス中のボタンが Space の離しで押されないようにする
    }
  });
  window.addEventListener('blur', () => { space = false; alt = false; });

  return { isSpaceDown: () => space };
}

/** 文字を打つ欄(テキスト・数値の入力欄など)にいるか。Space をキャンバスの平行移動に使うかの判定に使う */
function isTextEntry(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.matches('textarea, input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=color]):not([type=button]):not([type=submit]):not([type=file])') || t.isContentEditable);
}

export function isTyping(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.matches('input:not([type=range]):not([type=checkbox]):not([type=radio]), select, textarea') || t.isContentEditable);
}
