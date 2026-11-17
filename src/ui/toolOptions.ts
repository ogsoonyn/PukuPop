/**
 * ツールオプションの欄(上のバー)。選択中のツールの設定だけを出す。
 *   ブラシ・消しゴム・ぼかし: ブラシのサイズ・強さ・硬さ・筆圧(data-brush-opt)
 *   膨らみ: 描いたあとのパネルをたたむと(高さだけ残る)触れなくなるもののうち、ウェイトの重ね方・レイヤーの重ね方・四隅を動かす・
 *           四角に戻す(data-inflate-opt)。プレビュー中は下のパネルと同じ値を変える。ウェイトの重ね方は、描く前は次に描くときの設定。
 *           レイヤーの重ね方・四隅は範囲ごとのものなので、描くまで押せない(data-inflate-range。レイヤーの重ね方は描いたときに始まる値を見せる)。
 *           次に描くときの設定はブラウザに覚える(適用したときの設定も覚え、キャンセルした分は覚えない。四隅のずれは覚えない)。
 *   そのほか(つかむ・揺らす・視点・移動): 設定は無く、操作のヒントだけ
 * スマホでは、ブラシの設定はシートの「ツール」タブへ移す(ui/mobile.ts)。
 */
import { INFLATE_ANGLE, INFLATE_BLUR, type App, type InflateSettings } from '../app';
import type { InflateBlend } from '../paint/inflate';
import { BLENDS, BLEND_ORDER, type BlendMode } from '../model/project';
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
  const save = () => { const s = app.inflateSettings; prefs.set(KEY, { shape: s.shape, profile: s.profile, softness: s.softness, angle: s.angle, blend: s.blend, blur: s.blur, newLayer: s.newLayer, round: s.round, bulge: s.bulge }); };
  // 覚えている設定を戻す(値は選べるものだけ)
  {
    const v = prefs.get<Partial<InflateSettings>>(KEY) ?? {};
    const pick = <T extends string>(x: unknown, ok: readonly T[]): T | undefined => (ok.includes(x as T) ? (x as T) : undefined);
    const shape = pick(v.shape, ['ellipse', 'rect', 'kamaboko'] as const), profile = pick(v.profile, ['dome', 'cushion', 'cone'] as const);
    const blend = pick(v.blend, ['max', 'add', 'replace'] as const);
    const softness = typeof v.softness === 'number' && v.softness >= 0 && v.softness <= 1 ? v.softness : undefined;
    const blur = typeof v.blur === 'number' && Number.isFinite(v.blur) ? Math.round(Math.max(INFLATE_BLUR.min, Math.min(INFLATE_BLUR.max, v.blur))) : undefined;
    const frac = (x: unknown, min: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(Math.max(min, Math.min(1, x)) * 100) / 100 : undefined);
    const round = frac(v.round, 0), bulge = frac(v.bulge, -1);
    const angle = typeof v.angle === 'number' && Number.isFinite(v.angle) ? Math.round(Math.max(INFLATE_ANGLE.min, Math.min(INFLATE_ANGLE.max, v.angle))) : undefined;
    app.inflateSettings = {
      ...app.inflateSettings, ...(shape && { shape }), ...(profile && { profile }), ...(blend && { blend }),
      ...(softness !== undefined && { softness }), ...(angle !== undefined && { angle }), ...(blur !== undefined && { blur }), ...(typeof v.newLayer === 'boolean' && { newLayer: v.newLayer }),
      ...(round !== undefined && { round }), ...(bulge !== undefined && { bulge }),
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
  ui.tInflBlend.addEventListener('change', () => setInflate({ blend: ui.tInflBlend.value as InflateBlend }));
  // 範囲ごとのもの(描くまで押せない)。決まった値を選ぶだけなので、フレームにまとめずにそのまま映す
  for (const b of BLEND_ORDER) ui.tInflLayerBlend.add(new Option(BLENDS[b].label, b));
  ui.tInflLayerBlend.addEventListener('change', () => { if (app.previewingInflate) app.updateInflate({ layerBlend: ui.tInflLayerBlend.value as BlendMode }); });
  ui.tInflCorner.addEventListener('change', () => { if (app.previewingInflate) app.updateInflate({ cornerEdit: ui.tInflCorner.checked }); });
  ui.tInflWarpReset.addEventListener('click', () => { if (app.previewingInflate) app.updateInflate({ area: { warp: null } }); });

  /** 欄の値を今の設定に合わせる(入力中の欄は書き換えない) */
  function syncInflate(force = false): void {
    const s = app.inflateState, st = s?.settings ?? app.inflateSettings;
    const set = (el: HTMLInputElement | HTMLSelectElement, v: string) => { if ((force || document.activeElement !== el) && el.value !== v) el.value = v; };
    set(ui.tInflBlend, st.blend);
    // 描く前は、描いたときに始まる値を見せる(新しいレイヤーに作るなら、その既定の加算。そうでなければ今のレイヤーの重ね方)
    set(ui.tInflLayerBlend, s?.layerBlend ?? (st.newLayer ? 'add' : app.activeLayer?.blend ?? 'add'));
    ui.tInflCorner.checked = !!s?.cornerEdit;
    ui.tInflLayerBlend.disabled = ui.tInflCorner.disabled = !s;
    ui.tInflWarpReset.disabled = !s?.area.warp || s.area.warp.every(v => v === 0);
  }
  app.on('inflate', phase => {
    if (phase === 'end') { pending = {}; save(); } // 適用したら、その設定が次に描くときの設定になる(キャンセルなら前のまま)
    syncInflate(phase === 'end'); // 終えたら、欄にフォーカスが残っていても描く前の値に戻す
  });
  // 今のレイヤー・その重ね方が変わったら、描く前に見せる重ね方を合わせる(プレビュー中は右パネルで変えた値も映る)
  app.store.on('layer', ({ keys }) => { if (keys.includes('blend')) syncInflate(); });
  app.on('active', () => syncInflate());
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
