import { describe, it, expect } from 'vitest';
import { WeightMap, weightSizeFor, TILE } from '../../src/model/weightmap';
import { Store, createDocument, createProject, createLayer, LIMITS, scalePops, layerColor, LAYER_COLORS, meshSegments, alphaSpreadPx } from '../../src/model/project';
import { History, shrinkHistory } from '../../src/commands/history';
import { PatchLayer, InsertLayer, RemoveLayer, MoveLayer, WeightEdit, weightOperation, diffTiles } from '../../src/commands/commands';
import { Stroke, falloff } from '../../src/paint/stroke';

const image = (w = 800, h = 600) => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', ext: 'png', width: w, height: h });
const makeStore = () => new Store(createProject(createDocument(image(), 'test')));

describe('WeightMap', () => {
  it('長辺 1024px までに縮める', () => {
    expect(weightSizeFor(2048, 1024)).toEqual({ w: 1024, h: 512 });
    expect(weightSizeFor(300, 200)).toEqual({ w: 300, h: 200 });
  });

  it('正規化で最大値が 255 になる', () => {
    const wm = new WeightMap(4, 1, new Uint8Array([0, 50, 100, 25]));
    wm.normalize();
    expect([...wm.data]).toEqual([0, 127, 255, 64]);
  });

  it('反転と全消去', () => {
    const wm = new WeightMap(2, 1, new Uint8Array([0, 200]));
    wm.invert(); expect([...wm.data]).toEqual([255, 55]);
    wm.clear(); expect(wm.isEmpty()).toBe(true);
  });

  it('ガウスぼかしで総量がほぼ保たれ、段差がならされる', () => {
    const wm = new WeightMap(64, 64);
    for (let y = 24; y < 40; y++) for (let x = 24; x < 40; x++) wm.data[y * 64 + x] = 255;
    const sum = wm.data.reduce((s, v) => s + v, 0);
    wm.gaussianBlur(8);
    const after = wm.data.reduce((s, v) => s + v, 0);
    expect(Math.abs(after - sum) / sum).toBeLessThan(0.02);
    expect(wm.max()).toBeLessThan(255);
    expect(wm.data[32 * 64 + 20]).toBeGreaterThan(0);
  });

  it('アルファから生成', () => {
    const wm = new WeightMap(2, 2);
    wm.setFromAlpha(new Uint8Array([0, 255, 128, 0]), 2, 2);
    expect([...wm.data]).toEqual([0, 255, 128, 0]);
  });

  it('外へ広げる: 縦横 radius 以内の最大値になり、中の値は残る', () => {
    const wm = new WeightMap(7, 5);
    wm.data[2 * 7 + 3] = 200; // 真ん中
    wm.data[0] = 50;          // 左上の隅
    wm.dilate(1);
    const at = (x: number, y: number) => wm.data[y * 7 + x];
    for (let y = 1; y <= 3; y++) for (let x = 2; x <= 4; x++) expect(at(x, y)).toBe(200); // 斜めも含む正方形に広がる
    expect(at(1, 2)).toBe(0);
    expect(at(5, 2)).toBe(0);
    expect(at(3, 0)).toBe(0);
    expect(at(3, 4)).toBe(0);
    expect([at(0, 0), at(1, 0), at(0, 1), at(1, 1)]).toEqual([50, 50, 50, 50]);
    expect(at(2, 0)).toBe(0);
  });

  it('外へ広げる: 広い半径でも端で止まり、0 以下は何もしない', () => {
    const wm = new WeightMap(4, 3, new Uint8Array([0, 0, 0, 0, 0, 255, 128, 0, 0, 0, 0, 0]));
    const before = [...wm.data];
    wm.dilate(0);
    expect([...wm.data]).toEqual(before);
    wm.dilate(10);
    expect([...wm.data].every(v => v === 255)).toBe(true);
  });

  it('外へ広げる: 半透明の縁は外へずれるだけ', () => {
    const wm = new WeightMap(6, 1, new Uint8Array([255, 255, 128, 0, 0, 0]));
    wm.dilate(2);
    expect([...wm.data]).toEqual([255, 255, 255, 255, 128, 0]);
  });

  it('アルファから広げる幅はメッシュ1マス + 1画素', () => {
    const seg = meshSegments(1000, 500, 128);
    expect(seg).toEqual({ nx: 128, ny: 64 });
    expect(alphaSpreadPx(1024, 512, seg)).toBe(9); // 1マス 8px
    expect(alphaSpreadPx(1024, 512, meshSegments(1000, 500, 16))).toBe(65);
    expect(meshSegments(300, 900, 100)).toEqual({ nx: 33, ny: 100 });
  });

  it('UV の向き(v=1 が上)', () => {
    const wm = new WeightMap(1, 2, new Uint8Array([255, 0]));
    expect(wm.sampleUV(0.5, 1)).toBeCloseTo(1);
    expect(wm.sampleUV(0.5, 0)).toBeCloseTo(0);
  });
});

describe('History', () => {
  it('パラメータ変更を元に戻してやり直せる', () => {
    const store = makeStore(), h = new History(store), layer = store.doc!.layers[0];
    h.execute(PatchLayer.from(store, layer.id, { pop: 200 }));
    expect(layer.pop).toBe(200);
    h.undo(); expect(layer.pop).toBe(LIMITS.pop.def);
    h.redo(); expect(layer.pop).toBe(200);
  });

  it('入れ子のオブジェクトも元に戻る', () => {
    const store = makeStore(), h = new History(store), layer = store.doc!.layers[0];
    const before = { ...layer.physics };
    h.execute(PatchLayer.from(store, layer.id, { physics: { ...layer.physics, hardness: 0.99, preset: 'custom' } }));
    expect(layer.physics.hardness).toBe(0.99);
    h.undo(); expect(layer.physics).toEqual(before);
  });

  it('100手を超えた分は捨てる', () => {
    const store = makeStore(), h = new History(store), id = store.doc!.layers[0].id;
    for (let i = 0; i < 130; i++) h.execute(PatchLayer.from(store, id, { pop: i }));
    expect(h.size).toBe(100);
    while (h.undo());
    expect(store.doc!.layers[0].pop).toBe(29);
  });

  it('容量の上限を超えると古いものから捨てる', () => {
    const store = makeStore(), h = new History(store, { maxBytes: 2000 }), id = store.doc!.layers[0].id;
    for (let i = 0; i < 20; i++) h.execute(PatchLayer.from(store, id, { pop: i }));
    expect(h.bytes).toBeLessThanOrEqual(2000);
  });

  it('新しい操作でやり直し履歴が消える', () => {
    const store = makeStore(), h = new History(store), id = store.doc!.layers[0].id;
    h.execute(PatchLayer.from(store, id, { pop: 1 }));
    h.undo();
    h.execute(PatchLayer.from(store, id, { pop: 2 }));
    expect(h.canRedo).toBe(false);
  });

  it('積みを取り出して別の作業の積みと入れ替え、戻すと続きから元に戻せる(タブの切り替え)', () => {
    const store = makeStore(), h = new History(store), pa = store.project, la = pa.documents[0].layers[0];
    h.execute(PatchLayer.from(store, la.id, { pop: 11 }));
    h.execute(PatchLayer.from(store, la.id, { pop: 12 }));
    h.undo();
    const saved = h.take();
    expect(h.canUndo).toBe(false);
    expect(h.bytes).toBe(0);
    // 別の作業に切り替えて操作しても、預けた積みと元の作業は変わらない
    const pb = makeStore().project, lb = pb.documents[0].layers[0];
    store.replace(pb);
    h.execute(PatchLayer.from(store, lb.id, { pop: 99 }));
    const other = h.take();
    expect(la.pop).toBe(11);
    // 元の作業へ戻して積みを入れ替えると、続きからやり直し・元に戻すができる
    store.replace(pa);
    h.restore(saved);
    h.redo(); expect(la.pop).toBe(12);
    h.undo(); h.undo(); expect(la.pop).toBe(LIMITS.pop.def);
    expect(lb.pop).toBe(99);
    expect(other.undo.length).toBe(1);
  });

  it('預けた積みは古い手から捨てて上限に収める', () => {
    const store = makeStore(), h = new History(store), id = store.doc!.layers[0].id;
    for (let i = 0; i < 5; i++) h.execute(PatchLayer.from(store, id, { pop: i }));
    h.undo();
    const s = h.take(), each = s.undo[0].bytes, total = s.bytes;
    expect(shrinkHistory(s, total - each)).toBe(each);
    expect(s.undo.length).toBe(3);
    expect(s.redo.length).toBe(1);
    // 元に戻す側が無くなったら、やり直しの積みも捨てる
    shrinkHistory(s, 0);
    expect(s.undo.length + s.redo.length).toBe(0);
    expect(s.bytes).toBe(0);
  });

  it('レイヤーの追加・削除・並べ替え', () => {
    const store = makeStore(), h = new History(store), doc = store.doc!;
    const a = doc.layers[0], b = createLayer(doc, 'B');
    h.execute(new InsertLayer('追加', doc.id, b, 1));
    expect(doc.layers.map(l => l.name)).toEqual([a.name, 'B']);
    h.execute(new MoveLayer(b.id, 1, 0));
    expect(doc.layers[0]).toBe(b);
    h.execute(new RemoveLayer(store, a.id));
    expect(doc.layers).toEqual([b]);
    h.undo(); h.undo(); h.undo();
    expect(doc.layers).toEqual([a]);
  });
});

describe('ウェイトの編集とタイル差分', () => {
  it('塗りのストロークを元に戻すと完全に元どおり', () => {
    const store = makeStore(), h = new History(store), layer = store.doc!.layers[0];
    const original = layer.weights.data.slice();
    const st = new Stroke(layer.weights, 'brush', { size: 60, strength: 0.5, hardness: 0 });
    st.addPoint(100, 100); st.addPoint(300, 220); st.addPoint(500, 150);
    const tiles = st.finish();
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThan(layer.weights.tilesX * layer.weights.tilesY);
    h.push(new WeightEdit('塗り', layer.id, tiles));
    const painted = layer.weights.data.slice();
    expect(painted).not.toEqual(original);
    h.undo(); expect(layer.weights.data).toEqual(original);
    h.redo(); expect(layer.weights.data).toEqual(painted);
  });

  it('スタンプは 25% 間隔で補間され、線が途切れない', () => {
    const wm = new WeightMap(400, 100);
    const st = new Stroke(wm, 'brush', { size: 20, strength: 1, hardness: 0.5 });
    st.addPoint(10, 50); st.addPoint(390, 50);
    for (let x = 12; x < 385; x += 3) expect(wm.data[50 * 400 + x]).toBeGreaterThan(100);
  });

  it('強さ 1% でも丸めで消えずに積み上がる', () => {
    const wm = new WeightMap(200, 50);
    const st = new Stroke(wm, 'brush', { size: 40, strength: 0.01, hardness: 0 });
    for (let x = 20; x <= 180; x += 2) st.addPoint(x, 25);
    expect(wm.data[25 * 200 + 100]).toBeGreaterThan(0);
  });

  it('消しゴムとぼかし', () => {
    const wm = new WeightMap(100, 100);
    wm.data.fill(255);
    const er = new Stroke(wm, 'erase', { size: 30, strength: 1, hardness: 1 });
    for (let i = 0; i < 5; i++) er.addPoint(50 + i * 0.01, 50);
    for (let k = 0; k < 4; k++) { const e2 = new Stroke(wm, 'erase', { size: 30, strength: 1, hardness: 1 }); e2.addPoint(50, 50); }
    expect(wm.data[50 * 100 + 50]).toBe(0);
    // 段差(左 0 / 右 255)をぼかすと、境目の両側が近づく
    const st = new WeightMap(100, 100);
    for (let y = 0; y < 100; y++) for (let x = 50; x < 100; x++) st.data[y * 100 + x] = 255;
    const sm = new Stroke(st, 'smooth', { size: 60, strength: 1, hardness: 0 });
    sm.addPoint(50, 50);
    expect(st.data[50 * 100 + 49]).toBeGreaterThan(0);
    expect(st.data[50 * 100 + 50]).toBeLessThan(255);
    expect(st.data[5 * 100 + 49]).toBe(0); // ブラシの外は変わらない
  });

  it('ぼかしはブラシサイズに比例して広くならす(なだらかな所でも効く)', () => {
    const make = () => { const wm = new WeightMap(512, 512); for (let y = 0; y < 512; y++) for (let x = 256; x < 512; x++) wm.data[y * 512 + x] = 255; return wm; };
    const width = (wm: WeightMap) => { let n = 0; for (let x = 0; x < 512; x++) { const v = wm.data[250 * 512 + x]; if (v > 25 && v < 230) n++; } return n; };
    // くっきりした段差: 1回なぞると、ブラシ半径(32px)と同じくらいの幅までならされる
    const sharp = make();
    const s1 = new Stroke(sharp, 'smooth', { size: 64, strength: 0.3, hardness: 0 });
    for (let y = 100; y <= 400; y += 2) s1.addPoint(256, y);
    expect(width(sharp)).toBeGreaterThanOrEqual(25);
    // もともとなだらかな所: 以前は最大 1 しか変わらなかった
    const soft = make(); soft.gaussianBlur(24);
    const before = soft.data.slice(), w0 = width(soft);
    const s2 = new Stroke(soft, 'smooth', { size: 64, strength: 0.3, hardness: 0 });
    for (let y = 100; y <= 400; y += 2) s2.addPoint(256, y);
    let maxd = 0; for (let i = 0; i < before.length; i++) maxd = Math.max(maxd, Math.abs(before[i] - soft.data[i]));
    expect(maxd).toBeGreaterThan(10);
    expect(width(soft)).toBeGreaterThan(w0);
    // 大きいブラシほど広くならす
    const a = make(), b = make();
    const sa = new Stroke(a, 'smooth', { size: 32, strength: 0.5, hardness: 0 }), sb = new Stroke(b, 'smooth', { size: 160, strength: 0.5, hardness: 0 });
    for (let y = 100; y <= 400; y += 2) { sa.addPoint(256, y); sb.addPoint(256, y); }
    expect(width(b)).toBeGreaterThan(width(a) * 2);
  });

  it('一括処理は変わったタイルだけ記録する', () => {
    const store = makeStore(), h = new History(store), layer = store.doc!.layers[0];
    layer.weights.data[0] = 10;
    const cmd = weightOperation(store, layer.id, '正規化', wm => wm.normalize())!;
    expect(cmd.tiles.length).toBe(1);
    expect(layer.weights.data[0]).toBe(255);
    h.push(cmd); h.undo();
    expect(layer.weights.data[0]).toBe(10);
  });

  it('diffTiles は変化が無ければ空', () => {
    const wm = new WeightMap(TILE * 2 + 5, TILE + 1);
    expect(diffTiles(wm.data.slice(), wm)).toEqual([]);
  });

  it('falloff: 硬さ 100% なら縁まで 1', () => {
    expect(falloff(0.99, 1)).toBe(1);
    expect(falloff(0, 0)).toBe(1);
    expect(falloff(1, 0)).toBe(0);
    expect(falloff(0.5, 0)).toBeCloseTo(0.5);
  });
});

describe('複数のレイヤーのポップ量', () => {
  it('一番高いレイヤーを目標の値にし、ほかは同じ比率で伸び縮みする', () => {
    expect(scalePops([100, 200, 50], 400)).toEqual([200, 400, 100]);
    expect(scalePops([100, 300], 150)).toEqual([50, 150]);
  });
  it('0 のレイヤーは 0 のまま。全部 0 のときだけ揃える', () => {
    expect(scalePops([0, 120], 240)).toEqual([0, 240]);
    expect(scalePops([0, 0], 80)).toEqual([80, 80]);
  });
  it('小さいレイヤーは丸めで 0 にしない', () => {
    expect(scalePops([1500, 5], 100)).toEqual([100, 1]);
    expect(scalePops([1500, 5], 0)).toEqual([0, 0]);
  });
  it('1枚だけなら、その値になる', () => {
    expect(scalePops([300], 1500)).toEqual([1500]);
  });
});

describe('重ね表示の色', () => {
  it('一覧の下から順に決まり、8色を超えたら初めに戻る。先頭は前の重ね表示の色', () => {
    expect(layerColor(0)).toBe('#ff3380');
    expect(layerColor(LAYER_COLORS.length)).toBe(layerColor(0));
    expect(new Set(LAYER_COLORS).size).toBe(LIMITS.maxLayers);
  });
});
