/**
 * ツール全体の設定(ツールオプションの欄の右端の歯車から開く)。このブラウザに覚え(prefs)、ファイルには書かない。
 * 今あるのは、ブラシの筆圧(#brushPressure。結び付けは ui/panels.ts、覚えるのは main.ts の persistControls)、左のツールバーに出すボタンの選択(スマホのシートの一番上も同じ選択に従う)と、塗るときにウェイトの重ね表示を自動でON・OFFにするか(#vAutoOverlay・#vAutoOverlayOff。結び付けは表示の切り替えと一緒に ui/panels.ts)、
 * ポップ量のスライダーの最大値(#setPopMax。結び付けは ui/panels.ts、目盛りは ui/popSlider.ts)、
 * UIを隠すときにブラウザも全画面にするか(#setHideFull。結び付けは ui/hideUi.ts)。
 * 新しい設定は、この画面に足す。
 */
import { prefs } from '../storage/prefs';
import { TOOLBAR_ITEMS } from './actions';
import { ui } from './ids';

/** 隠したボタン。既定で隠すボタン(defaultHidden)は、ここではなく SHOWN_KEY に「出したもの」を覚える */
const KEY = 'toolbarHidden';
const SHOWN_KEY = 'toolbarShown';
const ITEMS = TOOLBAR_ITEMS.flatMap(g => g.items);
const DEFAULT_HIDDEN = ITEMS.filter(it => it.defaultHidden).map(it => it.id);
/** PC だけのボタン(スマホのシートにも、スマホの設定の欄にも出さない) */
const DESKTOP_ONLY = new Set(TOOLBAR_ITEMS.flatMap(g => g.items.filter(it => g.desktopOnly || it.desktopOnly).map(it => it.id)));

/** 覚えている設定から、今隠すボタン(今もあるものだけ)。既定で隠すボタンは、出すと選んでいなければ隠す */
function loadHidden(): Set<string> {
  const ids = (key: string) => { const v = prefs.get<unknown>(key); return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []); };
  const hidden = ids(KEY), shown = ids(SHOWN_KEY);
  return new Set(ITEMS.filter(it => it.defaultHidden ? !shown.has(it.id) : hidden.has(it.id)).map(it => it.id));
}

/**
 * 左のツールバーに映す。隠したボタンのほか、中が全部隠れたまとまりの枠と、
 * 前か後ろに出すものが無くなった区切りも隠す(区切りが続いたり端に残ったりしないように)
 */
function applyToolbar(hidden: ReadonlySet<string>): void {
  applyMobileNav(hidden);
  const nav = ui.toolNav;
  for (const b of nav.querySelectorAll<HTMLElement>('[data-nav]')) b.classList.toggle('nav-off', hidden.has(b.dataset.nav!) || embedOff(b));
  for (const g of nav.querySelectorAll<HTMLElement>('.nav-group')) g.classList.toggle('nav-off', !g.querySelector('[data-nav]:not(.nav-off)'));
  // 全部隠したときは、空の列を残さない
  nav.classList.toggle('nav-off', !nav.querySelector('[data-nav]:not(.nav-off)'));
  let seen = false, pending: HTMLElement | null = null;
  for (const el of [...nav.children] as HTMLElement[]) {
    if (el.classList.contains('divider')) {
      el.classList.add('nav-off');
      // 出すものが前にあり、前の区切りをまだ出していないときだけ、出す候補にする
      if (seen && !pending) pending = el;
    } else if (!el.classList.contains('nav-off')) {
      pending?.classList.remove('nav-off');
      pending = null;
      seen = true;
    }
  }
}

/** 埋め込みモードで使わないコマンドのボタンか(ui/actions.ts が data-embed-off を付ける)。隠したボタンと同じに扱う */
const embedOff = (el: Element): boolean => el.hasAttribute('data-embed-off');

/** スマホのシートの一番上に映す。前か後ろに出すものが無くなった区切りも隠す */
function applyMobileNav(hidden: ReadonlySet<string>): void {
  let seen = false, pending: HTMLElement | null = null;
  for (const el of [...ui.mNav.children] as HTMLElement[]) {
    if (el.dataset.nav) {
      const off = hidden.has(el.dataset.nav) || embedOff(el);
      el.classList.toggle('nav-off', off);
      if (!off) { pending?.classList.remove('nav-off'); pending = null; seen = true; }
    } else {
      el.classList.add('nav-off');
      if (seen && !pending) pending = el;
    }
  }
  // 全部隠したときは、空の帯を残さない(シートの高さは ui/mobile.ts が帯の高さの変化から決め直す)
  ui.mNav.classList.toggle('nav-off', !seen);
}

export function bindSettingsDialog(): { open: () => void } {
  let hidden = loadHidden();
  applyToolbar(hidden);

  const boxes: HTMLInputElement[] = [];
  ui.setToolbarList.replaceChildren(...TOOLBAR_ITEMS.map(g => {
    const fs = document.createElement('fieldset');
    fs.className = g.desktopOnly ? 'set-group d-only' : 'set-group';
    fs.append(Object.assign(document.createElement('legend'), { textContent: g.group }));
    for (const it of g.items) {
      const label = document.createElement('label');
      if (it.desktopOnly) label.className = 'd-only';
      // 埋め込みモードで使わないボタンは、出す・隠すの一覧にも出さない
      const btn = ui.toolNav.querySelector(`[data-nav="${it.id}"]`);
      if (btn && embedOff(btn)) label.setAttribute('data-embed-off', '');
      const cb = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'checkbox checkbox-xs' });
      cb.dataset.nav = it.id;
      cb.addEventListener('change', () => {
        hidden = new Set(hidden);
        if (cb.checked) hidden.delete(it.id); else hidden.add(it.id);
        save();
      });
      boxes.push(cb);
      label.append(cb, document.createTextNode(it.label));
      fs.append(label);
    }
    return fs;
  }));

  const sync = () => { for (const cb of boxes) cb.checked = !hidden.has(cb.dataset.nav!); };
  const save = () => {
    prefs.set(KEY, [...hidden].filter(id => !DEFAULT_HIDDEN.includes(id)));
    prefs.set(SHOWN_KEY, DEFAULT_HIDDEN.filter(id => !hidden.has(id)));
    applyToolbar(hidden);
  };
  ui.setToolbarReset.addEventListener('click', () => {
    // スマホでは、欄に出していない PC だけのボタン(ツール・3面図)の選択は変えない
    const mobile = document.documentElement.classList.contains('mobile');
    hidden = mobile ? new Set([...hidden].filter(id => DESKTOP_ONLY.has(id))) : new Set();
    save(); sync();
  });

  return { open: () => { sync(); ui.settingsDialog.showModal(); } };
}
