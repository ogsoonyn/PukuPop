/**
 * スマホの画面(幅が狭いとき)。3Dビューを全面に出し、ツールは下のバー、設定は下から引き上げるシートにまとめる。
 * 設定の部品(スライダー・レイヤー一覧・膨らませるのパネルなど)は作り直さず、PC の画面から DOM ごとシートへ移す。
 * 移す部品は index.html で data-m-slot の印を付けたもので、どのタブへどの順に移すかは下の MOBILE_SLOTS で決める
 * (PC の画面の並びを変えても、印が付いたままなら移る中身は変わらない)。スマホで出さない部品には d-only を付ける。
 * イベントの結び付けはそのまま残るので、PC とスマホで同じ処理が動く。幅が戻ったら元の場所へ戻す。
 * シートの一番上には左のツールバーの、その場で効く操作を横1列に並べる(作るのは ui/actions.ts)。
 * 下のバーは「つかむ・揺らす・移動・視点」と、編集ツールの枠(膨らみ・ブラシ・消しゴム・ぼかしのうち最後に使ったもの)。
 * 編集しながら角度を確かめられるよう、3Dビューの右下に回すハンドルを置き、どのツールでもそこから視点を回せる。
 */
import { PAINT_TOOLS, type App, type Tool } from '../app';
import { ui } from './ids';
import { icon } from './icons';
import { toolDef } from './tools';
import { setFineLock, isFineLocked, FINE } from './fine';
import { orbitCamera } from '../model/project';
import { setRedrawArmed, onRedrawArmed } from './inflateRedraw';
import { toast } from './dom';

/** スマホの配置にする条件。横向きのスマホ(高さが低く、指で触る)も含める */
export const MOBILE_QUERY = '(max-width: 767px), (max-height: 500px) and (pointer: coarse)';

type SheetState = 'closed' | 'half' | 'full';
/** シートのタブ。PC の右パネルのタブ(レイヤー・アニメーション・画像と表示)と同じ分け方にし、ツールとファイルを足す */
type Tab = 'layer' | 'anim' | 'tool' | 'view' | 'file';

/** シートへ移す部品(data-m-slot の名前)と、移す先のタブ。この順に並べる。prepend はタブの先頭へ入れる */
export const MOBILE_SLOTS: readonly { slot: string; tab: Tab; prepend?: boolean }[] = [
  { slot: 'layers', tab: 'layer', prepend: true },
  { slot: 'layerProps', tab: 'layer' },
  { slot: 'swing', tab: 'layer' },
  { slot: 'effect', tab: 'layer' },
  { slot: 'favorites', tab: 'anim' },
  { slot: 'autoSwing', tab: 'anim' },
  { slot: 'anim', tab: 'anim' },
  { slot: 'image', tab: 'view' },
  { slot: 'viewToggles', tab: 'view' },
  { slot: 'camera', tab: 'view' },
];

/** 下のバーの編集ツールの枠に入るツール(一覧の並び)。ブラシの設定を出すのは塗りの3つだけ */
const EDIT_TOOLS: readonly Tool[] = ['inflate', 'brush', 'erase', 'smooth'];
const BRUSH_TOOLS: Tool[] = ['brush', 'erase', 'smooth'];
/** 編集ツールの枠を長押しして一覧を開くまでの時間(ms) */
const LONG_PRESS = 450;
const TOOL_DESC: Record<Tool, string> = {
  inflate: '画像の上をドラッグして範囲を描くと、ここで高さや断面を決めて適用できます。描いたあとは、範囲は枠で直せ、枠の外を触ると視点が回ります。描き直すときは「描き直す」を押してから描きます。2本目の指を置くと描くのをやめます。',
  grab: 'つかむ: 画像を引っぱって離すと揺れます。',
  shake: '揺らす: 指で振ると、画像は動かずに揺れだけが出ます。',
  view: '視点: 画像の上でも1本指で回転します。',
  pan: '移動: 1本指で画像を動かします。動かした勢いで揺れます。',
  brush: 'ブラシ: なぞった所を持ち上げます。',
  erase: '消しゴム: なぞった所を元に戻します。',
  smooth: 'ぼかし: 塗りの段差をならします。',
};

export function bindMobileLayout(app: App): { readonly active: boolean } {
  const root = document.documentElement;
  const mq = window.matchMedia(MOBILE_QUERY);
  const { mSheet: sheet, mGrip: grip, mNav: nav, mPanes: panes } = ui;
  const pane = (t: Tab) => panes.querySelector<HTMLElement>(`[data-mpane="${t}"]`)!;
  // 印の付いた部品は最初に全部取っておく(足りなければ、スマホの幅になったときではなく起動時に分かる)
  const slotEls = MOBILE_SLOTS.map(s => {
    const el = document.querySelector(`[data-m-slot="${s.slot}"]`);
    if (!el) throw new Error(`スマホのシートへ移す部品 [data-m-slot="${s.slot}"] がありません`);
    return { ...s, el };
  });

  /* ---------- 部品を移す・戻す ---------- */

  /** 移したものと元の場所。戻すときは逆順に戻す */
  let moved: { el: Element; parent: Node; next: Node | null }[] = [];
  const move = (el: Element, to: Element, prepend = false) => {
    if (!el.parentNode) return;
    moved.push({ el, parent: el.parentNode, next: el.nextSibling });
    if (prepend) to.prepend(el); else to.append(el);
  };

  function enter(): void {
    root.classList.add('mobile');
    for (const s of slotEls) move(s.el, pane(s.tab), s.prepend);
    move(ui.inflateDialog, pane('tool'));
    for (const el of document.querySelectorAll('[data-brush-opt]')) move(el, ui.mBrushOpts);
    // 膨らみの、次に描くときの設定(ウェイトの重ね方。範囲ごとの項目は描く前は押せないので style.css で隠す)
    for (const el of document.querySelectorAll('[data-inflate-opt]')) move(el, ui.mInflOpts);
    // 3面図は縦長の画面では狭すぎるので使わない
    if (app.view.multi) app.setViewOption('multi', false);
    syncState(); syncTool();
    setSheet('closed', false);
  }
  function leave(): void {
    for (const m of moved.reverse()) m.parent.insertBefore(m.el, m.next);
    moved = [];
    root.classList.remove('mobile');
    root.style.removeProperty('--m-sheet');
    setFineLock(false); ui.mFine.setAttribute('aria-pressed', 'false');
    closeEditMenu(); setRedrawArmed(false);
  }

  /* ---------- シート ---------- */

  let state: SheetState = 'closed';
  const heights = () => {
    const avail = window.innerHeight - ui.mTop.offsetHeight - ui.mTools.offsetHeight;
    const peek = grip.offsetHeight + nav.offsetHeight + sheet.querySelector<HTMLElement>('.m-tabs')!.offsetHeight;
    return { closed: peek, half: Math.max(peek, Math.round(avail * 0.48)), full: Math.max(peek, avail - 8) };
  };
  /** シートの高さを変える。3Dビューはシートの上に収まるよう縮める(全部のときは半分の高さで止める) */
  function setSheet(s: SheetState, animate = true): void {
    state = s;
    const h = heights();
    sheet.classList.toggle('anim', animate);
    sheet.style.height = `${h[s]}px`;
    sheet.dataset.state = s;
    root.style.setProperty('--m-sheet', `${Math.min(h[s], h.half)}px`);
  }

  {
    let drag: { y: number; h: number; t: number; moved: boolean } | null = null;
    grip.addEventListener('pointerdown', e => {
      drag = { y: e.clientY, h: sheet.offsetHeight, t: performance.now(), moved: false };
      grip.setPointerCapture(e.pointerId);
      sheet.classList.remove('anim');
    });
    grip.addEventListener('pointermove', e => {
      if (!drag) return;
      const dy = e.clientY - drag.y, h = heights();
      if (Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) sheet.style.height = `${Math.max(h.closed, Math.min(h.full, drag.h - dy))}px`;
    });
    const up = (e: PointerEvent) => {
      if (!drag) return;
      const d = drag; drag = null;
      const order: SheetState[] = ['closed', 'half', 'full'];
      if (!d.moved) { setSheet(order[(order.indexOf(state) + 1) % 3]); return; }
      const v = (e.clientY - d.y) / Math.max(1, performance.now() - d.t);
      if (Math.abs(v) > 0.6) { setSheet(order[Math.max(0, Math.min(2, order.indexOf(state) + (v > 0 ? -1 : 1)))]); return; }
      const h = heights(), cur = sheet.offsetHeight;
      setSheet(order.reduce((a, b) => Math.abs(h[a] - cur) <= Math.abs(h[b] - cur) ? a : b));
    };
    grip.addEventListener('pointerup', up);
    // 取り消されたときはタップとみなさず、いちばん近い高さに止める
    grip.addEventListener('pointercancel', () => {
      if (!drag) return;
      drag = null;
      const h = heights(), cur = sheet.offsetHeight, order: SheetState[] = ['closed', 'half', 'full'];
      setSheet(order.reduce((a, b) => Math.abs(h[a] - cur) <= Math.abs(h[b] - cur) ? a : b));
    });
    grip.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSheet(state === 'closed' ? 'half' : state === 'half' ? 'full' : 'closed'); }
    });
  }

  function selectTab(t: Tab): void {
    for (const b of sheet.querySelectorAll<HTMLElement>('[data-mtab]')) b.setAttribute('aria-selected', String(b.dataset.mtab === t));
    for (const p of panes.querySelectorAll<HTMLElement>('[data-mpane]')) p.hidden = p.dataset.mpane !== t;
  }
  for (const b of sheet.querySelectorAll<HTMLElement>('[data-mtab]')) b.addEventListener('click', () => {
    selectTab(b.dataset.mtab as Tab);
    if (state === 'closed') setSheet('half');
  });
  window.addEventListener('resize', () => { if (mq.matches) setSheet(state, false); });
  // 一番上の並びを設定で全部隠す・出すと高さが変わるので、閉じたときに見える高さを決め直す
  new ResizeObserver(() => { if (mq.matches) setSheet(state, false); }).observe(nav);

  /* ---------- 上のバー ---------- */

  ui.mAuto.addEventListener('click', () => app.setAutoSwing(!app.project.autoSwing.enabled));

  /** 自動揺らしのボタンを、今の状態(モデル)に合わせる */
  function syncState(): void {
    ui.mAuto.setAttribute('aria-pressed', String(app.project.autoSwing.enabled));
    ui.mAuto.disabled = !app.activeLayer;
  }
  for (const ev of ['replace', 'layers', 'layer', 'project'] as const) app.store.on(ev, syncState);
  app.on('active', syncState);

  /* ---------- 微調整 ---------- */

  ui.mFine.addEventListener('click', () => {
    const on = ui.mFine.getAttribute('aria-pressed') !== 'true';
    ui.mFine.setAttribute('aria-pressed', String(on));
    setFineLock(on);
  });

  /* ---------- 回すハンドル ---------- */

  // 3Dビューの右下の丸。どのツールを選んでいても、ここからなぞると「視点」と同じように回る(画像の外の1本指と同じ回り方)。
  // 指が丸の外へ出ても、離すまで回し続ける。ダブルタップで視点を戻す。再生は止めない(視点の操作なので、ほかの回転と同じ)
  ui.mOrbit.innerHTML = icon('view');
  {
    let orbit: { id: number; x: number; y: number; t: number; moved: boolean } | null = null;
    let lastTap = 0;
    ui.mOrbit.addEventListener('contextmenu', e => e.preventDefault());
    ui.mOrbit.addEventListener('pointerdown', e => {
      if (orbit || !app.doc) return;
      e.preventDefault();
      ui.mOrbit.setPointerCapture(e.pointerId);
      orbit = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
      ui.mOrbit.classList.add('active');
    });
    ui.mOrbit.addEventListener('pointermove', e => {
      if (!orbit || e.pointerId !== orbit.id) return;
      const f = isFineLocked() ? FINE : 1, dx = (e.clientX - orbit.x) * f, dy = (e.clientY - orbit.y) * f;
      orbit.x = e.clientX; orbit.y = e.clientY;
      if (dx || dy) orbit.moved = true;
      orbitCamera(app.project.camera, dx, dy);
      app.emit('status', undefined);
    });
    const end = (e: PointerEvent) => {
      if (!orbit || e.pointerId !== orbit.id) return;
      const o = orbit; orbit = null;
      ui.mOrbit.classList.remove('active');
      if (e.type !== 'pointerup' || o.moved || performance.now() - o.t > 300) { lastTap = 0; return; }
      const now = performance.now();
      if (now - lastTap < 350) { lastTap = 0; app.resetView(); } else lastTap = now;
    };
    ui.mOrbit.addEventListener('pointerup', end);
    ui.mOrbit.addEventListener('pointercancel', end);
  }

  /* ---------- ツールと編集ツールの枠 ---------- */

  // PC の左のツールボタン(.tool)とは別に結び付ける(同じ data-tool のボタンが2つになるので、クラスは分ける)。
  // アイコンと名前は PC と同じ表(ui/tools.ts・ui/icons.ts)から入れる
  const toolHtml = (t: Tool) => `${icon(t)}<span></span>`;
  const fillTool = (b: HTMLElement, t: Tool) => { b.innerHTML = toolHtml(t); b.querySelector('span')!.textContent = toolDef(t).label; };
  for (const b of ui.mTools.querySelectorAll<HTMLButtonElement>('[data-mtool]')) fillTool(b, b.dataset.mtool as Tool);
  for (const b of ui.mEditMenu.querySelectorAll<HTMLButtonElement>('[data-medit]')) fillTool(b, b.dataset.medit as Tool);
  for (const b of ui.mTools.querySelectorAll<HTMLButtonElement>('[data-mtool]')) b.addEventListener('click', () => { if (!app.previewing) app.setTool(b.dataset.mtool as Tool); });

  /** 編集ツールの枠に入っているツール。最初は膨らみ(既存のファイルに範囲で膨らみを足すのが、スマホでいちばん多い編集のため) */
  let lastEdit: Tool = 'inflate';
  const editMenuOpen = () => !ui.mEditMenu.hidden;
  function openEditMenu(): void {
    ui.mEditMenu.hidden = false;
    ui.mEdit.setAttribute('aria-expanded', 'true');
  }
  function closeEditMenu(): void {
    ui.mEditMenu.hidden = true;
    ui.mEdit.setAttribute('aria-expanded', 'false');
  }
  {
    // 長押しで一覧を開く。開いたあとの click は、枠のツールへの切り替えに使わない
    let timer = 0, longPressed = false;
    const clear = () => { if (timer) { clearTimeout(timer); timer = 0; } };
    ui.mEdit.addEventListener('contextmenu', e => e.preventDefault());
    ui.mEdit.addEventListener('pointerdown', () => {
      longPressed = false; clear();
      if (app.previewing) return;
      timer = window.setTimeout(() => { timer = 0; longPressed = true; openEditMenu(); }, LONG_PRESS);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave'] as const) ui.mEdit.addEventListener(ev, clear);
    ui.mEdit.addEventListener('click', () => {
      if (longPressed) { longPressed = false; return; }
      if (app.previewing) return;
      // 編集ツールを選んでいる間にもう一度押すと、一覧を開く・閉じる
      if (PAINT_TOOLS.includes(app.tool)) { if (editMenuOpen()) closeEditMenu(); else openEditMenu(); }
      else app.setTool(lastEdit);
    });
  }
  for (const b of ui.mEditMenu.querySelectorAll<HTMLButtonElement>('[data-medit]')) b.addEventListener('click', () => {
    closeEditMenu();
    if (!app.previewing) app.setTool(b.dataset.medit as Tool);
  });
  // 一覧の外を触ったら閉じる(枠のボタンは、上の click で開け閉めする)
  document.addEventListener('pointerdown', e => {
    if (editMenuOpen() && !ui.mEditMenu.contains(e.target as Node) && !ui.mEdit.contains(e.target as Node)) closeEditMenu();
  }, true);

  function syncTool(): void {
    for (const b of ui.mTools.querySelectorAll<HTMLButtonElement>('[data-mtool]')) b.setAttribute('aria-pressed', String(b.dataset.mtool === app.tool));
    if (EDIT_TOOLS.includes(app.tool) && app.tool !== lastEdit) { lastEdit = app.tool; fillTool(ui.mEdit, lastEdit); }
    if (!ui.mEdit.querySelector('svg')) fillTool(ui.mEdit, lastEdit);
    ui.mEdit.setAttribute('aria-pressed', String(PAINT_TOOLS.includes(app.tool)));
    for (const b of ui.mEditMenu.querySelectorAll<HTMLButtonElement>('[data-medit]')) b.setAttribute('aria-checked', String(b.dataset.medit === app.tool));
    if (!PAINT_TOOLS.includes(app.tool)) closeEditMenu();
    ui.mToolDesc.textContent = TOOL_DESC[app.tool];
    ui.mBrushOpts.hidden = !BRUSH_TOOLS.includes(app.tool);
    // 描いたあとはパネル(同じタブに出る)で同じ値を変えるので、重ねて出さない
    ui.mInflOpts.hidden = app.tool !== 'inflate' || app.previewingInflate;
  }
  app.on('tool', syncTool);
  app.on('inflate', syncTool);

  /* ---------- 膨らみの描き直し ---------- */

  // スマホでは、プレビュー中に枠の外を触ると視点が回る(ui/input.ts)。描き直すときは、このボタンを押してから描く
  ui.inflRedraw.addEventListener('click', () => {
    const on = ui.inflRedraw.getAttribute('aria-pressed') !== 'true';
    setRedrawArmed(on);
    if (on) toast('画像の上をなぞって、範囲を描き直してください');
  });
  onRedrawArmed(on => ui.inflRedraw.setAttribute('aria-pressed', String(on)));
  app.on('inflate', phase => { if (phase === 'end') setRedrawArmed(false); });

  // 範囲を描いたら、高さや断面を決められるよう「ツール」タブを開く。終わったら元の高さに戻す
  let before: SheetState | null = null;
  app.on('inflate', phase => {
    if (!mq.matches) return;
    if (phase === 'begin') { before = state; selectTab('tool'); if (state === 'closed') setSheet('half'); }
    if (phase === 'end' && before) { setSheet(before); before = null; }
  });

  const apply = () => { if (mq.matches) enter(); else if (root.classList.contains('mobile')) leave(); };
  mq.addEventListener('change', apply);
  apply();
  return { get active() { return mq.matches; } };
}
