/**
 * お気に入りの一覧(右のパネルの「アニメーション」。スマホではシートの「アニメ」タブへ移す)。
 * 「☆ 追加」はコマンド(data-cmd。ui/actions.ts)で、ここは一覧の表示と行の操作だけを受け持つ。
 * 名前は行の入力欄でその場で書き換え、適用・上書き・削除はどれも App を通す(アンドゥできる)。
 */
import type { App } from '../app';
import { ui } from './ids';
import { isComposingKey } from './dom';
import { icon } from './icons';
import { LIMITS, MOTIONS, PRESETS, type Favorite } from '../model/project';
import { favoriteMatches, FAVORITE_NAME_MAX } from '../model/favorites';
import { takeSeconds } from '../physics/take';

/** 行の2段目に出す中身の要約(揺らし方・周期・記録) */
export function favoriteSummary(f: Favorite): string {
  const names = [...new Set(f.layers.filter(l => l.physics.enabled).map(l =>
    l.physics.preset === 'custom' ? `${MOTIONS[l.physics.motion].label}(調整)` : PRESETS[l.physics.preset].label))];
  const parts = [names.length ? names.join('、') : '揺れなし'];
  parts.push(f.autoSwing.enabled ? `周期 ${f.autoSwing.period.toFixed(1)}秒` : '自動揺らしなし');
  if (f.take) parts.push(`${f.take.keys ? 'キーフレーム' : '記録'} ${takeSeconds(f.take).toFixed(1)}秒`);
  return parts.join(' / ');
}

const dateText = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) || d.getTime() === 0 ? '' : d.toLocaleString();
};

export function bindFavoriteControls(app: App): void {
  const { favList: list, favCount: count, favEmpty: empty } = ui;
  const idOf = (el: EventTarget | null) => (el as HTMLElement | null)?.closest<HTMLElement>('[data-fav]')?.dataset.fav ?? '';

  list.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]'), id = idOf(b);
    if (!b || !id) return;
    if (b.dataset.act === 'apply') app.applyFavorite(id);
    else if (b.dataset.act === 'set') app.overwriteFavorite(id);
    else if (b.dataset.act === 'del') app.removeFavorite(id);
  });
  // 名前: 入力欄を離れたとき(Enter でも離れる)に変える。空なら元の名前に戻す。Esc で書きかけを捨てる
  list.addEventListener('change', e => {
    const el = e.target as HTMLInputElement, id = idOf(el);
    if (el.dataset.act !== 'name' || !id) return;
    app.renameFavorite(id, el.value);
    refresh(true);
  });
  list.addEventListener('keydown', e => {
    const el = e.target as HTMLInputElement;
    // 日本語の変換を確定する Enter・取り消す Esc では、欄を抜けない
    if (el.dataset.act !== 'name' || isComposingKey(e)) return;
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); el.value = app.project.favorites.find(f => f.id === idOf(el))?.name ?? el.value; el.blur(); }
  });

  function row(id: string): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'fav-row';
    li.dataset.fav = id;
    li.innerHTML = `<span class="fav-mark" role="img" aria-label="今の状態と同じ">●</span>`
      + `<div class="flex flex-col min-w-0"><input data-act="name" class="input input-ghost input-xs px-1 w-full" maxlength="${FAVORITE_NAME_MAX}" aria-label="名前"><span class="fav-sub text-xs opacity-60 truncate px-1"></span></div>`
      + `<button class="btn btn-xs" data-act="apply" title="この組み合わせに戻す(視点のほかは元に戻せる)">適用</button>`
      + `<button class="btn btn-xs btn-ghost btn-square fav-set" data-act="set" title="今の状態で上書きする(元に戻せる)" aria-label="今の状態で上書き">${icon('favSet')}</button>`
      + `<button class="btn btn-xs btn-ghost btn-square" data-act="del" title="消す(元に戻せる)" aria-label="消す">×</button>`;
    return li;
  }

  /** 値が変わったときだけ書く('status' は 0.5 秒ごとにも来るので) */
  const setAttr = (el: Element, k: string, v: string) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };
  const setText = (el: Element, v: string) => { if (el.textContent !== v) el.textContent = v; };

  /** names: 入力中でも名前を書き戻す(名前を確定したとき) */
  function refresh(names = false): void {
    const favs = app.project.favorites, doc = app.doc, can = app.canEditFavorites;
    // 行はお気に入りの ID で使い回す(順番で使い回すと、名前の入力中に一覧が変わったとき別のお気に入りの名前になる)
    const rows = new Map([...list.children].map(li => [(li as HTMLElement).dataset.fav!, li as HTMLLIElement]));
    const next = favs.map(f => rows.get(f.id) ?? row(f.id));
    if (next.length !== list.children.length || next.some((li, i) => list.children[i] !== li)) list.replaceChildren(...next);
    favs.forEach((f, i) => {
      const li = next[i];
      const same = !!doc && favoriteMatches(f, app.project, doc);
      setAttr(li, 'aria-current', String(same));
      const name = li.querySelector<HTMLInputElement>('[data-act=name]')!;
      // 入力中の名前は書き換えない
      if ((names || document.activeElement !== name) && name.value !== f.name) name.value = f.name;
      setAttr(name, 'aria-label', `お気に入り ${i + 1} の名前`);
      setText(li.querySelector('.fav-sub')!, favoriteSummary(f));
      // 追加した日時は補足なので、ツールチップに出す
      const date = dateText(f.createdAt);
      setAttr(li, 'title', date ? `追加した日時: ${date}` : '');
      for (const el of li.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) if (el.disabled === can) el.disabled = !can;
    });
    if (empty.hidden !== favs.length > 0) empty.hidden = favs.length > 0;
    setText(count, `${favs.length}/${LIMITS.favorites}`);
  }

  app.history.on('change', () => refresh());
  app.store.on('replace', () => refresh(true));
  app.store.on('project', () => refresh());
  app.store.on('layer', () => refresh());
  app.store.on('layers', () => refresh());
  app.on('take', () => refresh());
  app.on('status', () => refresh()); // 書き出しの始まり・終わりなど
  app.on('inflate', () => refresh());
  app.on('blur', () => refresh());
  refresh(true);
}
