/**
 * ツールオプションの欄(上のバー)。選択中のツールの設定だけを出す。
 *   ブラシ・消しゴム・ぼかし: ブラシのサイズ・強さ・硬さ・筆圧(data-brush-opt)
 *   膨らみ: 次に範囲を描くときの形・断面・縁のなだらかさ・角度・ウェイトの重ね方(data-inflate-opt)。描いたあとのプレビュー中は、
 *           下のパネルと同じ値を変える。次に描くときの設定はブラウザに覚える(適用したときの設定も覚え、キャンセルした分は覚えない)。
 *           仕上げのぼかし・レイヤーの重ね方・新しいレイヤーに作るは、描いたあとのパネルにだけ置く(ぼかしと新しいレイヤーに作るは同じく覚える)
 *   そのほか(つかむ・揺らす・視点・移動): 設定は無く、操作のヒントだけ
 * スマホでは、ブラシの設定はシートの「ツール」タブへ移す(ui/mobile.ts)。
 */
import { INFLATE_ANGLE, INFLATE_BLUR, type App, type InflateSettings } from '../app';
import type { InflateBlend, InflateProfile } from '../paint/inflate';
import { prefs } from '../storage/prefs';
import { ui } from './ids';
import { toolDef } from './tools';
import { hintHtml, hintText } from './mouseHint';

const PAINT_TOOLS = new Set(['brush', 'erase', 'smooth']);

export function bindToolOptions(app: App): void {
  const brushOpts = [...document.querySelectorAll<HTMLElement>('[data-brush-opt]')];
  const inflateOpts = [...document.querySelectorAll<HTMLElement>('[data-inflate-opt]')];

  /* ---------- 膨らみの既定値 ---------- */

  const KEY = 'inflateDefaults';
  const save = () => { const s = app.inflateSettings; prefs.set(KEY, { shape: s.shape, profile: s.profile, softness: s.softness, angle: s.angle, blend: s.blend, blur: s.blur, newLayer: s.newLayer }); };
  // 覚えている設定を戻す(値は選べるものだけ)
  {
    const v = prefs.get<Partial<InflateSettings>>(KEY) ?? {};
    const pick = <T extends string>(x: unknown, ok: readonly T[]): T | undefined => (ok.includes(x as T) ? (x as T) : undefined);
    const shape = pick(v.shape, ['ellipse', 'rect', 'kamaboko'] as const), profile = pick(v.profile, ['dome', 'cushion', 'cone'] as const);
    const blend = pick(v.blend, ['max', 'add', 'replace'] as const);
    const softness = typeof v.softness === 'number' && v.softness >= 0 && v.softness <= 1 ? v.softness : undefined;
    const blur = typeof v.blur === 'number' && Number.isFinite(v.blur) ? Math.round(Math.max(INFLATE_BLUR.min, Math.min(INFLATE_BLUR.max, v.blur))) : undefined;
    const angle = typeof v.angle === 'number' && Number.isFinite(v.angle) ? Math.round(Math.max(INFLATE_ANGLE.min, Math.min(INFLATE_ANGLE.max, v.angle))) : undefined;
    app.inflateSettings = {
      ...app.inflateSettings, ...(shape && { shape }), ...(profile && { profile }), ...(blend && { blend }),
      ...(softness !== undefined && { softness }), ...(angle !== undefined && { angle }), ...(blur !== undefined && { blur }), ...(typeof v.newLayer === 'boolean' && { newLayer: v.newLayer }),
    };
  }
  /** プレビューへの反映は1フレームに1回にまとめる(大きな画像でも滑らかに動かせるよう) */
  let pending: Partial<InflateSettings> = {}, scheduled = false;
  const flush = () => { scheduled = false; const p = pending; pending = {}; if (app.previewingInflate) app.updateInflate({ settings: p }); };
  /** プレビュー中ならその設定を、そうでなければ次に描くときの設定を変えて覚える */
  const setInflate = (patch: Partial<InflateSettings>) => {
    if (app.previewingInflate) {
      pending = { ...pending, ...patch };
      if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
      return;
    }
    app.inflateSettings = { ...app.inflateSettings, ...patch };
    save();
  };
  const softText = () => { ui.tInflSoftO.textContent = `${ui.tInflSoft.value}%`; };
  const angleText = () => { ui.tInflAngleO.textContent = `${ui.tInflAngle.value}°`; };
  ui.tInflKind.addEventListener('change', () => setInflate({ shape: ui.tInflKind.value as InflateSettings['shape'] }));
  ui.tInflProfile.addEventListener('change', () => setInflate({ profile: ui.tInflProfile.value as InflateProfile }));
  ui.tInflBlend.addEventListener('change', () => setInflate({ blend: ui.tInflBlend.value as InflateBlend }));
  ui.tInflSoft.addEventListener('input', () => { softText(); setInflate({ softness: +ui.tInflSoft.value / 100 }); });
  ui.tInflAngle.addEventListener('input', () => { angleText(); setInflate({ angle: +ui.tInflAngle.value }); });
  // つまみをダブルクリックすると傾きなし(0°)に戻す
  ui.tInflAngle.addEventListener('dblclick', () => { ui.tInflAngle.value = '0'; angleText(); setInflate({ angle: 0 }); });

  /** 欄の値を今の設定に合わせる(入力中の欄は書き換えない) */
  function syncInflate(): void {
    const st = app.inflateState?.settings ?? app.inflateSettings;
    const set = (el: HTMLInputElement | HTMLSelectElement, v: string) => { if (document.activeElement !== el && el.value !== v) el.value = v; };
    set(ui.tInflKind, st.shape);
    set(ui.tInflProfile, st.profile);
    set(ui.tInflBlend, st.blend);
    set(ui.tInflSoft, String(Math.round(st.softness * 100)));
    set(ui.tInflAngle, String(st.angle));
    softText(); angleText();
  }
  app.on('inflate', phase => {
    if (phase === 'end') { pending = {}; save(); } // 適用したら、その設定が次に描くときの設定になる(キャンセルなら前のまま)
    syncInflate();
  });
  syncInflate();

  /* ---------- ツールに合わせて中身を入れ替える ---------- */

  function refresh(): void {
    const paint = PAINT_TOOLS.has(app.tool);
    for (const el of brushOpts) el.hidden = !paint;
    for (const el of inflateOpts) el.hidden = app.tool !== 'inflate';
    const hint = toolDef(app.tool).hint;
    ui.toolHint.innerHTML = hintHtml(hint);
    // 幅が足りずに隠れた操作も、ツールチップで読めるようにする
    ui.toolHint.title = hintText(hint);
  }
  app.on('tool', refresh);
  refresh();
}
