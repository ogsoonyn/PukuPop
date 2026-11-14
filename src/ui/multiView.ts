/**
 * 3面図(正面・右から・下から・自由角度)。キャンバスは画面全体に敷いたまま、
 * 右側に並べたセルの位置を Stage へ渡して、その矩形に別のカメラで描かせる。
 * 正面・右から・下からの拡大率と平行移動は画面だけの設定で、保存も「未保存」の印も付けない。
 * 自由角度の視点はプロジェクトに保存するので、主ビューの視点と同じく動かすと「未保存」になる。
 * どちらもアンドゥには積まない。
 * 主ビューの平行移動と違って揺れの計算にも渡さない。
 */
import type { App } from '../app';
import { defaultMultiCamera, defaultOrthoView } from '../model/project';
import { ORTHO_ZOOM, type SubViewKind, type ViewRect } from '../stage/stage';
import { ui } from './ids';
import { fineFactor, wheelFineFactor, wheelDelta, isPinchWheel } from './fine';
import { smoothZoom } from './smoothZoom';

export function bindMultiView(app: App, canvas: HTMLCanvasElement): { layout: () => void } {
  const panel = ui.multiView;
  const cells = [...panel.querySelectorAll<HTMLElement>('.mv-cell')];

  function layout(): void {
    // UIを隠している間は、主ビューを画面いっぱいに出す
    const on = app.view.multi && !app.uiHidden;
    panel.classList.toggle('hidden', !on);
    panel.classList.toggle('flex', on);
    if (!on) { app.stage.setLayout(null, []); return; }
    const c = canvas.getBoundingClientRect(), p = panel.getBoundingClientRect();
    const rel = (r: DOMRect): ViewRect => ({ x: Math.round(r.left - c.left), y: Math.round(r.top - c.top), w: Math.round(r.width), h: Math.round(r.height) });
    app.stage.setLayout(
      { x: 0, y: 0, w: Math.max(1, Math.round(p.left - c.left)), h: Math.round(c.height) },
      cells.map(el => ({ kind: el.dataset.kind as SubViewKind, rect: rel(el.getBoundingClientRect()) })),
    );
  }

  app.on('view', layout);
  new ResizeObserver(layout).observe(panel);

  for (const el of cells) el.addEventListener('contextmenu', e => e.preventDefault());

  /**
   * セルの上のドラッグ。どのボタンで何をするかは modeOf が決め、null なら受け付けない。
   * アンドゥには積まない(自由角度だけは move の中で「未保存」にする)
   */
  /** modeOf に渡すため、ポインタのイベントからボタンと修飾キーだけを写す */
  const pick = (e: PointerEvent) => ({ button: e.button, buttons: e.buttons, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey });

  function bindDrag<M extends string>(el: HTMLElement, modeOf: (e: PointerEvent) => M | null, cursor: (m: M) => string,
    move: (m: M, dx: number, dy: number) => void): void {
    // shift: Shift を押して始めたドラッグ。Shift で操作が変わるセル(自由角度の Shift+左 = 平行移動)では、細かくする意味に取らない
    let drag: { id: number; x: number; y: number; mode: M; shift: boolean } | null = null;
    el.addEventListener('pointerdown', e => {
      if (drag) return;
      const mode = modeOf(e);
      if (!mode) return;
      e.preventDefault(); // 中ボタンでの自動スクロールや文字の選択を始めない
      // preventDefault でフォーカスが移らないので、入力欄に残ったフォーカスを外す(ショートカットが効くように)
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body) active.blur();
      el.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, mode, shift: e.shiftKey && modeOf({ ...pick(e), shiftKey: false } as PointerEvent) !== mode };
      el.style.cursor = cursor(mode);
    });
    el.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      // Ctrl か Shift を押している間は細かく動かす
      const f = fineFactor(e, !drag.shift);
      move(drag.mode, (e.clientX - drag.x) * f, (e.clientY - drag.y) * f);
      drag.x = e.clientX; drag.y = e.clientY;
    });
    const end = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      el.style.cursor = '';
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end); // ドラッグ中にセルが隠れたときも終える
  }

  // 自由角度: 左・右ドラッグで回転、中ドラッグ・Shift+左ドラッグで平行移動、ホイールでズーム、ダブルクリックで戻す。
  // Ctrl(⌘)で細かく動かす(Shift+左は平行移動なので、そのときの Shift は細かくする意味に取らない)
  const free = cells.find(el => el.dataset.kind === 'free')!;
  bindDrag(free,
    e => (e.button === 1 || (e.button === 0 && e.shiftKey) ? 'pan' : e.button === 0 || e.button === 2 ? 'orbit' : null),
    m => (m === 'pan' ? 'move' : 'grabbing'),
    (m, dx, dy) => {
      const cam = app.multiCam;
      if (m === 'pan') { app.stage.panFree(cam, dx, dy); return; }
      cam.yaw -= dx * 0.01;
      cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + dy * 0.01));
    });
  free.addEventListener('dblclick', () => { app.multiCam = defaultMultiCamera(); });
  // ホイールのズームは、主ビューと同じく目標へなめらかに寄せる(ui/smoothZoom.ts)。タッチパッドのピンチはその場で変える
  const setFreeZoom = (z: number) => { app.multiCam.zoom = z; };
  const freeZoom = smoothZoom({ get: () => app.multiCam.zoom, set: setFreeZoom, owner: () => app.multiCam, min: 0.2, max: 10 });
  free.addEventListener('wheel', e => {
    e.preventDefault();
    const d = wheelDelta(e) * 0.0012 * wheelFineFactor(e);
    if (isPinchWheel(e)) setFreeZoom(Math.max(0.2, Math.min(10, app.multiCam.zoom * Math.exp(d))));
    else freeZoom.add(d);
  }, { passive: false });

  // 正面・右から・下から: ドラッグで平行移動、ホイールでポインタの位置を中心にズーム、ダブルクリックで戻す。
  // 拡大率と平行移動は3つの図で共有する(縮尺と位置の対応がそろったままになる)。
  // ズームはなめらかに寄せ(タッチパッドのピンチはその場で変える)、寄せる途中も最後にホイールを回した図とポインタの位置を中心にする
  let orthoAt: { kind: Exclude<SubViewKind, 'free'>; x: number; y: number } = { kind: 'front', x: 0, y: 0 };
  const orthoZoom = smoothZoom({
    get: () => app.multiOrtho.zoom,
    set: (_z, factor) => app.stage.zoomOrtho(app.multiOrtho, orthoAt.kind, factor, orthoAt.x, orthoAt.y),
    owner: () => app.multiOrtho,
    min: ORTHO_ZOOM.min, max: ORTHO_ZOOM.max,
  });
  for (const el of cells) {
    if (el === free) continue;
    const kind = el.dataset.kind as Exclude<SubViewKind, 'free'>;
    bindDrag(el, e => (e.button === 0 || e.button === 1 ? 'pan' : null), () => 'move',
      (_m, dx, dy) => app.stage.panOrtho(app.multiOrtho, kind, dx, dy));
    el.addEventListener('dblclick', () => { app.multiOrtho = defaultOrthoView(); });
    // 他のセルの上と同じく、ホイールで主ビューがズームしないよう既定の動作を止める
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      orthoAt = { kind, x: e.clientX - (r.left + r.width / 2), y: e.clientY - (r.top + r.height / 2) };
      const d = -wheelDelta(e) * 0.0012 * wheelFineFactor(e);
      if (isPinchWheel(e)) app.stage.zoomOrtho(app.multiOrtho, kind, Math.exp(d), orthoAt.x, orthoAt.y);
      else orthoZoom.add(d);
    }, { passive: false });
  }

  return { layout };
}
