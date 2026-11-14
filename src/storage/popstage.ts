/**
 * .pukupop 形式(改名前は .popstage)。ZIP の中に project.json、元画像、ウェイトマップ(グレースケールPNG)、サムネイルを入れる。
 * DOM に依存しない(画像のデコードが必要な場合だけ呼び出し側から関数を渡す)。
 */
import { unzipSync, strToU8, strFromU8 } from 'fflate';
import { zipParts, concatParts, type ZipEntry } from './zip';
import {
  LIMITS, PRESETS, MOTIONS, BLENDS, MOTION_PARAMS, createProject, createLayer, defaultCamera, defaultMultiCamera, newId, wrapAngle,
  type Project, type CameraState, type Document, type Layer, type PhysicsParams, type PresetName, type MotionPattern, type BlendMode,
  type Favorite, type FavoriteLayer, type AutoSwing,
} from '../model/project';
import { WeightMap, weightSizeFor } from '../model/weightmap';
import { takeToJson, takeFromJson, type Take } from '../physics/take';
import { FAVORITE_NAME_MAX } from '../model/favorites';
import { encodeGrayPng, decodePngToGray, readPngSize, MAX_PNG_SIDE, type GrayImage } from './png';

export const FORMAT_VERSION = 1;
export const FILE_EXTENSION = '.pukupop';
/** 改名前(PopStage)の拡張子。開くときだけ受け付ける */
export const LEGACY_FILE_EXTENSION = '.popstage';

/** 展開する1ファイルあたりの上限(バイト)。ZIP 爆弾でメモリを使い切らないよう、宣言サイズで弾く */
export const UNZIP_LIMITS = { json: 16 << 20, take: 16 << 20, image: 256 << 20, weights: 64 << 20, thumbnail: 8 << 20, total: 512 << 20 };
/**
 * お気に入りが持つ記録1つの上限(バイト)。最長 60 秒の記録でも 1.2MB ほどなので、余裕を見てこの大きさにする
 * (最大 30 件あるので、今の記録と同じ上限にすると、細工したファイルで合計の上限を使い切れてしまう)
 */
export const FAVORITE_TAKE_LIMIT = 4 << 20;

/** 読み込むドキュメント数の上限(アプリが使うのは先頭だけだが、形式としては複数持てる) */
const MAX_DOCUMENTS = 8;

/** プロトタイプを辿らずに、自前のキーかどうかを調べる(`constructor` などを通さない) */
const own = (o: object, k: unknown): boolean => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

/** 背景色は #rrggbb だけを受け付ける(CSS に入るので、url() などを通さない) */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** 操作の記録(ループ再生用)を入れるファイル。無いファイル(古い版・記録なし)は記録なしとして開く */
export const TAKE_PATH = 'motion/take.json';
/** お気に入りだけが持つ記録を入れるファイル(今の記録と同じものは TAKE_PATH を指す) */
const favoriteTakePath = (i: number) => `motion/favorite-${i}.json`;
/** お気に入りの記録として読んでよいパス(ほかのファイルの名前や上限を横取りさせない) */
const isFavoriteTakePath = (v: unknown): v is string => typeof v === 'string' && (v === TAKE_PATH || /^motion\/favorite-\d{1,3}\.json$/.test(v));
/** 記録は作ったあと書き換えないので、自動保存のたびに JSON を作り直さないよう記録ごとに1回だけ作る */
const takeBytes = new WeakMap<Take, Uint8Array>();

/* ---------- project.json の形 ---------- */

interface LayerJson {
  id: string; name: string; visible: boolean; pop: number; blend?: BlendMode; physics: PhysicsParams;
  weights: { path: string; width: number; height: number };
}
interface DocumentJson {
  id: string; name: string;
  image: { path: string; mime: string; width: number; height: number };
  position: Project['documents'][number]['position']; rotation: Project['documents'][number]['rotation'];
  scale: number; meshDensity: number; opacity: number; layers: LayerJson[];
}
/** お気に入り。記録は別のファイルに入れ、take にそのパスを書く(記録が無ければ null) */
interface FavoriteJson {
  id: string; name: string; createdAt: string; layers: FavoriteLayer[]; autoSwing: AutoSwing; camera: CameraState;
  take: string | null; playing: boolean;
}
export interface ProjectJson {
  formatVersion: number;
  /** 書き出したアプリ。改名前のファイルは 'PopStage' */
  app: 'PukuPop' | 'PopStage';
  savedAt: string;
  /** multiCamera・favorites は後から足した項目なので、古いファイルには無い */
  project: Pick<Project, 'background' | 'camera' | 'fps' | 'autoSwing'> & { multiCamera?: Project['multiCamera']; favorites?: FavoriteJson[] };
  documents: DocumentJson[];
}

/** 古い版から順に変換する。キーは「この版から次の版へ」の変換。 */
const MIGRATIONS: Record<number, (j: Record<string, unknown>) => Record<string, unknown>> = {
  // 例: 1: j => ({ ...j, formatVersion: 2, ... }),
};

export function migrate(json: Record<string, unknown>): ProjectJson {
  let v = Number(json.formatVersion);
  if (!Number.isInteger(v) || v < 1) throw new Error('project.json の formatVersion が不正です');
  if (v > FORMAT_VERSION) throw new Error(`このファイルは新しい版(${v})で保存されています。アプリを更新してください。`);
  while (v < FORMAT_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) throw new Error(`formatVersion ${v} からの変換がありません`);
    json = m(json); v = Number(json.formatVersion);
  }
  return json as unknown as ProjectJson;
}

/* ---------- 保存 ---------- */

/**
 * プロジェクトを .pukupop のバイト列にする。
 * pngCache を渡すと、レイヤー ID ごとのウェイト PNG を使い回す(ウェイトを変えたら呼び出し側で消すこと)。
 */
export function serializeProject(project: Project, opts: SerializeOptions = {}): Uint8Array {
  return concatParts(projectParts(project, opts));
}

export interface SerializeOptions {
  thumbnail?: Uint8Array;
  /** レイヤー ID ごとのウェイト PNG。data が今のウェイトの配列と同じときだけ使い回す */
  pngCache?: Map<string, PngCacheEntry>;
}
export interface PngCacheEntry { data: Uint8Array; png: Uint8Array }

/** 元画像を Blob にしたもの(自動保存のたびに数十MB をコピーしないよう、画像ごとに1回だけ作る) */
const imageBlobs = new WeakMap<Uint8Array, Blob>();

/**
 * serializeProject と同じ中身を Blob で返す(自動保存用)。
 * 元画像は ZIP にコピーせず、画像ごとに作っておいた Blob をそのまま並べるので、画像が大きくてもほとんど止まらない。
 */
export function serializeProjectBlob(project: Project, opts: SerializeOptions = {}): Blob {
  const images = new Set(project.documents.map(d => d.image.bytes));
  return new Blob(projectParts(project, opts).map(p => {
    if (!images.has(p)) return p as BlobPart;
    let b = imageBlobs.get(p);
    if (!b) { b = new Blob([p as BlobPart]); imageBlobs.set(p, b); }
    return b;
  }), { type: 'application/zip' });
}

function projectParts(project: Project, opts: SerializeOptions): Uint8Array[] {
  const files: ZipEntry[] = [];
  const docs: DocumentJson[] = project.documents.map((doc, di) => {
    const imagePath = `images/doc-${di}.${doc.image.ext}`;
    // 元画像のバイト列は読み込んだあと書き換えないので、CRC を使い回せる
    files.push({ name: imagePath, data: doc.image.bytes, stable: true });
    return {
      id: doc.id, name: doc.name,
      image: { path: imagePath, mime: doc.image.mime, width: doc.image.width, height: doc.image.height },
      position: { ...doc.position }, rotation: { ...doc.rotation }, scale: doc.scale,
      meshDensity: doc.meshDensity, opacity: doc.opacity,
      layers: doc.layers.map((layer, li) => {
        const path = `weights/doc-${di}-layer-${li}.png`;
        const data = layer.weights.data, cached = opts.pngCache?.get(layer.id);
        let png = cached && cached.data === data ? cached.png : undefined;
        if (!png) { png = encodeGrayPng(layer.weights.width, layer.weights.height, data); opts.pngCache?.set(layer.id, { data, png }); }
        // キャッシュした PNG は作り直すまで書き換えないので、CRC を使い回せる
        files.push({ name: path, data: png, stable: !!opts.pngCache });
        return {
          id: layer.id, name: layer.name, visible: layer.visible, pop: layer.pop, blend: layer.blend, physics: { ...layer.physics, motionParams: { ...layer.physics.motionParams } },
          weights: { path, width: layer.weights.width, height: layer.weights.height },
        };
      }),
    };
  });
  // 記録は、同じものをいくつ持っていても1回だけ書く(今の記録は TAKE_PATH、お気に入りだけが持つ記録は別のファイル)
  const takePaths = new Map<Take, string>();
  const pushTake = (take: Take, name: string) => {
    let data = takeBytes.get(take);
    if (!data) { data = strToU8(JSON.stringify(takeToJson(take))); takeBytes.set(take, data); }
    files.push({ name, data, level: 6, stable: true });
    takePaths.set(take, name);
  };
  if (project.take) pushTake(project.take, TAKE_PATH);
  const favorites: FavoriteJson[] = project.favorites.map(f => {
    if (f.take && !takePaths.has(f.take)) pushTake(f.take, favoriteTakePath(takePaths.size));
    return {
      id: f.id, name: f.name, createdAt: f.createdAt,
      layers: f.layers.map(l => ({ id: l.id, pop: l.pop, blend: l.blend, physics: { ...l.physics, motionParams: { ...l.physics.motionParams } } })),
      autoSwing: { ...f.autoSwing }, camera: structuredClone(f.camera), take: f.take ? takePaths.get(f.take)! : null, playing: f.playing,
    };
  });
  const json: ProjectJson = {
    formatVersion: FORMAT_VERSION, app: 'PukuPop', savedAt: new Date().toISOString(),
    project: {
      background: project.background, camera: structuredClone(project.camera), multiCamera: structuredClone(project.multiCamera), fps: project.fps, autoSwing: { ...project.autoSwing },
      ...(favorites.length ? { favorites } : {}),
    },
    documents: docs,
  };
  files.push({ name: 'project.json', data: strToU8(JSON.stringify(json, null, 2)), level: 6 });
  if (opts.thumbnail) files.push({ name: 'thumbnail.png', data: opts.thumbnail });
  return zipParts(files);
}

/* ---------- 読み込み ---------- */

export interface LoadOptions {
  /** 内蔵デコーダで読めないPNG(インターレース等)のための代替デコーダ */
  decodeFallback?: (bytes: Uint8Array) => Promise<GrayImage>;
}

const num = (v: unknown, min: number, max: number, def: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
  return Math.max(min, Math.min(max, n));
};
const unit = (v: unknown, def: number) => num(v, 0, 1, def);
const str = (v: unknown, def: string) => (typeof v === 'string' ? v : def);
const vec = (v: unknown) => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { x: num(o.x, -1e6, 1e6, 0), y: num(o.y, -1e6, 1e6, 0), z: num(o.z, -1e6, 1e6, 0) };
};

/** 揺らし方の固有設定。知らない項目は捨て、範囲外は丸め、選択式は選択肢に無い値を捨てる。 */
function motionParamsFrom(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    const [m, k] = key.split('.');
    const def = own(MOTION_PARAMS, m) ? MOTION_PARAMS[m as MotionPattern].find(d => d.key === k) : undefined;
    if (!def || typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    if (def.options) { if (def.options.some(([val]) => val === raw)) out[key] = raw; }
    else out[key] = Math.max(def.min, Math.min(def.max, raw));
  }
  return out;
}

function physicsFrom(v: unknown): PhysicsParams {
  const o = (v ?? {}) as Record<string, unknown>;
  const preset: PresetName = o.preset === 'custom' || own(PRESETS, o.preset) ? (o.preset as PresetName) : 'custom';
  const base = PRESETS.puru;
  // 揺らし方の項目が無い古いファイルは、プリセットから補う。カスタムならこれまでの動き(左右に振る)にする
  const motion: MotionPattern = own(MOTIONS, o.motion) ? (o.motion as MotionPattern)
    : preset !== 'custom' ? PRESETS[preset].motion : 'shake';
  return {
    enabled: o.enabled !== false, preset,
    hardness: unit(o.hardness, base.hardness), mass: unit(o.mass, base.mass),
    weight: unit(o.weight, 0.15), damping: unit(o.damping, base.damping), motion,
    motionParams: motionParamsFrom(o.motionParams),
  };
}

export async function deserializeProject(bytes: Uint8Array, opts: LoadOptions = {}): Promise<{ project: Project; thumbnail?: Uint8Array }> {
  // まず project.json だけを展開し、そこに書かれたファイルだけを上限付きで展開する
  const pj = unzipEntries(bytes, new Map([['project.json', UNZIP_LIMITS.json]]))['project.json'];
  if (!pj) throw new Error('project.json が見つかりません');
  let parsed: unknown;
  try { parsed = JSON.parse(strFromU8(pj)); } catch { throw new Error('project.json を読めませんでした(壊れています)'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('project.json の形式が不正です');
  const json = migrate(parsed as Record<string, unknown>);
  // 実際に読む分(ドキュメントとレイヤーの上限まで)のファイルだけを展開する
  const isObj = <T>(v: unknown): v is T => !!v && typeof v === 'object';
  const docsJson = (Array.isArray(json.documents) ? json.documents : []).filter(isObj<DocumentJson>).slice(0, MAX_DOCUMENTS);
  const layersOf = (dj: DocumentJson) => (Array.isArray(dj.layers) ? dj.layers : []).filter(isObj<LayerJson>).slice(0, LIMITS.maxLayers);
  const wanted = new Map<string, number>();
  for (const dj of docsJson) {
    if (typeof dj?.image?.path === 'string') wanted.set(dj.image.path, UNZIP_LIMITS.image);
    for (const lj of layersOf(dj)) {
      if (typeof lj?.weights?.path === 'string') wanted.set(lj.weights.path, UNZIP_LIMITS.weights);
    }
  }
  // お気に入り(数の上限まで)と、それが持つ記録のファイル。記録が読めなくても、お気に入りは残す
  const favsJson = (Array.isArray(json.project?.favorites) ? json.project.favorites : []).filter(isObj<FavoriteJson>).slice(0, LIMITS.favorites);
  // サムネイル・記録は読み込みに要らないので、大きすぎるときは黙って捨てる
  const optional = new Map([['thumbnail.png', UNZIP_LIMITS.thumbnail], [TAKE_PATH, UNZIP_LIMITS.take]]);
  for (const fj of favsJson) if (isFavoriteTakePath(fj.take) && !optional.has(fj.take)) optional.set(fj.take, FAVORITE_TAKE_LIMIT);
  const files = unzipEntries(bytes, wanted, optional);

  const project = createProject();
  const p = json.project ?? {} as ProjectJson['project'];
  const cameraOf = (v: unknown, def: CameraState): CameraState => {
    const c = (isObj(v) ? v : {}) as Partial<CameraState>;
    return {
      fov: num(c.fov, LIMITS.fov.min, LIMITS.fov.max, def.fov), yaw: num(c.yaw, -1e3, 1e3, def.yaw),
      pitch: num(c.pitch, -1.5, 1.5, def.pitch), roll: wrapAngle(num(c.roll, -1e3, 1e3, 0)), zoom: num(c.zoom, 0.05, 20, def.zoom), target: vec(c.target),
    };
  };
  project.background = typeof p.background === 'string' && HEX_COLOR.test(p.background) ? p.background : null;
  project.camera = cameraOf(p.camera, defaultCamera());
  // 3面図の自由角度の視点(古いファイルには無いので、そのときは初めの視点)
  // 3面図の自由角度の視点は傾けられないので、傾きは 0 にする
  project.multiCamera = { ...cameraOf(p.multiCamera, defaultMultiCamera()), roll: 0 };
  project.fps = 60;
  project.autoSwing = autoSwingOf(p.autoSwing);
  // 操作の記録。読めなければ記録なしとして開く(画像やウェイトは開けるので、ファイルごと諦めない)。
  // 同じファイルを指す記録は同じものとして読む(お気に入りの記録が今の記録と同じかを見分けられるように)
  const takes = new Map<string, Take | null>();
  const takeAt = (path: unknown, fov: number): Take | null => {
    if (typeof path !== 'string' || !own(files, path)) return null;
    if (!takes.has(path)) {
      let t: Take | null = null;
      try { t = takeFromJson(JSON.parse(strFromU8(files[path])), fov); } catch { t = null; }
      takes.set(path, t);
    }
    return takes.get(path)!;
  };
  project.take = takeAt(TAKE_PATH, project.camera.fov);

  // ID はレイヤーやドキュメントを探す鍵なので、空・重複していたら振り直す
  const seenIds = new Set<string>();
  /** ファイルに書かれたレイヤーの ID → 読み込んだレイヤーの ID(振り直したときに、お気に入りの突き合わせも合わせる) */
  const layerIds = new Map<string, string>();
  const uniqueId = (v: unknown, prefix: string) => {
    let id = typeof v === 'string' && v ? v : newId(prefix);
    while (seenIds.has(id)) id = newId(prefix);
    seenIds.add(id);
    return id;
  };
  for (const dj of docsJson) {
    const imgBytes = own(files, dj.image?.path) ? files[dj.image.path] : undefined;
    if (!imgBytes) throw new Error(`画像 ${dj.image?.path} が見つかりません`);
    const ext = dj.image.path.split('.').pop() ?? 'png';
    const width = Math.round(num(dj.image.width, 1, 1 << 15, 1)), height = Math.round(num(dj.image.height, 1, 1 << 15, 1));
    const doc: Document = {
      id: uniqueId(dj.id, 'D'), name: str(dj.name, '画像'),
      image: { bytes: imgBytes, mime: str(dj.image.mime, 'image/png'), ext, width, height },
      position: vec(dj.position), rotation: vec(dj.rotation), scale: num(dj.scale, 0.01, 100, 1),
      meshDensity: Math.round(num(dj.meshDensity, LIMITS.density.min, LIMITS.density.max, LIMITS.density.def)),
      opacity: unit(dj.opacity, 1), layers: [],
    };
    const ws = weightSizeFor(width, height);
    for (const lj of layersOf(dj)) {
      const wb = own(files, lj.weights?.path) ? files[lj.weights.path] : undefined;
      let weights = new WeightMap(ws.w, ws.h);
      if (wb) {
        let g: GrayImage;
        try { g = decodePngToGray(wb); }
        catch (e) {
          // 内蔵デコーダで読めない PNG だけブラウザに任せる。寸法が大きすぎるものは任せない
          const size = readPngSize(wb);
          if (!opts.decodeFallback || !size || size.width > MAX_PNG_SIDE || size.height > MAX_PNG_SIDE) throw e;
          g = await opts.decodeFallback(wb);
        }
        weights = WeightMap.resampled(new WeightMap(g.width, g.height, g.data), ws.w, ws.h);
      }
      const lid = uniqueId(lj.id, 'L');
      if (typeof lj.id === 'string' && !layerIds.has(lj.id)) layerIds.set(lj.id, lid);
      const layer: Layer = {
        id: lid, name: str(lj.name, `レイヤー${doc.layers.length + 1}`),
        visible: lj.visible !== false, pop: num(lj.pop, LIMITS.pop.min, LIMITS.pop.max, LIMITS.pop.def),
        // 重ね方が無い(古いファイル)・知らない値は加算として読む
        blend: own(BLENDS, lj.blend) ? lj.blend as BlendMode : 'add',
        physics: physicsFrom(lj.physics), weights,
      };
      doc.layers.push(layer);
    }
    // レイヤーが1枚も無いと塗れないので、空のレイヤーを1枚用意する
    if (!doc.layers.length) { const l = createLayer(doc); seenIds.add(l.id); doc.layers.push(l); }
    project.documents.push(doc);
  }
  project.favorites = favoritesFrom(favsJson, layerIds, takeAt, project.camera);
  return { project, thumbnail: files['thumbnail.png'] };
}

function autoSwingOf(v: unknown): AutoSwing {
  const a = (v && typeof v === 'object' ? v : {}) as Partial<AutoSwing>;
  return {
    enabled: a.enabled !== false,
    period: num(a.period, LIMITS.period.min, LIMITS.period.max, LIMITS.period.def),
    strength: unit(a.strength, 0.5),
  };
}

/**
 * お気に入りを読む。形の合わない値は既定値や範囲に丸める。
 * もう無いレイヤーの分も残す(開いている間と同じく、適用で「飛ばしました」と伝え、今の状態と同じとは見なさない)。
 */
function favoritesFrom(
  list: FavoriteJson[], layerIds: Map<string, string>, takeAt: (path: unknown, fov: number) => Take | null, camera: CameraState,
): Favorite[] {
  const out: Favorite[] = [], seen = new Set<string>();
  for (const fj of list) {
    const layers: FavoriteLayer[] = [], used = new Set<string>();
    for (const lj of Array.isArray(fj.layers) ? fj.layers.slice(0, LIMITS.maxLayers) : []) {
      if (!lj || typeof lj !== 'object' || typeof lj.id !== 'string' || !lj.id) continue;
      // 読み込みで振り直したレイヤーは新しい ID に合わせる
      const id = layerIds.get(lj.id) ?? lj.id.slice(0, 64);
      if (used.has(id)) continue;
      used.add(id);
      layers.push({
        id, pop: num(lj.pop, LIMITS.pop.min, LIMITS.pop.max, LIMITS.pop.def),
        blend: own(BLENDS, lj.blend) ? lj.blend : 'add', physics: physicsFrom(lj.physics),
      });
    }
    let id = typeof fj.id === 'string' && fj.id ? fj.id : newId('F');
    while (seen.has(id)) id = newId('F');
    seen.add(id);
    const createdAt = typeof fj.createdAt === 'string' && !Number.isNaN(Date.parse(fj.createdAt)) ? fj.createdAt : new Date(0).toISOString();
    const c = (fj.camera && typeof fj.camera === 'object' ? fj.camera : {}) as Partial<CameraState>;
    const fov = num(c.fov, LIMITS.fov.min, LIMITS.fov.max, camera.fov);
    const take = isFavoriteTakePath(fj.take) ? takeAt(fj.take, fov) : null;
    out.push({
      id, name: str(fj.name, '').trim().slice(0, FAVORITE_NAME_MAX) || `お気に入り ${out.length + 1}`, createdAt, layers,
      autoSwing: autoSwingOf(fj.autoSwing),
      camera: { fov, yaw: num(c.yaw, -1e3, 1e3, camera.yaw), pitch: num(c.pitch, -1.5, 1.5, camera.pitch), roll: wrapAngle(num(c.roll, -1e3, 1e3, 0)), zoom: num(c.zoom, 0.05, 20, camera.zoom), target: vec(c.target) },
      take, playing: fj.playing === true && !!take,
    });
  }
  return out;
}

/**
 * wanted に挙げたファイルだけを展開する。宣言サイズが1ファイルの上限、または合計の上限を超えたら読み込みをやめる。
 * optional に挙げたファイルは、上限を超えていれば展開せずに捨てる。
 * 先に宣言サイズだけを調べてから展開するので、上限を超えるファイルのためにメモリを確保することはない。
 */
function unzipEntries(bytes: Uint8Array, wanted: Map<string, number>, optional = new Map<string, number>()): Record<string, Uint8Array> {
  const broken = () => new Error('プロジェクトファイルを展開できませんでした(壊れているか、形式が違います)');
  // 1回目: 展開せず、展開する予定のエントリの宣言サイズを調べる(同じ名前が重なっていてもすべて数える)
  const tooLarge: string[] = [], skip = new Set<string>();
  let total = 0;
  try {
    unzipSync(bytes, {
      filter: f => {
        const must = wanted.get(f.name), opt = optional.get(f.name);
        // 無圧縮のエントリは宣言サイズに関係なく圧縮後のサイズ分をコピーするので、大きい方で数える
        const size = Math.max(f.size, f.originalSize);
        if (must !== undefined) {
          if (size > must) tooLarge.push(f.name);
          total += size;
        } else if (opt !== undefined) {
          if (size > opt) skip.add(f.name); else total += size;
        }
        return false;
      },
    });
  } catch { throw broken(); }
  if (total > UNZIP_LIMITS.total) throw new Error('プロジェクトファイルの中身が大きすぎます(展開後の合計が上限を超えています)');
  if (tooLarge.length) throw new Error(`プロジェクトファイルの中のファイルが大きすぎます(${tooLarge.join(', ')})`);
  // 2回目: 調べた分だけを展開する
  try {
    return unzipSync(bytes, { filter: f => (wanted.has(f.name) || optional.has(f.name)) && !skip.has(f.name) });
  } catch { throw broken(); }
}
