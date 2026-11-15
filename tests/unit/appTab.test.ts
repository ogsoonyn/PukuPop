import { describe, it, expect } from 'vitest';
import { createDocument, createProject, LIMITS } from '../../src/model/project';
import type { Command } from '../../src/commands/history';
import { createTab, suggestedName, tabName, trimHiddenHistory } from '../../src/app/tab';
import { newImageDefaults } from '../../src/app/newImage';

const image = { bytes: new Uint8Array(), mime: 'image/png', ext: 'png', width: 10, height: 10 };
const projectOf = (name = 'cat.png') => createProject(createDocument(image, name));
const cmd = (bytes: number) => ({ bytes }) as unknown as Command;

describe('タブ(app/tab.ts)', () => {
  it('見出しと保存の名前は、ファイル名が無ければ画像の名前から作る', () => {
    const t = createTab(projectOf('cat.png'));
    expect(tabName(t)).toBe('cat.png');
    expect(suggestedName(t)).toBe('cat.pukupop');
    t.fileName = 'a.pukupop';
    expect(tabName(t)).toBe('a.pukupop');
    expect(suggestedName(t)).toBe('a.pukupop');
    expect(createTab(projectOf()).id).not.toBe(t.id);
  });

  it('アンドゥの合計が上限を超えたら、長く出していない裏のタブの古い手から捨てる', () => {
    const old = createTab(projectOf()), recent = createTab(projectOf());
    old.shownAt = 1; recent.shownAt = 2;
    old.history = { undo: [cmd(30), cmd(30)], redo: [], bytes: 60 };
    recent.history = { undo: [cmd(30)], redo: [], bytes: 30 };
    trimHiddenHistory(100, 40, [recent, old]);
    expect(old.history.bytes).toBe(30);
    expect(recent.history.bytes).toBe(30);
    trimHiddenHistory(1000, 40, [recent, old]); // 収まっていれば捨てない
    expect(old.history.bytes).toBe(30);
  });
});

describe('新しい画像の既定(app/newImage.ts)', () => {
  it('覚えた値を範囲に収めて使い、無い・おかしい値は今の作業から引き継ぐ', () => {
    const prev = projectOf();
    prev.background = '#123456';
    expect(newImageDefaults(prev, undefined)).toEqual({ background: '#123456', autoSwing: { ...prev.autoSwing }, fov: prev.camera.fov });
    const d = newImageDefaults(prev, { background: null, autoSwing: { enabled: !prev.autoSwing.enabled, period: 1e9, strength: 'x' }, fov: -5 });
    expect(d.background).toBeNull();
    expect(d.autoSwing).toEqual({ enabled: !prev.autoSwing.enabled, period: LIMITS.period.max, strength: prev.autoSwing.strength });
    expect(d.fov).toBe(LIMITS.fov.min);
    expect(newImageDefaults(prev, { background: 'red' }).background).toBe('#123456');
  });
});
