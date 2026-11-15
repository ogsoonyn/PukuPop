/** 書き出しダイアログ。 */
import type { App } from '../app';
import { availableFormats, canEncodeAt, estimateExportBytes, EXPORT_MEMORY_WARN, FORMAT_INFO, even, holdsAllFrames, type ExportFormat } from '../export/encoders';
import type { ExportSettings } from '../export/exporter';
import { ask, saveFile, toast, formatBytes } from './dom';
import { ui } from './ids';
import { persistControls } from '../storage/prefs';
import { takeSeconds } from '../physics/take';

const FORMATS: ExportFormat[] = ['mp4', 'webm', 'webm-alpha', 'png', 'gif', 'apng', 'still'];

export function bindExportDialog(app: App): { open: () => void } {
  const dlg = ui.exportDialog;
  const fmt = ui.exFormat, W = ui.exW, H = ui.exH;
  const dur = ui.exDur, loop = ui.exLoop;
  const bgColor = ui.exBgColor, progress = ui.exProgress;
  const status = ui.exStatus, note = ui.exNote, start = ui.exStart, cancel = ui.exCancel;
  let available: Record<ExportFormat, boolean> | null = null;
  let running: AbortController | null = null;
  let initialized = false;

  const radio = (name: string) => document.querySelector<HTMLInputElement>(`input[name=${name}]:checked`)!.value;
  const setRadio = (name: string, value: string) => { const r = document.querySelector<HTMLInputElement>(`input[name=${name}][value="${value}"]`); if (r) r.checked = true; };

  function viewSize(): [number, number] {
    const c = app.stage.canvas, s = Math.min(2, window.devicePixelRatio || 1);
    let w = c.clientWidth * s, h = c.clientHeight * s;
    const k = Math.min(1, 1920 / Math.max(w, h));
    w *= k; h *= k;
    return [even(w), even(h)];
  }

  function update(): void {
    const f = fmt.value as ExportFormat, info = FORMAT_INFO[f];
    const alphaRadio = document.querySelector<HTMLInputElement>('input[name=exBg][value=alpha]')!;
    alphaRadio.disabled = !info.alpha;
    ui.exBgAlphaLabel.classList.toggle('opacity-40', !info.alpha);
    if (!info.alpha && alphaRadio.checked) setRadio('exBg', 'color');
    const T = app.project.autoSwing.period;
    const rec = app.recorder.seconds;
    ui.exRecLen.textContent = rec > 0.5 ? `(直近 ${rec.toFixed(1)} 秒を記録中)` : '(記録がありません)';
    document.querySelector<HTMLInputElement>('input[name=exMotion][value=replay]')!.disabled = rec < 0.5;
    const L = takeSeconds(app.project.take);
    ui.exTakeLen.textContent = L > 0 ? `(1周 ${L.toFixed(1)} 秒)` : '(記録がありません)';
    const loopRadio = document.querySelector<HTMLInputElement>('input[name=exMotion][value=loop]')!;
    loopRadio.disabled = L <= 0;
    if (loopRadio.disabled && loopRadio.checked) setRadio('exMotion', 'auto');
    // 静止画は今の見た目を1枚撮るので、長さ・fps・動きの元・ループは使わない(選んだ値はそのまま残す)
    const still = f === 'still';
    if (still) document.querySelectorAll<HTMLInputElement>('input[name=exMotion], input[name=exFps]').forEach(r => { r.disabled = true; });
    else document.querySelectorAll<HTMLInputElement>('input[name=exFps], input[name=exMotion][value=auto]').forEach(r => { r.disabled = false; });
    dur.disabled = still;
    const motion = still ? null : radio('exMotion');
    loop.disabled = motion !== 'auto';
    const notes: string[] = [];
    if (still) notes.push('今の視点と揺れのまま、1枚の PNG にします。');
    if (motion === 'auto' && loop.checked) notes.push(`長さは周期 ${T.toFixed(1)} 秒の整数倍に丸めます(継ぎ目の無いループになります)。`);
    if (motion === 'replay') notes.push('「つかむ」やカメラの操作を記録どおりに再生します。最長 60 秒。');
    if (motion === 'loop') {
      notes.push(`長さは記録の1周 ${L.toFixed(1)} 秒の整数倍に丸めます。揺れが落ち着くまで何周か回してから撮るので、継ぎ目の無いループになります。`);
      if (app.project.autoSwing.enabled) notes.push('「自動で揺らす」がオンです。周期が記録の長さと合わないと、継ぎ目で自動の揺れがずれます。');
    }
    if (f === 'gif') notes.push('GIF は 256 色・1ビット透過です。サイズを小さく、30fps にすると軽くなります。');
    if (f === 'webm-alpha') notes.push('透過付き WebM は Chrome / Edge で再生できます。動画編集ソフトによっては透過が読めません。');
    if (f === 'png') notes.push('フレームごとの PNG を ZIP にまとめます。動画編集の素材向けです。');
    if (f === 'apng') notes.push('フルカラー・透過のままループします。対応していないアプリでは1枚目だけが出ます。');
    if (holdsAllFrames(f)) {
      const s = readSettings(), est = estimateExportBytes(f, s.width, s.height, Math.round(s.duration * s.fps));
      notes.push(`全フレームをメモリに溜めてから保存します(目安 ${formatBytes(est)} まで)。`);
    }
    if (available && !available.mp4) notes.push('このブラウザでは MP4 を書き出せません。');
    note.textContent = notes.join(' ');
  }

  async function init(): Promise<void> {
    available = await availableFormats();
    fmt.replaceChildren(...FORMATS.map(f => {
      const o = document.createElement('option');
      o.value = f; o.textContent = FORMAT_INFO[f].label + (available![f] ? '' : '(このブラウザでは不可)');
      o.disabled = !available![f];
      return o;
    }));
    fmt.value = available.mp4 ? 'mp4' : available.webm ? 'webm' : 'png';
    initialized = true;
  }

  fmt.addEventListener('change', update);
  loop.addEventListener('change', update);
  document.querySelectorAll('input[name=exMotion], input[name=exBg]').forEach(r => r.addEventListener('change', update));
  ui.exSizePreset.addEventListener('change', e => {
    const v = (e.target as HTMLSelectElement).value;
    if (!v) return;
    const [w, h] = v === 'view' ? viewSize() : v.split('x').map(Number);
    W.value = String(w); H.value = String(h);
    (e.target as HTMLSelectElement).value = '';
  });

  function readSettings(): ExportSettings {
    const motion = radio('exMotion') as ExportSettings['motion'];
    let duration = Math.max(0.5, Math.min(60, +dur.value || 3));
    if (motion === 'auto' && loop.checked) {
      const T = app.project.autoSwing.period;
      duration = Math.max(1, Math.round(duration / T)) * T;
    }
    const L = takeSeconds(app.project.take);
    if (motion === 'loop' && L > 0) duration = Math.max(1, Math.min(Math.floor(60 / L), Math.round(duration / L))) * L;
    return {
      format: fmt.value as ExportFormat,
      width: even(Math.max(16, Math.min(3840, +W.value || 1280))),
      height: even(Math.max(16, Math.min(3840, +H.value || 720))),
      fps: (+radio('exFps') === 30 ? 30 : 60),
      duration,
      background: radio('exBg') === 'alpha' ? null : bgColor.value,
      motion,
    };
  }

  function setRunning(on: boolean): void {
    start.disabled = on;
    cancel.textContent = on ? '中止' : '閉じる';
    progress.classList.toggle('hidden', !on);
    dlg.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#exportForm input, #exportForm select').forEach(el => { el.disabled = on; });
    if (!on) update();
    ui.sRec.textContent = on ? '● 書き出し中' : '';
  }

  /** 書き出してよいかを確かめる(確認の待ち中に2回目のクリックや「閉じる」が通らないよう、呼ぶ側でボタンを止めておく) */
  async function confirmStart(s: ExportSettings): Promise<boolean> {
    if (s.width * s.height > app.stage.maxTextureSize ** 2) { toast('サイズが大きすぎます。', 'error'); return false; }
    // 動画は実際のサイズでエンコードできるかを先に確かめる(形式の一覧は 1280×720 で調べている)
    if (!(await canEncodeAt(s.format, s.width, s.height))) {
      toast(`このブラウザでは ${s.width}×${s.height} の${FORMAT_INFO[s.format].label}を書き出せません。サイズを小さくしてください。`, 'error', 6000);
      return false;
    }
    const est = estimateExportBytes(s.format, s.width, s.height, Math.round(s.duration * s.fps));
    if (est > EXPORT_MEMORY_WARN) {
      const r = await ask({
        title: '書き出すデータが大きくなります',
        body: `${FORMAT_INFO[s.format].label}は全フレームをメモリに溜めてから保存するため、目安で ${formatBytes(est)} を使います。タブのメモリが足りなくなり、落ちるおそれがあります。
サイズや長さを減らすか、MP4 / WebM を選ぶと軽くなります。`,
        yes: 'このまま書き出す', no: 'やめる',
      });
      if (!r.ok) return false;
    }
    return true;
  }

  start.addEventListener('click', async () => {
    if (running || start.disabled) return;
    const s = readSettings();
    start.disabled = true; cancel.disabled = true;
    let ok = false;
    try { ok = await confirmStart(s); } finally { start.disabled = false; cancel.disabled = false; }
    if (!ok || !dlg.open) return; // 確認の間に Esc でダイアログが閉じられたら書き出さない
    if (s.format !== 'still') dur.value = String(+s.duration.toFixed(2));
    running = new AbortController();
    setRunning(true);
    const t0 = performance.now();
    try {
      const r = await app.exportMedia(s, (done, total) => {
        progress.value = (done / total) * 100;
        status.textContent = `${done} / ${total} フレーム`;
      }, running.signal);
      status.textContent = `${r.frames} フレーム、${formatBytes(r.blob.size)}、${((performance.now() - t0) / 1000).toFixed(1)} 秒で生成しました。保存先を選んでください。`;
      const info = FORMAT_INFO[s.format];
      const saved = await saveFile(r.blob, r.filename, [{ description: info.label, accept: { [info.mime]: [`.${info.ext}`] } }]);
      if (saved !== undefined) { toast(`「${saved?.name ?? r.filename}」を保存しました。`, 'success'); status.textContent = '保存しました。'; }
      else status.textContent = '保存をキャンセルしました。';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') status.textContent = '中止しました。';
      else { console.error(e); status.textContent = `失敗しました: ${e instanceof Error ? e.message : e}`; }
    } finally {
      running = null;
      setRunning(false);
    }
  });

  cancel.addEventListener('click', () => { if (running) running.abort(); else dlg.close(); });
  dlg.addEventListener('cancel', e => { if (running) e.preventDefault(); });

  return {
    async open() {
      if (!app.doc) { toast('先に画像を開いてください。', 'warning'); return; }
      if (!initialized) {
        await init();
        // 形式・大きさ・長さ・fps・ループはブラウザに覚えておく(形式の一覧ができてから戻す)
        // 形式は最後に戻す。静止画を先に戻すと fps のボタンが使えなくなり、覚えた fps が戻らないため
        persistControls('export', [W, H, dur, loop, ...document.querySelectorAll<HTMLInputElement>('input[name=exFps]'), fmt]);
      }
      if (!W.value) { const [w, h] = viewSize(); W.value = String(w); H.value = String(h); }
      if (!dur.value) dur.value = String(+(app.project.autoSwing.period * 2).toFixed(2));
      bgColor.value = app.project.background ?? app.bgColor;
      setRadio('exBg', app.project.background === null && FORMAT_INFO[fmt.value as ExportFormat].alpha ? 'alpha' : 'color');
      status.textContent = '';
      progress.value = 0;
      update();
      dlg.showModal();
    },
  };
}
