/** 右パネル(レイヤー一覧とプロパティ)とツールオプション。 */
import { countLabel, type App } from '../app';
import { PRESETS, PRESET_ORDER, BLENDS, BLEND_ORDER, MOTIONS, MOTION_PARAMS, LIMITS, motionParam, scalePops, layerColor, type MotionParamDef, type Layer, type PhysicsParams, type PresetName, type MotionPattern, type BlendMode, type Project, type Document } from '../model/project';
import { PatchLayer, PatchDocument, PatchProject, SetFov, Batch } from '../commands/commands';
import type { Command } from '../commands/history';
import { prefs } from '../storage/prefs';
import { ui } from './ids';
import { drawWeightThumb } from './imageio';
import { popSliderRange, popToSlider, sliderToPop } from './popSlider';
import { createHelp } from './help';
import { isComposingKey } from './dom';

type Target = 'layer' | 'doc' | 'project';
/** レイヤーへの変更は、選んでいるレイヤーごとに作る(揺れの設定など、変えた項目のほかはそのレイヤーの値を残すため) */
type LayerPatch = (l: Layer) => Partial<Layer>;
/** 変える前の値。レイヤーは id ごと、ドキュメントは id、プロジェクトは '' */
type Snap = Map<string, Record<string, unknown>>;

/** 重ね方のアイコン(一覧の右)。加算: 山の上に山を積む。最大: 2つの山をつないだ外形 */
const BLEND_ICONS: Record<BlendMode, string> = {
  add: '<path d="M1 15C3 10 6 9 12 9s9 1 11 6z" fill="currentColor" opacity=".35"/><path d="M7 9.6C8 4.5 9.8 2 12 2s4 2.5 5 7.6C15.5 9.2 14 9 12 9s-3.5.2-5 .6z" fill="currentColor"/>',
  max: '<path d="M1 15C2.5 8 4.5 4 8 4c2.6 0 3.8 2.4 4.6 5.2C13.6 6.6 15 5 17 5c3 0 4.8 4 6 10z" fill="currentColor" opacity=".8"/>',
};
/** 揺れのアイコン(一覧の右)。揺らさないレイヤーは薄くして斜線を引く(style.css の .swing-btn) */
const SWING_ICON = `<svg class="swing-ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0"/><path class="swing-off" d="M5 20 19 4"/></svg>`;
const blendIcon = (b: BlendMode) => `<svg class="blend-ico" viewBox="0 0 24 16" width="20" height="14" aria-hidden="true">${BLEND_ICONS[b]}</svg>`;

/** 選んだレイヤーで値が揃っていないときに、出力欄に出す文言 */
const MIXED = '混在';

export function bindPanels(app: App): { refresh: () => void } {
  const { store, history } = app;

  /* ---------- 汎用: スライダー → パッチ(ドラッグ中はその場で反映、離したら1手として記録) ---------- */

  function patchNow(target: Target, patch: object | LayerPatch): void {
    if (target === 'layer') { for (const l of app.selectedLayers) store.patchLayer(l.id, typeof patch === 'function' ? (patch as LayerPatch)(l) : patch as Partial<Layer>); }
    else if (target === 'doc') { const d = app.doc; if (d) store.patchDocument(d.id, patch as Partial<Document>); }
    else store.patchProject(patch as Partial<Project>);
  }

  function snapshot(target: Target, keys: string[]): Snap {
    const m: Snap = new Map();
    const put = (id: string, src: object) => {
      const o: Record<string, unknown> = {};
      for (const k of keys) o[k] = structuredClone((src as Record<string, unknown>)[k]);
      m.set(id, o);
    };
    if (target === 'layer') for (const l of app.selectedLayers) put(l.id, l);
    else if (target === 'doc') { if (app.doc) put(app.doc.id, app.doc); }
    else put('', app.project);
    return m;
  }

  /** 変わったものだけを記録する。レイヤーを複数変えたときもまとめて1手 */
  function record(target: Target, label: string, before: Snap, after: Snap): void {
    const changed = [...before].filter(([id, b]) => after.has(id) && JSON.stringify(b) !== JSON.stringify(after.get(id)));
    if (!changed.length) return;
    // 名前の枚数は、選んでいた枚数(値が元から同じで変わらなかったレイヤーも含める)
    const name = target === 'layer' ? countLabel(label, before.size) : label;
    const cmds: Command[] = changed.map(([id, b]) => {
      const a = after.get(id)!;
      return target === 'layer' ? new PatchLayer(name, id, b, a) : target === 'doc' ? new PatchDocument(name, id, b, a) : new PatchProject(name, b, a);
    });
    history.push(cmds.length === 1 ? cmds[0] : new Batch(name, cmds));
  }

  /**
   * 動かしている間はその場で反映し(input)、離したら1手として記録する(change)。
   * begin は動かし始めに1回だけ呼び、その戻り値(変える前の値)を input と commit に渡す。
   */
  function bindLive<B>(el: HTMLInputElement, o: { begin: () => B; input: (value: string, before: B) => void; commit: (before: B) => void }): void {
    let before: { v: B } | null = null;
    el.addEventListener('input', () => { before ??= { v: o.begin() }; o.input(el.value, before.v); });
    el.addEventListener('change', () => { if (before) o.commit(before.v); before = null; });
  }

  /** スライダー → 対象(レイヤー・ドキュメント・プロジェクト)への変更。out があれば値を書く */
  function bindRange(el: HTMLInputElement, out: HTMLElement | null, o: { target: Target; keys: string[]; label: string; toPatch: (v: number) => object | LayerPatch; fmt?: (v: number) => string }): void {
    bindLive(el, {
      begin: () => snapshot(o.target, o.keys),
      input: v => { patchNow(o.target, o.toPatch(+v)); if (out && o.fmt) { out.textContent = o.fmt(+v); out.classList.remove('is-mixed'); } },
      commit: before => record(o.target, o.label, before, snapshot(o.target, o.keys)),
    });
  }

  function exec(target: Target, label: string, patch: object | LayerPatch): void {
    const keys = typeof patch === 'function' ? Object.keys((patch as LayerPatch)(app.selectedLayers[0] ?? ({} as Layer))) : Object.keys(patch);
    const before = snapshot(target, keys);
    patchNow(target, patch);
    record(target, label, before, snapshot(target, keys));
  }

  /** 揺れの1項目だけを、選んでいるレイヤーそれぞれの値に書く */
  const physPatch = (k: keyof PhysicsParams, v: number, custom = true): LayerPatch => l => ({ physics: { ...l.physics, [k]: v / 100, ...(custom ? { preset: 'custom' as PresetName } : {}) } });
  const pct = (v: number) => `${Math.round(v)}`;
  /** 選んでいるレイヤーで値が揃っているか */
  const same = <T>(ls: readonly Layer[], f: (l: Layer) => T) => ls.every(l => f(l) === f(ls[0]));
  /** 出力欄に値か「混在」を書く */
  const setOut = (out: HTMLElement, text: string, mixed: boolean) => { if (out.textContent !== text) out.textContent = text; out.classList.toggle('is-mixed', mixed); };
  /** 選択欄に「混在」を出す(選べない項目。値を選び直すと消える) */
  function setSelect(el: HTMLSelectElement, mixed: boolean, value: string): void {
    let o = el.querySelector<HTMLOptionElement>('option[data-mixed]');
    if (mixed) {
      if (!o) { o = new Option(MIXED, ''); o.dataset.mixed = ''; o.disabled = true; o.hidden = true; el.prepend(o); }
      el.value = '';
    } else { o?.remove(); el.value = value; }
  }

  /* ---------- レイヤーのプロパティ ---------- */

  // ポップ量のスライダーは目盛りと px が比例しない(後半ほど粗い。popSlider.ts)
  // 複数のレイヤーを選んでいるときは、比率を保って伸び縮みさせる。数値とスライダーは一番高いレイヤーの値(model の scalePops)
  const popStart = () => app.selectedLayers.map(l => [l.id, l.pop] as const);
  /** スライダーの右端。最大値の設定より高いレイヤーでは、右端をその値まで広げる(触っただけで一気に下がらないように) */
  const popSliderMax = () => Math.max(app.popMax, ...app.selectedLayers.map(l => l.pop));
  const applyPops = (start: readonly (readonly [string, number])[], target: number) => {
    const pops = scalePops(start.map(([, p]) => p), target);
    start.forEach(([id], i) => store.patchLayer(id, { pop: pops[i] }));
  };
  bindLive(ui.pPop, {
    begin: () => ({ snap: snapshot('layer', ['pop']), start: popStart(), max: popSliderMax() }),
    input: (v, b) => { const p = sliderToPop(+v, b.max); applyPops(b.start, p); ui.pPopN.value = String(p); },
    commit: b => record('layer', 'ポップ量', b.snap, snapshot('layer', ['pop'])),
  });
  ui.pPopN.addEventListener('change', () => {
    const v = Math.max(LIMITS.pop.min, Math.min(LIMITS.pop.max, Math.round(+ui.pPopN.value || 0)));
    const before = snapshot('layer', ['pop']);
    applyPops(popStart(), v);
    record('layer', 'ポップ量', before, snapshot('layer', ['pop']));
  });
  // 重ね方
  const blendSel = ui.pBlend;
  for (const b of BLEND_ORDER) blendSel.add(new Option(BLENDS[b].label, b));
  blendSel.addEventListener('change', () => { if (blendSel.value) exec('layer', '重ね方', { blend: blendSel.value as BlendMode }); });
  // 「揺れ」はレイヤー一覧の行のアイコン、「自動で揺らす」は左のツールバー・メニュー・スマホの上のバーにも置く。どれも App を通して変え、表示はモデルから合わせる
  ui.pSwing.addEventListener('change', () => app.setLayerSwing(ui.pSwing.checked));
  ui.pAuto.addEventListener('change', () => app.setAutoSwing(ui.pAuto.checked));
  // プリセットと揺らし方の選択肢はモデルの定義から作る
  const presetSel = ui.pPreset, motionSel = ui.pMotion;
  presetSel.replaceChildren(...PRESET_ORDER.map(k => new Option(PRESETS[k].label, k)), new Option('カスタム', 'custom'));
  motionSel.replaceChildren(...(Object.keys(MOTIONS) as MotionPattern[]).map(k => new Option(MOTIONS[k].label, k)));

  // プリセットは材質と揺らし方を変え、自動揺らしの周期もおすすめの値にする(スマホのボタンと共通。app.setPreset)
  presetSel.addEventListener('change', () => { if (presetSel.value) app.setPreset(presetSel.value as PresetName); });
  motionSel.addEventListener('change', () => {
    if (!motionSel.value) return;
    exec('layer', '揺らし方', l => ({ physics: { ...l.physics, motion: motionSel.value as MotionPattern, preset: 'custom' } }));
  });

  // 詳細設定の開閉は、見る人ごとの好みとしてブラウザに覚えておく(使えなければ毎回閉じた状態)
  const details = ui.physDetails;
  details.open = prefs.get<boolean>('physDetails') ?? legacyDetailsOpen();
  details.addEventListener('toggle', () => prefs.set('physDetails', details.open));

  /* ---------- 揺らし方の固有設定(選んだ揺らし方に合わせて作り直す) ---------- */

  const paramBox = ui.motionParams;
  let paramKey = '';
  const fmtParam = (d: MotionParamDef, v: number) => (d.unit === '%' ? `${Math.round(v * 100)}%` : d.unit === 'Hz' ? `${v.toFixed(1)}Hz` : '');
  const paramPatch = (key: string, v: number): LayerPatch => l => ({ physics: { ...l.physics, preset: 'custom' as PresetName, motionParams: { ...l.physics.motionParams, [key]: v } } });

  function buildMotionParams(l: Layer): void {
    const motion = l.physics.motion, defs = MOTION_PARAMS[motion];
    paramBox.replaceChildren();
    paramBox.classList.toggle('hidden', defs.length === 0);
    for (const d of defs) {
      const key = `${motion}.${d.key}`, row = document.createElement('div'), label = `${MOTIONS[motion].label}: ${d.label}`;
      row.className = 'prop';
      const labelEl = document.createElement('label');
      labelEl.textContent = d.label; labelEl.htmlFor = `mp-${d.key}`;
      // 補足があれば「?」で開けるようにする(説明は行の下に出す)
      const help = d.hint ? createHelp(`mp-${d.key}-help`, d.label, d.hint) : null;
      const name = help ? Object.assign(document.createElement('span'), { className: 'prop-name' }) : labelEl;
      if (help) name.append(labelEl, help.button);
      if (d.options) {
        const sel = document.createElement('select');
        sel.id = `mp-${d.key}`; sel.className = 'select select-xs col-span-2 w-full'; sel.dataset.param = key;
        sel.append(...d.options.map(([v, text]) => new Option(text, String(v))));
        sel.addEventListener('change', () => exec('layer', label, paramPatch(key, +sel.value)));
        if (help) sel.setAttribute('aria-describedby', help.text.id);
        row.append(name, sel);
      } else {
        const input = document.createElement('input'), out = document.createElement('output');
        input.id = `mp-${d.key}`; input.type = 'range'; input.className = 'range range-xs'; input.dataset.param = key;
        input.min = String(d.min); input.max = String(d.max); input.step = String(d.step);
        bindRange(input, out, { target: 'layer', keys: ['physics'], label, toPatch: v => paramPatch(key, v), fmt: v => fmtParam(d, v) });
        if (help) input.setAttribute('aria-describedby', help.text.id);
        row.append(name, input, out);
      }
      paramBox.append(row);
      if (help) paramBox.append(help.text);
    }
  }

  /** 選んだレイヤーで揺らし方が揃っていないときは、揺らし方ごとの設定は出さない(項目が揺らし方ごとに違うため) */
  function showMixedMotion(): void {
    const note = document.createElement('p');
    note.className = 'text-xs opacity-70'; note.textContent = '揺らし方が揃っていないので、揺らし方ごとの設定は出していません。';
    paramBox.replaceChildren(note);
    paramBox.classList.remove('hidden');
  }

  function refreshMotionParams(l: Layer, ls: readonly Layer[]): void {
    const mixed = !same(ls, x => x.physics.motion), motion = l.physics.motion;
    const k = mixed ? 'mixed' : `${l.id}/${motion}`;
    if (k !== paramKey) { paramKey = k; if (mixed) showMixedMotion(); else buildMotionParams(l); }
    if (mixed) return;
    for (const d of MOTION_PARAMS[motion]) {
      const el = paramBox.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-param="${motion}.${d.key}"]`);
      if (!el) continue;
      const val = (x: Layer) => motionParam(x.physics.motionParams, motion, d.key), v = val(l), all = same(ls, val);
      if (el instanceof HTMLSelectElement) { setSelect(el, !all, String(v)); continue; }
      if (!el.matches(':active')) el.value = String(v);
      setOut(el.nextElementSibling as HTMLElement, all ? fmtParam(d, v) : MIXED, !all);
    }
  }

  bindRange(ui.pHard, ui.pHardO, { target: 'layer', keys: ['physics'], label: '硬さ', toPatch: v => physPatch('hardness', v), fmt: pct });
  bindRange(ui.pMass, ui.pMassO, { target: 'layer', keys: ['physics'], label: '質量', toPatch: v => physPatch('mass', v), fmt: pct });
  bindRange(ui.pDamp, ui.pDampO, { target: 'layer', keys: ['physics'], label: 'おさまり', toPatch: v => physPatch('damping', v), fmt: pct });
  // 「重さ」はプリセットに含まれないので、変えてもカスタムにはしない
  bindRange(ui.pWeight, ui.pWeightO, { target: 'layer', keys: ['physics'], label: '重さ', toPatch: v => physPatch('weight', v, false), fmt: pct });

  /* ---------- 画像・カメラ・自動揺らし ---------- */

  bindRange(ui.pDensity, ui.pDensityO, { target: 'doc', keys: ['meshDensity'], label: 'メッシュ密度', toPatch: v => ({ meshDensity: v }), fmt: v => `${v}` });
  bindRange(ui.pOpacity, ui.pOpacityO, { target: 'doc', keys: ['opacity'], label: '不透明度', toPatch: v => ({ opacity: v / 100 }), fmt: v => `${v}%` });
  // 画角は視点と同じ camera に入っているが、アンドゥでは画角だけを戻す
  bindLive(ui.pFov, {
    begin: () => app.project.camera.fov,
    input: v => { store.patchProject({ camera: { ...app.project.camera, fov: +v } }); ui.pFovO.textContent = `${v}°`; },
    commit: before => { if (before !== +ui.pFov.value) history.push(new SetFov('画角', before, +ui.pFov.value)); },
  });
  bindRange(ui.pPeriod, ui.pPeriodO, { target: 'project', keys: ['autoSwing'], label: '自動揺らしの周期', toPatch: v => ({ autoSwing: { ...app.project.autoSwing, period: v / 10 } }), fmt: v => `${(v / 10).toFixed(1)}秒` });
  bindRange(ui.pAutoStr, ui.pAutoStrO, { target: 'project', keys: ['autoSwing'], label: '自動揺らしの強さ', toPatch: v => ({ autoSwing: { ...app.project.autoSwing, strength: v / 100 } }), fmt: pct });
  ui.pBgTransparent.addEventListener('change', () => app.setBackgroundTransparent(ui.pBgTransparent.checked));
  bindLive(ui.pBgColor, {
    begin: () => snapshot('project', ['background']),
    input: v => patchNow('project', { background: v }),
    commit: before => record('project', '背景色', before, snapshot('project', ['background'])),
  });

  /* ---------- 表示 ---------- */

  // ウェイトの重ね表示は3つから選ぶ(OFF / 選択中 / 全レイヤー)
  const overlayRadios = [[ui.vOverlayOff, 'off'], [ui.vOverlaySel, 'selected'], [ui.vOverlayAll, 'all']] as const;
  for (const [el, mode] of overlayRadios) el.addEventListener('change', () => { if (el.checked) app.setOverlayMode(mode); });
  const viewToggles = [[ui.vFade, 'fade'], [ui.vMulti, 'multi'], [ui.vFlat, 'flat'], [ui.vGrid, 'grid']] as const;
  for (const [el, key] of viewToggles) el.addEventListener('change', () => app.setViewOption(key, el.checked));
  ui.vPause.addEventListener('change', () => app.setPaused(ui.vPause.checked));
  ui.vAutoOverlay.addEventListener('change', () => app.setAutoOverlay(ui.vAutoOverlay.checked));
  ui.vAutoOverlayOff.addEventListener('change', () => app.setAutoOverlayOff(ui.vAutoOverlayOff.checked));
  ui.setPopMax.addEventListener('change', () => {
    const v = parseFloat(ui.setPopMax.value);
    if (Number.isFinite(v)) { app.setPopMax(v); prefs.set('popMax', app.popMax); } // 空欄・数でないときは変えない
    ui.setPopMax.value = String(app.popMax);
  });

  /* ---------- ツールオプション ---------- */

  const brushRange = (el: HTMLInputElement, out: HTMLElement, set: (v: number) => void, fmt: (v: number) => string) => {
    const f = () => { set(+el.value); out.textContent = fmt(+el.value); };
    el.addEventListener('input', f); f();
  };
  brushRange(ui.brushSize, ui.brushSizeO, v => { app.brush.size = v; }, v => `${v}px`);
  brushRange(ui.brushStrength, ui.brushStrengthO, v => { app.brush.strength = v / 100; }, v => `${v}%`);
  brushRange(ui.brushHardness, ui.brushHardnessO, v => { app.brush.hardness = v / 100; }, v => `${v}%`);
  ui.brushPressure.addEventListener('change', () => { app.brush.pressure = ui.brushPressure.value as typeof app.brush.pressure; });

  /* ---------- レイヤー一覧 ---------- */

  const list = ui.layerList;
  const thumbs = new Map<string, HTMLCanvasElement>();
  /** Shift+クリックで範囲を選ぶときの起点 */
  let anchor: string | null = null;
  /** スマホの選択モード(長押しで入る)。入っている間は、タップで足す・外す */
  let selectMode = false;
  /** 一覧のクリックで選び直している間(選択モードを抜けるかの判定用) */
  let fromList = false;

  /** 一覧の行の揺れのアイコン(レイヤーの id ごと) */
  const swingBtns = new Map<string, HTMLButtonElement>();
  function syncSwingBtn(id: string): void {
    const b = swingBtns.get(id), l = app.doc?.layers.find(x => x.id === id);
    if (!b || !l) return;
    const on = l.physics.enabled;
    if (b.getAttribute('aria-pressed') === String(on)) return;
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', '揺らす');
    b.title = on ? '揺れ: ON(押すとOFF)' : '揺れ: OFF(押すとON)';
  }

  function renderList(): void {
    const doc = app.doc;
    // 作り直してもキーボードのフォーカスを失わないよう、一覧にフォーカスがあったかを覚えておく
    const hadFocus = list.contains(document.activeElement) && document.activeElement?.tagName === 'LI';
    // Ctrl+↑↓ で塗りの先と別の行へ移っていることがあるので、フォーカスのあった行を覚えておく
    const focusRow = hadFocus ? (document.activeElement as HTMLElement).dataset.id : undefined;
    // 重ね方・揺れのボタンにあったフォーカスは、作り直したあと同じ行のボタンへ戻す(続けて押せるように)
    const focusBtn = list.contains(document.activeElement) ? ['blend-btn', 'swing-btn'].find(c => document.activeElement?.classList.contains(c)) : undefined;
    const btnFocus = focusBtn ? document.activeElement?.closest('li')?.dataset.id : undefined;
    list.replaceChildren();
    thumbs.clear();
    swingBtns.clear();
    if (!doc) { updateSelection(); return; }
    ui.layerCount.textContent = `${doc.layers.length} / ${LIMITS.maxLayers}`;
    // 上ほど手前(配列の後ろ)に並べる
    doc.layers.forEach((layer, index) => {
      const li = document.createElement('li');
      li.className = 'layer-row flex items-center gap-2 rounded px-1.5 py-1 cursor-pointer hover:bg-base-200';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-label', layer.name);
      li.dataset.id = layer.id;

      const eye = document.createElement('input');
      eye.type = 'checkbox'; eye.className = 'checkbox checkbox-xs'; eye.checked = layer.visible; eye.title = '表示';
      eye.addEventListener('click', e => e.stopPropagation());
      // 表示のチェックは、選んでいても押した1行だけに効かせる
      eye.addEventListener('change', () => history.execute(PatchLayer.from(store, layer.id, { visible: eye.checked }, eye.checked ? 'レイヤーを表示' : 'レイヤーを非表示')));

      const th = document.createElement('canvas');
      // サムネイルは重ね表示と同じレイヤーの色で描く(色は一覧の下から順に決まる。塗っていなくても薄く色が付く)
      th.width = 44; th.height = 33; th.className = 'shrink-0'; th.title = 'ウェイト(重ね表示と同じ色)';
      th.dataset.color = layerColor(index);
      // 塗っていないレイヤーはサムネイルの色が薄いので、下の縁にもレイヤーの色を付ける
      th.style.borderBottom = `3px solid ${layerColor(index)}`;
      drawWeightThumb(th, layer.weights.data, layer.weights.width, layer.weights.height, layerColor(index));
      thumbs.set(layer.id, th);

      const name = document.createElement('span');
      name.className = 'truncate flex-1'; name.textContent = layer.name; name.title = 'ダブルクリックで名前を変更';
      name.addEventListener('dblclick', () => rename(layer, name));

      const info = document.createElement('span');
      info.className = 'layer-info text-xs opacity-70 tabular-nums flex items-center gap-1';
      info.dataset.blend = layer.blend;
      // 重ね方のアイコンは押すと次の重ね方に切り替える(表示のチェックと同じく、押した1行だけに効かせる)
      const blendBtn = document.createElement('button');
      blendBtn.type = 'button'; blendBtn.className = 'blend-btn';
      blendBtn.innerHTML = blendIcon(layer.blend);
      const next = BLEND_ORDER[(BLEND_ORDER.indexOf(layer.blend) + 1) % BLEND_ORDER.length];
      blendBtn.title = `重ね方: ${BLENDS[layer.blend].label}(押すと「${BLENDS[next].label}」に切り替え)`;
      blendBtn.setAttribute('aria-label', `重ね方: ${BLENDS[layer.blend].label}`);
      blendBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (pressed === layer.id) { pressed = null; return; } // 長押しで選択モードに入った直後のクリックでは切り替えない
        history.execute(PatchLayer.from(store, layer.id, { blend: next }, `重ね方を${BLENDS[next].label}に`));
      });
      // 揺れのアイコンも押すとその行だけ揺らす・揺らさないを切り替える
      const swingBtn = document.createElement('button');
      swingBtn.type = 'button'; swingBtn.className = 'swing-btn';
      swingBtn.innerHTML = SWING_ICON;
      swingBtn.dataset.id = layer.id;
      swingBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (pressed === layer.id) { pressed = null; return; }
        const l = app.doc?.layers.find(x => x.id === layer.id);
        if (l) app.setLayerSwing(!l.physics.enabled, [l.id]);
      });
      swingBtns.set(layer.id, swingBtn);
      syncSwingBtn(layer.id);
      const popNum = document.createElement('span');
      popNum.className = 'pop-num';
      popNum.textContent = String(layer.pop); popNum.title = `ポップ量 ${layer.pop}px`;
      info.append(popNum, blendBtn, swingBtn);

      li.append(eye, th, name, info);
      li.addEventListener('click', e => onRowClick(layer.id, e));
      bindLongPress(li, layer.id);
      li.addEventListener('keydown', e => {
        if (e.target !== li) return;
        if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); e.stopPropagation(); rename(layer, name); }
      });
      list.prepend(li);
    });
    updateSelection();
    if (hadFocus) {
      const li = (focusRow && list.querySelector<HTMLElement>(`li[data-id="${CSS.escape(focusRow)}"]`)) || list.querySelector<HTMLElement>('li.is-primary-focus');
      if (li) { for (const x of list.querySelectorAll<HTMLElement>('li')) x.tabIndex = x === li ? 0 : -1; li.focus(); }
    }
    if (btnFocus) list.querySelector<HTMLElement>(`li[data-id="${CSS.escape(btnFocus)}"] .${focusBtn}`)?.focus();
  }

  /** 一覧の下から順の id(Shift の範囲選択用) */
  const order = () => app.doc?.layers.map(l => l.id) ?? [];
  /** 範囲の起点。選択の中に無い(一覧の外で選び直した・消えた)ときは、最後に押したレイヤー */
  const rangeAnchor = () => (anchor && app.selectedLayerIds.has(anchor) && order().includes(anchor) ? anchor : app.activeLayerId!);

  /** クリック: そのレイヤーだけ。Ctrl(⌘): 足す・外す。Shift: 起点からの範囲。選択モードではタップで足す・外す */
  function onRowClick(id: string, e: MouseEvent): void {
    fromList = true;
    try { rowClick(id, e); } finally { fromList = false; }
  }
  function rowClick(id: string, e: MouseEvent): void {
    if (pressed === id) { pressed = null; return; } // 長押しで選択モードに入った直後のクリックは無視する
    if (e.shiftKey) {
      const anchor = rangeAnchor();
      const o = order(), a = o.indexOf(anchor), b = o.indexOf(id);
      app.selectLayers(o.slice(Math.min(a, b), Math.max(a, b) + 1), id);
      return;
    }
    anchor = id;
    if (e.ctrlKey || e.metaKey || selectMode) { toggleLayer(id); return; }
    if (id !== app.activeLayerId || app.multiSelected) app.setActiveLayer(id);
  }
  /** そのレイヤーを選択に足す・外す(Ctrl+クリック・選択モードのタップ・Ctrl+Space)。最後の1枚は外さない */
  function toggleLayer(id: string): void {
    const ids = app.selectedLayerIds;
    anchor = id;
    const was = fromList;
    fromList = true;
    try {
      if (!ids.has(id)) { app.selectLayers([...ids, id], id); return; }
      if (ids.size === 1) return;
      const rest = [...ids].filter(x => x !== id);
      app.selectLayers(rest, id === app.activeLayerId ? rest[rest.length - 1] : app.activeLayerId!);
    } finally { fromList = was; }
  }

  // スマホ: 長押しで選択モードに入り、そのレイヤーを足す
  let pressTimer = 0, pressed: string | null = null;
  function bindLongPress(li: HTMLElement, id: string): void {
    let start: { x: number; y: number } | null = null;
    const cancel = () => { clearTimeout(pressTimer); start = null; };
    li.addEventListener('pointerdown', e => {
      pressed = null; // 長押しのあとにクリックが来なかったときに、次のタップを無視しない
      if (e.pointerType !== 'touch') return;
      start = { x: e.clientX, y: e.clientY };
      clearTimeout(pressTimer);
      pressTimer = window.setTimeout(() => {
        start = null; pressed = id; selectMode = true;
        if (!app.selectedLayerIds.has(id)) app.selectLayers([...app.selectedLayerIds, id], id);
        else updateSelection();
        navigator.vibrate?.(15);
      }, 450);
    });
    li.addEventListener('pointermove', e => { if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) cancel(); });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave'] as const) li.addEventListener(ev, cancel);
    // 長押しでブラウザのメニューを出さない
    li.addEventListener('contextmenu', e => { if (pressed === id || selectMode) e.preventDefault(); });
  }

  // 上下の矢印・Home・End で選ぶレイヤーを移す(Shift 付きは範囲を広げる)。Esc で1枚に戻す
  list.addEventListener('keydown', e => {
    if ((e.target as HTMLElement).tagName !== 'LI') return;
    if (e.key === 'Escape' && (app.multiSelected || selectMode)) {
      e.preventDefault(); e.stopPropagation(); selectMode = false;
      if (app.activeLayerId) app.setActiveLayer(app.activeLayerId);
      return;
    }
    const items = [...list.querySelectorAll<HTMLElement>('li')];
    const i = items.indexOf(e.target as HTMLElement);
    const ctrl = e.ctrlKey || e.metaKey;
    // Ctrl+Space: フォーカスしている行を足す・外す(クリックの Ctrl と同じ)。3Dビューの平行移動(Space)に回さない
    if (ctrl && e.code === 'Space' && !e.shiftKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation();
      if (e.repeat) return; // 押し続けても足す・外すを繰り返さない
      const id = (e.target as HTMLElement).dataset.id;
      if (id && !app.previewing) toggleLayer(id);
      return;
    }
    // Ctrl+↑↓: 選択は変えずにフォーカスだけ移す(離れた行へ移ってから Ctrl+Space で足すため)
    if (ctrl && !e.shiftKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault(); e.stopPropagation();
      const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1)))];
      for (const li of items) li.tabIndex = li === next ? 0 : -1;
      next.focus();
      return;
    }
    const j = e.key === 'ArrowUp' ? i - 1 : e.key === 'ArrowDown' ? i + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -2;
    if (j === -2 || ctrl) return; // Ctrl+Home などはコマンドに回す
    e.preventDefault(); e.stopPropagation();
    const next = items[Math.max(0, Math.min(items.length - 1, j))], id = next.dataset.id;
    if (id && e.shiftKey) {
      const anchor = rangeAnchor();
      const o = order(), a = o.indexOf(anchor), b = o.indexOf(id);
      app.selectLayers(o.slice(Math.min(a, b), Math.max(a, b) + 1), id);
    } else if (id) { anchor = id; if (id !== app.activeLayerId || app.multiSelected) app.setActiveLayer(id); }
    for (const li of items) li.tabIndex = li === next ? 0 : -1;
    next.focus();
  });

  // プレビュー中(膨らみ・全体ぼかし)は、仮のレイヤーやぼかし中のレイヤーの選択を変えない
  ui.layerSelAll.addEventListener('click', () => { if (!app.previewing) app.selectAllLayers(); });
  ui.layerSelOne.addEventListener('click', () => { if (app.previewing) return; selectMode = false; if (app.activeLayerId) app.setActiveLayer(app.activeLayerId); });
  ui.layerSelDone.addEventListener('click', () => { selectMode = false; updateSelection(); });

  function updateSelection(): void {
    const ids = app.selectedLayerIds;
    // Ctrl+↑↓ で移った行にフォーカスがあるなら、Tab の止まる先もその行に残す
    const focused = document.activeElement instanceof HTMLElement && document.activeElement.tagName === 'LI' && list.contains(document.activeElement) ? document.activeElement : null;
    list.querySelectorAll<HTMLElement>('li').forEach(li => {
      const on = ids.has(li.dataset.id!), primary = li.dataset.id === app.activeLayerId;
      li.setAttribute('aria-selected', String(on));
      // 選んだ中で、塗りの先になるレイヤー(最後に押したもの)に枠を付ける。複数のときだけ見分けが要る
      li.classList.toggle('is-primary', primary && ids.size > 1);
      li.classList.toggle('is-primary-focus', primary);
      // 一覧の中では最後に押した項目だけを Tab で止め、矢印キーで移る(roving tabindex)
      li.tabIndex = (focused ? li === focused : primary) ? 0 : -1;
    });
    const n = ids.size;
    ui.layerSelBar.hidden = n < 2 && !selectMode;
    ui.layerSelText.textContent = selectMode ? `選択モード: ${n}枚` : `${n}枚を選択中`;
    ui.layerSelDone.hidden = !selectMode;
  }

  function rename(layer: Layer, span: HTMLElement): void {
    const input = document.createElement('input');
    input.className = 'input input-xs flex-1 min-w-0'; input.value = layer.name;
    span.replaceWith(input); input.focus(); input.select();
    let done = false;
    const finish = (ok: boolean, byKey = false) => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (ok && v && v !== layer.name) history.execute(PatchLayer.from(store, layer.id, { name: v }, '名前の変更'));
      else renderList();
      // Enter / Esc で終えたときは、項目にフォーカスを戻す(クリックで外したときは奪わない)
      if (byKey) list.querySelector<HTMLElement>('li.is-primary-focus')?.focus();
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (isComposingKey(e)) return; // 変換を確定する Enter・取り消す Esc では抜けない
      if (e.key === 'Enter') finish(true, true);
      if (e.key === 'Escape') finish(false, true);
    });
    input.addEventListener('blur', () => finish(true));
  }

  const pendingThumbs = new Set<string>();
  let thumbTimer = 0;
  store.on('weights', ({ layerId }) => {
    pendingThumbs.add(layerId);
    if (thumbTimer) return;
    thumbTimer = window.setTimeout(() => {
      thumbTimer = 0;
      for (const id of pendingThumbs) {
        const c = thumbs.get(id), found = store.findLayer(id), l = found?.layer;
        if (c && l) drawWeightThumb(c, l.weights.data, l.weights.width, l.weights.height, layerColor(found.index));
      }
      pendingThumbs.clear();
    }, 250);
  });

  /* ---------- 状態 → 画面 ---------- */

  const setRange = (el: HTMLInputElement, out: HTMLElement | null, v: number, text?: string) => {
    if (document.activeElement !== el || !el.matches(':active')) el.value = String(v);
    if (out && text !== undefined) out.textContent = text;
  };

  /**
   * 選択中のレイヤーが無いとき(画像を開く前)に止める部品の入れ物。表示の切り替えは画像が無くても使えるので除く。
   * スマホではシートへ移すので、いま #props の中にあるかどうかではなく、最初に入れ物ごと覚えておく
   */
  const viewSection = ui.vOverlayOff.closest('section');
  const layerSections = [...ui.props.querySelectorAll('section')].filter(s => s !== viewSection);

  function refreshProps(): void {
    const l = app.activeLayer, d = app.doc, p = app.project;
    const disabled = !l;
    for (const s of layerSections) for (const el of s.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) el.disabled = disabled;
    // 膨らませるのプレビュー中は、新しいレイヤーに作るかどうかがこのレイヤーのポップ量で決まるので、ポップ量は触らせない。
    // レイヤー一覧も、仮に入れたレイヤーの名前や表示を変えて記録しないよう、操作できなくする
    if (app.previewingInflate) ui.pPop.disabled = ui.pPopN.disabled = true;
    // 全体ぼかしのプレビュー中も、ぼかしているレイヤーを切り替えたり消したりしないよう、一覧は操作できなくする
    list.inert = ui.layerSelBar.inert = app.previewing;
    list.classList.toggle('opacity-60', app.previewing);
    const ls = app.selectedLayers;
    // 複数のときは「最後に押したレイヤー ほか N 枚」。ほかの名前は title で見せる
    ui.activeLayerName.textContent = !l ? '-' : ls.length > 1 ? `${l.name} ほか${ls.length - 1}枚` : l.name;
    ui.activeLayerName.title = ls.length > 1 ? ls.map(x => x.name).reverse().join('、') : '';
    if (l && ls.length) {
      // ポップ量は一番高いレイヤーの値を出す(動かすとほかは同じ比率で変わる)
      const top = Math.max(...ls.map(x => x.pop));
      const max = popSliderMax();
      ui.pPop.max = String(popSliderRange(max));
      setRange(ui.pPop, null, popToSlider(top, max));
      if (document.activeElement !== ui.pPopN) ui.pPopN.value = String(top);
      const blendMixed = !same(ls, x => x.blend);
      setSelect(blendSel, blendMixed, l.blend);
      // 説明は画面に並べず、「?」で開く欄に入れる(選択欄の aria-describedby でも読み上げる)
      ui.pBlendDesc.textContent = blendMixed ? '選んだレイヤーで重ね方が違います。選ぶと全部をその重ね方にします。' : BLENDS[l.blend].desc;
      const swingMixed = !same(ls, x => x.physics.enabled);
      ui.pSwing.checked = !swingMixed && l.physics.enabled; ui.pSwing.indeterminate = swingMixed;
      const presetMixed = !same(ls, x => x.physics.preset), motionMixed = !same(ls, x => x.physics.motion);
      setSelect(presetSel, presetMixed, l.physics.preset);
      setSelect(motionSel, motionMixed, l.physics.motion);
      ui.pPresetDesc.textContent = presetMixed ? '選んだレイヤーでプリセットが違います。選ぶと全部に当てます。'
        : l.physics.preset === 'custom' ? `${MOTIONS[l.physics.motion].desc}(詳細設定で調整中)` : PRESETS[l.physics.preset].desc;
      refreshMotionParams(l, ls);
      ui.physSummary.textContent = `— ${motionMixed ? MIXED : MOTIONS[l.physics.motion].label}`;
      const mat = (el: HTMLInputElement, out: HTMLElement, k: 'hardness' | 'mass' | 'weight' | 'damping') => {
        const all = same(ls, x => x.physics[k]);
        setRange(el, null, Math.round(l.physics[k] * 100));
        setOut(out, all ? pct(l.physics[k] * 100) : MIXED, !all);
      };
      mat(ui.pHard, ui.pHardO, 'hardness'); mat(ui.pMass, ui.pMassO, 'mass'); mat(ui.pWeight, ui.pWeightO, 'weight'); mat(ui.pDamp, ui.pDampO, 'damping');
    }
    if (d) {
      setRange(ui.pDensity, ui.pDensityO, d.meshDensity, `${d.meshDensity}`);
      setRange(ui.pOpacity, ui.pOpacityO, Math.round(d.opacity * 100), `${Math.round(d.opacity * 100)}%`);
    }
    setRange(ui.pFov, ui.pFovO, p.camera.fov, `${p.camera.fov}°`);
    ui.pBgTransparent.checked = p.background === null;
    ui.pBgColor.value = p.background ?? app.bgColor;
    ui.pAuto.checked = p.autoSwing.enabled;
    setRange(ui.pPeriod, ui.pPeriodO, Math.round(p.autoSwing.period * 10), `${p.autoSwing.period.toFixed(1)}秒`);
    setRange(ui.pAutoStr, ui.pAutoStrO, Math.round(p.autoSwing.strength * 100), pct(p.autoSwing.strength * 100));
    for (const [el, key] of viewToggles) el.checked = app.view[key];
    for (const [el, mode] of overlayRadios) el.checked = app.overlayMode === mode;
    ui.vPause.checked = app.paused;
    ui.vAutoOverlay.checked = app.autoOverlay;
    ui.vAutoOverlayOff.checked = app.autoOverlayOff;
    ui.vAutoOverlayOff.disabled = !app.autoOverlay;
    if (document.activeElement !== ui.setPopMax) ui.setPopMax.value = String(app.popMax);
  }

  let queued = false;
  const refresh = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; refreshProps(); });
  };

  store.on('replace', () => { renderList(); refresh(); });
  store.on('layers', () => { renderList(); refresh(); });
  // 複数のレイヤーを一度に変えると1枚ごとに届くので、一覧の作り直しは次の描画の前に1回にまとめる
  let listQueued = false;
  const queueList = () => {
    if (listQueued) return;
    listQueued = true;
    requestAnimationFrame(() => { listQueued = false; renderList(); });
  };
  store.on('layer', ({ layerId, keys }) => {
    if (keys.some(k => k === 'name' || k === 'visible' || k === 'pop' || k === 'blend')) queueList();
    // 揺れの設定はスライダーで続けて変わるので、一覧は作り直さずアイコンだけ合わせる
    else if (keys.includes('physics')) syncSwingBtn(layerId);
    refresh();
  });
  store.on('document', refresh);
  store.on('project', refresh);
  // 一覧の外(新規・削除・ファイルの読み込みなど)で1枚を選び直したときは、選択モードを抜ける。一覧のタップで減ったときは抜けない
  app.on('active', () => { if (!fromList && !app.multiSelected) selectMode = false; updateSelection(); refresh(); });
  app.on('view', refresh);
  app.on('inflate', refresh); // プレビュー中はポップ量を触らせない
  app.on('blur', refresh);

  renderList(); refresh();
  return { refresh };
}

/** 前の版は詳細設定の開閉を別のキーに覚えていた。prefs にまだ無いときだけ読む */
function legacyDetailsOpen(): boolean {
  try { return localStorage.getItem('popstage.physDetails') === 'open'; } catch { return false; }
}
