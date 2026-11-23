/** 最近開いたファイルのダイアログ。縮小画像の一覧から選んで開き直す。 */
import type { App } from '../app';
import { recent, readRecent, type RecentEntry } from '../storage/recent';
import { ask, toast, formatBytes } from './dom';
import { ui } from './ids';

const KIND_LABEL = { project: 'プロジェクト', image: '画像' } as const;

function when(t: number): string {
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `今日 ${time}`;
  const date = d.toLocaleDateString('ja-JP', d.getFullYear() === now.getFullYear() ? { month: 'numeric', day: 'numeric' } : { year: 'numeric', month: 'numeric', day: 'numeric' });
  return `${date} ${time}`;
}

export function bindRecentDialog(app: App): { open: () => Promise<void> } {
  const dlg = ui.recentDialog, list = ui.recentList, empty = ui.recentEmpty, clear = ui.recentClear;
  let urls: string[] = [];
  const revoke = () => { urls.forEach(u => URL.revokeObjectURL(u)); urls = []; };
  dlg.addEventListener('close', revoke);

  async function render(focusIndex = -1): Promise<void> {
    const entries = await recent.list();
    revoke();
    list.replaceChildren(...entries.map(card));
    empty.classList.toggle('hidden', entries.length > 0);
    clear.disabled = entries.length === 0;
    if (focusIndex < 0) return;
    if (entries.length) list.querySelectorAll<HTMLButtonElement>('button.recent-open')[Math.min(focusIndex, entries.length - 1)]?.focus();
    else dlg.querySelector<HTMLButtonElement>('form[method=dialog] button')?.focus(); // 空になったら「閉じる」へ
  }

  function card(e: RecentEntry, i: number): HTMLElement {
    const li = document.createElement('li');
    li.className = 'relative';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'recent-open flex flex-col w-full text-left rounded-box border border-base-300 bg-base-100 hover:border-primary focus-visible:outline-2 focus-visible:outline-primary overflow-hidden';
    btn.title = `${e.name}(${formatBytes(e.size)})\nDelete キーで一覧から外す`;
    btn.setAttribute('aria-keyshortcuts', 'Delete');
    const pic = document.createElement('div');
    pic.className = 'recent-thumb aspect-[4/3] bg-base-200 flex items-center justify-center';
    if (e.thumb) {
      const img = document.createElement('img'), url = URL.createObjectURL(e.thumb);
      urls.push(url);
      img.src = url; img.alt = ''; img.className = 'w-full h-full object-contain';
      pic.append(img);
    } else {
      pic.textContent = KIND_LABEL[e.kind];
      pic.classList.add('text-xs', 'opacity-60');
    }
    const name = document.createElement('span');
    name.className = 'recent-name px-2 pt-1 text-sm font-medium truncate';
    name.textContent = e.name;
    const meta = document.createElement('span');
    meta.className = 'px-2 pb-1.5 text-xs opacity-70 flex items-center gap-1';
    meta.textContent = `${KIND_LABEL[e.kind]} · ${when(e.openedAt)}`;
    if (!e.handle) {
      const b = document.createElement('span');
      b.className = 'badge badge-ghost badge-xs';
      b.textContent = 'コピー';
      b.title = 'このブラウザに控えた中身から開きます(元のファイルとは別扱いです)';
      meta.append(b);
    }
    btn.append(pic, name, meta);
    btn.addEventListener('click', () => void openEntry(e, i));
    btn.addEventListener('keydown', ev => { if (ev.key === 'Delete') { ev.preventDefault(); void removeEntry(e, i); } });
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'recent-remove btn btn-xs btn-circle btn-ghost bg-base-100/80 absolute top-1 right-1';
    x.textContent = '✕';
    x.setAttribute('aria-label', `「${e.name}」を一覧から外す`);
    x.title = '一覧から外す(ファイルは消えません)';
    x.addEventListener('click', () => void removeEntry(e, i));
    li.append(btn, x);
    return li;
  }

  async function removeEntry(e: RecentEntry, i: number): Promise<void> {
    await recent.remove(e.id);
    await render(i);
  }

  /** 項目の中身を読む。場所から読めずコピーから開くとき(Android の Chrome)は、元のファイルとは別扱いになることを伝える */
  async function readEntry(e: RecentEntry): Promise<{ file: File; handle?: FileSystemFileHandle } | null> {
    const r = await readRecent(e);
    if (r === 'denied') { toast('ファイルを読む許可が得られませんでした。', 'warning'); return null; }
    if (r.fromCopy) toast('元のファイルを読めなかったので、このブラウザに控えたコピーから開きます。保存するときは保存先を選び直してください。', 'info', 6000);
    return r;
  }

  /** ダブルクリックなどで2回目が来ても無視する */
  let opening = false;

  async function openEntry(e: RecentEntry, i: number): Promise<void> {
    if (opening) return;
    if (app.busy) { toast('いまはファイルを開けません。処理が終わってからもう一度お試しください。', 'warning'); return; }
    opening = true;
    try { await openEntryNow(e, i); } finally { opening = false; }
  }

  async function openEntryNow(e: RecentEntry, i: number): Promise<void> {
    let got: { file: File; handle?: FileSystemFileHandle } | null;
    try { got = await readEntry(e); } catch (err) {
      if ((err as DOMException).name === 'NotFoundError') {
        const r = await ask({ title: `「${e.name}」が見つかりません`, body: '移動・名前の変更・削除をした可能性があります。一覧から外しますか?', yes: '一覧から外す', no: 'そのまま' });
        if (r.ok) await recent.remove(e.id);
        if (dlg.open) await render(i); // 外したカードの位置へフォーカスを戻す
      } else toast(`開けませんでした: ${err instanceof Error ? err.message : err}`, 'error', 6000);
      return;
    }
    if (!got) return;
    // 新しいタブで開く(開いているプロジェクトならそのタブを出す)。タブの数が上限なら、一覧を出したまま伝える
    if (!(await app.roomFor(got.handle))) return;
    dlg.close();
    // コピーから開いたら、開けたときにこの項目を(場所を残したまま)覚え直す。次は許可が通れば場所から開ける
    await app.openFile(got.file, got.handle, got.handle ? {} : { recentId: e.id });
  }

  clear.addEventListener('click', async () => {
    const r = await ask({ title: '一覧を消去しますか?', body: '最近開いたファイルの一覧と、このブラウザに控えたコピーを消します。ファイル自体は消えません。', yes: '消去する' });
    if (!r.ok) return;
    await recent.clear();
    if (dlg.open) await render();
  });

  return {
    async open() {
      await render();
      dlg.showModal();
      list.querySelector<HTMLButtonElement>('button.recent-open')?.focus();
    },
  };
}
