/**
 * 揺らし方図鑑(guide.html)。自動揺らしの揺らし方を、編集アプリと同じ揺れの計算(physics/world.ts の PhysicsWorld)で動かし、
 * 斜めと横から見た絵・時間ごとのずれのグラフ・設定の効き方を見せる。揺らし方の説明の文章は ./info.ts。
 * 編集アプリ(App)・アンドゥ・設定の保存・ service worker は使わない。描き方はこのページ向けの簡略化で、アプリの3D表示(Stage)とは別物
 */
import './guide.css';
import { defaultPhysics, type PhysicsParams,
  MOTIONS, MOTION_PARAMS, PRESETS, EFFECT_LIMITS, defaultEffect,
  type MotionPattern, type Layer, type PresetName, type Vec3, type EffectTiming, type MotionParamDef,
} from '../model/project';
import { WeightMap } from '../model/weightmap';
import { motionAnchor, motionSpread } from '../physics/motion';
import { PhysicsWorld, PHYSICS_DT, coefficients } from '../physics/world';
import { MAX_BURSTS, PEAK_MIN, inflation as inflationOf, type Burst } from '../physics/effect';
import { effectEnvelope } from '../playback/stageSwing';
import { GUIDE, type GuideAxis } from './info';
type Material = Pick<PhysicsParams, 'hardness' | 'mass' | 'damping' | 'weight'>;
/** 本体の係数の式を、材質の4項目だけから使う */
const coef = (p: Material) => coefficients({ ...defaultPhysics(), ...p });

type Motion = Exclude<MotionPattern, 'none'>;
type PresetKey = Exclude<PresetName, 'custom'>;
const TAU = Math.PI * 2;
const DT = PHYSICS_DT;
/** 画像の長辺を 1024px とみなす(正規化座標の 1 = 512px) */
const UNIT = 512;

const ORDER = (Object.keys(MOTIONS) as MotionPattern[]).filter((m): m is Motion => m !== 'none');
/** エフェクトが出る揺らし方: 手前へ膨らむ(手前へのずれか範囲の広がりがある)もの。左右・上下にだけ動く揺らし方では出ない */
const FX_ORDER = ORDER.filter(m => GUIDE[m].axes.some(a => a === 'z' || a === 'r'));
const FX_MOTIONS: ReadonlySet<Motion> = new Set(FX_ORDER);
/** 揺らし方ごとの代表のプリセット(ほかは先に出てくるもの) */
const PRESET_OF = {} as Record<Motion, PresetKey>;
for (const [k, p] of Object.entries(PRESETS) as [PresetKey, (typeof PRESETS)[PresetKey]][]) if (p.motion !== 'none' && !PRESET_OF[p.motion]) PRESET_OF[p.motion] = k;
// ためて膨らむは、横にも広がる「ぷくっ」を見本にする(先に出てくる「ためてぼよん」は横の広がり 0%)
PRESET_OF.charge2 = 'puku';
const presetOf = (m: Motion) => PRESETS[PRESET_OF[m]];
const defParams = (m: Motion): Record<string, number> => Object.fromEntries(MOTION_PARAMS[m].map(d => [d.key, d.def]));

// ───────── 設定と揺れの計算 ─────────
interface FxState { enabled: boolean; ring: boolean; timing: EffectTiming; opacity: number; spread: number; duration: number; burstMin: number }
interface State {
  motion: Motion; P: Record<string, number>; period: number; strength: number;
  hardness: number; mass: number; damping: number; weight: number; popPx: number; fx: FxState;
}
function makeState(motion: Motion, fxOn: boolean): State {
  const pr = presetOf(motion), d = defaultEffect();
  return {
    motion, P: { ...defParams(motion), ...(pr.params ?? {}) }, period: pr.period, strength: 0.5,
    hardness: pr.hardness, mass: pr.mass, damping: pr.damping, weight: 0.15, popPx: 80,
    fx: { enabled: fxOn, ring: true, timing: d.timing, opacity: d.opacity, spread: d.spread, duration: d.duration, burstMin: d.burstMin },
  };
}
const prefixed = (st: State) => Object.fromEntries(Object.entries(st.P).map(([k, v]) => [`${st.motion}.${k}`, v]));
const fxActive = (st: State) => st.fx.enabled;
/** 揺れの計算に渡すレイヤー(塗りは使わないので 1×1) */
function guideLayer(st: State): Layer {
  return {
    id: 'guide', name: '', visible: true, pop: st.popPx, blend: 'add',
    physics: { enabled: true, preset: 'custom', hardness: st.hardness, mass: st.mass, weight: st.weight, damping: st.damping, motion: st.motion, motionParams: prefixed(st) },
    effect: { ...defaultEffect(), enabled: fxActive(st), ring: st.fx.ring, timing: st.fx.timing, opacity: st.fx.opacity, spread: st.fx.spread, duration: st.fx.duration, burstMin: st.fx.burstMin },
    weights: new WeightMap(1, 1),
  };
}
/** 膨らみの量(physics/effect.ts の測り方をそのまま使う)。手前へのずれ ÷ ポップ量(ふわっと膨らむは上も)+ 広がり */
const inflation = (m: Motion, sz: number, sy: number, r: number, pop: number) => inflationOf(m, { x: 0, y: sy, z: sz }, r, pop);

interface Rec {
  n: number; len: number; T: number;
  sx: Float32Array; sy: Float32Array; sz: Float32Array; r: Float32Array;
  bx: Float32Array; by: Float32Array; bz: Float32Array; rb: Float32Array; gy: Float32Array; I: Float32Array; Ib: Float32Array;
  /** 膨らみの量の傾き(I/秒)。エフェクトの「膨らみ始め」はこれで決まる */
  dI: Float32Array; dIb: Float32Array;
  bursts: Burst[];
}
/** 揺れが落ち着くまで回してから、recPeriods 周期分を 1/120 秒ごとに記録する。時刻は記録の頭から */
function simulate(st: State, recPeriods = 2): Rec {
  const T = st.period, S = st.strength, m = st.motion, mp = prefixed(st), pop = st.popPx / UNIT;
  const layer = guideLayer(st), layers = [layer], world = new PhysicsWorld();
  world.unitPx = UNIT; world.autoSwing = { enabled: true, period: T, strength: S };
  const warm = Math.ceil(Math.max(6 * T, 8) / T) * T, recLen = recPeriods * T;
  const steps = Math.round((warm + recLen) / DT), recStart = Math.round(warm / DT), n = steps - recStart;
  const F = () => new Float32Array(n);
  const rec: Rec = { n, len: recLen, T, sx: F(), sy: F(), sz: F(), r: F(), bx: F(), by: F(), bz: F(), rb: F(), gy: F(), I: F(), Ib: F(), dI: F(), dIb: F(), bursts: [] };
  const tmp: Vec3 = { x: 0, y: 0, z: 0 }, base: Vec3 = { x: 0, y: 0, z: 0 };
  const seen = new Set<number>();
  for (let i = 0; i < steps; i++) {
    world.step(layers);
    const t1 = world.time;
    for (const b of world.bursts(layer.id)) if (!seen.has(b.t)) { seen.add(b.t); if (b.t >= warm - st.fx.duration - 1) rec.bursts.push({ t: b.t - warm, s: { ...b.s }, r: b.r }); }
    if (i < recStart) continue;
    const j = i - recStart, s = world.displacement(layer.id), r = world.spread(layer.id);
    rec.sx[j] = s.x; rec.sy[j] = s.y; rec.sz[j] = s.z; rec.r[j] = r;
    motionAnchor(m, t1, T, S, tmp, pop, mp);
    rec.bx[j] = tmp.x; rec.by[j] = tmp.y; rec.bz[j] = tmp.z; rec.rb[j] = motionSpread(m, t1, T, S, mp);
    rec.gy[j] = world.baseOffset(layers, t1, base).y;
    rec.I[j] = inflation(m, s.z, s.y, r, pop); rec.Ib[j] = inflation(m, tmp.z, tmp.y, rec.rb[j], pop);
  }
  // 傾きは1刻み前との差。頭だけは次の刻みとの差で測る
  for (let j = 0; j < n; j++) { const a = j ? j - 1 : 0, b = j ? j : Math.min(1, n - 1); rec.dI[j] = (rec.I[b] - rec.I[a]) / DT; rec.dIb[j] = (rec.Ib[b] - rec.Ib[a]) / DT; }
  return rec;
}
/** 再生の時刻 t で出ているエフェクト。記録は周期でつながるので、前後の繰り返しの分も見る */
function aliveBursts(rec: Rec, t: number, duration: number): { b: Burst; k: number }[] {
  const out: { b: Burst; k: number }[] = [];
  for (const b of rec.bursts) for (const off of [0, rec.len, -rec.len]) {
    const age = (t - (b.t + off)) / duration;
    if (age >= 0 && age < 1) out.push({ b, k: age });
  }
  out.sort((a, c) => c.k - a.k);
  return out.slice(-MAX_BURSTS);
}

// ───────── 色(テーマから読む) ─────────
interface Colors { [k: string]: string | boolean; dark: boolean }
let C: Colors = { dark: false };
const col = (k: string) => String(C[k] ?? '#888');
function readColors(): void {
  const cs = getComputedStyle(document.documentElement), g = (n: string) => cs.getPropertyValue(n).trim();
  const theme = document.documentElement.getAttribute('data-theme');
  C = {
    ink: g('--ink'), muted: g('--muted'), grid: g('--grid'), accent: g('--accent'), img: g('--img'), imgEdge: g('--img-edge'),
    x: g('--c-x'), y: g('--c-y'), z: g('--c-z'), r: g('--c-r'), i: g('--c-i'), anchor: g('--c-anchor'), fx: g('--c-fx'),
    dark: theme === 'dark' || (!theme && matchMedia('(prefers-color-scheme: dark)').matches),
  };
}
readColors();
const redrawAll = new Set<() => void>();
const onTheme = () => { readColors(); for (const f of redrawAll) f(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', onTheme);
new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
function alpha(hex: string, a: number): string {
  const h = hex.replace('#', ''); if (h.length !== 6) return hex;
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${a})`;
}

// ───────── キャンバス ─────────
function fitCanvas(cv: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const dpr = Math.min(2, window.devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return null;
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d'); if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

/** 塗った所のウェイト(円、中心 (0, CY)、半径 R。中ほどまで 1、外へなめらかに 0) */
const R = 0.42, CY = 0.05, GRID_N = 20;
const weightAt = (x: number, y: number) => { const d = Math.hypot(x, y - CY); if (d >= R) return 0; const t = Math.max(0, (d - R * 0.35) / (R * 0.65)); return 1 - t * t * (3 - 2 * t); };

interface Frame { sx: number; sy: number; sz: number; r: number; bx: number; by: number; bz: number; gy: number }
interface DrawOpt { pop: number; fx?: FxState; bursts?: { b: Burst; k: number }[] | null; anchor?: boolean; view?: number; angle?: 'oblique' | 'front'; mag?: number }
const frameAt = (rec: Rec, t: number): Frame => {
  const i = Math.min(rec.n - 1, Math.max(0, Math.floor(t / DT)));
  return { sx: rec.sx[i], sy: rec.sy[i], sz: rec.sz[i], r: rec.r[i], bx: rec.bx[i], by: rec.by[i], bz: rec.bz[i], gy: rec.gy[i] };
};
/** 絵のずれだけを k 倍にする(グラフはそのまま) */
function magnify(f: Frame, opt: DrawOpt): [Frame, DrawOpt] {
  const k = opt.mag ?? 1; if (k === 1) return [f, opt];
  const g = { sx: f.sx * k, sy: f.sy * k, sz: f.sz * k, r: f.r * k, bx: f.bx * k, by: f.by * k, bz: f.bz * k, gy: f.gy * k };
  return [g, { ...opt, bursts: opt.bursts?.map(({ b, k: age }) => ({ b: { t: b.t, s: { x: b.s.x * k, y: b.s.y * k, z: b.s.z * k }, r: b.r * k }, k: age })) }];
}
interface P3 { x: number; y: number; z: number; w: number }
/** 塗った所の網目(3D)。s, r: ずれと広がり、scale: 重心のまわりの倍率、lift: ウェイトの分だけ手前へ足す量 */
function meshPts(s: Vec3, r: number, pop: number, gy: number, scale = 1, lift = 0): P3[] {
  const N = GRID_N, P: P3[] = [];
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const x = -R + (2 * R * i) / N, y = CY - R + (2 * R * j) / N, w = weightAt(x, y);
    const px = x + w * (s.x + r * x), py = y + w * (s.y + r * (y - CY)), pz = w * (pop + s.z);
    P.push({ x: px * scale, y: CY + (py - CY) * scale + gy, z: pz * scale + w * lift, w });
  }
  return P;
}
/** ウェイト lvl の輪郭(円)を、ずれ s・広がり r で動かした点 */
function contour(s: Vec3, r: number, lvl: number): { x: number; y: number }[] {
  let lo = 0, hi = R; for (let q = 0; q < 20; q++) { const mid = (lo + hi) / 2; if (weightAt(mid, CY) > lvl) lo = mid; else hi = mid; }
  const out = [];
  for (let q = 0; q < 48; q++) { const a = (q / 48) * TAU, x = lo * Math.cos(a), y = CY + lo * Math.sin(a); out.push({ x: x + lvl * (s.x + r * x), y: y + lvl * (s.y + r * (y - CY)) }); }
  return out;
}
/** 見る向き。正面か、斜め上から見下ろす(手前への膨らみが見える) */
function camera(angle: DrawOpt['angle']) {
  if (angle === 'front') return { ca: 1, sa: 0, cb: 1, sb: 0 };
  const a = -0.62, b = 0.42; // 横に約 35°、上から約 24°
  return { ca: Math.cos(a), sa: Math.sin(a), cb: Math.cos(b), sb: Math.sin(b) };
}

/** 塗った所の絵(斜めか正面) */
function drawFront(cv: HTMLCanvasElement, f0: Frame, opt0: DrawOpt): void {
  const [f, opt] = magnify(f0, opt0);
  const fc = fitCanvas(cv); if (!fc) return; const { ctx, w, h } = fc;
  const cam = camera(opt.angle), obl = opt.angle !== 'front';
  const V = opt.view ?? 0.8, sc = Math.min(w, h) / (2 * V), ox = w / 2 + (obl ? -0.08 * sc : 0), oy = h / 2 + (obl ? 0.05 * sc : 0);
  const S = (x: number, y: number, z: number) => {
    const x1 = x * cam.ca + z * cam.sa, z1 = -x * cam.sa + z * cam.ca;
    return { x: ox + x1 * sc, y: oy - (y * cam.cb - z1 * cam.sb) * sc, d: y * cam.sb + z1 * cam.cb };
  };
  type Pt = ReturnType<typeof S>;
  ctx.clearRect(0, 0, w, h);
  const gy = f.gy, pop = Math.max(opt.pop, 1e-4);
  const poly = (pts: Pt[]) => { ctx.beginPath(); pts.forEach((p, q) => q ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); };
  // 画像の面(長辺 = 2)と、元の位置の輪郭
  ctx.fillStyle = col('img'); ctx.strokeStyle = col('imgEdge'); ctx.lineWidth = 1;
  poly([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) => S(x, y + gy, 0))); ctx.fill(); ctx.stroke();
  ctx.setLineDash([3, 4]); ctx.strokeStyle = alpha(col('muted'), 0.55);
  ctx.beginPath(); for (let q = 0; q <= 48; q++) { const a = (q / 48) * TAU, p = S(R * 0.82 * Math.cos(a), CY + gy + R * 0.82 * Math.sin(a), 0); q ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); } ctx.stroke(); ctx.setLineDash([]);
  const N = GRID_N, cell = (2 * R) / N;
  const quads = (P: P3[]) => {
    const out: { pts: Pt[]; d: number; wm: number; hm: number; dzdx: number; dzdy: number }[] = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const a = P[j * (N + 1) + i], b = P[j * (N + 1) + i + 1], c = P[(j + 1) * (N + 1) + i + 1], d = P[(j + 1) * (N + 1) + i];
      const wm = (a.w + b.w + c.w + d.w) / 4; if (wm < 0.01) continue;
      const pts = [a, b, c, d].map(p => S(p.x, p.y, p.z));
      out.push({ pts, d: pts.reduce((v, p) => v + p.d, 0) / 4, wm, hm: (a.z + b.z + c.z + d.z) / 4,
        dzdx: (b.z - a.z + c.z - d.z) / (2 * cell), dzdy: (d.z - a.z + c.z - b.z) / (2 * cell) });
    }
    if (obl) out.sort((p, q) => p.d - q.d);
    return out;
  };
  const gridCol = alpha(C.dark ? '#ffffff' : '#5a2040', 0.2);
  for (const q of quads(meshPts({ x: f.sx, y: f.sy, z: f.sz }, f.r, opt.pop, gy))) {
    let L: number;
    if (obl) { // 面の向きで明るさを変える(左上からの光)
      const nl = Math.hypot(q.dzdx, q.dzdy, 1), lit = Math.max(0, Math.min(1, (q.dzdx * 0.45 - q.dzdy * 0.55 + 0.7) / nl));
      L = C.dark ? 30 + 34 * lit : 52 + 34 * lit;
    } else { const t = Math.max(-0.5, Math.min(1.6, q.hm / (pop + 0.02))); L = C.dark ? 38 + 22 * t : 82 - 22 * t; }
    ctx.fillStyle = `hsla(340, 72%, ${L}%, ${Math.min(1, q.wm * 1.4)})`;
    poly(q.pts); ctx.fill(); ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.6; ctx.stroke();
    if (q.wm > 0.03) { ctx.strokeStyle = gridCol; ctx.lineWidth = 0.5; ctx.stroke(); }
  }
  // エフェクト(出したときの形のコピーを、重心のまわりで広げ、ウェイトの分だけ手前へ出す)
  if (opt.bursts && opt.fx) for (const { b, k } of opt.bursts) {
    const env = effectEnvelope(k, opt.fx.opacity, opt.fx.spread);
    for (const q of quads(meshPts(b.s, b.r, opt.pop, gy, env.scale, env.lift * opt.pop))) {
      const a = env.alpha * 0.85 * Math.min(1, Math.max(0, (q.wm - 0.03) / 0.42));
      if (a < 0.004) continue;
      ctx.fillStyle = `rgba(255,255,255,${a})`; poly(q.pts); ctx.fill();
    }
    poly(contour(b.s, b.r, 0.3).map(p => S(p.x * env.scale, CY + (p.y - CY) * env.scale + gy, 0.3 * (opt.pop + b.s.z) * env.scale + 0.3 * env.lift * opt.pop)));
    if (opt.fx.ring) { ctx.strokeStyle = `rgba(255,255,255,${Math.min(1, env.alpha * 1.5)})`; ctx.lineWidth = 2.2; ctx.stroke(); ctx.strokeStyle = alpha(col('accent'), Math.min(1, env.alpha * 1.2)); ctx.lineWidth = 1; ctx.stroke(); }
    else { ctx.strokeStyle = alpha(col('accent'), env.alpha * 0.35); ctx.lineWidth = 1; ctx.stroke(); }
  }
  // 土台と、塗った所のてっぺん
  if (opt.anchor !== false) {
    const A = S(f.bx, CY + f.by + gy, opt.pop + f.bz), B = S(f.sx, CY + f.sy + gy, opt.pop + f.sz);
    ctx.strokeStyle = alpha(col('ink'), 0.5); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
    ctx.strokeStyle = col('anchor'); ctx.lineWidth = 1.5; ctx.setLineDash([2, 2]);
    ctx.beginPath(); ctx.arc(A.x, A.y, 6, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(A.x - 9, A.y); ctx.lineTo(A.x + 9, A.y); ctx.moveTo(A.x, A.y - 9); ctx.lineTo(A.x, A.y + 9); ctx.stroke();
    ctx.fillStyle = col('ink'); ctx.beginPath(); ctx.arc(B.x, B.y, 3, 0, TAU); ctx.fill();
  }
}

/** 右から見た断面(縦 = 上下 y、横 = 手前 z)。中心を通る縦の線の上で */
function drawSide(cv: HTMLCanvasElement, f0: Frame, opt0: DrawOpt): void {
  const [f, opt] = magnify(f0, opt0);
  const fc = fitCanvas(cv); if (!fc) return; const { ctx, w, h } = fc;
  const V = opt.view ?? 0.8, sc = h / (2 * V), ox = 18, oy = h / 2;
  const Y = (y: number) => oy - y * sc, Z = (z: number) => ox + z * sc;
  ctx.clearRect(0, 0, w, h);
  const gy = f.gy;
  ctx.fillStyle = col('imgEdge'); ctx.fillRect(Z(-0.03), Y(1 + gy), 0.03 * sc, 2 * sc);
  const prof = (s: Vec3, r: number, scale = 1, lift = 0) => {
    const pts: { y: number; z: number }[] = [];
    for (let q = 0; q <= 40; q++) {
      const y = CY - R + (2 * R * q) / 40, wgt = weightAt(0, y), yy = y + wgt * (s.y + r * (y - CY));
      pts.push({ y: CY + gy + (yy - CY) * scale, z: wgt * (opt.pop + s.z) * scale + wgt * lift });
    }
    return pts;
  };
  const fill = (pts: { y: number; z: number }[]) => { ctx.beginPath(); ctx.moveTo(Z(0), Y(pts[0].y)); pts.forEach(p => ctx.lineTo(Z(Math.max(0, p.z)), Y(p.y))); ctx.lineTo(Z(0), Y(pts[pts.length - 1].y)); ctx.closePath(); };
  ctx.setLineDash([3, 4]); ctx.strokeStyle = alpha(col('muted'), 0.6); ctx.lineWidth = 1;
  ctx.beginPath(); prof({ x: 0, y: 0, z: 0 }, 0).forEach((p, q) => q ? ctx.lineTo(Z(p.z), Y(p.y)) : ctx.moveTo(Z(p.z), Y(p.y))); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = C.dark ? 'hsla(340, 70%, 55%, .85)' : 'hsla(340, 72%, 66%, .9)';
  fill(prof({ x: f.sx, y: f.sy, z: f.sz }, f.r)); ctx.fill();
  if (opt.bursts && opt.fx) for (const { b, k } of opt.bursts) {
    const env = effectEnvelope(k, opt.fx.opacity, opt.fx.spread);
    ctx.fillStyle = `rgba(255,255,255,${env.alpha * 0.6})`; ctx.strokeStyle = `rgba(255,255,255,${env.alpha})`;
    fill(prof(b.s, b.r, env.scale, env.lift * opt.pop)); ctx.fill(); ctx.stroke();
  }
  ctx.strokeStyle = col('anchor'); ctx.lineWidth = 1.5; ctx.setLineDash([2, 2]);
  ctx.beginPath(); ctx.arc(Z(opt.pop + f.bz), Y(CY + f.by + gy), 5, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = col('muted'); ctx.font = '10px ' + getComputedStyle(document.body).fontFamily;
  ctx.fillText('手前 →', w - 44, h - 8); ctx.fillText('画像', 4, 12);
}

interface Series { data: ArrayLike<number>; style: 'solid' | 'dash' | 'ghost'; color: string }
interface Lane { key: string; label: string; k: number; series: Series[]; extraRange?: number[]; unit?: string; hline?: { v: number; label: string } }
interface GraphExtras { bursts?: Burst[]; duration?: number }
const niceStep = (raw: number) => { const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6)))), m = raw / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; };
const fmtNum = (v: number, step: number) => { const d = Math.max(0, -Math.floor(Math.log10(step) + 1e-9)); return (Math.abs(v) < step / 1e6 ? 0 : v).toFixed(d); };
const MONO = '10.5px ui-monospace, "SFMono-Regular", Consolas, monospace';

/** 時間のグラフ(向きごとに段を分ける)。play は再生位置(秒) */
function drawGraph(cv: HTMLCanvasElement, rec: Pick<Rec, 'len' | 'T'>, lanes: Lane[], play: number | null, extras: GraphExtras = {}): { left: number; pw: number } | undefined {
  const laneH = lanes.length === 1 ? 150 : 92, top = 6, gap = 14, bottom = 26, need = top + lanes.length * laneH + (lanes.length - 1) * gap + bottom;
  if (Math.abs(cv.clientHeight - need) > 1) cv.style.height = need + 'px';
  const fc = fitCanvas(cv); if (!fc) return; const { ctx, w } = fc;
  ctx.clearRect(0, 0, w, need);
  const left = 54, pw = w - left - 10, len = rec.len, TX = (t: number) => left + (t / len) * pw;
  const font = '11px ' + getComputedStyle(document.body).fontFamily;
  lanes.forEach((lane, li) => {
    const y0 = top + li * (laneH + gap), y1 = y0 + laneH;
    let lo = 0, hi = 0;
    for (const s of lane.series) for (let i = 0; i < s.data.length; i += 2) { const v = s.data[i] * lane.k; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (lane.extraRange) { lo = Math.min(lo, ...lane.extraRange); hi = Math.max(hi, ...lane.extraRange); }
    let span = hi - lo; if (span < 0.5) { const mid = (hi + lo) / 2; hi = mid + 0.25; lo = mid - 0.25; span = 0.5; }
    hi += span * 0.08; lo -= span * 0.08;
    const VY = (v: number) => y1 - ((v - lo) / (hi - lo)) * laneH;
    ctx.fillStyle = alpha(col('img'), 0.55); ctx.fillRect(left, y0, pw, laneH);
    const step = niceStep((hi - lo) / 3);
    ctx.font = MONO; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const yy = VY(v); ctx.strokeStyle = Math.abs(v) < 1e-9 ? alpha(col('muted'), 0.6) : col('grid'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(left + pw, yy); ctx.stroke();
      ctx.fillStyle = col('muted'); ctx.fillText(fmtNum(v, step) + (lane.unit ?? '%'), left - 5, yy);
    }
    for (let p = 0; p <= len + 1e-9; p += rec.T) { ctx.strokeStyle = alpha(col('muted'), 0.35); ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(TX(p), y0); ctx.lineTo(TX(p), y1); ctx.stroke(); ctx.setLineDash([]); }
    if (lane.hline) {
      const yy = VY(lane.hline.v * lane.k);
      ctx.strokeStyle = alpha(col('i'), 0.85); ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(left + pw, yy); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = MONO; ctx.fillStyle = col('i'); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(lane.hline.label, left + pw - 4, yy - 2);
    }
    if (extras.bursts) for (const bt of extras.bursts) for (const off of [0, -len, len]) {
      const t = bt.t + off; if (t < 0 || t > len) continue;
      ctx.strokeStyle = col('fx'); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(TX(t), y0); ctx.lineTo(TX(t), y1); ctx.stroke();
      if (extras.duration) { ctx.fillStyle = alpha(col('fx'), 0.12); ctx.fillRect(TX(t), y0, Math.min(TX(len), TX(t + extras.duration)) - TX(t), laneH); }
    }
    for (const s of lane.series) {
      ctx.strokeStyle = s.style === 'ghost' ? alpha(s.color, 0.22) : s.color;
      ctx.lineWidth = s.style === 'ghost' ? 5 : s.style === 'dash' ? 1.5 : 2.2;
      ctx.setLineDash(s.style === 'dash' ? [5, 4] : []);
      ctx.beginPath();
      const n = s.data.length, stepI = Math.max(1, Math.floor(n / (pw * 1.5)));
      for (let i = 0; i < n; i += stepI) { const x = left + (i / (n - 1)) * pw, y = VY(s.data[i] * lane.k); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.font = font; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillStyle = col('ink');
    ctx.fillText(lane.label, left + 6, y0 + 4);
  });
  const yb = top + lanes.length * laneH + (lanes.length - 1) * gap;
  ctx.font = MONO; ctx.fillStyle = col('muted'); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const ts = niceStep(len / 6);
  for (let t = 0; t <= len + 1e-9; t += ts) ctx.fillText(fmtNum(t, ts) + 's', TX(t), yb + 6);
  if (play != null) { const x = TX(play); ctx.strokeStyle = col('ink'); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, yb); ctx.stroke(); ctx.fillStyle = col('ink'); ctx.beginPath(); ctx.moveTo(x - 5, yb); ctx.lineTo(x + 5, yb); ctx.lineTo(x, yb - 6); ctx.fill(); }
  return { left, pw };
}

/** 正面から見た軌跡(x-y) */
function drawTraj(cv: HTMLCanvasElement, rec: Rec, ghost: Rec | null, play: number): void {
  const fc = fitCanvas(cv); if (!fc) return; const { ctx, w, h } = fc;
  ctx.clearRect(0, 0, w, h);
  let m = 0.02; for (const a of [rec.sx, rec.sy, rec.bx, rec.by, ...(ghost ? [ghost.sx, ghost.sy] : [])]) for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]));
  const sc = (Math.min(w, h) / 2 - 14) / (m * 1.1), ox = w / 2, oy = h / 2, X = (x: number) => ox + x * sc, Y = (y: number) => oy - y * sc;
  ctx.fillStyle = alpha(col('img'), 0.55); ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = alpha(col('muted'), 0.5); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, oy); ctx.lineTo(w, oy); ctx.moveTo(ox, 0); ctx.lineTo(ox, h); ctx.stroke();
  const path = (xs: Float32Array, ys: Float32Array, c: string, lw: number, dash: number[] = []) => { ctx.strokeStyle = c; ctx.lineWidth = lw; ctx.setLineDash(dash); ctx.beginPath(); for (let i = 0; i < xs.length; i += 2) { if (i) ctx.lineTo(X(xs[i]), Y(ys[i])); else ctx.moveTo(X(xs[i]), Y(ys[i])); } ctx.stroke(); ctx.setLineDash([]); };
  if (ghost) path(ghost.sx, ghost.sy, alpha(col('accent'), 0.2), 5);
  path(rec.bx, rec.by, col('anchor'), 1.4, [4, 3]);
  path(rec.sx, rec.sy, col('accent'), 2);
  const i = Math.min(rec.n - 1, Math.floor(play / DT));
  ctx.fillStyle = col('ink'); ctx.beginPath(); ctx.arc(X(rec.sx[i]), Y(rec.sy[i]), 4, 0, TAU); ctx.fill();
  ctx.strokeStyle = col('anchor'); ctx.beginPath(); ctx.arc(X(rec.bx[i]), Y(rec.by[i]), 4, 0, TAU); ctx.stroke();
  ctx.fillStyle = col('muted'); ctx.font = MONO; ctx.textAlign = 'right'; ctx.fillText('±' + (m * 50 * 1.1).toFixed(1) + '%', w - 6, 12);
}

// ───────── 1つずつ試す(エフェクトの節でも同じ部品を使う) ─────────
const COMMON = {
  period: { label: '周期', min: 0.3, max: 10, step: 0.1, fmt: (v: number) => v.toFixed(1) + '秒', hint: '揺らし方を1回くり返す長さ。動きの形(割合)はそのままで、速さだけが変わります。短くすると土台が速く動くので、同じ材質でも弾みが強くなります。' },
  strength: { label: '強さ', min: 0, max: 1, step: 0.01, fmt: (v: number) => Math.round(v * 100) + '%', hint: 'すべての揺らし方の振れ幅に掛かります(自動揺らしの強さ。既定 50%)。' },
  pop: { label: 'ポップ量', min: 0, max: 300, step: 1, fmt: (v: number) => v + 'px', hint: '塗った所の手前への高さ(既定 80px、画像の長辺 1024px として)。ためて膨らむ・ゆっくり膨らむ・一瞬膨らむの手前への動きはこれに比例します。' },
};
const MAT = {
  hardness: { label: '硬さ', hint: 'バネの強さ k。上げると速く小さく弾みます。' },
  mass: { label: '質量', hint: '慣性 m。上げるとゆっくり大きく弾みます。' },
  damping: { label: 'おさまり', hint: 'ブレーキ c。上げると弾みがすぐ止まります。' },
  weight: { label: '重さ', hint: '下へ引く力。止まっている位置が少し下がります(既定 15%)。' },
} as const;
type MatKey = keyof typeof MAT;
type LaneKey = GuideAxis | 'I' | 'V';
const AXIS: Record<LaneKey, { label: string; color: string; k: number }> = {
  x: { label: '左右のずれ x', color: 'x', k: 50 },
  y: { label: '上下のずれ y', color: 'y', k: 50 },
  z: { label: '手前へのずれ z', color: 'z', k: 50 },
  r: { label: '範囲の広がり r', color: 'r', k: 100 },
  I: { label: '膨らみの量 I', color: 'i', k: 100 },
  V: { label: '膨らむ速さ(I の傾き)', color: 'i', k: 1 },
};
function laneKeys(st: State): LaneKey[] {
  let axes: LaneKey[] = GUIDE[st.motion].axes.slice();
  if (st.motion === 'stretch') axes = [st.P.dir <= 1 ? 'y' : st.P.dir <= 3 ? 'x' : 'z'];
  // エフェクトの判定: 膨らみ始めは I の傾き、一番膨らんだときは I で決まる
  if (fxActive(st)) axes.push(st.fx.timing === 'peak' ? 'I' : 'V');
  return axes;
}
const pctText = (v: number) => Math.round(v * 100) + '%';

interface SliderOpt { key: string; label: string; hint?: string; min?: number; max?: number; step?: number; options?: [number, string][]; get: () => number; set: (v: number) => void; fmt?: (v: number) => string; after?: () => void }

const explorers: Explorer[] = [];
class Explorer {
  st: State; rec!: Rec; ghost!: Rec; ghostSame = false;
  showGhost = true; speed = 1; mag = 1; angle: 'oblique' | 'front' = 'oblique'; playing = true; t = 0; last = performance.now(); visible = true;
  gx: { left: number; pw: number } | undefined;
  front!: HTMLCanvasElement; side!: HTMLCanvasElement; graph!: HTMLCanvasElement; traj!: HTMLCanvasElement; trajbox!: HTMLElement; gwrap!: HTMLElement;

  constructor(readonly root: HTMLElement, readonly id: string, readonly motions: Motion[], readonly withFx: boolean) {
    this.st = makeState(motions[0], withFx);
    this.build(); this.recompute(); explorers.push(this);
    redrawAll.add(() => this.drawStatic());
    new IntersectionObserver(es => { this.visible = es[0].isIntersecting; }).observe(root);
    new ResizeObserver(() => this.drawStatic()).observe(this.graph);
  }
  q<T extends HTMLElement = HTMLElement>(s: string): T { return this.root.querySelector(`[data-r="${s}"]`) as T; }
  build(): void {
    const id = this.id;
    this.root.innerHTML = `
      <div class="flex flex-wrap gap-1.5 mb-3" role="group" aria-label="揺らし方を選ぶ">${this.motions.map(m => `<button type="button" class="btn btn-xs sm:btn-sm btn-outline chip-motion" data-m="${m}" aria-pressed="false">${MOTIONS[m].label}</button>`).join('')}</div>
      <div class="ex-grid">
        <div class="flex flex-col gap-3 min-w-0">
          <div class="panel p-3 flex flex-col gap-2">
            <div class="flex items-baseline justify-between gap-2 flex-wrap"><h3 class="text-xl font-bold" data-r="title"></h3><span class="badge badge-outline text-xs" data-r="preset"></span></div>
            <div class="views">
              <div class="min-w-0"><div class="flex items-center justify-between gap-2 mb-1"><span class="text-xs muted" data-r="vlabel">斜めから(網目 = 塗った所)</span><div class="join" role="group" aria-label="見る向き"><button type="button" class="btn btn-xs join-item" data-angle="oblique">斜め</button><button type="button" class="btn btn-xs join-item" data-angle="front">正面</button></div></div><canvas class="cv-front rounded-lg" data-r="front"></canvas></div>
              <div class="min-w-0"><div class="text-xs muted mb-1">右から見た断面</div><canvas class="cv-side rounded-lg" data-r="side"></canvas></div>
            </div>
            <div class="flex flex-wrap items-center gap-2 text-xs muted"><span><span style="color:var(--c-anchor)">⊕ 点線の丸</span> = 土台</span><span>● = 塗った所のてっぺん</span><span>点線の輪郭 = 元の位置</span><span>「動き×2・×4」は絵のずれだけを拡大します(グラフはそのまま)</span></div>
            <div class="flex flex-wrap items-center gap-2">
              <button type="button" class="btn btn-sm btn-primary" data-r="play">一時停止</button>
              <div class="join" role="group" aria-label="再生の速さ">${[0.1, 0.25, 0.5, 1].map(s => `<button type="button" class="btn btn-sm join-item" data-speed="${s}">${s === 1 ? '等速' : s + '×'}</button>`).join('')}</div>
              <div class="join" role="group" aria-label="動きの拡大">${[1, 2, 4].map(s => `<button type="button" class="btn btn-sm join-item" data-mag="${s}">動き×${s}</button>`).join('')}</div>
              <span class="num text-xs muted" data-r="clock"></span>
            </div>
          </div>
          <div class="panel p-3 flex flex-col gap-2 text-[14.5px]"><p data-r="what"></p><div class="formula" data-r="formula"></div></div>
        </div>
        <div class="panel p-3 flex flex-col gap-4 min-w-0">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <h3 class="font-bold">設定</h3>
            <div class="flex gap-2 flex-wrap">
              <label class="label cursor-pointer gap-2 text-xs"><input id="${id}-ghost" type="checkbox" class="toggle toggle-xs toggle-primary" checked><span>既定の値の線を重ねる</span></label>
              <button type="button" class="btn btn-xs btn-ghost border border-base-300" data-r="reset">プリセットの値に戻す</button>
            </div>
          </div>
          <div class="flex flex-col gap-3"><div class="eyebrow">この揺らし方の設定</div><div class="flex flex-col gap-3" data-r="mparams"></div></div>
          ${this.withFx ? '<div class="flex flex-col gap-3"><div class="eyebrow">エフェクト</div><div class="flex flex-col gap-3" data-r="fxparams"></div></div>' : ''}
          <div class="flex flex-col gap-3"><div class="eyebrow">自動揺らし・ポップ量</div><div class="flex flex-col gap-3" data-r="common"></div></div>
          <details class="collapse collapse-arrow bg-base-200/40 border border-base-300"><summary class="collapse-title text-sm font-semibold min-h-0 py-2">材質(硬さ・質量・おさまり・重さ)</summary><div class="collapse-content flex flex-col gap-3" data-r="mat"></div></details>
        </div>
      </div>
      <div class="panel p-3 mt-4 flex flex-col gap-2">
        <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs muted items-center">
          <span class="font-semibold text-[13px]" style="color:var(--ink)">時間ごとのずれ(2周期分、揺れが落ち着いた後)</span>
          <span><span class="legend-dash" style="color:var(--c-anchor)"></span>土台</span><span><span class="legend-dot" style="color:var(--ink)"></span>塗った所(色は向き)</span><span data-r="lg-ghost"><span class="legend-ghost" style="color:var(--ink)"></span>既定の値のとき</span>
          <span data-r="lg-fx" hidden><span class="legend-dot" style="color:var(--c-fx)"></span>エフェクトが出た時刻 <span class="legend-dash" style="color:var(--c-i)"></span>しきい値の下限</span>
          <span class="ml-auto">グラフを押すと、その時刻へ飛びます</span>
        </div>
        <div class="grid gap-3" data-r="gwrap">
          <canvas class="cv-graph" data-r="graph"></canvas>
          <div data-r="trajbox" class="flex flex-col gap-1"><div class="text-xs muted">正面から見た軌跡(<span style="color:var(--c-anchor)">点線</span> 土台 / <span style="color:var(--accent)">実線</span> 塗った所)</div><canvas class="cv-traj max-w-[260px]" data-r="traj"></canvas></div>
        </div>
        <div class="kv" data-r="stats"></div>
      </div>`;
    this.front = this.q('front'); this.side = this.q('side'); this.graph = this.q('graph'); this.traj = this.q('traj'); this.trajbox = this.q('trajbox'); this.gwrap = this.q('gwrap');
    this.root.querySelectorAll<HTMLButtonElement>('.chip-motion').forEach(b => b.addEventListener('click', () => this.setMotion(b.dataset.m as Motion)));
    const play = this.q<HTMLButtonElement>('play');
    play.addEventListener('click', () => { this.playing = !this.playing; play.textContent = this.playing ? '一時停止' : '再生'; this.last = performance.now(); });
    this.root.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach(b => b.addEventListener('click', () => { this.speed = Number(b.dataset.speed); this.markButtons(); }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-mag]').forEach(b => b.addEventListener('click', () => { this.mag = Number(b.dataset.mag); this.markButtons(); this.drawFrame(true); }));
    this.root.querySelectorAll<HTMLButtonElement>('[data-angle]').forEach(b => b.addEventListener('click', () => {
      this.angle = b.dataset.angle === 'front' ? 'front' : 'oblique';
      this.q('vlabel').textContent = this.angle === 'front' ? '正面から(網目 = 塗った所、色の濃さ = 手前への高さ)' : '斜めから(網目 = 塗った所)';
      this.markButtons(); this.drawFrame(true);
    }));
    this.markButtons();
    this.root.querySelector<HTMLInputElement>(`#${id}-ghost`)!.addEventListener('change', e => { this.showGhost = (e.target as HTMLInputElement).checked; this.drawStatic(); });
    this.q('reset').addEventListener('click', () => { const fx = this.st.fx; this.st = makeState(this.st.motion, this.withFx); this.st.fx = fx; this.renderControls(); this.recompute(); });
    const seek = (e: PointerEvent) => {
      const rc = this.graph.getBoundingClientRect(), g = this.gx ?? { left: 54, pw: rc.width - 64 };
      this.t = Math.max(0, Math.min(this.rec.len - 1e-6, ((e.clientX - rc.left - g.left) / g.pw) * this.rec.len));
      this.playing = false; play.textContent = '再生'; this.drawFrame();
    };
    this.graph.addEventListener('pointerdown', e => { this.graph.setPointerCapture(e.pointerId); seek(e); });
    this.graph.addEventListener('pointermove', e => { if (this.graph.hasPointerCapture(e.pointerId)) seek(e); });
    this.setMotion(this.st.motion, true);
  }
  markButtons(): void {
    this.root.querySelectorAll<HTMLElement>('[data-speed]').forEach(b => b.classList.toggle('btn-active', Number(b.dataset.speed) === this.speed));
    this.root.querySelectorAll<HTMLElement>('[data-mag]').forEach(b => b.classList.toggle('btn-active', Number(b.dataset.mag) === this.mag));
    this.root.querySelectorAll<HTMLElement>('[data-angle]').forEach(b => b.classList.toggle('btn-active', b.dataset.angle === this.angle));
  }
  setMotion(m: Motion, initial = false): void {
    const fx = this.st.fx; this.st = makeState(m, this.withFx); this.st.fx = fx; this.t = 0;
    this.root.querySelectorAll('.chip-motion').forEach(b => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.m === m)));
    this.renderControls(); if (!initial) this.recompute();
  }
  slider(container: HTMLElement, o: SliderOpt): void {
    const id = `${this.id}-${o.key}`, wrap = document.createElement('div'); wrap.className = 'param-row';
    const hint = o.hint ? `<div class="hint">${o.hint}</div>` : '';
    if (o.options) {
      wrap.innerHTML = `<label for="${id}" class="text-sm font-medium">${o.label}</label><select id="${id}" class="select select-sm w-auto">${o.options.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>${hint}`;
      const el = wrap.querySelector('select')!; el.value = String(o.get());
      el.addEventListener('change', () => { o.set(Number(el.value)); o.after?.(); this.recompute(); });
    } else {
      wrap.innerHTML = `<label for="${id}" class="text-sm font-medium">${o.label}</label><output for="${id}"></output><input id="${id}" type="range" class="range range-xs range-primary w-full" min="${o.min}" max="${o.max}" step="${o.step}">${hint}`;
      const el = wrap.querySelector('input')!, out = wrap.querySelector('output')!, fmt = o.fmt ?? String;
      el.value = String(o.get()); out.textContent = fmt(o.get());
      let raf = 0;
      el.addEventListener('input', () => { o.set(Number(el.value)); out.textContent = fmt(Number(el.value)); o.after?.(); if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.recompute(); }); });
    }
    container.appendChild(wrap);
  }
  renderControls(): void {
    const st = this.st, info = GUIDE[st.motion], pr = presetOf(st.motion);
    this.q('title').textContent = MOTIONS[st.motion].label; this.q('preset').textContent = `プリセット「${pr.label}」・周期 ${pr.period}秒`;
    this.q('what').textContent = info.what; this.q('formula').textContent = info.formula;
    const mp = this.q('mparams'); mp.innerHTML = '';
    const defNote = (d: MotionParamDef) => d.unit === '%' ? `(既定 ${pctText(d.def)})` : d.unit === 'Hz' ? `(既定 ${d.def}回/秒)` : '';
    for (const d of MOTION_PARAMS[st.motion]) {
      this.slider(mp, { key: 'm-' + d.key, label: d.label, min: d.min, max: d.max, step: d.step, options: d.options, hint: (info.notes[d.key] ?? d.hint ?? '') + defNote(d),
        get: () => st.P[d.key], set: v => { st.P[d.key] = v; }, fmt: v => d.unit === '%' ? pctText(v) : d.unit === 'Hz' ? v.toFixed(1) + '回/秒' : String(v) });
    }
    const cm = this.q('common'); cm.innerHTML = '';
    this.slider(cm, { key: 'period', ...COMMON.period, get: () => st.period, set: v => { st.period = v; } });
    this.slider(cm, { key: 'strength', ...COMMON.strength, get: () => st.strength, set: v => { st.strength = v; } });
    this.slider(cm, { key: 'pop', ...COMMON.pop, get: () => st.popPx, set: v => { st.popPx = v; } });
    const mt = this.q('mat'); mt.innerHTML = '';
    for (const k of Object.keys(MAT) as MatKey[]) this.slider(mt, { key: 'mat-' + k, label: MAT[k].label, hint: MAT[k].hint, min: 0, max: 1, step: 0.01, get: () => st[k], set: v => { st[k] = v; }, fmt: pctText });
    const fxp = this.root.querySelector<HTMLElement>('[data-r="fxparams"]');
    if (!fxp) return;
    fxp.innerHTML = '';
    const fx = st.fx, L = EFFECT_LIMITS;
    const tg = document.createElement('div'); tg.className = 'flex flex-wrap gap-3 items-center';
    tg.innerHTML = `<label class="label cursor-pointer gap-2 text-sm"><input id="${this.id}-fxon" type="checkbox" class="toggle toggle-sm toggle-primary"${fx.enabled ? ' checked' : ''}><span>エフェクトを付ける</span></label><label class="label cursor-pointer gap-2 text-sm"><input id="${this.id}-ring" type="checkbox" class="toggle toggle-sm"${fx.ring ? ' checked' : ''}><span>波紋も出す</span></label>`;
    fxp.appendChild(tg);
    tg.querySelector<HTMLInputElement>(`#${this.id}-fxon`)!.addEventListener('change', e => { fx.enabled = (e.target as HTMLInputElement).checked; this.recompute(); });
    tg.querySelector<HTMLInputElement>(`#${this.id}-ring`)!.addEventListener('change', e => { fx.ring = (e.target as HTMLInputElement).checked; });
    this.slider(fxp, { key: 'fx-timing', label: '出すとき', options: [[0, '膨らみ始め'], [1, '一番膨らんだとき']], hint: '膨らみ始め: 膨らむ速さ(I の傾き)が「出る勢い」と前の膨らみの一番急な傾きの両方を越えた瞬間。一番膨らんだとき: 膨らみが止まった所で、I が下限と前に出したときの I の両方を越えていれば出す。', get: () => fx.timing === 'peak' ? 1 : 0, set: v => { fx.timing = v ? 'peak' : 'burst'; } });
    this.slider(fxp, { key: 'fx-min', label: '出る勢い', min: L.burstMin.min, max: L.burstMin.max, step: 0.1, hint: `膨らみ始めに出すときの、膨らむ速さの下限(I/秒、既定 ${L.burstMin.def})。小さいほど弱い膨らみでも出ます。グラフの点線がこの値です。`, get: () => fx.burstMin, set: v => { fx.burstMin = v; }, fmt: v => v.toFixed(1) });
    this.slider(fxp, { key: 'fx-op', label: '濃さ', min: L.opacity.min, max: L.opacity.max, step: 0.01, hint: `コピーの一番濃いときの不透明度(既定 ${pctText(L.opacity.def)})。`, get: () => fx.opacity, set: v => { fx.opacity = v; }, fmt: pctText, after: drawEnv });
    this.slider(fxp, { key: 'fx-sp', label: '広がり', min: L.spread.min, max: L.spread.max, step: 0.01, hint: `消えるまでに広がる大きさ(重心からの距離に対する割合、既定 ${pctText(L.spread.def)})。`, get: () => fx.spread, set: v => { fx.spread = v; }, fmt: pctText, after: drawEnv });
    this.slider(fxp, { key: 'fx-du', label: '消えるまでの時間', min: L.duration.min, max: L.duration.max, step: 0.01, hint: `出てから消えるまで(既定 ${L.duration.def} 秒)。周期より長いと、次の膨らみのコピーと重なります(1レイヤー${MAX_BURSTS}つまで)。`, get: () => fx.duration, set: v => { fx.duration = v; }, fmt: v => v.toFixed(2) + '秒', after: drawEnv });
  }
  recompute(): void {
    const st = this.st;
    this.rec = simulate(st);
    const g = makeState(st.motion, false); g.popPx = st.popPx; g.fx = { ...st.fx };
    this.ghost = simulate(g);
    this.ghostSame = JSON.stringify(g) === JSON.stringify(st);
    if (this.t >= this.rec.len) this.t %= this.rec.len;
    this.drawStatic();
  }
  lanes(): Lane[] {
    const st = this.st, rec = this.rec, gh = this.ghost, isP = st.motion === 'piston', ghostOn = this.showGhost && !this.ghostSame;
    const plus = (a: Float32Array, b: Float32Array) => a.map((v, i) => v + b[i]);
    return laneKeys(st).map(key => {
      const ax = AXIS[key], c = col(ax.color);
      const [res, anc, gr] = key === 'x' ? [rec.sx, rec.bx, gh.sx]
        : key === 'y' ? (isP ? [plus(rec.sy, rec.gy), rec.gy, plus(gh.sy, gh.gy)] : [rec.sy, rec.by, gh.sy])
        : key === 'z' ? [rec.sz, rec.bz, gh.sz] : key === 'r' ? [rec.r, rec.rb, gh.r] : key === 'I' ? [rec.I, rec.Ib, gh.I] : [rec.dI, rec.dIb, gh.dI];
      // 傾きの段は、土台の線を引かない(離した瞬間などの急な所が大きく跳ねて、目盛りがつぶれるため)
      const series: Series[] = [...(ghostOn ? [{ data: gr, style: 'ghost' as const, color: c }] : []), ...(key === 'V' ? [] : [{ data: anc, style: 'dash' as const, color: col('anchor') }]), { data: res, style: 'solid', color: c }];
      let label = ax.label + (key === 'r' ? '(中心からの距離に対する %)' : key === 'I' ? '(手前のずれ÷ポップ量 + 広がり、%)' : key === 'V' ? '(I/秒)' : '(画像の長辺に対する %)');
      if (isP && key === 'y') label = '上下の位置 y(点線 = 画像全体、実線 = 塗った所の画面上の位置)';
      const hline = key === 'V' ? { v: st.fx.burstMin, label: `出る勢い(下限) ${st.fx.burstMin.toFixed(1)}` } : key === 'I' && fxActive(st) ? { v: PEAK_MIN, label: `下限 ${pctText(PEAK_MIN)}` } : undefined;
      return { key, label, k: ax.k, series, unit: key === 'V' ? '' : '%', hline, extraRange: hline ? [0, hline.v * ax.k * 1.15] : undefined };
    });
  }
  graphExtras(): GraphExtras { return fxActive(this.st) ? { bursts: this.rec.bursts, duration: this.st.fx.duration } : {}; }
  drawStatic(): void {
    if (!this.rec) return;
    this.gx = drawGraph(this.graph, this.rec, this.lanes(), this.t, this.graphExtras());
    const traj = !!GUIDE[this.st.motion].traj; this.trajbox.hidden = !traj;
    this.gwrap.style.gridTemplateColumns = traj && this.root.clientWidth > 700 ? 'minmax(0,1fr) 260px' : '';
    if (traj) drawTraj(this.traj, this.rec, this.showGhost && !this.ghostSame ? this.ghost : null, this.t);
    this.q('lg-fx').hidden = !fxActive(this.st); this.q('lg-ghost').hidden = this.ghostSame;
    this.renderStats();
    this.drawFrame(true);
  }
  renderStats(): void {
    const st = this.st, rec = this.rec, { k, m, c } = coef(st), f = Math.sqrt(k / m) / TAU, z = c / (2 * Math.sqrt(k * m));
    const maxAbs = (a: ArrayLike<number>) => { let v = 0; for (let i = 0; i < a.length; i++) v = Math.max(v, Math.abs(a[i])); return v; };
    const key = laneKeys(st)[0], isP = st.motion === 'piston';
    const res = isP ? rec.sy.map((v, i) => v + rec.gy[i]) : key === 'x' ? rec.sx : key === 'y' ? rec.sy : key === 'z' ? rec.sz : rec.r;
    const anc = isP ? rec.gy : key === 'x' ? rec.bx : key === 'y' ? rec.by : key === 'z' ? rec.bz : rec.rb;
    const ratio = maxAbs(anc) > 1e-6 ? maxAbs(res) / maxAbs(anc) : NaN;
    const items: [string, string][] = [
      ['弾む速さ f', f.toFixed(2) + ' 回/秒'], ['減りかた ζ', z.toFixed(2) + (z >= 1 ? '(弾まない)' : '')],
      ['揺らし方の速さ', (1 / st.period).toFixed(2) + ' 回/秒'], ['1周期に弾む回数', (f * st.period).toFixed(1) + ' 回'],
      [isP ? '画像に対する振れ' : '土台に対する振れ', Number.isFinite(ratio) ? '×' + ratio.toFixed(2) : '—'], ['k / m / c', `${k.toFixed(0)} / ${m.toFixed(2)} / ${c.toFixed(1)}`],
    ];
    if (fxActive(st)) items.push(['エフェクト', `1周期に ${Math.round(rec.bursts.filter(b => b.t >= 0 && b.t < rec.len).length / (rec.len / rec.T))} 回`]);
    this.q('stats').innerHTML = items.map(([a, b]) => `<div><span>${a}</span><b>${b}</b></div>`).join('');
  }
  tick(now: number): void {
    const dt = Math.min(0.1, (now - this.last) / 1000); this.last = now;
    if (this.playing) this.t = (this.t + dt * this.speed) % this.rec.len;
    if (this.visible) this.drawFrame();
  }
  drawFrame(skipGraph = false): void {
    const rec = this.rec, f = frameAt(rec, this.t), fx = fxActive(this.st);
    const opt: DrawOpt = { angle: this.angle, mag: this.mag, pop: this.st.popPx / UNIT, fx: this.st.fx, bursts: fx ? aliveBursts(rec, this.t, this.st.fx.duration) : null };
    drawFront(this.front, f, opt); drawSide(this.side, f, opt);
    if (!skipGraph) {
      this.gx = drawGraph(this.graph, rec, this.lanes(), this.t, this.graphExtras());
      if (GUIDE[this.st.motion].traj) drawTraj(this.traj, rec, this.showGhost && !this.ghostSame ? this.ghost : null, this.t);
    }
    this.q('clock').textContent = `${this.t.toFixed(2)}秒 / 位相 ${((this.t / rec.T) % 1).toFixed(2)}`;
  }
}

const scrollToExplore = () => document.getElementById('explore')!.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });

// ───────── 一覧 ─────────
interface Card { m: Motion; cv: HTMLCanvasElement; sp: HTMLCanvasElement; st: State; rec: Rec; t: number; visible: boolean }
const gcards: Card[] = [];
for (const m of ORDER) {
  const pr = presetOf(m), el = document.createElement('div'), info = GUIDE[m];
  el.className = 'panel gcard p-2.5 flex flex-col gap-1.5 min-w-0'; el.tabIndex = 0; el.setAttribute('role', 'button'); el.setAttribute('aria-label', MOTIONS[m].label + 'を試す');
  el.innerHTML = `<canvas class="cv-front rounded-md"></canvas><div class="flex items-baseline justify-between gap-1"><b class="disp text-[15px] leading-tight">${MOTIONS[m].label}</b><span class="text-[11px] muted whitespace-nowrap">${pr.label}</span></div><p class="text-[12px] muted leading-snug">${MOTIONS[m].desc}</p><canvas class="h-[34px]"></canvas><div class="text-[10.5px] muted flex flex-wrap gap-x-2">${info.axes.map(a => `<span style="color:var(--c-${a})">● ${AXIS[a].label.split(' ')[0]}</span>`).join('')}${FX_MOTIONS.has(m) ? '<span class="badge badge-xs badge-warning">エフェクト可</span>' : ''}</div>`;
  document.getElementById('gallery')!.appendChild(el);
  const [cv, sp] = el.querySelectorAll('canvas');
  const st = makeState(m, false), card: Card = { m, cv, sp, st, rec: simulate(st, 1), t: 0, visible: false };
  gcards.push(card);
  new IntersectionObserver(es => { card.visible = es[0].isIntersecting; }).observe(el);
  const open = () => { mainEx.setMotion(m); scrollToExplore(); };
  el.addEventListener('click', open); el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
}
function drawSpark(card: Card): void {
  const fc = fitCanvas(card.sp); if (!fc) return; const { ctx, w, h } = fc, rec = card.rec, key = GUIDE[card.m].axes[0], isP = card.m === 'piston';
  const a = key === 'x' ? rec.bx : key === 'y' ? (isP ? rec.gy : rec.by) : key === 'z' ? rec.bz : rec.rb;
  const b = key === 'x' ? rec.sx : key === 'y' ? (isP ? rec.sy.map((v, i) => v + rec.gy[i]) : rec.sy) : key === 'z' ? rec.sz : rec.r;
  let lo = 0, hi = 0; for (const arr of [a, b]) for (let i = 0; i < arr.length; i++) { lo = Math.min(lo, arr[i]); hi = Math.max(hi, arr[i]); }
  const span = Math.max(hi - lo, 1e-4), Y = (v: number) => h - 3 - ((v - lo) / span) * (h - 6);
  ctx.clearRect(0, 0, w, h); ctx.fillStyle = alpha(col('img'), 0.6); ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = alpha(col('muted'), 0.5); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(w, Y(0)); ctx.stroke();
  const line = (arr: Float32Array, c: string, lw: number, dash: number[] = []) => { ctx.strokeStyle = c; ctx.lineWidth = lw; ctx.setLineDash(dash); ctx.beginPath(); for (let i = 0; i < arr.length; i += 2) { const x = (i / (arr.length - 1)) * w; if (i) ctx.lineTo(x, Y(arr[i])); else ctx.moveTo(x, Y(arr[i])); } ctx.stroke(); ctx.setLineDash([]); };
  line(a, col('anchor'), 1.2, [3, 2]); line(b, col(AXIS[key].color), 1.6);
  const x = (card.t / rec.len) * w; ctx.strokeStyle = col('ink'); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
}

// ───────── 材質 ─────────
const mat: Record<MatKey, number> = { hardness: 0, mass: 0, damping: 0, weight: 0.15 };
const matGraph = document.getElementById('mat-graph') as HTMLCanvasElement, matPreset = document.getElementById('mat-preset') as HTMLSelectElement;
const setMat = (k: MatKey, v: number) => {
  mat[k] = v;
  (document.getElementById('mat-' + k) as HTMLInputElement).value = String(v);
  document.querySelector(`output[for="mat-${k}"]`)!.textContent = pctText(v);
};
for (const k of Object.keys(MAT) as MatKey[]) {
  const wrap = document.createElement('div'); wrap.className = 'param-row';
  wrap.innerHTML = `<label for="mat-${k}" class="text-sm font-medium">${MAT[k].label}</label><output for="mat-${k}"></output><input id="mat-${k}" type="range" class="range range-xs range-primary w-full" min="0" max="1" step="0.01"><div class="hint">${MAT[k].hint}</div>`;
  const el = wrap.querySelector('input')!;
  el.addEventListener('input', () => { setMat(k, Number(el.value)); matPreset.value = ''; drawMat(); });
  document.getElementById('mat-sliders')!.appendChild(wrap);
}
matPreset.innerHTML = '<option value="">(自由に設定)</option>' + (Object.entries(PRESETS) as [PresetKey, (typeof PRESETS)[PresetKey]][]).map(([k, p]) => `<option value="${k}">${p.label}(${MOTIONS[p.motion].label})</option>`).join('');
const applyMatPreset = (key: PresetKey) => { const p = PRESETS[key]; setMat('hardness', p.hardness); setMat('mass', p.mass); setMat('damping', p.damping); };
matPreset.addEventListener('change', () => { if (matPreset.value) { applyMatPreset(matPreset.value as PresetKey); drawMat(); } });
function drawMat(): void {
  const { k, m, c, g } = coef(mat), f = Math.sqrt(k / m) / TAU, z = c / (2 * Math.sqrt(k * m)), decay = c / (2 * m);
  const D = 3, n = Math.round(D / DT), a = new Float32Array(n), s = new Float32Array(n), env = new Float32Array(n), step = 0.1, sag = (-g * m) / k;
  let x = sag, v = 0;
  for (let i = 0; i < n; i++) {
    const t = i * DT, b = t >= 0.1 ? step : 0, bp = t - DT >= 0.1 ? step : 0;
    v += ((-k * (x - b) - c * (v - (b - bp) / DT) - g * m) / m) * DT; x += v * DT;
    a[i] = b; s[i] = x; env[i] = t >= 0.1 ? step + sag + step * Math.exp(-decay * (t - 0.1)) : step + sag;
  }
  drawGraph(matGraph, { len: D, T: 0.5 }, [{ key: 'm', label: '上下のずれ y(画像の長辺に対する %)', k: 50, extraRange: [-0.5, 10], series: [{ data: env, style: 'ghost', color: col('i') }, { data: a, style: 'dash', color: col('anchor') }, { data: s, style: 'solid', color: col('y') }] }], null);
  const items: [string, string][] = [
    ['k / m / c', `${k.toFixed(0)} / ${m.toFixed(2)} / ${c.toFixed(1)}`], ['弾む速さ f', f.toFixed(2) + ' 回/秒'], ['減りかた ζ', z.toFixed(3) + (z >= 1 ? '(弾まない)' : '')],
    ['行き過ぎ', z < 1 ? Math.round(100 * Math.exp((-Math.PI * z) / Math.sqrt(1 - z * z))) + '%' : '0%'], ['弾みが 5% まで減る', z >= 1 ? '—' : (Math.log(20) / decay).toFixed(2) + '秒'], ['重さの沈み込み', (sag * 50).toFixed(3) + '%'],
  ];
  document.getElementById('mat-kv')!.innerHTML = items.map(([p, q]) => `<div><span>${p}</span><b>${q}</b></div>`).join('');
}
matPreset.value = 'tame'; applyMatPreset('tame'); setMat('weight', 0.15);
redrawAll.add(drawMat); new ResizeObserver(drawMat).observe(matGraph);

// ───────── エフェクトの形 ─────────
const envCv = document.getElementById('env-graph') as HTMLCanvasElement;
let fxEx: Explorer | null = null;
function drawEnv(): void {
  if (!fxEx) return;
  const fx = fxEx.st.fx, n = 200, a = new Float32Array(n), sc = new Float32Array(n), li = new Float32Array(n);
  for (let i = 0; i < n; i++) { const e = effectEnvelope(i / (n - 1), fx.opacity, fx.spread); a[i] = e.alpha; sc[i] = e.scale - 1; li[i] = e.lift; }
  drawGraph(envCv, { len: fx.duration, T: fx.duration }, [{ key: 'e', label: `濃さ・広がり・手前(%) — 消えるまで ${fx.duration.toFixed(2)} 秒`, k: 100, extraRange: [0, 80], series: [{ data: li, style: 'dash', color: col('z') }, { data: sc, style: 'solid', color: col('r') }, { data: a, style: 'solid', color: col('fx') }] }], null);
}
redrawAll.add(drawEnv); new ResizeObserver(drawEnv).observe(envCv);

// ───────── プリセット表 ─────────
{
  const tb = document.getElementById('preset-table')!;
  tb.innerHTML = '<thead><tr><th>プリセット</th><th>揺らし方</th><th class="text-right">周期</th><th class="text-right">硬さ</th><th class="text-right">質量</th><th class="text-right">おさまり</th><th class="text-right">f(回/秒)</th><th class="text-right">ζ</th><th class="text-right">1周期に弾む</th><th>説明</th></tr></thead><tbody>'
    + (Object.values(PRESETS)).map(p => {
      const c = coef({ ...p, weight: 0.15 }), f = Math.sqrt(c.k / c.m) / TAU, z = c.c / (2 * Math.sqrt(c.k * c.m));
      return `<tr class="hover cursor-pointer" data-m="${p.motion}" tabindex="0"><td class="font-semibold whitespace-nowrap">${p.label}</td><td class="whitespace-nowrap">${MOTIONS[p.motion].label}</td><td class="num text-right">${p.period}秒</td><td class="num text-right">${pctText(p.hardness)}</td><td class="num text-right">${pctText(p.mass)}</td><td class="num text-right">${pctText(p.damping)}</td><td class="num text-right">${f.toFixed(2)}</td><td class="num text-right">${z.toFixed(2)}</td><td class="num text-right">${(f * p.period).toFixed(1)}回</td><td class="text-xs muted min-w-[16em]">${p.desc}</td></tr>`;
    }).join('') + '</tbody>';
  tb.querySelectorAll<HTMLElement>('tr[data-m]').forEach(tr => {
    const go = () => { mainEx.setMotion(tr.dataset.m as Motion); scrollToExplore(); };
    tr.addEventListener('click', go); tr.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  });
}

// ───────── 起動 ─────────
const mainEx = new Explorer(document.getElementById('ex-main')!, 'exm', ORDER, false);
fxEx = new Explorer(document.getElementById('ex-fx')!, 'exf', FX_ORDER, true);
fxEx.setMotion('charge2');
drawEnv(); drawMat();
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
if (reduce) for (const e of explorers) { e.playing = false; e.t = e.rec.T * 0.62; e.q('play').textContent = '再生'; }
let lastG = performance.now();
function loop(now: number): void {
  for (const e of explorers) e.tick(now);
  const dt = Math.min(0.1, (now - lastG) / 1000); lastG = now;
  for (const c of gcards) {
    if (!c.visible) continue;
    c.t = reduce ? c.rec.T * 0.62 : (c.t + dt) % c.rec.len;
    drawFront(c.cv, frameAt(c.rec, c.t), { pop: c.st.popPx / UNIT, view: 0.62, angle: 'oblique' });
    drawSpark(c);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
// 確認用(E2E): 揺らし方の一覧と、いま開いている揺らし方
(window as unknown as { pukupopGuide?: unknown }).pukupopGuide = { motions: ORDER, current: () => mainEx.st.motion, setMotion: (m: Motion) => mainEx.setMotion(m) };
