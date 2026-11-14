import { describe, it, expect } from 'vitest';
import { UI_IDS } from '../../src/ui/ids';
import { MOBILE_SLOTS } from '../../src/ui/mobile';
import { keyString } from '../../src/ui/actions';
import { TOOLS } from '../../src/ui/tools';
import html from '../../index.html?raw';

/** index.html の id → タグ名 */
const tags = new Map<string, string[]>();
for (const m of html.matchAll(/<([a-z0-9]+)\b[^>]*?\sid="([^"]+)"/g)) tags.set(m[2], [...(tags.get(m[2]) ?? []), m[1]]);

describe('画面の要素の一覧(ui/ids.ts)と index.html', () => {
  it('一覧の要素がすべて index.html にあり、タグも合っている', () => {
    const bad = Object.entries(UI_IDS).filter(([id, tag]) => tags.get(id)?.[0] !== tag).map(([id, tag]) => `${id}: <${tag}> のはずが ${tags.get(id) ?? '無い'}`);
    expect(bad).toEqual([]);
  });

  it('id は重なっていない', () => {
    expect([...tags].filter(([, t]) => t.length > 1).map(([id]) => id)).toEqual([]);
  });

  it('スマホのシートへ移す部品の印(data-m-slot)が、1つずつある', () => {
    for (const { slot } of MOBILE_SLOTS) expect(html.split(`data-m-slot="${slot}"`).length - 1, slot).toBe(1);
    const used = [...html.matchAll(/data-m-slot="([^"]+)"/g)].map(m => m[1]);
    expect(used.filter(s => !MOBILE_SLOTS.some(x => x.slot === s))).toEqual([]);
  });
});

describe('ショートカットの読み取り', () => {
  const ev = (o: Partial<KeyboardEvent>) => ({ key: '', code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o }) as KeyboardEvent;

  it('文字は大文字にし、修飾キーを Ctrl・Shift・Alt の順に付ける', () => {
    expect(keyString(ev({ key: 'b', code: 'KeyB' }))).toBe('B');
    expect(keyString(ev({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+Z');
    expect(keyString(ev({ key: 'Home', code: 'Home' }))).toBe('Home');
    expect(keyString(ev({ key: 'Escape', code: 'Escape' }))).toBe('Esc');
    expect(keyString(ev({ key: '[', code: 'BracketRight' }))).toBe('[');
  });

  it('Mac の ⌘ は Ctrl として読む', () => {
    expect(keyString(ev({ key: 's', code: 'KeyS', metaKey: true }))).toBe('Ctrl+S');
  });

  it('日本語入力中(Process)と Alt 付きは、キーの位置で読む', () => {
    expect(keyString(ev({ key: 'Process', code: 'KeyG' }))).toBe('G');
    expect(keyString(ev({ key: 'π', code: 'KeyP', ctrlKey: true, shiftKey: true, altKey: true }))).toBe('Ctrl+Shift+Alt+P');
  });

  it('ツールのキーは1文字の大文字で、重ならない', () => {
    const keys = TOOLS.map(t => t.key);
    expect(keys.every(k => /^[A-Z]$/.test(k))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('項目の説明(「?」)', () => {
  it('data-help が指す説明が index.html にあり、最初は隠れている', () => {
    const refs = [...html.matchAll(/data-help="([^"]+)"/g)].map(m => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    for (const id of refs) expect(html, id).toMatch(new RegExp(`<p id="${id}" class="help-text[^"]*" hidden>`));
  });
});
