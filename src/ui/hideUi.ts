/**
 * UIを隠して、3Dビューを画面いっぱいに出す(コマンド toggleUi、Tab)。
 *
 * - 隠すのは、メニューバー・ツールの設定の行・左のツールバー・右パネル・ステータスバー・3面図と、
 *   スマホの上のバー・シート・下のバー(style.css の html.ui-hidden)。状態は App.uiHidden で、覚えない(開き直すと戻る)。
 * - 戻すのは、もう一度 Tab・Esc・右上の「UIを戻す」。PC では、マウスを動かすと右上のバーとシークバーを少しの間だけ出す。
 *   スマホにはキーもマウスも無いので、どちらも出したままにする(右上のバーは薄く)。
 * - 右上のバー(#viewBar)には、見ながら切り替えたいもの(アニメーションの再生・停止、自動で揺らす、お気に入り)を「UIを戻す」と並べる。
 *   再生と自動で揺らすはコマンドのボタン(ui/actions.ts)。お気に入りはここで選ぶ欄を作り、選ぶと App.applyFavorite で当てる
 *   (選んだ状態は残さない。当てたあとで揺れを変えられるので、どれを当てているかは決まらないため)。
 * - 隠している間の 3Dビューの操作は、見るだけ(ツールを使わない。マウスの左ドラッグで平行移動・右で回す。ui/input.ts)。
 * - 膨らませる・ぼかすのパネルは、使っている途中なら出したまま(画面全体に浮かべているので隠す対象に入らない)。
 * - 設定の「ブラウザも全画面にする」(setHideFull)がオンなら、隠すときにブラウザの全画面にもする。
 *   全画面はブラウザの Esc でもやめられ、そのときは UI も戻す。
 */
import type { App } from '../app';
import { prefs } from '../storage/prefs';
import { ui } from './ids';
import { isTyping } from './input';

/** マウスを止めてから、戻すボタンとシークバーを消すまで(ミリ秒) */
const PEEK_MS = 2000;
const PREF = 'hideUiFullscreen';

export function bindHideUi(app: App): void {
  const root = document.documentElement;
  const mobile = () => root.classList.contains('mobile');

  /* ---------- 設定: ブラウザも全画面にする ---------- */
  const canFull = !!document.fullscreenEnabled && typeof root.requestFullscreen === 'function';
  // 全画面にできないブラウザ(iPhone の Safari など)では、設定の欄を出さない
  ui.setHideFullRow.hidden = !canFull;
  ui.setHideFull.checked = prefs.get<boolean>(PREF) ?? false;
  ui.setHideFull.addEventListener('change', () => prefs.set(PREF, ui.setHideFull.checked));
  /** このアプリが隠すときに全画面にしたか(自分で入れた全画面だけを、戻すときにやめる) */
  let ownFull = false;
  /** 全画面にする要求の途中 */
  let fullReq: Promise<void> | null = null;
  const exitFull = () => void document.exitFullscreen().catch(() => {});

  /* ---------- 状態 → 画面 ---------- */
  let shown = false;
  function apply(): void {
    const on = app.uiHidden;
    if (on === shown) return;
    shown = on;
    root.classList.toggle('ui-hidden', on);
    // 隠した部品にフォーカスが残らないように外す(Tab を続けて押したときも隠す・戻すに使えるように)
    (document.activeElement as HTMLElement | null)?.blur();
    if (on) {
      peek();
      // キーやボタンを押した流れの中で呼ぶ(ブラウザは、操作に続くときだけ全画面を許す)
      if (canFull && ui.setHideFull.checked && !document.fullscreenElement) {
        ownFull = true;
        const req = fullReq = root.requestFullscreen()
          .catch(() => { if (fullReq === req) ownFull = false; })
          // 全画面に入る前に戻したときは、入ってからやめる
          .then(() => { if (fullReq === req) fullReq = null; if (!app.uiHidden && document.fullscreenElement) exitFull(); });
      }
    } else {
      endPeek();
      if (ownFull && document.fullscreenElement) exitFull();
      ownFull = false;
    }
  }
  app.on('view', apply);
  document.addEventListener('fullscreenchange', () => {
    // ブラウザの Esc などで全画面をやめたときは、UI も戻す
    if (!document.fullscreenElement && ownFull) { ownFull = false; app.setUiHidden(false); }
  });

  /* ---------- 戻す ---------- */
  ui.uiRestore.addEventListener('click', () => app.setUiHidden(false));
  window.addEventListener('keydown', e => {
    if (!app.uiHidden || e.key !== 'Escape' || e.defaultPrevented || isTyping(e)) return;
    // 膨らませる・ぼかすの途中なら、Esc はそのキャンセルに使う。ダイアログが開いているなら、ダイアログを閉じるのに使う
    if (app.previewing || document.querySelector('dialog[open]:modal')) return;
    e.preventDefault();
    app.setUiHidden(false);
  });
  // スマホでは膨らませるのパネルが下のシートの中にあるので、始まったら UI を戻す
  app.on('inflate', p => { if (p === 'begin' && app.uiHidden && mobile()) app.setUiHidden(false); });
  app.on('blur', p => { if (p === 'begin' && app.uiHidden && mobile()) app.setUiHidden(false); });

  /* ---------- お気に入りを選ぶ欄 ---------- */
  const fav = ui.viewFav, favHead = fav.options[0];
  let favKey = '';
  function refreshFav(): void {
    const list = app.project.favorites, key = JSON.stringify(list.map(f => [f.id, f.name]));
    if (key !== favKey) {
      favKey = key;
      fav.replaceChildren(favHead, ...list.map(f => new Option(f.name, f.id)));
    }
    fav.hidden = !list.length;
    fav.disabled = !app.canEditFavorites;
  }
  // 選ばずに閉じると欄にフォーカスが残り、Esc・Tab が欄のもの(文字の欄の扱い)になって UI を戻せない。
  // Esc はいつも、Tab はマウス・指で触ってフォーカスしたときは、欄から離して UI を戻す(キーボードで移ってきたなら Tab はふつうに移る)
  let favByPointer = false;
  fav.addEventListener('pointerdown', () => { favByPointer = true; });
  fav.addEventListener('keydown', e => {
    if (e.key !== 'Escape' && !(e.key === 'Tab' && favByPointer && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();
    fav.blur();
    app.setUiHidden(false);
  });
  // 欄から離れたら、少し経てばバーを消す
  fav.addEventListener('blur', () => { favByPointer = false; if (app.uiHidden) peek(); });
  fav.addEventListener('change', () => {
    const id = fav.value;
    fav.value = '';
    // 選び終えたらフォーカスを外す(続けて Tab で戻せるように。バーも少し経てば消える)
    fav.blur();
    if (id) app.applyFavorite(id);
  });
  app.store.on('replace', refreshFav);
  app.store.on('project', ({ keys }) => { if (keys.includes('favorites')) refreshFav(); });
  for (const ev of ['take', 'status', 'inflate', 'blur', 'view'] as const) app.on(ev, refreshFav);
  refreshFav();

  /* ---------- マウスを動かすと、右上のバーとシークバーを少しの間だけ出す ---------- */
  let timer = 0;
  /** ポインタが右上のバーかシークバーの上にあるか(上にある間は消さない) */
  let over = false;
  function peek(): void {
    root.classList.add('ui-peek');
    clearTimeout(timer);
    if (!over) timer = window.setTimeout(hidePeek, PEEK_MS);
  }
  function hidePeek(): void {
    // お気に入りの一覧を開いている間(ポインタはブラウザの一覧の上にあり、ページには来ない)は消さない
    if (document.activeElement === fav) { timer = window.setTimeout(hidePeek, PEEK_MS); return; }
    root.classList.remove('ui-peek');
  }
  function endPeek(): void {
    clearTimeout(timer);
    over = false;
    root.classList.remove('ui-peek');
  }
  window.addEventListener('pointermove', e => {
    // 塗る・つかむなどでドラッグしている間は出さない(絵を見ながら動かしているので)
    if (!app.uiHidden || e.buttons !== 0 || e.pointerType === 'touch') return;
    const t = e.target as Element | null;
    over = !!t?.closest?.('#viewBar, #playBar');
    peek();
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { over = false; if (app.uiHidden) peek(); });

  apply();
}
