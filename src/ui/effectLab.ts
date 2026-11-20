/**
 * 膨らんだ瞬間のエフェクトの出し方を試すパネル(実験用のテストページ、?fxlab)。
 * 出し方の切り替えと、手前への揺れ具合で決めるときの下限・跳ね返りの割合を変え、選んでいるレイヤーの膨らみの量をグラフで見る。
 */
import { effectLab, labTrace, LAB_KEEP } from '../physics/effectLab';

interface LabApp {
  readonly activeLayerId: string | null;
  readonly activeLayer: { effect: { timing: 'burst' | 'peak' } } | undefined;
  readonly world: { time: number };
  readonly store: { emit(type: 'change', v: undefined): void };
}

export function mountEffectLab(app: LabApp): void {
  effectLab.mode = 'forward';
  effectLab.trace = true;
  const box = document.createElement('div');
  box.id = 'fxLab';
  box.style.cssText = 'position:fixed;left:96px;bottom:36px;z-index:60;width:390px;background:var(--color-base-100,#fff);color:var(--color-base-content,#222);border:1px solid #c9b;border-radius:10px;padding:10px 12px;font-size:12px;box-shadow:0 4px 16px #0003;display:flex;flex-direction:column;gap:6px;';
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center"><b>エフェクトの出し方のテスト</b><button id="fxLabMin" class="btn btn-xs btn-ghost">たたむ</button></div>
    <div id="fxLabBody" style="display:flex;flex-direction:column;gap:6px">
      <label style="display:flex;justify-content:space-between;gap:8px">判定
        <select id="fxLabMode" class="select select-xs"><option value="forward">手前への揺れ具合(すべての揺らし方)</option><option value="push">今の方式(膨らむ揺らし方だけ)</option></select></label>
      <div id="fxLabSliders" style="display:flex;flex-direction:column;gap:4px"></div>
      <canvas id="fxLabGraph" width="366" height="120" style="width:366px;height:120px;border-radius:6px;background:#f7f2f5"></canvas>
      <div style="opacity:.75;line-height:1.5">青: 膨らみの量(手前へのずれ ÷ ポップ量 + 広がり)。突き出しを1回ごとに測り、● 出た / ○ 出ない(跳ね返り・弱い)。下の一覧は新しい順。</div>
      <div id="fxLabLog" style="font-family:ui-monospace,monospace;font-size:11px;line-height:1.5;max-height:7.5em;overflow:auto"></div>
    </div>`;
  document.body.append(box);
  const $ = <T extends HTMLElement>(id: string) => box.querySelector<T>('#' + id)!;
  const mode = $<HTMLSelectElement>('fxLabMode');
  mode.value = effectLab.mode;
  mode.addEventListener('change', () => { effectLab.mode = mode.value as 'push' | 'forward'; sliders.hidden = effectLab.mode !== 'forward'; app.store.emit('change', undefined); });
  $('fxLabMin').addEventListener('click', () => { const b = $('fxLabBody'); b.hidden = !b.hidden; $('fxLabMin').textContent = b.hidden ? 'ひらく' : 'たたむ'; });
  const sliders = $('fxLabSliders');
  const defs: [keyof typeof effectLab, string, number, number, number, (v: number) => string][] = [
    ['vmin', '膨らみ始めの下限(速さ)', 0.1, 6, 0.1, v => v.toFixed(1)],
    ['amin', '一番膨らんだときの下限(量)', 0.01, 0.8, 0.01, v => v.toFixed(2)],
    ['rebound', '跳ね返りとみなす割合', 0, 1.2, 0.05, v => `${Math.round(v * 100)}%`],
    ['decay', '前の強さが薄れる時間', 0.1, 5, 0.1, v => `${v.toFixed(1)}秒`],
  ];
  for (const [key, label, min, max, step, fmt] of defs) {
    const row = document.createElement('label');
    row.style.cssText = 'display:grid;grid-template-columns:12.5em 1fr 3.5em;align-items:center;gap:6px';
    const input = Object.assign(document.createElement('input'), { type: 'range', min: String(min), max: String(max), step: String(step), value: String(effectLab[key]), className: 'range range-xs', id: `fxLab_${key}` });
    const out = document.createElement('output');
    out.textContent = fmt(effectLab[key] as number);
    input.addEventListener('input', () => { (effectLab as unknown as Record<string, number>)[key] = +input.value; out.textContent = fmt(+input.value); });
    row.append(label, input, out);
    sliders.append(row);
  }
  const graph = $<HTMLCanvasElement>('fxLabGraph'), g = graph.getContext('2d')!, log = $('fxLabLog');
  let lastLog = '';
  const draw = () => {
    requestAnimationFrame(draw);
    if ($('fxLabBody').hidden) return;
    const W = graph.width, H = graph.height, id = app.activeLayerId, tr = id ? labTrace.get(id) ?? [] : [];
    g.clearRect(0, 0, W, H);
    const now = tr.length ? tr[tr.length - 1].t : app.world.time;
    let lo = 0, hi = 0.3;
    for (const p of tr) { lo = Math.min(lo, p.I); hi = Math.max(hi, p.I); }
    const X = (t: number) => W - ((now - t) / LAB_KEEP) * W, Y = (I: number) => H - 8 - ((I - lo) / (hi - lo || 1)) * (H - 16);
    g.strokeStyle = '#0002'; g.beginPath(); g.moveTo(0, Y(0)); g.lineTo(W, Y(0)); g.stroke();
    g.strokeStyle = '#3a6fd8'; g.lineWidth = 1.5; g.beginPath();
    tr.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p.I)) : g.moveTo(X(p.t), Y(p.I))));
    g.stroke();
    for (const p of tr) {
      if (p.S === undefined) continue;
      g.beginPath(); g.arc(X(p.t), Y(p.I), 4, 0, Math.PI * 2);
      if (p.fire) { g.fillStyle = '#e0457b'; g.fill(); } else { g.strokeStyle = '#999'; g.lineWidth = 1; g.stroke(); }
    }
    const peak = app.activeLayer?.effect.timing === 'peak', unit = peak ? '量' : '速さ';
    const rows = tr.filter(p => p.S !== undefined).slice(-12).reverse()
      .map(p => `${p.fire ? '●' : '○'} ${unit} ${p.S!.toFixed(2)} / 境目 ${p.ref!.toFixed(2)}`);
    const text = effectLab.mode === 'forward' ? (rows.join('\n') || 'まだ突き出しがありません') : '今の方式では記録しません';
    if (text !== lastLog) { log.textContent = text; log.style.whiteSpace = 'pre'; lastLog = text; }
  };
  draw();
}
