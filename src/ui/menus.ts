/**
 * メニュー(daisyUI のドロップダウン)をキーボードでたどれるようにする。
 *   メニュー名で ↓・Enter・Space: 最初の項目へ / ↑: 最後の項目へ
 *   項目の上で ↑↓: 前後の項目へ(端では反対の端へ)、Home・End: 最初・最後へ、Esc: メニュー名へ戻って閉じる
 *   ←→: 隣のメニューへ(上のメニューバーだけ)
 * ドロップダウンはフォーカスが中にある間だけ開くので、項目へフォーカスを移せば開いたままになる。
 * ここで扱ったキーは、ショートカット(ui/actions.ts の window の keydown)へ伝えない。
 */
export function bindMenus(): void {
  for (const bar of document.querySelectorAll<HTMLElement>('#menubar, #mTop')) {
    const dropdowns = [...bar.querySelectorAll<HTMLElement>(':scope > .dropdown')];
    dropdowns.forEach((dd, i) => {
      const trigger = dd.querySelector<HTMLElement>(':scope > [role=button]');
      const list = dd.querySelector<HTMLElement>(':scope > ul.menu');
      if (!trigger || !list) return;
      trigger.setAttribute('aria-haspopup', 'menu');
      list.setAttribute('role', 'menu');
      if (trigger.textContent?.trim()) list.setAttribute('aria-label', trigger.textContent.trim());
      for (const li of list.querySelectorAll(':scope > li')) {
        const item = li.querySelector('button');
        if (item) { li.setAttribute('role', 'none'); item.setAttribute('role', 'menuitem'); }
        else li.setAttribute('role', 'presentation'); // 見出し
      }
      /** 押せる項目(使えない項目は飛ばす) */
      const items = () => [...list.querySelectorAll<HTMLButtonElement>('button[role=menuitem]:not(:disabled)')];
      const focusAt = (k: number) => { const xs = items(); if (xs.length) xs[(k + xs.length) % xs.length].focus(); };
      const handled = (e: KeyboardEvent) => { e.preventDefault(); e.stopPropagation(); };

      trigger.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { handled(e); focusAt(0); }
        else if (e.key === 'ArrowUp') { handled(e); focusAt(-1); }
        // 開いたメニューを Esc で閉じる(ショートカットの Esc「選択を1枚に戻す」へ回さない)
        else if (e.key === 'Escape') { handled(e); trigger.blur(); }
        else if (bar.id === 'menubar' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
          handled(e);
          dropdowns[(i + (e.key === 'ArrowRight' ? 1 : -1) + dropdowns.length) % dropdowns.length].querySelector<HTMLElement>(':scope > [role=button]')?.focus();
        }
      });
      list.addEventListener('keydown', e => {
        const xs = items(), k = xs.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === 'ArrowDown') { handled(e); focusAt(k + 1); }
        else if (e.key === 'ArrowUp') { handled(e); focusAt(k < 0 ? -1 : k - 1); }
        else if (e.key === 'Home') { handled(e); focusAt(0); }
        else if (e.key === 'End') { handled(e); focusAt(-1); }
        else if (e.key === 'Escape') { handled(e); trigger.focus(); trigger.blur(); }
        else if (bar.id === 'menubar' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
          // 隣のメニューを開き、その最初の項目へ(閉じている間は項目が隠れていてフォーカスできないので、先にメニュー名で開く)
          handled(e);
          const next = dropdowns[(i + (e.key === 'ArrowRight' ? 1 : -1) + dropdowns.length) % dropdowns.length];
          next.querySelector<HTMLElement>(':scope > [role=button]')?.focus();
          next.querySelector<HTMLButtonElement>('ul.menu button[role=menuitem]:not(:disabled)')?.focus();
        }
      });
    });
  }
}
