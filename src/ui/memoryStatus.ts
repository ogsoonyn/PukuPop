/**
 * ステータスバーの右端の、メモリの使用量の見積もり。押すと内訳を出す。
 * fps と同じく 0.5 秒ごとに数え直す(数えるのはレイヤーの配列の長さを足すだけなので軽い)
 */
import type { App } from '../app';
import { formatBytes, type MemoryUsage } from '../model/memory';
import { ui } from './ids';

export function bindMemoryStatus(app: App): void {
  const root = ui.sMem.parentElement!;
  let lastText = '';

  const refresh = () => {
    if (!ui.sMem.offsetParent) return; // スマホ・UIを隠すでステータスバーが出ていない
    const m = app.memoryUsage();
    const text = `メモリ 約 ${formatBytes(m.total)}`;
    if (text !== lastText) { ui.sMem.textContent = text; lastText = text; }
    if (root.matches(':focus-within')) renderDetail(m, app.history.options.maxBytes);
  };
  app.on('fps', refresh);
  app.on('tabs', refresh);
  root.addEventListener('focusin', refresh);
  // フォーカスで開くので、Esc で閉じる(ほかのショートカットには回さない)
  root.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    (document.activeElement as HTMLElement | null)?.blur();
  });
}

function renderDetail(m: MemoryUsage, historyLimit: number): void {
  const box = ui.sMemDetail;
  const rows: [string, string][] = [
    ['画像・ウェイト', formatBytes(m.data)],
    ['アンドゥ', `${formatBytes(m.history)} / 上限 ${formatBytes(historyLimit)}`],
    ['表示・GPU', formatBytes(m.render)],
  ];
  const table = (head: string[], body: string[][]) => {
    const t = document.createElement('table');
    t.className = 'table table-xs tabular-nums';
    const tr = (cells: string[], tag: 'th' | 'td') => {
      const r = document.createElement('tr');
      cells.forEach((c, i) => { const e = document.createElement(tag); e.textContent = c; if (i > 0) e.className = 'text-right'; r.append(e); });
      return r;
    };
    if (head.length) { const h = document.createElement('thead'); h.append(tr(head, 'th')); t.append(h); }
    const b = document.createElement('tbody'); body.forEach(c => b.append(tr(c, 'td'))); t.append(b);
    return t;
  };
  const title = (s: string) => { const p = document.createElement('p'); p.className = 'font-bold mt-2 first:mt-0'; p.textContent = s; return p; };
  const note = document.createElement('p');
  note.className = 'opacity-70 mt-2';
  note.textContent = 'アプリが持っているデータの量の見積もりです。ブラウザが実際に使うメモリはこれより多くなります。アンドゥの上限は全部のタブの合計です。レイヤーの追加・削除を戻せるあいだは、そのウェイトをアンドゥの側にも数えます。JS のヒープには、画像やウェイトのバイト列はほとんど入りません。';

  const parts: Node[] = [title(`合計 約 ${formatBytes(m.total)}`), table([], rows)];
  if (m.tabs.length > 1) {
    parts.push(title('タブごと'), table(['', 'データ', 'アンドゥ', '表示'],
      m.tabs.map(t => [`${t.active ? '● ' : ''}${t.name || '(名前なし)'}`, formatBytes(t.data), formatBytes(t.history), formatBytes(t.render)])));
  }
  if (m.heap) parts.push(title('JS のヒープ(ブラウザの計測)'), table([], [['使用中', `${formatBytes(m.heap.used)} / 上限 ${formatBytes(m.heap.limit)}`]]));
  parts.push(note);
  box.replaceChildren(...parts);
}
