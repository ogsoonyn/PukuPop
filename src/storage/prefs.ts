/**
 * 画面の設定をこのブラウザに覚えておく(localStorage)。ファイルには書かない。
 * 覚えるのは、ブラシ・表示の切り替え・書き出しの設定、左のツールバー(とスマホのシートの一番上)に出すボタン、新しい画像を開いたときの既定値。
 * 読めない・書けない環境(プライベートウィンドウなど)では、黙って既定のまま動く。
 */
const KEY = 'popstage.prefs.v1';

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function readAll(): Record<string, Json> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

let cache: Record<string, Json> | null = null;
let timer = 0;
const flush = () => { clearTimeout(timer); timer = 0; if (cache) try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* 覚えられないだけ */ } };
// 間引いている間にタブを閉じても失わない
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { if (timer) flush(); });

export const prefs = {
  get<T = unknown>(key: string): T | undefined {
    cache ??= readAll();
    return Object.prototype.hasOwnProperty.call(cache, key) ? (cache[key] as T) : undefined;
  },
  /** 書き込みは間引く(スライダーを動かしている間に何度も書かない) */
  set(key: string, value: Json): void {
    cache ??= readAll();
    cache[key] = value;
    clearTimeout(timer);
    timer = window.setTimeout(flush, 200);
  },
};

type Control = HTMLInputElement | HTMLSelectElement;

/**
 * フォームの部品の値を覚え、呼んだ時点で前回の値に戻す。戻すときはいつもの input / change を送るので、
 * 画面の処理はそのまま使える。radio は name ごとにまとめて扱う。
 */
export function persistControls(group: string, controls: Control[]): void {
  const saved = prefs.get<Record<string, Json>>(group) ?? {};
  const keyOf = (el: Control) => (el instanceof HTMLInputElement && el.type === 'radio' ? `radio:${el.name}` : el.id);
  const valueOf = (el: Control): Json => (el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value);
  const save = (el: Control) => {
    const cur = prefs.get<Record<string, Json>>(group) ?? {};
    prefs.set(group, { ...cur, [keyOf(el)]: valueOf(el) });
  };
  for (const el of controls) {
    const key = keyOf(el), v = saved[key];
    const radio = el instanceof HTMLInputElement && el.type === 'radio';
    if (v !== undefined) {
      if (radio) {
        if (el.value === v && !el.checked && !el.disabled) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
      } else if (el instanceof HTMLInputElement && el.type === 'checkbox') {
        if (typeof v === 'boolean' && el.checked !== v) { el.checked = v; el.dispatchEvent(new Event('change', { bubbles: true })); }
      } else if (typeof v === 'string' && el.value !== v) {
        // 選べない値(無くなった選択肢など)は戻さない
        if (el instanceof HTMLSelectElement && ![...el.options].some(o => o.value === v && !o.disabled)) continue;
        el.value = v;
        el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
        if (el instanceof HTMLInputElement && el.type !== 'range') el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    el.addEventListener(el instanceof HTMLInputElement && el.type === 'range' ? 'input' : 'change', () => { if (!radio || (el as HTMLInputElement).checked) save(el); });
  }
}
