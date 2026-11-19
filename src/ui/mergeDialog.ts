/**
 * レイヤーの結合のダイアログ。何を結合するかを出し、重ね方(高い方・加算)を選んで結合する。
 * 重ね方は開くたびに「高い方」から始める(加算は、わざわざ選ぶときだけ)。
 */
import type { App } from '../app';
import { MERGE_MODES, type MergeMode } from '../model/merge';
import { ui } from './ids';

export function bindMergeDialog(app: App): { open: () => void } {
  const dlg = ui.mergeDialog, sel = ui.mergeMode;
  for (const [v, m] of Object.entries(MERGE_MODES)) { const o = new Option(m.label, v); o.title = m.desc; sel.add(o); }

  ui.mergeApply.addEventListener('click', () => {
    dlg.close();
    app.mergeLayers(sel.value as MergeMode);
  });
  ui.mergeCancel.addEventListener('click', () => dlg.close());

  return {
    open() {
      const ls = app.mergeTargets;
      if (ls.length < 2) return;
      const names = [...ls].reverse().map(l => `「${l.name}」`);
      ui.mergeTarget.textContent = app.multiSelected
        ? `選んでいる${ls.length}枚(${names.join('')})を、一番下の${names[names.length - 1]}にまとめます。`
        : `${names[0]}を、すぐ下の${names[1]}にまとめます。`;
      sel.value = 'max';
      dlg.showModal();
      ui.mergeApply.focus();
    },
  };
}
