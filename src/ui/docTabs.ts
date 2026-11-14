/**
 * 開いている作業のタブ。PC はメニューバーの右に並べ、スマホは上のバーの見出しを押すと一覧を出す。
 * 切り替え・閉じるは App(switchTab / closeTab)を通す。中身の入れ替えは App がまとめて行う。
 */
import type { App, Tab } from '../app';
import { ui } from './ids';

export function bindDocTabs(app: App, deps: { open: () => unknown }): void {
  const strip = ui.docTabs, dlg = ui.tabDialog, list = ui.tabList;

  /** 見出しと未保存の印 */
  const label = (t: Tab, cls: string) => {
    const name = app.tabName(t);
    const wrap = Object.assign(document.createElement('span'), { className: cls });
    if (t.dirty) {
      const dot = Object.assign(document.createElement('span'), { className: 'doc-tab-dirty', textContent: '●', title: '保存されていない変更があります' });
      dot.setAttribute('aria-label', '未保存');
      wrap.append(dot);
    }
    wrap.append(Object.assign(document.createElement('span'), { className: 'doc-tab-text', textContent: name }));
    return wrap;
  };
  const closeButton = (t: Tab, className: string) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className, textContent: '×', title: 'タブを閉じる' });
    b.setAttribute('aria-label', `「${app.tabName(t)}」を閉じる`);
    b.addEventListener('click', e => { e.stopPropagation(); void app.closeTab(t.id); });
    return b;
  };

  function renderStrip(): void {
    // 作り直すとフォーカスが外れるので、タブの列にあったら表のタブへ戻す
    const focused = strip.contains(document.activeElement);
    strip.replaceChildren(...app.tabs.map(t => {
      const active = t === app.activeTab;
      const box = Object.assign(document.createElement('div'), { className: 'doc-tab' });
      box.setAttribute('role', 'presentation');
      box.dataset.active = String(active);
      const tab = Object.assign(document.createElement('button'), { type: 'button', className: 'doc-tab-name', title: app.tabName(t) });
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      tab.append(label(t, 'doc-tab-label'));
      tab.addEventListener('click', () => void app.switchTab(t.id));
      // 中ボタンで閉じる(ブラウザのタブと同じ)
      box.addEventListener('auxclick', e => { if (e.button === 1) { e.preventDefault(); void app.closeTab(t.id); } });
      box.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); }); // 中ボタンの自動スクロールを出さない
      box.append(tab, closeButton(t, 'doc-tab-close'));
      return box;
    }));
    strip.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focused) strip.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }
  // タブの上では左右の矢印で隣のタブへ
  strip.addEventListener('keydown', e => {
    if (!(e.target instanceof HTMLElement) || e.target.getAttribute('role') !== 'tab') return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); app.stepTab(e.key === 'ArrowRight' ? 1 : -1); }
  });

  function renderList(): void {
    list.replaceChildren(...app.tabs.map(t => {
      const li = document.createElement('li');
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'tab-item' });
      b.setAttribute('aria-current', String(t === app.activeTab));
      b.append(label(t, 'tab-item-label'));
      b.addEventListener('click', () => { dlg.close(); void app.switchTab(t.id); });
      li.append(b, closeButton(t, 'btn btn-ghost btn-sm btn-square tab-item-close'));
      return li;
    }));
  }

  function renderTitle(): void {
    const t = app.activeTab, n = app.tabs.length;
    ui.mTitle.querySelector('.m-title-name')!.textContent = `${t.dirty ? '● ' : ''}${app.tabName(t)}`;
    ui.mTitle.querySelector('.m-title-count')!.textContent = n > 1 ? `${app.tabs.indexOf(t) + 1}/${n}` : '';
    ui.mTitle.setAttribute('aria-label', `開いている作業: ${app.tabName(t)}${n > 1 ? `(${n} 件中 ${app.tabs.indexOf(t) + 1} 件目)` : ''}`);
  }

  function render(): void {
    renderStrip();
    renderTitle();
    if (dlg.open) renderList();
    // タブが上限のときは開けない(理由は一覧の下に出る。ui/actions.ts の data-blocked)
    ui.tabOpen.disabled = !app.canOpenTab;
  }

  ui.mTitle.addEventListener('click', () => { renderList(); dlg.showModal(); });
  ui.tabOpen.addEventListener('click', () => { dlg.close(); void deps.open(); });
  app.on('file', render);
  app.on('tabs', render);
  render();
}
