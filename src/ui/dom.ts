/** DOM まわりの小さな道具。 */
import { ui } from './ids';

/**
 * 日本語などの変換の途中のキーか。変換を確定する Enter・取り消す Esc で欄を抜けないよう、
 * Enter / Esc で欄を閉じる処理の前に確かめる(Safari は確定後に isComposing を外すので keyCode 229 も見る)
 */
export function isComposingKey(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}

export function toast(message: string, kind: 'info' | 'success' | 'error' | 'warning' = 'info', ms = 3500): void {
  const box = ui.toasts;
  const el = document.createElement('div');
  el.className = `alert alert-${kind} py-2 px-3 text-sm shadow`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  box.append(el);
  setTimeout(() => el.remove(), ms);
}

interface AskOptions { title: string; body?: string; yes?: string; no?: string | null; input?: { label: string; value: number; min: number; max: number; step?: number } }

/** 確認・数値入力用のモーダル。ブラウザ標準の confirm/prompt は使わない。 */
export function ask(o: AskOptions): Promise<{ ok: boolean; value?: number }> {
  const dlg = ui.askDialog;
  ui.askTitle.textContent = o.title;
  ui.askBody.textContent = o.body ?? '';
  const yes = ui.askYes, no = ui.askNo;
  yes.textContent = o.yes ?? 'OK';
  no.textContent = o.no ?? 'キャンセル';
  no.classList.toggle('hidden', o.no === null);
  const wrap = ui.askInputWrap, input = ui.askInput;
  wrap.classList.toggle('hidden', !o.input);
  if (o.input) {
    ui.askInputLabel.textContent = o.input.label;
    Object.assign(input, { value: String(o.input.value), min: String(o.input.min), max: String(o.input.max), step: String(o.input.step ?? 1) });
  }
  return new Promise(resolve => {
    const done = (ok: boolean) => {
      yes.onclick = no.onclick = null; dlg.onclose = null; input.onkeydown = null;
      dlg.close();
      const v = o.input ? Math.max(o.input.min, Math.min(o.input.max, Number(input.value) || o.input.value)) : undefined;
      resolve({ ok, value: v });
    };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); done(true); } };
    // close イベントは閉じた後に遅れて届く。続けて ask() を開いたとき、前の分の close で
    // 新しいダイアログが閉じないよう、まだ開いているなら無視する(Esc で閉じたときは閉じている)
    dlg.onclose = () => { if (!dlg.open) done(false); };
    dlg.showModal();
    (o.input ? input : yes).focus();
  });
}

/** ファイルの選択画面を開けなかった理由が「ユーザーの操作の直後ではない」ことか */
export function isGestureError(e: unknown): boolean {
  const n = (e as DOMException)?.name;
  return n === 'SecurityError' || n === 'NotAllowedError';
}

/**
 * ブラウザはファイルの選択画面を、クリックやキー操作の直後にしか開かせない。ショートカットのあと
 * 時間がたったときや、続けて開いたときなどに断られたら、ボタンを押してもらってからもう一度開く。
 */
export async function retryWithClick<T>(open: () => Promise<T>, label: string): Promise<T | undefined> {
  try { return await open(); } catch (e) {
    if (!isGestureError(e)) throw e;
    const r = await ask({ title: label, body: 'ブラウザの制限で、ファイルの選択画面をすぐに開けませんでした。下のボタンを押すと開きます。', yes: label });
    if (!r.ok) throw new DOMException('キャンセル', 'AbortError');
    return await open();
  }
}

export function setBusy(on: boolean): void {
  const el = ui.busy;
  el.classList.toggle('hidden', !on);
  el.classList.toggle('flex', on);
}

/**
 * ファイルを保存する。Chrome 系では保存先を選ぶダイアログを使い、無ければダウンロードにする。
 * 戻り値は保存したハンドル(ダウンロード時は null)。キャンセル時は undefined。
 */
export async function saveFile(blob: Blob, name: string, types: FilePickerAcceptType[], handle?: FileSystemFileHandle | null): Promise<FileSystemFileHandle | null | undefined> {
  if (handle) {
    const w = await handle.createWritable();
    await w.write(blob); await w.close();
    return handle;
  }
  if (window.showSaveFilePicker) {
    try {
      const h = await retryWithClick(() => window.showSaveFilePicker!({ suggestedName: name, types }), '保存先を選ぶ…');
      if (!h) return undefined;
      const w = await h.createWritable();
      await w.write(blob); await w.close();
      return h;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return undefined;
      // セキュリティ上の制限などで使えないときはダウンロードへ
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
