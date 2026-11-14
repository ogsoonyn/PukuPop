import { describe, it, expect } from 'vitest';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { createDocument, createProject, createLayer, applyPreset, Store, LIMITS } from '../../src/model/project';
import { captureFavorite, favoriteMatches, nextFavoriteName, samePhysics } from '../../src/model/favorites';
import { SetFavorites } from '../../src/commands/commands';
import { History } from '../../src/commands/history';
import { serializeProject, deserializeProject, TAKE_PATH } from '../../src/storage/popstage';
import { takeFromKeys, type Take } from '../../src/physics/take';

const makeProject = () => {
  const doc = createDocument({ bytes: new Uint8Array([9, 8, 7, 6]), mime: 'image/jpeg', ext: 'jpg', width: 300, height: 200 }, 'プリン');
  doc.layers.push(createLayer(doc, '顔'));
  return createProject(doc);
};
const view = (yaw: number) => ({ yaw, pitch: 0, roll: 0, zoom: 1, target: { x: 0, y: 0, z: 0 } });
const makeTake = (yaw: number): Take => takeFromKeys([{ view: view(0), seconds: 1, mode: 'smooth' }, { view: view(yaw), seconds: 1, mode: 'bounce' }], 40)!;

describe('お気に入り', () => {
  it('今の状態から作り、今の状態と同じかを見分ける(視点は比べない。揺らし方の固有設定はキーの並びによらない)', () => {
    const p = makeProject(), doc = p.documents[0];
    doc.layers[0].physics = applyPreset(doc.layers[0].physics, 'tame');
    doc.layers[0].physics.motionParams = { 'charge.depth': 0.5, 'charge.time': 0.4 };
    const f = captureFavorite(p, doc, { name: 'a', playing: true });
    expect(f.layers.map(l => l.id)).toEqual(doc.layers.map(l => l.id));
    expect(f.playing).toBe(false); // 記録が無ければ再生していたことにしない
    expect(favoriteMatches(f, p, doc)).toBe(true);
    // 残したあとに今の状態を変えても、お気に入りは変わらない
    doc.layers[0].physics.motionParams['charge.depth'] = 0.6;
    expect(f.layers[0].physics.motionParams['charge.depth']).toBe(0.5);
    expect(favoriteMatches(f, p, doc)).toBe(false);
    doc.layers[0].physics.motionParams = { 'charge.time': 0.4, 'charge.depth': 0.5 };
    expect(favoriteMatches(f, p, doc)).toBe(true);
    p.camera.yaw += 1;
    expect(favoriteMatches(f, p, doc)).toBe(true);
    p.autoSwing = { ...p.autoSwing, period: 3 };
    expect(favoriteMatches(f, p, doc)).toBe(false);
    p.autoSwing = { ...f.autoSwing };
    doc.layers[1].pop = 300;
    expect(favoriteMatches(f, p, doc)).toBe(false);
    doc.layers[1].pop = f.layers[1].pop;
    p.take = makeTake(1);
    expect(favoriteMatches(f, p, doc)).toBe(false);
    // 後から足したレイヤーは見ない。残したレイヤーが消えたら同じとはしない
    p.take = null;
    doc.layers.push(createLayer(doc, '足した'));
    expect(favoriteMatches(f, p, doc)).toBe(true);
    doc.layers.splice(1, 1);
    expect(favoriteMatches(f, p, doc)).toBe(false);
  });

  it('揺れの設定の比べ方: 固有設定の項目の数が違えば違う', () => {
    const p = makeProject().documents[0].layers[0].physics;
    expect(samePhysics(p, { ...p, motionParams: { 'jiggle.amp': 1 } })).toBe(false);
    expect(samePhysics(p, { ...p })).toBe(true);
    // 後から足した項目も比べる
    expect(samePhysics(p, { ...p, extra: 1 } as typeof p)).toBe(false);
    expect(samePhysics({ ...p, extra: 1 } as typeof p, { ...p, extra: 2 } as typeof p)).toBe(false);
  });

  it('名前は使われていない番号にする', () => {
    const p = makeProject(), doc = p.documents[0];
    const a = captureFavorite(p, doc, { name: 'お気に入り 2', playing: false });
    expect(nextFavoriteName([])).toBe('お気に入り 1');
    expect(nextFavoriteName([a])).toBe('お気に入り 3');
  });

  it('一覧の差し替えはアンドゥ・リドゥでき、中身はコピーしない', () => {
    const p = makeProject(), store = new Store(p), h = new History(store);
    p.take = makeTake(1);
    const f = captureFavorite(p, p.documents[0], { name: 'a', playing: true });
    h.execute(new SetFavorites('残す', [], [f]));
    expect(store.project.favorites).toEqual([f]);
    expect(store.project.favorites[0]).toBe(f);
    expect(store.project.favorites[0].take).toBe(p.take);
    h.undo();
    expect(store.project.favorites).toEqual([]);
    h.redo();
    expect(store.project.favorites[0]).toBe(f);
  });
});

describe('お気に入りの保存', () => {
  it('保存して読み込むと戻る。今の記録と同じ記録は1回だけ書き、読み込んでも同じものになる', async () => {
    const p = makeProject(), doc = p.documents[0];
    const t1 = makeTake(1), t2 = makeTake(2);
    p.take = t1;
    doc.layers[1].physics = applyPreset(doc.layers[1].physics, 'puku');
    p.camera.fov = 30; p.camera.yaw = 0.4;
    const a = captureFavorite(p, doc, { name: 'いい揺れ', playing: true });
    p.take = t2;
    const b = captureFavorite(p, doc, { name: '別の動き', playing: false });
    const c = captureFavorite({ ...p, take: null }, doc, { name: '記録なし', playing: true });
    const d = captureFavorite({ ...p, take: t2 }, doc, { name: '同じ記録', playing: false });
    p.take = t1;
    p.favorites = [a, b, c, d];
    const bytes = serializeProject(p);
    const files = unzipSync(bytes);
    // t1 は今の記録のファイルを、t2 はお気に入り用の1つのファイルを使う
    expect(Object.keys(files).filter(n => n.startsWith('motion/')).sort()).toEqual(['motion/favorite-1.json', TAKE_PATH].sort());
    const q = (await deserializeProject(bytes)).project;
    expect(q.favorites.map(f => f.name)).toEqual(['いい揺れ', '別の動き', '記録なし', '同じ記録']);
    const [qa, qb, qc, qd] = q.favorites;
    expect(qa.take).toBe(q.take);
    expect(qb.take).not.toBeNull(); expect(qb.take).not.toBe(q.take); expect(qd.take).toBe(qb.take);
    expect(qb.take!.samples.length).toBe(t2.samples.length);
    expect(qc.take).toBeNull(); expect(qc.playing).toBe(false);
    expect(qa.playing).toBe(true);
    for (const [x, y] of [[a, qa], [b, qb], [c, qc]] as const) {
      expect(y.id).toBe(x.id); expect(y.createdAt).toBe(x.createdAt);
      expect(y.layers).toEqual(x.layers); expect(y.autoSwing).toEqual(x.autoSwing); expect(y.camera).toEqual(x.camera);
    }
    expect(favoriteMatches(qa, q, q.documents[0])).toBe(true);
  });

  it('お気に入りの無いファイル(古いファイル)は空で開き、project.json にも書かない', async () => {
    const p = makeProject(), bytes = serializeProject(p);
    expect(JSON.parse(strFromU8(unzipSync(bytes)['project.json'])).project.favorites).toBeUndefined();
    expect((await deserializeProject(bytes)).project.favorites).toEqual([]);
  });

  it('形の合わないお気に入りは丸め、無いレイヤー・読めない記録は捨て、数は上限まで', async () => {
    const p = makeProject(), doc = p.documents[0], lid = doc.layers[0].id;
    const bytes = serializeProject(p), files = unzipSync(bytes);
    const json = JSON.parse(strFromU8(files['project.json']));
    json.project.favorites = [
      null, 'x',
      {
        id: '', name: '   ', createdAt: 'いつか', playing: true, take: 'motion/favorite-0.json',
        layers: [{ id: lid, pop: 1e9, blend: 'constructor', physics: { preset: 'zzz', hardness: 9, motion: 'bad' } }, { id: 'nope', pop: 1 }, { id: lid, pop: 5 }, null],
        autoSwing: { period: -1, strength: 'a' }, camera: { fov: 999, pitch: 9, target: { x: 'a' } },
      },
      { id: 'dup', name: 'b', take: 'images/doc-0.jpg', layers: 'x' },
      { id: 'dup', name: 'c'.repeat(500), take: 'constructor' },
      ...Array.from({ length: LIMITS.favorites + 5 }, (_, i) => ({ id: `F${i}`, name: `n${i}` })),
    ];
    const broken = zipSync({ ...files, 'project.json': strToU8(JSON.stringify(json)), 'motion/favorite-0.json': strToU8('{oops') });
    const q = (await deserializeProject(broken)).project;
    expect(q.favorites.length).toBe(LIMITS.favorites);
    const [f0, f1, f2] = q.favorites;
    expect(f0.id).not.toBe(''); expect(f0.name).toBe('お気に入り 1'); expect(f0.createdAt).toBe(new Date(0).toISOString());
    expect(f0.take).toBeNull(); expect(f0.playing).toBe(false);
    // もう無いレイヤー(nope)の分は残し、重なった ID・null は捨てる
    expect(f0.layers.map(l => l.id)).toEqual([lid, 'nope']);
    expect(f0.layers[0]).toMatchObject({ id: lid, pop: LIMITS.pop.max, blend: 'add' });
    expect(f0.layers[0].physics.preset).toBe('custom'); expect(f0.layers[0].physics.hardness).toBe(1);
    expect(f0.autoSwing.period).toBe(LIMITS.period.min); expect(f0.autoSwing.strength).toBe(0.5);
    expect(f0.camera.fov).toBe(LIMITS.fov.max); expect(f0.camera.pitch).toBe(1.5); expect(f0.camera.target.x).toBe(0);
    expect(f1.layers).toEqual([]); expect(f1.take).toBeNull();
    expect(f2.id).not.toBe('dup'); expect(f2.name.length).toBe(40); expect(f2.take).toBeNull();
  });

  it('読み込みでレイヤーの ID を振り直したときは、お気に入りの突き合わせも合わせる', async () => {
    const p = makeProject(), doc = p.documents[0];
    p.favorites = [captureFavorite(p, doc, { name: 'a', playing: false })];
    const files = unzipSync(serializeProject(p));
    const json = JSON.parse(strFromU8(files['project.json']));
    json.documents[0].layers[1].id = json.documents[0].layers[0].id; // 重なった ID は振り直される
    json.project.favorites[0].layers[1].id = 'missing';
    const q = (await deserializeProject(zipSync({ ...files, 'project.json': strToU8(JSON.stringify(json)) }))).project;
    expect(q.favorites[0].layers.map(l => l.id)).toEqual([q.documents[0].layers[0].id, 'missing']);
    expect(favoriteMatches(q.favorites[0], q, q.documents[0])).toBe(false);
  });

  it('今の記録が無く、お気に入りだけが記録を持つときも保存して戻る', async () => {
    const p = makeProject(), doc = p.documents[0];
    p.take = makeTake(1);
    p.favorites = [captureFavorite(p, doc, { name: 'a', playing: true })];
    p.take = null;
    const bytes = serializeProject(p);
    expect(Object.keys(unzipSync(bytes)).filter(n => n.startsWith('motion/'))).toEqual(['motion/favorite-0.json']);
    const q = (await deserializeProject(bytes)).project;
    expect(q.take).toBeNull();
    expect(q.favorites[0].take?.samples.length).toBe(p.favorites[0].take!.samples.length);
    expect(q.favorites[0].take?.keys?.length).toBe(2);
    expect(q.favorites[0].playing).toBe(true);
  });

  it('記録のパスにほかのファイルの名前を書いても読まない。大きすぎる記録は捨てて開く', async () => {
    const p = makeProject();
    p.favorites = [captureFavorite(p, p.documents[0], { name: 'a', playing: false })];
    const files = unzipSync(serializeProject(p, { thumbnail: new Uint8Array([1, 2]) }));
    const json = JSON.parse(strFromU8(files['project.json']));
    const base = json.project.favorites[0];
    const paths = ['thumbnail.png', '__proto__', 'constructor', 'project.json', 'images/doc-0.jpg', 'motion/../thumbnail.png', 'motion/favorite-0.json'];
    json.project.favorites = paths.map((take, i) => ({ ...base, id: `F${i}`, take }));
    // 上限を超える記録(中身は読めなくてよい。宣言サイズで捨てる)
    const big = new Uint8Array((4 << 20) + 1).fill(32);
    const bytes = zipSync({ ...files, 'project.json': strToU8(JSON.stringify(json)), 'motion/favorite-0.json': [big, { level: 0 }] });
    const { project: q, thumbnail } = await deserializeProject(bytes);
    expect(thumbnail).toEqual(new Uint8Array([1, 2]));
    expect(q.favorites.map(f => f.take)).toEqual(paths.map(() => null));
  });
});
