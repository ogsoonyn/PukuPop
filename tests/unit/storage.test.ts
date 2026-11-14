import { describe, it, expect } from 'vitest';
import { zlibSync, zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { encodeGrayPng, decodePngToGray } from '../../src/storage/png';
import { serializeProject, deserializeProject, migrate, FORMAT_VERSION, UNZIP_LIMITS } from '../../src/storage/popstage';
import { createDocument, createProject, createLayer, defaultMultiCamera } from '../../src/model/project';
import { captureFavorite } from '../../src/model/favorites';
import { takeFromKeys } from '../../src/physics/take';

describe('PNG', () => {
  it('グレースケールの往復', () => {
    const w = 37, h = 23, data = new Uint8Array(w * h);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7 + (i >> 3)) & 0xff;
    const back = decodePngToGray(encodeGrayPng(w, h, data));
    expect(back.width).toBe(w); expect(back.height).toBe(h);
    expect(back.data).toEqual(data);
  });

  it('RGBA(外部ソフトで保存し直した形)を輝度で読む・Paeth フィルタ', () => {
    // 2x2 RGBA、各行 Paeth(4) フィルタ
    const px = [[255, 255, 255, 255], [0, 0, 0, 255], [128, 128, 128, 255], [10, 10, 10, 255]];
    const raw: number[] = [];
    const img = (x: number, y: number, c: number) => px[y * 2 + x][c];
    for (let y = 0; y < 2; y++) {
      raw.push(4);
      for (let x = 0; x < 2; x++) for (let c = 0; c < 4; c++) {
        const a = x > 0 ? img(x - 1, y, c) : 0, b = y > 0 ? img(x, y - 1, c) : 0, cc = x > 0 && y > 0 ? img(x - 1, y - 1, c) : 0;
        const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc;
        raw.push((img(x, y, c) - pred) & 0xff);
      }
    }
    const png = buildPng(2, 2, 8, 6, zlibSync(new Uint8Array(raw)));
    expect([...decodePngToGray(png).data]).toEqual([255, 0, 128, 10]);
  });

  it('対応外の形式は例外', () => {
    expect(() => decodePngToGray(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow();
  });

  it('巨大な寸法を名乗る PNG は展開前に弾く', () => {
    const png = buildPng(100000, 100000, 8, 0, zlibSync(new Uint8Array(16)));
    expect(() => decodePngToGray(png)).toThrow(/too large/);
  });

  it('画像データが足りない PNG は例外', () => {
    const png = buildPng(4, 4, 8, 0, zlibSync(new Uint8Array(6)));
    expect(() => decodePngToGray(png)).toThrow(/truncated/);
  });

  it('展開後のデータが大きくなりすぎる寸法(色数・ビット深度込み)は確保する前に弾く', () => {
    const png = buildPng(4000, 4000, 16, 6, zlibSync(new Uint8Array(16))); // 約 128MB
    expect(() => decodePngToGray(png)).toThrow(/too large/);
  });

  it('寸法より多いデータが入っていても、寸法どおりの画像として読める', () => {
    const raw = new Uint8Array(4 << 20); // 2x2 に対して 4MB
    const g = decodePngToGray(buildPng(2, 2, 8, 0, zlibSync(raw)));
    expect(g.width).toBe(2); expect([...g.data]).toEqual([0, 0, 0, 0]);
  });
});

describe('.pukupop', () => {
  const makeProject = () => {
    const doc = createDocument({ bytes: new Uint8Array([9, 8, 7, 6]), mime: 'image/jpeg', ext: 'jpg', width: 300, height: 200 }, 'プリン');
    const l1 = doc.layers[0];
    for (let i = 0; i < l1.weights.data.length; i += 3) l1.weights.data[i] = i & 0xff;
    l1.pop = 1234; l1.physics = { enabled: false, preset: 'bain', hardness: 0.1, mass: 0.9, weight: 0.3, damping: 0.05, motion: 'stretch', motionParams: { 'stretch.amp': 1.5, 'stretch.dir': 3, 'charge.depth': 0.9 } };
    const l2 = createLayer(doc, '顔'); l2.visible = false; l2.weights.data.fill(77);
    doc.layers.push(l2);
    doc.meshDensity = 256;
    const p = createProject(doc);
    p.background = '#112233'; p.camera.fov = 25; p.camera.target = { x: 5, y: -3, z: 0 };
    p.autoSwing = { enabled: false, period: 3, strength: 0.25 };
    return p;
  };

  it('新しい名前で書き出し、改名前(PopStage)のファイルもそのまま読める', async () => {
    const bytes = await serializeProject(makeProject());
    const json = JSON.parse(strFromU8(unzipSync(bytes)['project.json']));
    expect(json.app).toBe('PukuPop');
    json.app = 'PopStage';
    const legacy = zipSync({ ...unzipSync(bytes), 'project.json': strToU8(JSON.stringify(json)) });
    const back = await deserializeProject(legacy);
    expect(back.project.documents[0].layers[0].pop).toBe(1234);
  });

  it('保存して読み込むと同じ状態に戻る', async () => {
    const p = makeProject();
    const bytes = serializeProject(p, { thumbnail: new Uint8Array([1, 2]) });
    const { project: q, thumbnail } = await deserializeProject(bytes);
    expect(thumbnail).toEqual(new Uint8Array([1, 2]));
    expect(q.background).toBe('#112233');
    expect(q.camera).toEqual(p.camera);
    expect(q.autoSwing).toEqual(p.autoSwing);
    const [d0, d1] = [p.documents[0], q.documents[0]];
    expect(d1.name).toBe(d0.name);
    expect(d1.image.bytes).toEqual(d0.image.bytes);
    expect(d1.image.ext).toBe('jpg');
    expect(d1.meshDensity).toBe(256);
    expect(d1.layers.length).toBe(2);
    for (let i = 0; i < 2; i++) {
      const a = d0.layers[i], b = d1.layers[i];
      expect(b.id).toBe(a.id); expect(b.name).toBe(a.name); expect(b.visible).toBe(a.visible);
      expect(b.pop).toBe(a.pop); expect(b.blend).toBe(a.blend); expect(b.physics).toEqual(a.physics);
      expect(b.weights.width).toBe(a.weights.width);
      expect(b.weights.data).toEqual(a.weights.data);
    }
  });

  it('不正な値は範囲内に丸める', async () => {
    const json = {
      formatVersion: 1, app: 'PopStage', project: { camera: { fov: 999 } },
      documents: [{ name: 'x', image: { path: 'images/doc-0.png', width: 10, height: 10 }, meshDensity: 99999,
        layers: [
          { name: 'L', pop: 99999, physics: { hardness: 5, preset: 'zzz' }, weights: { path: 'none.png' } },
          // 以前はマイナスのポップ量(へこみ)を保存できた。今は 0 にする
          { name: 'M', pop: -120, weights: { path: 'none.png' } },
        ] }],
    };
    const zip = zipSync({ 'project.json': strToU8(JSON.stringify(json)), 'images/doc-0.png': new Uint8Array([1]) });
    const { project } = await deserializeProject(zip);
    expect(project.camera.fov).toBe(90);
    expect(project.documents[0].meshDensity).toBe(512);
    expect(project.documents[0].layers[0].pop).toBe(1500);
    expect(project.documents[0].layers[1].pop).toBe(0);
    expect(project.documents[0].layers[0].physics.hardness).toBe(1);
    expect(project.documents[0].layers[0].physics.preset).toBe('custom');
  });

  it('視点・お気に入り・キーフレームの傾きを保存して戻す。傾きの無い古いファイルは 0°、範囲外は丸め、3面図の視点は傾けない', async () => {
    const p = makeProject();
    p.camera.roll = 0.5;
    p.favorites = [captureFavorite(p, p.documents[0], { name: 'a', playing: false })];
    p.camera.roll = -0.25;
    const keys = [0.4, -3].map(roll => ({ view: { yaw: 0, pitch: 0, roll, zoom: 1, target: { x: 0, y: 0, z: 0 } }, seconds: 1, mode: 'smooth' as const }));
    p.take = takeFromKeys(keys, p.camera.fov);
    p.multiCamera = { ...p.multiCamera, roll: 1 };
    const { project: q } = await deserializeProject(serializeProject(p));
    expect(q.camera.roll).toBeCloseTo(-0.25);
    expect(q.favorites[0].camera.roll).toBeCloseTo(0.5);
    expect(q.take!.keys!.map(k => k.view.roll)).toEqual([0.4, -3]);
    expect(q.take!.samples[0].camera.roll).toBeCloseTo(0.4);
    expect(q.multiCamera.roll).toBe(0);
    // 項目の無い古いファイル(視点とお気に入り)
    const doc = { name: 'x', image: { path: 'images/doc-0.png', width: 10, height: 10 }, layers: [{ id: 'L1', name: 'L', weights: { path: 'none.png' } }] };
    const fav = { id: 'F1', name: 'f', createdAt: new Date(0).toISOString(), layers: [], autoSwing: { enabled: false, period: 2, strength: 0.5 }, camera: { yaw: 0.2, pitch: 0, zoom: 1 }, take: null, playing: false };
    const old = zipSync({ 'project.json': strToU8(JSON.stringify({ formatVersion: 1, app: 'PopStage', project: { camera: { yaw: 0.3 }, favorites: [fav] }, documents: [doc] })), 'images/doc-0.png': new Uint8Array([1]) });
    const r = (await deserializeProject(old)).project;
    expect(r.camera.roll).toBe(0); expect(r.camera.yaw).toBeCloseTo(0.3);
    expect(r.favorites[0].camera.roll).toBe(0);
    // 範囲外・数でない値
    const big = zipSync({ 'project.json': strToU8(JSON.stringify({ formatVersion: 1, app: 'PukuPop', project: { camera: { roll: 7 }, favorites: [{ ...fav, camera: { roll: 'x' } }] }, documents: [doc] })), 'images/doc-0.png': new Uint8Array([1]) });
    const b = (await deserializeProject(big)).project;
    expect(b.camera.roll).toBeCloseTo(7 - 2 * Math.PI);
    expect(b.favorites[0].camera.roll).toBe(0);
  });

  it('3面図の自由角度の視点を保存して戻す。古いファイルや不正な値では初めの視点・範囲内にする', async () => {
    const p = makeProject();
    p.multiCamera = { fov: 30, yaw: -1.2, pitch: 0.3, roll: 0, zoom: 2.5, target: { x: 12, y: -4, z: 7 } };
    const { project: q } = await deserializeProject(serializeProject(p));
    expect(q.multiCamera).toEqual(p.multiCamera);
    // 項目の無い古いファイル
    const doc = { name: 'x', image: { path: 'images/doc-0.png', width: 10, height: 10 }, layers: [{ name: 'L', weights: { path: 'none.png' } }] };
    const old = zipSync({ 'project.json': strToU8(JSON.stringify({ formatVersion: 1, app: 'PopStage', project: {}, documents: [doc] })), 'images/doc-0.png': new Uint8Array([1]) });
    expect((await deserializeProject(old)).project.multiCamera).toEqual(defaultMultiCamera());
    // 不正な値
    const bad = zipSync({ 'project.json': strToU8(JSON.stringify({ formatVersion: 1, app: 'PopStage', project: { multiCamera: { fov: 999, pitch: 9, zoom: 'x', target: { x: 'a' } } }, documents: [doc] })), 'images/doc-0.png': new Uint8Array([1]) });
    const m = (await deserializeProject(bad)).project.multiCamera;
    expect(m.fov).toBe(90);
    expect(m.pitch).toBe(1.5);
    expect(m.zoom).toBe(defaultMultiCamera().zoom);
    expect(m.target).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('重ね方を保存して戻す。項目の無い古いファイル・知らない値は加算にする', async () => {
    const p = makeProject();
    p.documents[0].layers[0].blend = 'max';
    const { project: q } = await deserializeProject(serializeProject(p));
    expect(q.documents[0].layers[0].blend).toBe('max');
    const layer = (blend?: unknown) => ({ name: 'L', blend, weights: { path: 'none.png' } });
    const json = {
      formatVersion: 1, app: 'PopStage', project: {},
      documents: [{ name: 'x', image: { path: 'images/doc-0.png', width: 10, height: 10 }, layers: [layer(), layer('zzz'), layer('max'), layer('__proto__')] }],
    };
    const zip = zipSync({ 'project.json': strToU8(JSON.stringify(json)), 'images/doc-0.png': new Uint8Array([1]) });
    const { project } = await deserializeProject(zip);
    expect(project.documents[0].layers.map(l => l.blend)).toEqual(['add', 'add', 'max', 'add']);
  });

  it('揺らし方の項目が無い古いファイルは、プリセットから補う', async () => {
    const layer = (physics: object) => ({ name: 'L', physics, weights: { path: 'none.png' } });
    const json = {
      formatVersion: 1, app: 'PopStage', project: {},
      documents: [{ name: 'x', image: { path: 'images/doc-0.png', width: 10, height: 10 },
        layers: [layer({ preset: 'bain' }), layer({ preset: 'custom' }), layer({ preset: 'puru', motion: 'circle' }), layer({ motion: 'zzz' })] }],
    };
    const zip = zipSync({ 'project.json': strToU8(JSON.stringify(json)), 'images/doc-0.png': new Uint8Array([1]) });
    const { project } = await deserializeProject(zip);
    expect(project.documents[0].layers.map(l => l.physics.motion)).toEqual(['jump', 'shake', 'circle', 'shake']);
  });

  it('揺らし方の固有設定: 知らない項目は捨て、範囲外は丸め、選択肢に無い値は捨てる', async () => {
    const json = {
      formatVersion: 1, app: 'PopStage', project: {},
      documents: [{ name: 'x', image: { path: 'images/doc-0.png', width: 10, height: 10 },
        layers: [{ name: 'L', weights: { path: 'none.png' }, physics: { preset: 'custom', motion: 'charge',
          motionParams: { 'charge.depth': 5, 'charge.time': 0.5, 'charge.zzz': 1, 'nope.depth': 1, 'circle.dir': 7, 'stretch.dir': 2, 'jump.height': 'x' } } }] }],
    };
    const zip = zipSync({ 'project.json': strToU8(JSON.stringify(json)), 'images/doc-0.png': new Uint8Array([1]) });
    const { project } = await deserializeProject(zip);
    expect(project.documents[0].layers[0].physics.motionParams).toEqual({ 'charge.depth': 1, 'charge.time': 0.5, 'stretch.dir': 2 });
  });

  const oneLayer = (project: object, physics: object = {}) => ({
    formatVersion: 1, app: 'PopStage', project,
    documents: [{ name: 'x', image: { path: 'images/doc-0.png', width: 10, height: 10 }, layers: [{ name: 'L', physics, weights: { path: 'none.png' } }] }],
  });
  const zipOf = (json: object, extra: Record<string, Uint8Array> = {}) =>
    zipSync({ 'project.json': strToU8(JSON.stringify(json)), 'images/doc-0.png': new Uint8Array([1]), ...extra });

  it('プロトタイプにある名前(constructor など)は知らない値として扱う', async () => {
    const zip = zipOf(oneLayer({}, { preset: 'toString', motion: 'constructor', motionParams: { 'constructor.x': 1, 'toString.y': 2, '__proto__.z': 3 } }));
    const { project } = await deserializeProject(zip);
    const ph = project.documents[0].layers[0].physics;
    expect(ph.preset).toBe('custom');
    expect(ph.motion).toBe('shake');
    expect(ph.motionParams).toEqual({});
  });

  it('背景色は #rrggbb だけを受け付ける', async () => {
    const bg = async (background: unknown) => (await deserializeProject(zipOf(oneLayer({ background })))).project.background;
    expect(await bg('#AbCdEf')).toBe('#AbCdEf');
    expect(await bg('url(https://example.com/track.png)')).toBeNull();
    expect(await bg('red')).toBeNull();
    expect(await bg('#123')).toBeNull();
  });

  it('必要なファイルの展開後のサイズが上限を超えていたら読まない', async () => {
    const zip = declareSize(zipOf(oneLayer({})), 'images/doc-0.png', UNZIP_LIMITS.image + 1);
    await expect(deserializeProject(zip)).rejects.toThrow(/大きすぎます/);
  });

  it('1つずつは上限内でも、合計が上限を超えたら読まない(ZIP 爆弾)', async () => {
    const json = oneLayer({}) as any;
    json.documents[0].layers = Array.from({ length: 8 }, (_, i) => ({ name: `L${i}`, weights: { path: `w${i}.png` } }));
    const extra: Record<string, Uint8Array> = {};
    for (let i = 0; i < 8; i++) extra[`w${i}.png`] = new Uint8Array([1]);
    let zip: Uint8Array = zipOf(json, extra);
    for (let i = 0; i < 8; i++) zip = declareSize(zip, `w${i}.png`, UNZIP_LIMITS.weights); // 8 × 64MB + 画像 > 512MB
    await expect(deserializeProject(zip)).rejects.toThrow(/合計/);
  });

  it('無圧縮のエントリで展開後のサイズを小さく偽っても、実際の大きさで上限を判定する', async () => {
    const json = oneLayer({}) as any;
    json.documents[0].layers[0].weights.path = 'w.png';
    const zip = declareSize(zipSync({
      'project.json': strToU8(JSON.stringify(json)), 'images/doc-0.png': new Uint8Array([1]),
      'w.png': [new Uint8Array(UNZIP_LIMITS.weights + 1), { level: 0 }], // 無圧縮で格納し、展開後は 1 バイトと偽る
    }), 'w.png', 1);
    await expect(deserializeProject(zip)).rejects.toThrow(/大きすぎます/);
  });

  it('ZIP の中のパスにプロトタイプの名前(constructor など)を書いても、ファイルがあるとは見なさない', async () => {
    const json = oneLayer({}) as any;
    json.documents[0].image.path = 'constructor';
    await expect(deserializeProject(zipOf(json))).rejects.toThrow(/見つかりません/);
  });

  it('使わないファイルは展開しない。サムネイルが大きすぎるときは捨てて読み込みは続ける', async () => {
    // 展開しようとすれば 4GB を確保して失敗するエントリ
    let zip: Uint8Array = declareSize(zipOf(oneLayer({}), { 'junk.bin': new Uint8Array([1]), 'thumbnail.png': new Uint8Array([2]) }), 'junk.bin', 0xfffffff0);
    zip = declareSize(zip, 'thumbnail.png', UNZIP_LIMITS.thumbnail + 1);
    const { project, thumbnail } = await deserializeProject(zip);
    expect(project.documents.length).toBe(1);
    expect(thumbnail).toBeUndefined();
  });

  it('project.json が壊れている・形が違うときは分かりやすく失敗する', async () => {
    await expect(deserializeProject(zipSync({ 'project.json': strToU8('{oops') }))).rejects.toThrow(/project.json/);
    const { project } = await deserializeProject(zipOf({ formatVersion: 1, project: {}, documents: { a: 1 } }));
    expect(project.documents).toEqual([]);
  });

  it('レイヤーの ID が空・重複していたら振り直す。レイヤーが無ければ空のレイヤーを1枚作る。null の要素は無視する', async () => {
    const json = oneLayer({}) as any;
    json.documents[0].id = 'X';
    json.documents[0].layers = [null, { id: 'X', name: 'a', weights: {} }, { id: 'X', name: 'b' }, { id: '', name: 'c' }, 7];
    const { project } = await deserializeProject(zipOf(json));
    const ids = [project.documents[0].id, ...project.documents[0].layers.map(l => l.id)];
    expect(project.documents[0].layers.map(l => l.name)).toEqual(['a', 'b', 'c']);
    expect(new Set(ids).size).toBe(4);
    expect(ids[0]).toBe('X');

    json.documents[0].layers = [];
    const empty = await deserializeProject(zipOf(json));
    expect(empty.project.documents[0].layers.length).toBe(1);
  });

  it('新しい版のファイルは読めないと伝える', () => {
    expect(() => migrate({ formatVersion: FORMAT_VERSION + 1 })).toThrow(/新しい版/);
    expect(() => migrate({ formatVersion: 'x' })).toThrow();
  });

  it('ZIP でないものは分かりやすく失敗する', async () => {
    await expect(deserializeProject(new Uint8Array([1, 2, 3]))).rejects.toThrow(/展開できません/);
  });
});

function buildPng(w: number, h: number, depth: number, ctype: number, idat: Uint8Array): Uint8Array {
  // encodeGrayPng を土台に IHDR と IDAT を差し替える
  const base = encodeGrayPng(1, 1, new Uint8Array([0]));
  const crcOf = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crcOf(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = depth; ihdr[9] = ctype;
  const parts = [base.subarray(0, 8), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** ZIP の中央ディレクトリに書かれた「展開後のサイズ」を書き換える(実際のデータはそのまま) */
function declareSize(zip: Uint8Array, name: string, size: number): Uint8Array {
  const out = zip.slice(), dv = new DataView(out.buffer);
  for (let p = 0; p + 46 <= out.length; p++) {
    if (dv.getUint32(p, true) !== 0x02014b50) continue;
    const n = dv.getUint16(p + 28, true);
    if (new TextDecoder().decode(out.subarray(p + 46, p + 46 + n)) === name) { dv.setUint32(p + 24, size, true); return out; }
  }
  throw new Error(`entry ${name} not found`);
}
