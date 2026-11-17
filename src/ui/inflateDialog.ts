/**
 * 「膨らませる」のパネル。膨らみツールで範囲を描くと開き、数値を変えるとその場でプレビューする。
 * 視点を回して形を確かめられるよう、ほかの操作を止めないダイアログ(show)にする。適用で1手として記録する。
 */
import { INFLATE_ANGLE, INFLATE_BLUR, type App, type InflatePatch, type InflateSettings } from '../app';
import type { InflateProfile, InflateBlend } from '../paint/inflate';
import { BLENDS, BLEND_ORDER, LIMITS, type BlendMode } from '../model/project';
import { popSliderRange, popToSlider, sliderToPop } from './popSlider';
import { ui } from './ids';

export function bindInflateDialog(app: App): void {
  const dlg = ui.inflateDialog;
  const kind = ui.inflKind, w = ui.inflW, h = ui.inflH;
  const height = ui.inflHeight, heightN = ui.inflHeightN;
  const soft = ui.inflSoft, softN = ui.inflSoftN;
  const angle = ui.inflAngle, angleN = ui.inflAngleN;
  const blur = ui.inflBlur, blurN = ui.inflBlurN;
  const blend = ui.inflBlend, layerBlend = ui.inflLayerBlend;
  for (const b of BLEND_ORDER) layerBlend.add(new Option(BLENDS[b].label, b));
  const profiles = [...document.querySelectorAll<HTMLInputElement>('input[name=inflProfile]')];
  let queued: InflatePatch = {}, scheduled = false;

  /** 高さのスライダーの右端。最大値の設定より高い高さで始めたときは、その値まで広げる(触っただけで一気に下がらないように) */
  let startHeight = 0;
  const heightMax = () => Math.max(app.popMax, startHeight);
  const clampInt = (v: string, min: number, max: number) => Math.max(min, Math.min(max, Math.round(+v || 0)));
  const flush = () => { const q = queued; queued = {}; app.updateInflate(q); };
  /** 大きな画像でも滑らかに動かせるよう、プレビューは1フレームに1回だけ計算する */
  const update = (patch: InflatePatch) => {
    queued = { settings: { ...queued.settings, ...patch.settings }, area: { ...queued.area, ...patch.area }, layerBlend: patch.layerBlend ?? queued.layerBlend };
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
  blend.addEventListener('change', () => update({ settings: { blend: blend.value as InflateBlend } }));
  layerBlend.addEventListener('change', () => update({ layerBlend: layerBlend.value as BlendMode }));
  ui.inflNewLayer.addEventListener('change', () => update({ settings: { newLayer: ui.inflNewLayer.checked } }));
  // 右パネルで重ね方を変えたときも、パネルの表示を合わせる
  app.store.on('layer', ({ keys }) => { if (app.previewingInflate && keys.includes('blend')) fill(); });
  for (const r of profiles) r.addEventListener('change', () => { if (r.checked) update({ settings: { profile: r.value as InflateProfile } }); });
  for (const el of [w, h, heightN, softN, angleN, blurN]) el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } });

  function finish(apply: boolean): void {
    if (!app.previewingInflate) return;
    if (scheduled || queued.settings || queued.area || queued.layerBlend) flush(); // まだ反映していない入力があれば、先に反映してから確定する
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
