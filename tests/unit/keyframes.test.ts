import { describe, it, expect } from 'vitest';
import { createDocument, createProject, type Project } from '../../src/model/project';
import { KeyframeEditor, type KeyframeHost } from '../../src/app/keyframes';
import type { TakeState } from '../../src/app/recording';
import { SetTake } from '../../src/commands/commands';
import { takeFromKeys, KEY_SECONDS, MAX_KEYS, TAKE_MIN_SECONDS, type KeyFrame, type Take } from '../../src/physics/take';
import type { Command } from '../../src/commands/history';

const image = { bytes: new Uint8Array(), mime: 'image/png', ext: 'png', width: 10, height: 10 };
const key = (yaw: number, seconds = 1, mode: KeyFrame['mode'] = 'smooth'): KeyFrame => ({ view: { yaw, pitch: 0, roll: 0, zoom: 1, target: { x: 0, y: 0, z: 0 } }, seconds, mode });

/** App の代わりの Host。呼ばれたものを log に残す */
function setup(keys: KeyFrame[] = [], take: Take | null = null) {
  const doc = createDocument(image, 'd'), project: Project = createProject(doc);
  project.take = take;
  const log: string[] = [], executed: Command[] = [];
  const host: KeyframeHost & { exporting: boolean; takeState: TakeState; doc: typeof doc | undefined } = {
    keyDraft: keys,
    project,
    doc,
    exporting: false,
    takeState: 'idle',
    stopTake: () => { log.push('stop'); },
    playTake: () => { log.push('play'); },
    cutView: () => { log.push('cut'); },
    execute: c => { executed.push(c); c.apply({ patchProject: (p: Partial<Project>) => Object.assign(project, p) } as never); log.push('execute'); },
    draftChanged: () => { log.push('draft'); },
    viewChanged: () => { log.push('view'); },
  };
  return { ed: new KeyframeEditor(host), host, project, log, executed };
}

describe('キーフレームの下書きの編集(KeyframeEditor)', () => {
  it('sync: 記録がキーフレームから作ったものなら下書きに入れ、記録した操作に入れ替わったときは下書きを残す(Issue #145)', () => {
    const e = setup([key(9)], takeFromKeys([key(0), key(1)], 40));
    e.ed.sync();
    expect(e.host.keyDraft.map(k => k.view.yaw)).toEqual([0, 1]);
    expect(e.host.keyDraft).not.toBe(e.project.take!.keys); // 写しを入れる
    expect(e.log).toEqual(['draft']);
    // 同じ並びなら入れ直さず、知らせも出さない(未保存にしない)
    e.log.length = 0;
    e.ed.sync();
    expect(e.log).toEqual([]);

    const noKeys = setup([key(9)], { samples: takeFromKeys([key(0), key(1)], 40)!.samples });
    noKeys.ed.sync();
    expect(noKeys.host.keyDraft.map(k => k.view.yaw)).toEqual([9]); // そのまま
    expect(noKeys.log).toEqual([]);

    const none = setup([key(9)], null);
    none.ed.sync();
    expect(none.host.keyDraft).toHaveLength(1); // そのまま
    expect(none.log).toEqual([]); // 知らせも出さない
  });

  it('canPlay: 2つ以上・1周が短すぎない・止まっている・手で記録した操作が無いときだけ再生できる', () => {
    expect(setup([key(0)]).ed.canPlay).toBe(false);
    expect(setup([key(0, 0.2), key(1, 0.2)]).ed.canPlay).toBe(false); // 0.4 秒 < TAKE_MIN_SECONDS
    expect(0.4).toBeLessThan(TAKE_MIN_SECONDS);
    const ok = setup([key(0, 0.25), key(1, 0.25)]);
    expect(ok.ed.canPlay).toBe(true); // ちょうど下限
    ok.host.takeState = 'recording';
    expect(ok.ed.canPlay).toBe(false);
    ok.host.takeState = 'playing';
    expect(ok.ed.canPlay).toBe(false);
    ok.host.takeState = 'idle';
    ok.host.exporting = true;
    expect(ok.ed.canPlay).toBe(false);
    ok.host.exporting = false;
    ok.host.doc = undefined;
    expect(ok.ed.canPlay).toBe(false);
    // 手で記録した操作(keys 無し)があれば不可、キーフレームの記録なら可
    const manual = setup([key(0), key(1)], { samples: takeFromKeys([key(0), key(1)], 40)!.samples });
    expect(manual.ed.canPlay).toBe(false);
    expect(setup([key(0), key(1)], takeFromKeys([key(0), key(1)], 40)).ed.canPlay).toBe(true);
  });

  it('play: 一覧が今の記録と同じならそのまま再生し、違えば記録を作り直して再生する。再生できなければ何もしない', () => {
    const same = setup([key(0), key(1)], takeFromKeys([key(0), key(1)], 40));
    same.ed.play();
    expect(same.log).toEqual(['play']);
    expect(same.executed).toHaveLength(0);

    const diff = setup([key(0), key(1, 1, 'bounce')], takeFromKeys([key(0), key(1)], 40));
    diff.ed.play();
    expect(diff.log).toEqual(['execute', 'play']);
    expect(diff.executed[0]).toBeInstanceOf(SetTake);
    expect(diff.project.take!.keys![1].mode).toBe('bounce');

    const fresh = setup([key(0), key(1)], null);
    fresh.ed.play();
    expect(fresh.log).toEqual(['execute', 'play']);

    const no = setup([key(0)]);
    no.ed.play();
    expect(no.log).toEqual([]);
  });

  it('makeTake: 記録中は作らない', () => {
    const e = setup([key(0), key(1)]);
    e.host.takeState = 'recording';
    e.ed.makeTake();
    expect(e.log).toEqual([]);
  });

  it('add: 今の視点を、1つ前の時間とつなぎ方で足す。上限では何もしない', () => {
    const e = setup([key(0, 2.5, 'bounce')]);
    e.project.camera.yaw = 0.7;
    e.ed.add();
    expect(e.host.keyDraft).toHaveLength(2);
    expect(e.host.keyDraft[1]).toMatchObject({ seconds: 2.5, mode: 'bounce', view: { yaw: 0.7 } });
    expect(e.log).toEqual(['stop', 'draft']);
    const empty = setup([]);
    empty.ed.add();
    expect(empty.host.keyDraft[0]).toMatchObject({ seconds: KEY_SECONDS.def, mode: 'smooth' });

    const full = setup(Array.from({ length: MAX_KEYS }, (_, i) => key(i)));
    full.ed.add();
    expect(full.host.keyDraft).toHaveLength(MAX_KEYS);
    expect(full.log).toEqual([]); // 止めもしない・知らせも出さない
  });

  it('move: 範囲外・同じ場所は何もせず、動かすときは秒数を場所に残す', () => {
    const e = setup([key(0, 1), key(1, 2), key(2, 3)]);
    for (const [f, t] of [[0, 0], [-1, 1], [3, 0], [0, 3], [0, -1]]) e.ed.move(f, t);
    expect(e.log).toEqual([]);
    e.ed.move(0, 2);
    expect(e.host.keyDraft.map(k => k.view.yaw)).toEqual([1, 2, 0]);
    expect(e.host.keyDraft.map(k => k.seconds)).toEqual([1, 2, 3]);
    expect(e.log).toEqual(['draft']);
  });

  it('setOption: 秒数は 0.1 刻みに丸めて範囲に収め、つなぎ方は変える。無い番号は何もしない', () => {
    const e = setup([key(0)]);
    e.ed.setOption(0, { seconds: 1.234 });
    expect(e.host.keyDraft[0].seconds).toBe(1.2);
    e.ed.setOption(0, { seconds: 0 });
    expect(e.host.keyDraft[0].seconds).toBe(KEY_SECONDS.min);
    e.ed.setOption(0, { seconds: 99 });
    expect(e.host.keyDraft[0].seconds).toBe(KEY_SECONDS.max);
    e.ed.setOption(0, { mode: 'bounce' });
    expect(e.host.keyDraft[0]).toMatchObject({ seconds: KEY_SECONDS.max, mode: 'bounce' });
    e.log.length = 0;
    e.ed.setOption(1, { seconds: 2 });
    expect(e.log).toEqual([]);
  });

  it('set / remove / goto: 今の視点で登録し直す・消す・視点を動かす(無い番号は何もしない)', () => {
    const e = setup([key(0), key(1)]);
    e.project.camera.yaw = 0.3;
    e.ed.set(1);
    expect(e.host.keyDraft[1].view.yaw).toBe(0.3);
    e.ed.set(5); e.ed.remove(5); e.ed.goto(5);
    expect(e.log).toEqual(['stop', 'draft']);
    e.log.length = 0;
    e.ed.goto(0);
    expect(e.project.camera.yaw).toBe(0);
    expect(e.log).toEqual(['stop', 'cut', 'view']);
    e.log.length = 0;
    e.ed.remove(0);
    expect(e.host.keyDraft).toHaveLength(1);
    expect(e.log).toEqual(['draft']);
  });
});
