/**
 * 「膨らませる」のパネル。膨らみツールで範囲を描くと開き、数値を変えるとその場でプレビューする。
 * 視点を回して形を確かめられるよう、ほかの操作を止めないダイアログ(show)にする。適用で1手として記録する。
 * 見出しのボタンでたたむと、高さと適用・キャンセルだけにする(高さは枠でも上の欄でも変えられないため)。たたんだかはブラウザに覚え、
 * 次に範囲を描いたときもそのまま出す。スマホではシートの中に入るので、たたまない。
 */
import { INFLATE_ANGLE, INFLATE_BLUR, type App, type InflatePatch, type InflateSettings } from '../app';
import type { InflateProfile, InflateBlend } from '../paint/inflate';
import { BLENDS, BLEND_ORDER, LIMITS, type BlendMode } from '../model/project';
import { popSliderRange, popToSlider, sliderToPop } from './popSlider';
import { ui } from './ids';
import { icon } from './icons';
import { prefs } from '../storage/prefs';

export function bindInflateDialog(app: App): void {
  const dlg = ui.inflateDialog;
  const kind = ui.inflKind, w = ui.inflW, h = ui.inflH;
  const height = ui.inflHeight, heightN = ui.inflHeightN;
  const soft = ui.inflSoft, softN = ui.inflSoftN;
  const angle = ui.inflAngle, angleN = ui.inflAngleN;
  const blur = ui.inflBlur, blurN = ui.inflBlurN;
  const round = ui.inflRound, roundN = ui.inflRoundN, bulge = ui.inflBulge, bulgeN = ui.inflBulgeN;
  const blend = ui.inflBlend, layerBlend = ui.inflLayerBlend;
  for (const b of BLEND_ORDER) layerBlend.add(new Option(BLENDS[b].label, b));
  const profiles = [...document.querySelectorAll<HTMLInputElement>('input[name=inflProfile]')];
  let queued: InflatePatch = {}, scheduled = false;

  /* ---------- たたむ ---------- */
  const COMPACT_KEY = 'inflatePanelCompact';
  const setCompact = (on: boolean) => {
    dlg.classList.toggle('compact', on);
    const btn = ui.inflCompact, label = on ? 'パネルを広げる' : 'パネルをたたむ';
    btn.innerHTML = icon(on ? 'panelExpand' : 'panelShrink', 'w-4 h-4');
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', label);
    btn.title = label;
  };
  setCompact(prefs.get<boolean>(COMPACT_KEY) === true);
  ui.inflCompact.addEventListener('click', () => {
    const on = !dlg.classList.contains('compact');
    setCompact(on);
    prefs.set(COMPACT_KEY, on);
  });

  /** 高さのスライダーの右端。最大値の設定より高い高さで始めたときは、その値まで広げる(触っただけで一気に下がらないように) */
  let startHeight = 0;
  const heightMax = () => Math.max(app.popMax, startHeight);
  const clampInt = (v: string, min: number, max: number) => Math.max(min, Math.min(max, Math.round(+v || 0)));
  const flush = () => { const q = queued; queued = {}; app.updateInflate(q); };
  /** 大きな画像でも滑らかに動かせるよう、プレビューは1フレームに1回だけ計算する */
  const update = (patch: InflatePatch) => {
    queued = {
      settings: { ...queued.settings, ...patch.settings }, area: { ...queued.area, ...patch.area },
      layerBlend: patch.layerBlend ?? queued.layerBlend, cornerEdit: patch.cornerEdit ?? queued.cornerEdit,
    };
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; flush(); });
  };

  kind.addEventListener('change', () => update({ settings: { shape: kind.value as InflateSettings['shape'] } }));
  w.addEventListener('input', () => { if (+w.value >= 2) update({ area: { w: clampInt(w.value, 2, 8192) } }); });
  h.addEventListener('input', () => { if (+h.value >= 2) update({ area: { h: clampInt(h.value, 2, 8192) } }); });
  // 高さのスライダーはポップ量と同じ目盛り(前半ほど細かい)
  height.addEventListener('input', () => { const v = sliderToPop(+height.value, heightMax()); heightN.value = String(v); update({ settings: { height: v } }); });
  heightN.addEventListener('input', () => { const v = clampInt(heightN.value, 0, LIMITS.pop.max); height.value = String(popToSlider(v, heightMax())); update({ settings: { height: v } }); });
  soft.addEventListener('input', () => { softN.value = soft.value; update({ settings: { softness: clampInt(soft.value, 0, 100) / 100 } }); });
  softN.addEventListener('input', () => { soft.value = String(clampInt(softN.value, 0, 100)); update({ settings: { softness: clampInt(softN.value, 0, 100) / 100 } }); });
  const angleOf = (v: string) => clampInt(v, INFLATE_ANGLE.min, INFLATE_ANGLE.max);
  angle.addEventListener('input', () => { angleN.value = angle.value; update({ settings: { angle: angleOf(angle.value) } }); });
  angle.addEventListener('dblclick', () => { angle.value = angleN.value = '0'; update({ settings: { angle: 0 } }); });
  angleN.addEventListener('input', () => { if (angleN.value === '' || angleN.value === '-') return; angle.value = String(angleOf(angleN.value)); update({ settings: { angle: angleOf(angleN.value) } }); });
  const blurOf = (v: string) => clampInt(v, INFLATE_BLUR.min, INFLATE_BLUR.max);
  blur.addEventListener('input', () => { blurN.value = blur.value; update({ settings: { blur: blurOf(blur.value) } }); });
  blurN.addEventListener('input', () => { if (blurN.value === '') return; blur.value = String(blurOf(blurN.value)); update({ settings: { blur: blurOf(blurN.value) } }); });
  // 角の丸み(0〜100%)・辺のふくらみ(-100〜100%)。数値の欄は打っている途中の '-' を待つ
  const pair = (r: HTMLInputElement, n: HTMLInputElement, min: number, max: number, key: 'round' | 'bulge') => {
    r.addEventListener('input', () => { n.value = r.value; update({ settings: { [key]: clampInt(r.value, min, max) / 100 } }); });
    n.addEventListener('input', () => { if (n.value === '' || n.value === '-') return; const v = clampInt(n.value, min, max); r.value = String(v); update({ settings: { [key]: v / 100 } }); });
    r.addEventListener('dblclick', () => { r.value = n.value = '0'; update({ settings: { [key]: 0 } }); });
  };
  pair(round, roundN, 0, 100, 'round');
  pair(bulge, bulgeN, -100, 100, 'bulge');
  ui.inflCorner.addEventListener('change', () => update({ cornerEdit: ui.inflCorner.checked }));
  ui.inflWarpReset.addEventListener('click', () => update({ area: { warp: null } }));
  blend.addEventListener('change', () => update({ settings: { blend: blend.value as InflateBlend } }));
  layerBlend.addEventListener('change', () => update({ layerBlend: layerBlend.value as BlendMode }));
  ui.inflNewLayer.addEventListener('change', () => update({ settings: { newLayer: ui.inflNewLayer.checked } }));
  // 右パネルで重ね方を変えたときも、パネルの表示を合わせる
  app.store.on('layer', ({ keys }) => { if (app.previewingInflate && keys.includes('blend')) fill(); });
  for (const r of profiles) r.addEventListener('change', () => { if (r.checked) update({ settings: { profile: r.value as InflateProfile } }); });
  for (const el of [w, h, heightN, softN, angleN, blurN, roundN, bulgeN]) el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } });

  function finish(apply: boolean): void {
    if (!app.previewingInflate) return;
    if (scheduled || queued.settings || queued.area || queued.layerBlend || queued.cornerEdit !== undefined) flush(); // まだ反映していない入力があれば、先に反映してから確定する
    app.endInflate(apply);
  }
  ui.inflApply.addEventListener('click', () => finish(true));
  ui.inflCancel.addEventListener('click', () => finish(false));
  // ヘルプなど別のダイアログを Esc で閉じたときは、プレビューを捨てない
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && dlg.open && !document.querySelector('dialog[open]:modal')) { e.preventDefault(); finish(false); } });

  /** 入力中の欄は書き換えない(打っている途中の値が消えないように) */
  const set = (el: HTMLInputElement | HTMLSelectElement, v: string) => { if (document.activeElement !== el) el.value = v; };

  function fill(): void {
    const s = app.inflateState; if (!s) return;
    const layer = app.store.findLayer(s.layerId)?.layer, st = s.settings;
    ui.inflTarget.textContent = `レイヤー「${layer?.name ?? ''}」に重ねます。範囲は枠で直せ、枠の外をドラッグすると描き直します。`;
    set(kind, st.shape);
    set(w, String(Math.round(s.area.w))); set(h, String(Math.round(s.area.h)));
    height.max = String(popSliderRange(heightMax()));
    set(height, String(popToSlider(st.height, heightMax()))); set(heightN, String(st.height));
    set(soft, String(Math.round(st.softness * 100))); set(softN, String(Math.round(st.softness * 100)));
    set(angle, String(st.angle)); set(angleN, String(st.angle));
    set(blur, String(st.blur)); set(blurN, String(st.blur));
    const pct = (v: number) => String(Math.round(v * 100));
    set(round, pct(st.round)); set(roundN, pct(st.round)); set(bulge, pct(st.bulge)); set(bulgeN, pct(st.bulge));
    // 角の丸み・辺のふくらみは矩形とカマボコだけに効く
    ui.inflRoundRow.hidden = ui.inflBulgeRow.hidden = st.shape === 'ellipse';
    ui.inflCorner.checked = s.cornerEdit;
    ui.inflWarpReset.disabled = !s.area.warp || s.area.warp.every(v => v === 0);
    set(blend, st.blend);
    set(layerBlend, s.layerBlend);
    ui.inflNewLayer.checked = st.newLayer;
    for (const r of profiles) r.checked = r.value === st.profile;
    // 高さ = ウェイト × ポップ量。このレイヤーのポップ量を超えるときは、新しいレイヤーに作ることを知らせる
    const note = ui.inflNote, pop = s.sourcePop;
    const over = st.height > pop;
    note.textContent = s.newLayer
      ? `${over ? `高さがこのレイヤーのポップ量(${pop}px)を超えるので` : '「新しいレイヤーに作る」がオンなので'}、新しいレイヤー「${s.newLayer.name}」(ポップ量 ${s.newLayer.pop}px)に作ります。このレイヤーは変わりません。`
      : s.limited
        ? over
          ? `高さがこのレイヤーのポップ量(${pop}px)を超えますが、レイヤーが上限の ${LIMITS.maxLayers} 枚なので新しいレイヤーを作れません。${pop}px で止まります。`
          : `レイヤーが上限の ${LIMITS.maxLayers} 枚なので新しいレイヤーを作れません。このレイヤーに重ねます。`
        : `頂上は ${st.height}px(ポップ量 ${pop}px の ${pop > 0 ? Math.round(st.height / pop * 100) : 0}%)。右ドラッグで視点を回して確かめられます。`;
    note.classList.toggle('text-warning', !!s.newLayer || s.limited);
  }

  app.on('inflate', phase => {
    if (phase === 'end') { queued = {}; if (dlg.open) dlg.close(); return; }
    if (phase === 'begin') startHeight = app.inflateState?.settings.height ?? 0;
    fill();
    if (phase === 'begin' && !dlg.open) dlg.show();
  });
}
