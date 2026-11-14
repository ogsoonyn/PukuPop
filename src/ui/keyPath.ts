/**
 * キーフレームの枠と経路の重ね表示。1番のキーフレームの視点を撮影カメラとして止めたまま、画像のほうを動かしたと
 * みなし(ループ再生で画像を動かすのと同じ計算)、各キーフレームで画像が来る所を輪郭の枠で、順番を番号で、
 * 画像の中心の動き(実際に再生する曲線と同じ keyCurve)を矢印と秒数で、3Dビューの上に SVG で重ねる。
 * 枠と経路は空間に置いたものなので、視点を動かすと横や上からも見られる。1番の視点から見ると、撮影カメラで映る並びになる。
 * 「ゴースト」をオンにすると、同じ所に画像そのものを平らな半透明で重ねる(主ビューだけ)。
 *
 * - キーフレームの部品が見えているとき(右パネル・スマホのシートで「アニメーション」を開いているとき)だけ出す。
 *   記録中・再生中・書き出し中は出さない。「経路」の切り替えはブラウザに覚える(ファイルには書かない)。
 * - 視点・キーフレーム・画面の大きさが変わったフレームだけ描き直す。
 * - 番号を押すとその視点へ移る。一覧の行にポインタを乗せる・フォーカスすると、そのフレームを強める。
 */
import type { App } from '../app';
import { keyCurve, type KeyMode, type ViewKey } from '../physics/take';
import { wrapAngle } from '../model/project';
import { prefs } from '../storage/prefs';
import { ui } from './ids';

type Pt = { x: number; y: number };

/**
 * キーフレームの部品が見えているか(右パネル・スマホのシートで「アニメーション」を開いているか)。
 * 重ね表示と、止まっている間の再生のバー(ui/playBar.ts)が使う
 */
export function keySectionShown(): boolean {
  // スマホでシートを畳んでいるときは、キーフレームの部品は見えていない
  if (document.documentElement.classList.contains('mobile') && ui.mSheet.dataset.state === 'closed') return false;
  const section = ui.keySection;
  return section.checkVisibility?.() ?? section.offsetParent !== null;
}

const NS = 'http://www.w3.org/2000/svg';
/** 番号の円の半径(px) */
const R = 10;
/** 1区間の経路を何点で描くか */
const SAMPLES = 32;
const PREF = 'keyPath';
const GHOST_PREF = 'keyGhost';

const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;
const sameView = (a: ViewKey, b: ViewKey) => near(a.yaw, b.yaw, 1e-4) && near(a.pitch, b.pitch, 1e-4) && near(wrapAngle(a.roll - b.roll), 0, 1e-4) && near(a.zoom, b.zoom, 1e-4)
  && near(a.target.x, b.target.x, 1e-3) && near(a.target.y, b.target.y, 1e-3) && near(a.target.z, b.target.z, 1e-3);
const fmt = (v: number) => v.toFixed(1);
const sec = (v: number) => `${v.toFixed(1)}秒`;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.append(e);
  return e;
}

/** 折れ線の長さ */
function lengthOf(pts: readonly Pt[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
}

/** 折れ線の始まりから長さ s の点と、そこでの向き(単位ベクトル) */
function pointAt(pts: readonly Pt[], s: number): { p: Pt; dir: Pt } {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l > 0 && acc + l >= s) {
      const t = (s - acc) / l;
      return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, dir: { x: (b.x - a.x) / l, y: (b.y - a.y) / l } };
    }
    acc += l;
  }
  const a = pts.at(-2) ?? pts[0], b = pts.at(-1)!, l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { p: { ...b }, dir: { x: (b.x - a.x) / l, y: (b.y - a.y) / l } };
}

/** 折れ線の始まりから s0〜s1 の部分 */
function slice(pts: readonly Pt[], s0: number, s1: number): Pt[] {
  const out: Pt[] = [pointAt(pts, s0).p];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc > s0 && acc < s1) out.push(pts[i]);
  }
  out.push(pointAt(pts, s1).p);
  return out;
}

/** 同じ所に重なった番号は横に並べる(回転やズームだけのキーフレームは、画面の中心が同じ所に来る) */
function spread(points: readonly (Pt | null)[]): (Pt | null)[] {
  const out = points.map(p => (p ? { ...p } : null));
  const done = new Set<number>();
  points.forEach((p, i) => {
    if (!p || done.has(i)) return;
    const group = points.flatMap((q, j) => (q && !done.has(j) && Math.hypot(q.x - p.x, q.y - p.y) < R * 2.6 ? [j] : []));
    group.forEach(j => done.add(j));
    if (group.length < 2) return;
    group.forEach((j, k) => { out[j] = { x: p.x + (k - (group.length - 1) / 2) * (R * 2.6 + 3), y: p.y }; });
  });
  return out;
}

type World = { x: number; y: number; z: number };
/** 今の視点には関わらない、ワールド座標の形(キーフレーム・画角・主ビューの縦横比・画像の置き方が同じなら使い回す) */
interface Shape { frames: (World[] | null)[]; centers: (World | null)[]; paths: World[][]; seconds: number[]; modes: KeyMode[]; rigs: ReturnType<App['stage']['rigMatrix']>[] }

export function bindKeyPath(app: App): void {
  const host = ui.keyPath, toggle = ui.keyPathShow, ghost = ui.keyGhostShow;
  const svg = el('svg', { class: 'key-path', 'aria-hidden': 'true' }, host);
  // 経路・ゴーストの入・切は App が持つ(左のツールバー・メニューからも切り替える)。ここではブラウザに覚え、チェックボックスに映す。
  // 覚えている値は、左のツールバーとメニューを作る(bindActions)前にここで入れる(main.ts の呼ぶ順)
  app.keyOverlay = { path: prefs.get<boolean>(PREF) ?? true, ghost: prefs.get<boolean>(GHOST_PREF) ?? false };
  toggle.addEventListener('change', () => app.setKeyOverlay('path', toggle.checked));
  ghost.addEventListener('change', () => app.setKeyOverlay('ghost', ghost.checked));
  let saved = { ...app.keyOverlay };
  const syncToggles = () => {
    const o = app.keyOverlay;
    toggle.checked = o.path; ghost.checked = o.ghost;
    if (o.path !== saved.path) prefs.set(PREF, o.path);
    if (o.ghost !== saved.ghost) prefs.set(GHOST_PREF, o.ghost);
    saved = { ...o };
  };
  toggle.checked = app.keyOverlay.path; ghost.checked = app.keyOverlay.ghost;

  // 番号を押して(ずらさずに)離すとその視点へ。押したときに一覧のフォーカスが外れて描き直しても届くよう、押した番号を覚えておく
  let press: { key: number; x: number; y: number; id: number } | null = null;
  svg.addEventListener('pointerdown', e => {
    const g = (e.target as Element).closest<SVGGElement>('[data-key]');
    if (!g || e.button !== 0) return;
    e.preventDefault();
    press = { key: Number(g.dataset.key), x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  window.addEventListener('pointerup', e => {
    const p = press;
    if (!p || p.id !== e.pointerId) return;
    press = null;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 8) app.gotoKey(p.key);
  });
  window.addEventListener('pointercancel', () => { press = null; });
  // 番号の上のホイールは3Dビューのズームに回す
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    ui.view.dispatchEvent(new WheelEvent('wheel', e));
  }, { passive: false });

  // 一覧の行に乗せた・フォーカスしたフレームを強める
  let hover = -1;
  const rowIndex = (t: EventTarget | null) => Number((t as HTMLElement | null)?.closest<HTMLElement>('[data-key]')?.dataset.key ?? -1);
  ui.keyList.addEventListener('pointerover', e => { hover = rowIndex(e.target); });
  ui.keyList.addEventListener('pointerleave', () => { hover = -1; });
  ui.keyList.addEventListener('focusin', e => { hover = rowIndex(e.target); });
  ui.keyList.addEventListener('focusout', () => { hover = -1; });

  let last = '', shapeSig = '', shape: Shape | null = null;
  function visible(): boolean {
    if ((!app.keyOverlay.path && !app.keyOverlay.ghost) || !app.keyDraft.length || !app.doc || app.exporting || app.takeState !== 'idle') return false;
    return keySectionShown();
  }

  /**
   * 各キーフレームで画像が来る所(輪郭と中心)と、画像の中心の経路を、ワールド座標で求める。
   * 1番の視点を止めたまま、そこから見て各キーフレームの視点で見たとおりに映るよう画像を動かす(実際の動きの曲線を区間ごとに細かく取る)
   */
  function buildShape(fov: number): Shape {
    const stage = app.stage, curve = keyCurve(app.keyDraft, fov);
    const keys = curve?.keys ?? app.keyDraft.slice(0, 1);
    const base = { ...keys[0].view, fov, target: { ...keys[0].view.target } };
    const rigs = keys.map(k => stage.rigMatrix(base, { ...k.view, fov }));
    const placed = rigs.map(m => stage.placedOutline(m));
    const paths: World[][] = [];
    if (curve) {
      const m = stage.rigMatrix(base, base);
      keys.forEach((k, i) => {
        const pts: World[] = [];
        for (let s = 0; s <= SAMPLES; s++) {
          stage.rigMatrix(base, curve.at(Math.min(curve.starts[i] + (k.seconds * s) / SAMPLES, curve.total - 1e-6)), m);
          pts.push(stage.placedOutline(m).center);
        }
        paths.push(pts);
      });
    }
    return { frames: placed.map(p => p.corners), centers: placed.map(p => p.center), paths, seconds: keys.map(k => k.seconds), modes: keys.map(k => k.mode), rigs };
  }

  function update(): void {
    if (!visible()) {
      if (last !== 'off') { host.hidden = true; svg.replaceChildren(); app.stage.setGhosts(null); last = 'off'; }
      return;
    }
    const m = app.stage.mainView(), c = app.project.camera, d = app.doc!;
    if (hover >= app.keyDraft.length) hover = -1;
    const ss = JSON.stringify([app.keyDraft, c.fov, m.w, m.h, d.position, d.rotation, d.scale]);
    const sig = `${ss}|${m.x},${m.y}|${c.yaw},${c.pitch},${c.roll},${c.zoom},${c.target.x},${c.target.y},${c.target.z}|${hover}|${app.keyOverlay.ghost}|${app.keyOverlay.path}`;
    if (sig === last) return;
    last = sig;
    if (ss !== shapeSig || !shape) { shapeSig = ss; shape = buildShape(c.fov); }
    // ゴーストだけのときは、重ね表示(SVG)は隠す
    host.hidden = !app.keyOverlay.path;
    Object.assign(host.style, { left: `${m.x}px`, top: `${m.y}px`, width: `${m.w}px`, height: `${m.h}px` });
    svg.setAttribute('viewBox', `0 0 ${m.w} ${m.h}`);
    draw(shape);
  }

  const line = (pts: readonly Pt[]) => pts.map(p => `${fmt(p.x)},${fmt(p.y)}`).join(' ');

  function draw(sh: Shape): void {
    const stage = app.stage, cam = app.project.camera, n = sh.centers.length;
    const toScreen = (w: World | null) => (w ? stage.toMainScreen(w) : null);
    const current = app.keyDraft.findIndex(k => sameView(k.view, cam));
    const strong = hover >= 0 ? hover : current;
    stage.setGhosts(app.keyOverlay.ghost ? sh.rigs : null, strong);
    svg.replaceChildren();
    if (!app.keyOverlay.path) return;
    const frames = el('g', { class: 'kp-frames' }, svg), paths = el('g', { class: 'kp-paths' }, svg);
    const labels = el('g', { class: 'kp-labels' }, svg), marks = el('g', { class: 'kp-marks' }, svg);
    // 順番は濃さでも表す(最初が濃く、あとほど薄く)
    const alpha = (i: number) => (n < 2 ? 1 : 1 - (i / (n - 1)) * 0.5);
    // 線・矢じりは、暗い太い線を下に敷いて、画像の明暗どちらの上でも見えるようにする(filter は描き直しが重い)
    const stroke = (tag: 'polygon' | 'polyline', attrs: Record<string, string | number>, parent: Element) => {
      el(tag, { ...attrs, class: `${attrs.class} kp-halo` }, parent);
      el(tag, attrs, parent);
    };

    sh.frames.forEach((f, i) => {
      const pts = f?.map(toScreen);
      if (!pts || pts.some(p => !p)) return;
      stroke('polygon', { class: `kp-frame${i === strong ? ' strong' : ''}`, points: line(pts as Pt[]), 'stroke-opacity': i === strong ? 1 : alpha(i) * 0.75 }, frames);
    });
    const centers = spread(sh.centers.map(toScreen));

    const placed: Pt[] = [];
    sh.paths.forEach((path, i) => {
      const pts = path.map(toScreen).filter((p): p is Pt => !!p);
      const a = centers[i];
      const back = i === n - 1, cls = `kp-path${back ? ' back' : ''}`, op = String(alpha(i));
      const L = pts.length >= 2 ? lengthOf(pts) : 0;
      let label: Pt | null = null;
      if (L > R * 2 + 14) {
        // 番号の円の内側は描かない。矢じりは着く側の円の手前に置く
        stroke('polyline', { class: cls, points: line(slice(pts, R + 2, L - R - 2)), 'stroke-opacity': op }, paths);
        const { p, dir } = pointAt(pts, L - R - 2), w = 5, h = 9;
        const bx = p.x - dir.x * h, by = p.y - dir.y * h;
        stroke('polygon', {
          class: 'kp-arrow', 'fill-opacity': op,
          points: `${fmt(p.x)},${fmt(p.y)} ${fmt(bx - dir.y * w)},${fmt(by + dir.x * w)} ${fmt(bx + dir.y * w)},${fmt(by - dir.x * w)}`,
        }, paths);
        // 秒数は区間の真ん中に置く。番号やほかの秒数と重なるなら、区間の中でずらし、だめなら横へ逃がす
        const free = (q: Pt) => centers.every(c => !c || Math.hypot(c.x - q.x, c.y - q.y) > R + 14)
          && placed.every(o => Math.abs(o.x - q.x) > 36 || Math.abs(o.y - q.y) > 17);
        for (const f of [0.5, 0.38, 0.62, 0.28, 0.72]) { const q = pointAt(pts, L * f).p; if (free(q)) { label = q; break; } }
        if (!label) { const { p: q, dir: dd } = pointAt(pts, L / 2); label = { x: q.x - dd.y * 16, y: q.y + dd.x * 16 }; }
      } else if (a) {
        // 経路がほとんど動かない(回転・ズームだけ)ときは、秒数を番号の下に出す
        label = { x: a.x, y: a.y + R + 10 };
      }
      if (label) {
        placed.push(label);
        const g = el('g', { class: `kp-sec${back ? ' back' : ''}`, transform: `translate(${fmt(label.x)},${fmt(label.y)})` }, labels);
        el('rect', { x: -17, y: -8, width: 34, height: 16, rx: 8 }, g);
        el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g).textContent = sec(sh.seconds[i]);
      }
    });

    centers.forEach((c, i) => {
      if (!c) return;
      // 通り方は形で見分ける: なめらかは丸、弾む(そこで急に止まる)はひし形
      const bounce = sh.modes[i] === 'bounce', D = R * 1.3;
      const g = el('g', { class: `kp-mark${i === strong ? ' strong' : ''}`, 'data-key': i, 'data-mode': sh.modes[i], transform: `translate(${fmt(c.x)},${fmt(c.y)})` }, marks);
      el('title', {}, g).textContent = `${i + 1}(${bounce ? '弾む' : 'なめらか'}): この視点を見る`;
      if (bounce) el('polygon', { class: 'kp-shape', points: `0,${-D} ${D},0 0,${D} ${-D},0` }, g);
      else el('circle', { class: 'kp-shape', r: R }, g);
      // 2けたはひし形の縁にかからないよう小さくする
      el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', ...(i >= 9 ? { style: 'font-size: 9px' } : {}) }, g).textContent = String(i + 1);
    });
  }

  // 描くのは frame(描画の直後)だけにする。ほかの知らせの時点では、カメラの行列が今の視点と合っていないことがある
  // (番号で視点を移した直後・書き出しの後)。見えなくなったときだけ、ほかの知らせでもすぐ消す(書き出し中は frame が出ない)
  app.on('frame', update);
  const hideIfNeeded = () => { last = ''; if (!visible()) update(); };
  // 行を消したときは、強めていた行がもう無いことがある(消えた要素からは focusout が届かない)
  app.on('take', () => { hover = -1; hideIfNeeded(); });
  app.on('view', () => { last = ''; shapeSig = ''; syncToggles(); hideIfNeeded(); });
  app.on('status', hideIfNeeded);
  // タブの切り替えは frame で拾う(見えているかを毎フレーム確かめる)
  update();
}
