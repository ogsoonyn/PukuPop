/**
 * 「膨らませる」のプレビュー中に、範囲の枠とハンドルを3Dビュー(主ビュー)に SVG で重ねる。
 * 枠は膨らむ前の平らな画像の面に描くので、視点を回すと台形に見える。楕円のときは楕円の輪郭も重ねる。
 *   辺・角の8点: 大きさ(反対側を止める。Shift で縦横比を保つ、Alt で中心を止める)
 *   枠の中: 移動 / 枠の上の丸: 回す(Shift で 15° ごと) / 枠の外: 範囲を描き直す(ui/input.ts)
 *   「四隅を動かす」の間は、角の4点は大きさでなく、その角だけを動かす(形を崩す。丸い点で見分ける)
 * 崩した形(四隅を動かした・角を丸めた・辺をふくらませた)は、枠を崩した四角で描き、形の輪郭を点線で重ねる。
 * ポインタの操作は ui/input.ts が受け、どこを掴んだかをここの hitFrame で決める。重ね表示自体はポインタを通す。
 * 枠が画面上で小さいときは、辺のハンドルを隠し、角の当たりも小さくして、枠の中を掴んで動かせるようにする。
 */
import type { App } from '../app';
import { HANDLES, areaPoint, type Handle } from '../paint/areaEdit';
import { fromSquare, isFlatWarp, warpCorners } from '../paint/shapeWarp';
import { ui } from './ids';

type Pt = { x: number; y: number };

const NS = 'http://www.w3.org/2000/svg';
/** ハンドルの当たりの半径(px)。マウス・ペンと指 */
const HIT = 10, HIT_TOUCH = 22;
/** 回すハンドルを枠の上の辺から離す距離(px) */
const ROT_GAP = 28;
/** 枠の短い辺がこれより短い(px)ときは、辺のハンドルを出さない。指では当たりが大きいので、中を掴む所が残るよう長めにする */
const EDGE_MIN = 40, EDGE_MIN_TOUCH = HIT_TOUCH * 3;
/** 楕円・崩した形の輪郭を何点で描くか */
const ELLIPSE_SAMPLES = 64;

/** 四隅を動かすときの角。index は形を崩す計算(paint/shapeWarp.ts)の四隅の順(左上・右上・右下・左下) */
export type FrameHit = { kind: 'resize'; handle: Handle } | { kind: 'move' } | { kind: 'rotate' } | { kind: 'corner'; index: number };

/** 角のハンドル(su・sv は形の右・上が正)を、四隅の順の番号へ */
export const cornerIndex = (h: Handle): number => (h.sv > 0 ? (h.su < 0 ? 0 : 1) : (h.su > 0 ? 2 : 3));

interface Geometry {
  /** 枠の四隅(右上・右下・左下・左上)。主ビューの左上からの CSS ピクセル */
  corners: Pt[];
  handles: { h: Handle; p: Pt }[];
  /** 上の辺の中点と、回すハンドル */
  top: Pt; rot: Pt;
  center: Pt;
  /** 枠の短い辺の画面上の長さ */
  minSide: number;
  /** 形の輪郭(楕円、崩した形。崩していない矩形・カマボコなら null) */
  ellipse: Pt[] | null;
  /** 四隅を動かすか */
  cornerEdit: boolean;
}

/** 崩す前の形の輪郭の点(正規化した座標、y は下)。矩形・カマボコは角を丸めた四角 */
function outlineSquare(shape: string, round: number, w: number, h: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  if (shape === 'ellipse') {
    for (let i = 0; i < ELLIPSE_SAMPLES; i++) { const t = (i / ELLIPSE_SAMPLES) * Math.PI * 2; pts.push({ x: Math.cos(t), y: Math.sin(t) }); }
    return pts;
  }
  // 角は丸みの半径の円弧にする。半径は短い方の辺の半分に対する割合(paint/inflate.ts と同じ)なので、正規化した座標では縦横で割合が違う
  const rr = Math.max(0, Math.min(1, round)) * Math.min(w, h) / 2, rx = rr / (w / 2), ry = rr / (h / 2), N = 12;
  const corners = [{ cx: 1, cy: 1, a0: 0 }, { cx: -1, cy: 1, a0: Math.PI / 2 }, { cx: -1, cy: -1, a0: Math.PI }, { cx: 1, cy: -1, a0: Math.PI * 1.5 }];
  for (const c of corners) {
    const ox = c.cx * (1 - rx), oy = c.cy * (1 - ry);
    for (let i = 0; i <= N; i++) { const t = c.a0 + (i / N) * Math.PI / 2; pts.push({ x: ox + Math.cos(t) * rx, y: oy + Math.sin(t) * ry }); }
  }
  // 角と角の間も点を足す(ふくらみで辺が曲がるのを描くため)
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    out.push(a);
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.1);
    for (let k = 1; k < steps; k++) out.push({ x: a.x + (b.x - a.x) * k / steps, y: a.y + (b.y - a.y) * k / steps });
  }
  return out;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * 回す丸を付ける辺(1: 形の上、-1: 形の下)。回して ±90° を越えると角度は反対側へ回り込み、形の上下が入れ替わるので、
 * そのときは付ける辺も入れ替えて、丸が画面上で跳ばないようにする
 */
let rotSide: 1 | -1 = 1, sideAngle = 0;
/**
 * 回すドラッグの間に ui/input.ts が呼ぶ。angle はそのときの(回り込んだあとの)角度。
 * パネルの数値などで角度がこれと違う値に変わったら、付ける辺は形の上に戻す
 */
export function setRotSide(side: 1 | -1, angle: number): void { rotSide = side; sideAngle = angle; }

/** 今の範囲の枠を、主ビューの画面の位置で求める。プレビュー中でない・画面に収まらない(カメラの後ろ)ときは null */
function geometry(app: App, withEllipse = true): Geometry | null {
  const s = app.inflateState; if (!s || !app.stage.hasDocument) return null;
  const a = s.area, ang = s.settings.angle, st = s.settings;
  if (ang !== sideAngle) { rotSide = 1; sideAngle = ang; }
  /** 形の中の位置(su・sv は崩す前の四角の -1〜1、形の右・上が正)を、四隅を動かした分だけ写して画面へ */
  const warped = !isFlatWarp(a.warp), wc = warped ? warpCorners(a.warp) : null;
  const toScreen = (X: number, Y: number) => { const q = areaPoint(a, ang, X, -Y); return app.stage.imageToMainScreen(q.x, q.y); };
  const at = (su: number, sv: number) => {
    if (!wc) return toScreen(su, -sv);
    const ss = (su + 1) / 2, tt = (1 - sv) / 2; // 四隅の順は y が下向き
    return toScreen(
      (1 - ss) * (1 - tt) * wc[0].x + ss * (1 - tt) * wc[1].x + ss * tt * wc[2].x + (1 - ss) * tt * wc[3].x,
      (1 - ss) * (1 - tt) * wc[0].y + ss * (1 - tt) * wc[1].y + ss * tt * wc[2].y + (1 - ss) * tt * wc[3].y,
    );
  };
  const handles: { h: Handle; p: Pt }[] = [];
  for (const h of HANDLES) { const p = at(h.su, h.sv); if (!p) return null; handles.push({ h, p }); }
  const center = at(0, 0); if (!center) return null;
  const corner = (su: number, sv: number) => handles.find(e => e.h.su === su && e.h.sv === sv)!.p;
  const corners = [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)];
  const top = corner(0, rotSide);
  // 回すハンドルは、中心から上の辺の中点へ向かう向きに離して置く。枠が潰れて向きが決まらないときは、形の「上」を少し先で測る
  let dx = top.x - center.x, dy = top.y - center.y, l = Math.hypot(dx, dy);
  if (l < 1) { const far = at(0, rotSide * (1 + 1000 / Math.max(1, a.h))); if (far) { dx = far.x - center.x; dy = far.y - center.y; l = Math.hypot(dx, dy); } }
  if (l < 1e-6) { dx = 0; dy = -1; l = 1; }
  const rot = { x: top.x + dx / l * ROT_GAP, y: top.y + dy / l * ROT_GAP };
  const minSide = Math.min(dist(corners[0], corners[1]), dist(corners[1], corners[2]));
  let ellipse: Pt[] | null = null;
  const square = st.shape === 'ellipse', round = square ? 0 : st.round, bulge = square ? 0 : st.bulge;
  if (withEllipse && (square || warped || round || bulge)) {
    ellipse = [];
    for (const q of outlineSquare(st.shape, round, a.w, a.h)) {
      const w = fromSquare(q.x, q.y, a.warp, bulge), p = toScreen(w.x, w.y);
      if (!p) { ellipse = null; break; }
      ellipse.push(p);
    }
  }
  return { corners, handles, top, rot, center, minSide, ellipse, cornerEdit: s.cornerEdit };
}

/** 点が(凸の)四角形の中にあるか */
function insideQuad(q: readonly Pt[], p: Pt): boolean {
  let sign = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q[(i + 1) % q.length];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (c === 0) continue;
    const s = Math.sign(c);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

/** 辺のハンドルを出すか(枠が画面上で十分大きいとき)。描くのと当たり判定で同じ条件にする。スマホの画面では指に合わせて境目を大きくする */
const edgesShown = (g: Geometry) => g.minSide >= (document.documentElement.classList.contains('mobile') ? EDGE_MIN_TOUCH : EDGE_MIN);

/**
 * 画面の点(clientX/Y)で掴むものを決める。回すハンドル > いちばん近い大きさのハンドル > 枠の中(移動)。
 * 当たるものが無ければ null(範囲の描き直しになる)
 */
export function hitFrame(app: App, clientX: number, clientY: number, touch: boolean): FrameHit | null {
  const g = geometry(app, false); if (!g) return null;
  const r = ui.view.getBoundingClientRect(), m = app.stage.mainView();
  const p = { x: clientX - r.left - m.x, y: clientY - r.top - m.y };
  const R = touch ? HIT_TOUCH : HIT;
  if (dist(p, g.rot) <= R) return { kind: 'rotate' };
  // 枠が小さいときは、角の当たりを小さくして、中を掴めるようにする
  const edges = edgesShown(g), cornerR = edges ? R : Math.max(5, Math.min(R, g.minSide / 3));
  let best: { h: Handle; d: number } | null = null;
  for (const { h, p: q } of g.handles) {
    const isCorner = h.su !== 0 && h.sv !== 0;
    if (!isCorner && !edges) continue;
    const d = dist(p, q);
    if (d <= (isCorner ? cornerR : R) && (!best || d < best.d)) best = { h, d };
  }
  if (best) return g.cornerEdit && best.h.su !== 0 && best.h.sv !== 0 ? { kind: 'corner', index: cornerIndex(best.h) } : { kind: 'resize', handle: best.h };
  if (insideQuad(g.corners, p)) return { kind: 'move' };
  return null;
}

/** 掴むものに合わせたカーソル。大きさのハンドルは、画面上で中心から見た向きの両矢印にする */
export function frameCursor(app: App, hit: FrameHit, dragging: boolean): string {
  if (hit.kind === 'move') return 'move';
  if (hit.kind === 'rotate') return dragging ? 'grabbing' : 'grab';
  if (hit.kind === 'corner') return 'crosshair';
  const g = geometry(app, false);
  const q = g?.handles.find(e => e.h.su === hit.handle.su && e.h.sv === hit.handle.sv)?.p;
  if (!g || !q) return 'move';
  const deg = ((Math.atan2(q.y - g.center.y, q.x - g.center.x) * 180 / Math.PI) % 180 + 180) % 180;
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(deg / 45) % 4];
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent.append(e);
  return e;
}

export function bindInflateFrame(app: App): void {
  const host = ui.inflateFrame;
  const svg = el('svg', { class: 'inflate-frame', 'aria-hidden': 'true' }, host);
  let last = '';

  function update(): void {
    const g = app.exporting ? null : geometry(app);
    if (!g) {
      if (last !== 'off') { host.hidden = true; svg.replaceChildren(); last = 'off'; }
      return;
    }
    const m = app.stage.mainView();
    const f = (v: number) => v.toFixed(1), line = (pts: readonly Pt[]) => pts.map(p => `${f(p.x)},${f(p.y)}`).join(' ');
    // ハンドルは膨らみツールのときだけ出す(ほかのツールでは掴めないので、枠の線だけにする)
    const handles = app.tool === 'inflate', touch = document.documentElement.classList.contains('mobile');
    const sig = `${m.x},${m.y},${m.w},${m.h}|${line(g.corners)}|${f(g.rot.x)},${f(g.rot.y)}|${g.ellipse ? line(g.ellipse) : 0}|${handles}|${touch}|${g.cornerEdit}`;
    if (sig === last) return;
    last = sig;
    host.hidden = false;
    Object.assign(host.style, { left: `${m.x}px`, top: `${m.y}px`, width: `${m.w}px`, height: `${m.h}px` });
    svg.setAttribute('viewBox', `0 0 ${m.w} ${m.h}`);
    svg.replaceChildren();
    // 線は暗い太い線を下に敷いて、画像の明暗どちらの上でも見えるようにする
    const stroke = (tag: 'polygon' | 'polyline' | 'line', attrs: Record<string, string | number>) => {
      el(tag, { ...attrs, class: `${attrs.class} if-halo` }, svg);
      el(tag, attrs, svg);
    };
    if (g.ellipse) stroke('polygon', { class: 'if-shape', points: line(g.ellipse) });
    stroke('polygon', { class: 'if-box', points: line(g.corners) });
    if (!handles) return;
    stroke('line', { class: 'if-stem', x1: f(g.top.x), y1: f(g.top.y), x2: f(g.rot.x), y2: f(g.rot.y) });
    const edges = edgesShown(g);
    for (const { h, p } of g.handles) {
      if (!edges && (h.su === 0 || h.sv === 0)) continue;
      // 四隅を動かす間の角は、大きさのハンドルと見分けるよう丸い点にする
      if (g.cornerEdit && h.su !== 0 && h.sv !== 0) el('circle', { class: 'if-handle if-corner', cx: f(p.x), cy: f(p.y), r: 5.5 }, svg);
      else el('rect', { class: 'if-handle', x: f(p.x - 4.5), y: f(p.y - 4.5), width: 9, height: 9, rx: 1.5 }, svg);
    }
    el('circle', { class: 'if-handle if-rot', cx: f(g.rot.x), cy: f(g.rot.y), r: 5.5 }, svg);
  }

  app.on('frame', update);
  app.on('inflate', phase => { if (phase === 'begin') setRotSide(1, app.inflateState?.settings.angle ?? 0); update(); });
  app.on('tool', update);
}
