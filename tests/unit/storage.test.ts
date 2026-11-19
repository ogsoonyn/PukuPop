import { describe, it, expect } from 'vitest';
import { zlibSync, zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { encodeGrayPng, decodePngToGray } from '../../src/storage/png';
import { serializeProject, deserializeProject, migrate, FORMAT_VERSION, UNZIP_LIMITS } from '../../src/storage/popstage';
import { createDocument, createProject, createLayer, defaultMultiCamera } from '../../src/model/project';
import { captureFavorite } from '../../src/model/favorites';
import { takeFromKeys } from '../../src/physics/take';
import { imageHeaderSize, jpegOrientation, imageOrientedSize, isImageMime, sniffImageMime } from '../../src/storage/imagehead';

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
    l1.pop = 1234; l1.physics = { enabled: false, preset: 'bain', hardness: 0.1, mass: 0.9, weight: 0.3, damping: 0.05, motion: 'stretch', motionParams: { 'stretch.amp': 1.5, 'stretch.dir': 3, 'charge2.depth': 0.9 } };
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

  it('キーフレームの一覧を、記録と別に保存して戻す。項目の無い古いファイルは記録のキーフレームで補う(Issue #145)', async () => {
    const key = (yaw: number, seconds = 1) => ({ view: { yaw, pitch: 0, roll: 0, zoom: 1, target: { x: 0, y: 0, z: 0 } }, seconds, mode: 'smooth' as const });
    const p = makeProject();
    // 記録で入れ替えた後: 記録はキーフレームを持たないが、一覧は残っている
    p.take = { samples: takeFromKeys([key(0), key(1)], p.camera.fov)!.samples };
    p.keyframes = [key(0.1, 2), key(0.2), key(0.3, 9)];
    const { project: q } = await deserializeProject(serializeProject(p));
    expect(q.take!.keys).toBeUndefined();
    expect(q.keyframes.map(k => [k.view.yaw, k.seconds])).toEqual([[0.1, 2], [0.2, 1], [0.3, 5]]); // 秒数は範囲に丸める
    // 1つだけでも残す。空にした一覧は、記録のキーフレームで補わない
    p.keyframes = [key(0.5)];
    expect((await deserializeProject(serializeProject(p))).project.keyframes.map(k => k.view.yaw)).toEqual([0.5]);
    p.take = takeFromKeys([key(0), key(1)], p.camera.fov);
    p.keyframes = [];
    expect((await deserializeProject(serializeProject(p))).project.keyframes).toEqual([]);
    // 項目の無い古いファイル: 記録がキーフレームから作ったものなら、そのキーフレーム。そうでなければ空
    const files = unzipSync(serializeProject(p));
    const json = JSON.parse(strFromU8(files['project.json']));
    delete json.project.keyframes;
    files['project.json'] = strToU8(JSON.stringify(json));
    const old = (await deserializeProject(zipSync(files))).project;
    expect(old.keyframes.map(k => k.view.yaw)).toEqual([0, 1]);
    expect(old.keyframes).not.toBe(old.take!.keys); // 写しを持つ(一覧を編集しても記録は変わらない)
    // 配列でなければ、項目が無いのと同じ
    json.project.keyframes = { 0: 1 };
    files['project.json'] = strToU8(JSON.stringify(json));
    expect((await deserializeProject(zipSync(files))).project.keyframes.map(k => k.view.yaw)).toEqual([0, 1]);
    delete files['motion/take.json'];
    expect((await deserializeProject(zipSync(files))).project.keyframes).toEqual([]);
  });

  it('読み込みでレイヤーの ID を振り直したら、記録(今の記録・お気に入りの記録)のつかみの効き具合の ID も合わせる(Issue #59)', async () => {
    const p = makeProject(), doc = p.documents[0], [l1, l2] = doc.layers;
    const key = (yaw: number) => ({ view: { yaw, pitch: 0, roll: 0, zoom: 1, target: { x: 0, y: 0, z: 0 } }, seconds: 1, mode: 'smooth' as const });
    const withGains = (yaw: number) => ({
      samples: takeFromKeys([key(0), key(yaw)], p.camera.fov)!.samples.map(s => ({ ...s, grabGains: [[l1.id, 0.25], [l2.id, 0.75]] as [string, number][] })),
    });
    p.take = withGains(1);
    // 今の記録とは別の記録を持つお気に入り(motion/favorite-1.json)
    p.favorites = [{ ...captureFavorite(p, doc, { name: 'a', playing: false }), take: withGains(2) }];
    // 細工したファイル: 1枚目のレイヤーの ID をドキュメントの ID と同じにする(読み込みで振り直される)
    const files = unzipSync(serializeProject(p));
    for (const path of ['project.json', 'motion/take.json', 'motion/favorite-1.json']) {
      expect(files[path]).toBeDefined();
      files[path] = strToU8(strFromU8(files[path]).replaceAll(l1.id, doc.id));
    }
    const q = (await deserializeProject(zipSync(files))).project;
    const [m1, m2] = q.documents[0].layers;
    expect(m1.id).not.toBe(doc.id);
    expect(m2.id).toBe(l2.id);
    for (const t of [q.take!, q.favorites[0].take!]) expect(t.samples[0].grabGains).toEqual([[m1.id, 0.25], [m2.id, 0.75]]);
    expect(q.favorites[0].layers.map(l => l.id)).toEqual([m1.id, m2.id]);

    // 2枚が同じ ID: その ID は先に出てきたレイヤーを指す(振り直した2枚目には当てない)。
    // 今の記録とお気に入りが同じ記録を指すときは、当て直したあとも同じ記録のまま
    p.favorites = [captureFavorite(p, doc, { name: 'b', playing: false })];
    const dup = unzipSync(serializeProject(p));
    expect(JSON.parse(strFromU8(dup['project.json'])).project.favorites[0].take).toBe('motion/take.json');
    for (const path of ['project.json', 'motion/take.json']) dup[path] = strToU8(strFromU8(dup[path]).replaceAll(l2.id, l1.id));
    const r = (await deserializeProject(zipSync(dup))).project;
    const [n1, n2] = r.documents[0].layers;
    expect(n1.id).toBe(l1.id);
    expect(n2.id).not.toBe(l1.id);
    expect(r.take!.samples[0].grabGains).toEqual([[n1.id, 0.25]]);
    expect(r.favorites[0].take).toBe(r.take);
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
        layers: [{ name: 'L', weights: { path: 'none.png' }, physics: { preset: 'custom', motion: 'charge2',
          motionParams: { 'charge2.depth': 5, 'charge2.time': 0.5, 'charge2.zzz': 1, 'nope.depth': 1, 'circle.dir': 7, 'stretch.dir': 2, 'jump.height': 'x' } } }] }],
    };
    const zip = zipSync({ 'project.json': strToU8(JSON.stringify(json)), 'images/doc-0.png': new Uint8Array([1]) });
    const { project } = await deserializeProject(zip);
    expect(project.documents[0].layers[0].physics.motionParams).toEqual({ 'charge2.depth': 1, 'charge2.time': 0.5, 'stretch.dir': 2 });
  });

  it('統合した前の「ためて膨らむ」(charge)は、横の広がり 0% の charge2 として読み、ためる深さ・時間・膨らみの強さを引き継ぐ', async () => {
    const physics = (o: object, id?: string) => ({ id, name: 'L', weights: { path: 'none.png' }, physics: o });
    // お気に入りが持つレイヤーの揺れも同じように読む
    const fav = { id: 'F1', name: 'f', createdAt: new Date(0).toISOString(), autoSwing: { enabled: true, period: 2, strength: 0.5 }, camera: {}, take: null, playing: false,
      layers: [{ id: 'L1', pop: 10, blend: 'add', physics: { preset: 'tame', motion: 'charge', motionParams: { 'charge.depth': 0.8 } } }] };
    const json = {
      formatVersion: 1, app: 'PukuPop', project: { favorites: [fav] },
      documents: [{ name: 'x', image: { path: 'images/doc-0.png', width: 10, height: 10 }, layers: [
        physics({ preset: 'tame', motion: 'charge', motionParams: { 'charge.depth': 0.9, 'charge.time': 0.4, 'charge.bulge': 1.2, 'jump.height': 2 } }, 'L1'),
        // 前に charge2 へ切り替えたときの値は、charge の値(無ければ既定値)で置き換える
        physics({ preset: 'custom', motion: 'charge', motionParams: { 'charge2.depth': 0.2, 'charge2.spread': 0.4, 'charge2.pinch': 0.3 } }),
        // 揺らし方の項目が無い古いファイルは、プリセットの揺らし方で補う。固有設定は前の動きを保つのに要るもの(ためてぼよんの横の広がり 0%)だけ補い、
        // 後から足した値(どきどきの横の広がり)は入れない
        physics({ preset: 'tame' }),
        physics({ preset: 'doki' }),
      ] }],
    };
    const { project } = await deserializeProject(zipSync({ 'project.json': strToU8(JSON.stringify(json)), 'images/doc-0.png': new Uint8Array([1]) }));
    const ph = project.documents[0].layers.map(l => l.physics);
    expect(ph.map(p => p.motion)).toEqual(['charge2', 'charge2', 'charge2', 'heartbeat']);
    expect(ph[0].preset).toBe('tame');
    expect(ph[0].motionParams).toEqual({ 'charge2.depth': 0.9, 'charge2.time': 0.4, 'charge2.bulge': 1.2, 'charge2.spread': 0, 'jump.height': 2 });
    expect(ph[1].motionParams).toEqual({ 'charge2.spread': 0, 'charge2.pinch': 0.3 });
    expect(ph[2].motionParams).toEqual({ 'charge2.spread': 0 });
    expect(ph[3].motionParams).toEqual({});
    const fp = project.favorites[0].layers[0].physics;
    expect(fp.motion).toBe('charge2');
    expect(fp.motionParams).toEqual({ 'charge2.depth': 0.8, 'charge2.spread': 0 });
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

  it('formatVersion は JSON の数だけを版として読む(文字列の "1"・true・[1] は断る)', async () => {
    expect(migrate({ formatVersion: 1 }).formatVersion).toBe(1);
    for (const v of ['1', true, [1], 1.5, 0, null]) expect(() => migrate({ formatVersion: v })).toThrow(/formatVersion が不正/);
    const json = oneLayer({}) as any;
    json.formatVersion = '1';
    await expect(deserializeProject(zipOf(json))).rejects.toThrow(/formatVersion が不正/);
  });

  it('元画像の拡張子は中身(分からなければ mime)から決め、パスの末尾をそのまま使わない', async () => {
    const png = encodeGrayPng(3, 2, new Uint8Array(6));
    const jpeg = jpegOf(30, 20, 1);
    const load = async (image: object, bytes: Uint8Array, path = 'x/a.b/c') => {
      const json = oneLayer({}) as any;
      json.documents[0].image = { path, width: 10, height: 10, ...image };
      const { project } = await deserializeProject(zipSync({ 'project.json': strToU8(JSON.stringify(json)), [path]: bytes }));
      return project;
    };
    // 中身が PNG なら、パスや mime が違っても PNG として読む。保存し直すと決まった形のパスになる
    const p = await load({ mime: 'image/webp' }, png);
    expect(p.documents[0].image).toMatchObject({ mime: 'image/png', ext: 'png' });
    const back = unzipSync(serializeProject(p));
    expect(Object.keys(back).filter(k => k.startsWith('images/'))).toEqual(['images/doc-0.png']);
    const pj = await load({ mime: 'image/png' }, jpeg);
    expect(pj.documents[0].image).toMatchObject({ mime: 'image/jpeg', ext: 'jpg' });
    expect(Object.keys(unzipSync(serializeProject(pj))).filter(k => k.startsWith('images/'))).toEqual(['images/doc-0.jpg']);
    // 中身から分からなければ mime から。知らない mime(プロトタイプの名前も)・無いときは PNG
    expect((await load({ mime: 'image/webp' }, new Uint8Array([1]))).documents[0].image).toMatchObject({ mime: 'image/webp', ext: 'webp' });
    for (const mime of ['image/gif', 'constructor', 3, undefined]) {
      expect((await load({ mime }, new Uint8Array([1]))).documents[0].image).toMatchObject({ mime: 'image/png', ext: 'png' });
    }
  });

  it('project.json に元画像の幅・高さが無い・不正なときは、画像のヘッダ(JPEG は EXIF の向きを当てた寸法)で補う', async () => {
    const load = async (image: object, bytes: Uint8Array) => {
      const json = oneLayer({}) as any;
      json.documents[0].image = { path: 'images/doc-0.png', ...image };
      const { project } = await deserializeProject(zipSync({ 'project.json': strToU8(JSON.stringify(json)), 'images/doc-0.png': bytes }));
      const { width, height } = project.documents[0].image;
      return [width, height];
    };
    const png = encodeGrayPng(30, 20, new Uint8Array(600));
    // 両方とも正しければ project.json の値(丸めて上限まで)
    expect(await load({ width: 300.4, height: 200 }, png)).toEqual([300, 200]);
    expect(await load({ width: 99999, height: 200 }, png)).toEqual([32768, 200]);
    // 無い・数でない・1 未満・片方だけ不正なら、ヘッダの寸法
    for (const bad of [{}, { width: '300', height: 200 }, { width: 0, height: 0 }, { width: 300 }, { width: 300, height: null }, { width: -5, height: 200 }]) {
      expect(await load(bad, png)).toEqual([30, 20]);
    }
    // JPEG は EXIF の向きが 5〜8 なら縦横を入れ替える(リトルエンディアン・ビッグエンディアンの両方)
    expect(await load({}, jpegOf(30, 20, 1))).toEqual([30, 20]);
    expect(await load({}, jpegOf(30, 20, 6))).toEqual([20, 30]);
    expect(await load({}, jpegOf(30, 20, 8, false))).toEqual([20, 30]);
    expect(await load({}, jpegOf(30, 20, 3, false))).toEqual([30, 20]);
    // WebP のヘッダからも補う
    for (const kind of ['VP8 ', 'VP8L', 'VP8X'] as const) expect(await load({}, webpOf(kind, 30, 20))).toEqual([30, 20]);
    // ヘッダの寸法にも上限を当てる
    const huge = encodeGrayPng(1, 1, new Uint8Array(1));
    new DataView(huge.buffer, huge.byteOffset).setUint32(16, 100000);
    expect(await load({}, huge)).toEqual([32768, 1]);
    // ヘッダからも読めない・ヘッダの寸法が 0 なら読めないファイル
    await expect(load({}, new Uint8Array([1]))).rejects.toThrow(/寸法が分かりません/);
    await expect(load({}, jpegFrom(sof0(0, 20)))).rejects.toThrow(/寸法が分かりません/);
    await expect(load({}, webpOf('VP8 ', 30, 0))).rejects.toThrow(/寸法が分かりません/);
  });

  it('ZIP でないものは分かりやすく失敗する', async () => {
    await expect(deserializeProject(new Uint8Array([1, 2, 3]))).rejects.toThrow(/展開できません/);
  });
});

describe('画像のヘッダ', () => {
  it('扱う画像の種類は自分のプロパティだけで見分ける(constructor などを通さない。Issue #151)', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/webp']) expect(isImageMime(m)).toBe(true);
    for (const m of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'image/gif', '', undefined, null, 1]) expect(isImageMime(m)).toBe(false);
  });

  it('種類と寸法を中身から読む', () => {
    expect(sniffImageMime(encodeGrayPng(3, 2, new Uint8Array(6)))).toBe('image/png');
    expect(sniffImageMime(jpegOf(3, 2, 1))).toBe('image/jpeg');
    expect(sniffImageMime(webpOf('VP8L', 3, 2))).toBe('image/webp');
    expect(sniffImageMime(new Uint8Array([1, 2, 3]))).toBeNull();
    // 印の一部だけが合うものは見分けない(RIFF の無い WEBP、2バイトだけの PNG の印)
    expect(sniffImageMime(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBeNull();
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0, 0]))).toBeNull();
    for (const kind of ['VP8 ', 'VP8L', 'VP8X'] as const) expect(imageHeaderSize(webpOf(kind, 300, 200))).toEqual({ width: 300, height: 200 });
  });

  it('JPEG の EXIF の向きを読む。Exif でない APP1 や余計なバイトは読み飛ばす', () => {
    const exif = (o: number, opt = {}) => jpegSeg(0xe1, exifApp1(o, opt));
    expect(jpegOrientation(jpegFrom(exif(6), sof0(30, 20)))).toBe(6);
    expect(jpegOrientation(jpegFrom(exif(7, { le: false }), sof0(30, 20)))).toBe(7);
    // 先に XMP の APP1・APP0 があっても読む
    const xmp = jpegSeg(0xe1, [...strToU8('http://ns.adobe.com/xap/1.0/'), 0, 1, 2, 3]);
    expect(jpegOrientation(jpegFrom(jpegSeg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0]), xmp, exif(5), sof0(30, 20)))).toBe(5);
    // マーカーの間の余計なバイト・0xFF の詰め物
    expect(jpegOrientation(jpegFrom([0, 0, 0xff, 0xff], exif(8), sof0(30, 20)))).toBe(8);
    expect(imageOrientedSize(jpegFrom([0, 0xff], exif(6), sof0(30, 20)))).toEqual({ width: 20, height: 30 });
    // 画像データ(SOS)より後ろの APP1 は見ない
    expect(jpegOrientation(jpegFrom(sof0(30, 20), jpegSeg(0xda, [0]), exif(6)))).toBe(1);
  });

  it('EXIF の向きが読めない・細工した形なら 1(回転なし)', () => {
    const one = (data: number[]) => jpegOrientation(jpegFrom(jpegSeg(0xe1, data), sof0(30, 20)));
    expect(one(exifApp1(9))).toBe(1);
    expect(one(exifApp1(0))).toBe(1);
    expect(one(exifApp1(6, { type: 4 }))).toBe(1); // LONG
    expect(one(exifApp1(6, { count: 2 }))).toBe(1);
    expect(one(exifApp1(6, { ifdOffset: 0x7fffffff }))).toBe(1);
    expect(one(exifApp1(6, { ifdOffset: 0xffffffff }))).toBe(1);
    expect(one(exifApp1(6, { entries: 0xffff }))).toBe(6); // 件数が多すぎても、先頭の項目が向きなら読める
    expect(one(exifApp1(6, { entries: 0 }))).toBe(1);
    expect(one([0x45, 0x78, 0x69, 0x66, 0, 0, 0x41, 0x41, 42, 0, 8, 0, 0, 0])).toBe(1); // II/MM でない
    // APP1 が途中で切れている・長さが 2 未満
    const app1 = jpegSeg(0xe1, exifApp1(6));
    expect(jpegOrientation(new Uint8Array([0xff, 0xd8, ...app1.slice(0, 20)]))).toBe(1);
    expect(jpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 1, ...app1]))).toBe(1);
    // JPEG でない・空
    expect(jpegOrientation(new Uint8Array())).toBe(1);
    expect(jpegOrientation(encodeGrayPng(1, 1, new Uint8Array(1)))).toBe(1);
  });

  it('壊した JPEG でも例外にならず、すぐ終わる', () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const base = jpegFrom(jpegSeg(0xe1, exifApp1(6)), sof0(30, 20));
    for (let i = 0; i < 3000; i++) {
      const b = base.slice(0, 2 + Math.floor(rand() * (base.length - 1)));
      for (let k = 0; k < 4; k++) b[Math.floor(rand() * b.length)] = Math.floor(rand() * 256);
      const o = jpegOrientation(b);
      expect(o >= 1 && o <= 8).toBe(true);
      imageOrientedSize(b);
    }
    expect(jpegOrientation(new Uint8Array(1 << 20).fill(0xff))).toBe(1);
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

/** EXIF の APP1 の中身。向きのタグ1つだけの IFD を持つ。細工した形も作れるよう、型・個数・IFD の位置・件数を変えられる */
function exifApp1(orientation: number, o: { le?: boolean; type?: number; count?: number; ifdOffset?: number; entries?: number } = {}): number[] {
  const le = o.le ?? true;
  const u16 = (v: number) => (le ? [v & 0xff, (v >> 8) & 0xff] : [(v >> 8) & 0xff, v & 0xff]);
  const u32 = (v: number) => (le ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24] : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  const tiff = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(o.ifdOffset ?? 8), ...u16(o.entries ?? 1),
    ...u16(0x0112), ...u16(o.type ?? 3), ...u32(o.count ?? 1), ...u16(orientation), 0, 0, ...u32(0)];
  return [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
}
const jpegSeg = (m: number, data: number[]) => [0xff, m, (data.length + 2) >> 8, (data.length + 2) & 0xff, ...data];
const sof0 = (w: number, h: number) => jpegSeg(0xc0, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const jpegFrom = (...parts: number[][]) => new Uint8Array([0xff, 0xd8, ...parts.flat(), 0xff, 0xd9]);

/** 寸法(SOF0)と EXIF の向き(APP1)だけを持つ JPEG を作る。画像データは持たない */
function jpegOf(w: number, h: number, orientation: number, littleEndian = true): Uint8Array {
  return jpegFrom(jpegSeg(0xe1, exifApp1(orientation, { le: littleEndian })), sof0(w, h));
}

/** 寸法だけを持つ WebP(VP8 / VP8L / VP8X)のヘッダを作る */
function webpOf(kind: 'VP8 ' | 'VP8L' | 'VP8X', w: number, h: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set(strToU8('RIFF'), 0); b.set(strToU8('WEBP'), 8); b.set(strToU8(kind), 12);
  if (kind === 'VP8X') { b.set([(w - 1) & 0xff, ((w - 1) >> 8) & 0xff, (w - 1) >> 16], 24); b.set([(h - 1) & 0xff, ((h - 1) >> 8) & 0xff, (h - 1) >> 16], 27); }
  if (kind === 'VP8L') { const v = (w - 1) | ((h - 1) << 14); b[20] = 0x2f; b.set([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0x0f], 21); }
  if (kind === 'VP8 ') b.set([w & 0xff, (w >> 8) & 0x3f, h & 0xff, (h >> 8) & 0x3f], 26);
  return b;
}

describe('膨らんだ瞬間のエフェクト(レイヤーの effect)', () => {
  it('保存して読むと戻り、項目の無い古いファイルは切ったものとして読む。形の合わない値は既定値', async () => {
    const doc = createDocument({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', ext: 'png', width: 40, height: 20 }, 'p');
    doc.layers[0].effect = { enabled: true, ring: true, timing: 'peak', opacity: 0.8, spread: 0.5, duration: 1.2, color: 'custom', customColor: '#12ab34', blend: 'add' };
    const bytes = serializeProject(createProject(doc));
    const back = await deserializeProject(bytes);
    expect(back.project.documents[0].layers[0].effect).toEqual(doc.layers[0].effect);

    const files = unzipSync(bytes), json = JSON.parse(strFromU8(files['project.json']));
    delete json.documents[0].layers[0].effect;
    const old = await deserializeProject(zipSync({ ...files, 'project.json': strToU8(JSON.stringify(json)) }));
    expect(old.project.documents[0].layers[0].effect.enabled).toBe(false);

    json.documents[0].layers[0].effect = { enabled: 'yes', timing: 'later', opacity: 9, spread: -1, duration: 'x', color: 'red', customColor: 'url(x)', blend: 'screen' };
    const bad = (await deserializeProject(zipSync({ ...files, 'project.json': strToU8(JSON.stringify(json)) }))).project.documents[0].layers[0].effect;
    expect(bad).toEqual({ enabled: false, ring: false, timing: 'burst', opacity: 1, spread: 0.05, duration: 0.55, color: 'white', customColor: '#ff8ab8', blend: 'normal' });
  });
});
