/** 変更操作の一覧。どれも Store の低レベル操作だけを使う。 */
import type { Command } from './history';
import type { Store, Layer, Document, Project, Favorite } from '../model/project';
import { WeightMap, TILE, type Rect } from '../model/weightmap';
import type { KeyFrame, Take } from '../physics/take';

const OBJ_BYTES = 256;

function deepCopy<T>(v: T): T {
  if (v instanceof WeightMap) return v.clone() as T;
  if (v && typeof v === 'object') return structuredClone(v);
  return v;
}

function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = deepCopy(obj[k]);
  return out;
}

/* ---------- パラメータの変更 ---------- */

export class PatchLayer implements Command {
  readonly bytes = OBJ_BYTES;
  constructor(readonly label: string, private layerId: string, private before: Partial<Layer>, private after: Partial<Layer>) {}
  /** 現在値を before として取り込んで作る */
  static from(store: Store, layerId: string, after: Partial<Layer>, label = 'レイヤー設定の変更'): PatchLayer {
    const f = store.findLayer(layerId);
    if (!f) throw new Error(`layer not found: ${layerId}`);
    return new PatchLayer(label, layerId, pick(f.layer, Object.keys(after) as (keyof Layer)[]), deepCopy(after));
  }
  apply(store: Store): void { store.patchLayer(this.layerId, deepCopy(this.after)); }
  revert(store: Store): void { store.patchLayer(this.layerId, deepCopy(this.before)); }
}

export class PatchDocument implements Command {
  readonly bytes = OBJ_BYTES;
  constructor(readonly label: string, private docId: string, private before: Partial<Document>, private after: Partial<Document>) {}
  static from(store: Store, docId: string, after: Partial<Document>, label = 'ドキュメント設定の変更'): PatchDocument {
    const doc = store.findDoc(docId);
    if (!doc) throw new Error(`document not found: ${docId}`);
    return new PatchDocument(label, docId, pick(doc, Object.keys(after) as (keyof Document)[]), deepCopy(after));
  }
  apply(store: Store): void { store.patchDocument(this.docId, deepCopy(this.after)); }
  revert(store: Store): void { store.patchDocument(this.docId, deepCopy(this.before)); }
}

export class PatchProject implements Command {
  readonly bytes = OBJ_BYTES;
  constructor(readonly label: string, private before: Partial<Project>, private after: Partial<Project>) {}
  static from(store: Store, after: Partial<Project>, label = 'プロジェクト設定の変更'): PatchProject {
    return new PatchProject(label, pick(store.project, Object.keys(after) as (keyof Project)[]), deepCopy(after));
  }
  apply(store: Store): void { store.patchProject(deepCopy(this.after)); }
  revert(store: Store): void { store.patchProject(deepCopy(this.before)); }
}

/**
 * 操作の記録の差し替え(新しく記録した・消した)。記録は作ったあと書き換えないので、コピーせずに持つ。
 */
/**
 * 今の動き(project.take)の差し替え。キーフレームから作った動きに替えるときは、キーフレームの一覧もそのキーフレームに合わせ、
 * アンドゥで前の一覧に戻す(お気に入りの適用など)。一覧を変えないとき(操作の記録・消す・一覧から作る)は、一覧に触らない。
 * 一覧の編集はアンドゥに積まないので、触らないことで、記録をアンドゥしても直しかけの一覧が消えないようにする(Issue #145)。
 */
export class SetTake implements Command {
  readonly bytes: number;
  /** 一覧を替えるときの前後(替えないときは null) */
  private readonly keyframes: { before: KeyFrame[]; after: KeyFrame[] } | null;
  /** keyframes: 実行する前のキーフレームの一覧(project.keyframes) */
  constructor(readonly label: string, private before: Take | null, private after: Take | null, keyframes: readonly KeyFrame[]) {
    const k = after?.keys;
    this.keyframes = k && JSON.stringify(k) !== JSON.stringify(keyframes) ? { before: structuredClone([...keyframes]), after: structuredClone([...k]) } : null;
    this.bytes = OBJ_BYTES + ((before?.samples.length ?? 0) + (after?.samples.length ?? 0)) * 200;
  }
  // 一覧はその場で書き換えられるので、当てるたびに写しを渡す
  apply(store: Store): void {
    store.patchProject(this.keyframes ? { take: this.after, keyframes: structuredClone(this.keyframes.after) } : { take: this.after });
  }
  revert(store: Store): void {
    store.patchProject(this.keyframes ? { take: this.before, keyframes: structuredClone(this.keyframes.before) } : { take: this.before });
  }
}

/**
 * お気に入りの一覧の差し替え(残す・名前を変える・上書きする・消す)。お気に入りは作ったあと書き換えないので、
 * 一覧の配列だけを作り直し、中身はコピーせずに持つ(記録を持っていても重くならない)。
 */
export class SetFavorites implements Command {
  readonly bytes: number;
  constructor(readonly label: string, private before: readonly Favorite[], private after: readonly Favorite[]) {
    this.bytes = OBJ_BYTES * (before.length + after.length + 1);
  }
  apply(store: Store): void { store.patchProject({ favorites: [...this.after] }); }
  revert(store: Store): void { store.patchProject({ favorites: [...this.before] }); }
}

/**
 * 画角の変更。視点(回転・平行移動・ズーム)はアンドゥの対象外なので、カメラ全体ではなく
 * 画角だけを差分として持ち、戻すときも今の視点に画角だけを当てる。
 */
export class SetFov implements Command {
  readonly bytes = OBJ_BYTES;
  constructor(readonly label: string, private before: number, private after: number) {}
  apply(store: Store): void { store.patchProject({ camera: { ...store.project.camera, fov: this.after } }); }
  revert(store: Store): void { store.patchProject({ camera: { ...store.project.camera, fov: this.before } }); }
}

/** 複数の変更を1手にまとめる(プリセットで材質と周期を同時に変えるときなど)。selectAfter は Command を見る */
export class Batch implements Command {
  readonly bytes: number;
  constructor(readonly label: string, private commands: Command[], readonly selectAfter?: string) {
    this.bytes = commands.reduce((s, c) => s + c.bytes, 0);
  }
  apply(store: Store): void { for (const c of this.commands) c.apply(store); }
  revert(store: Store): void { for (const c of [...this.commands].reverse()) c.revert(store); }
}

/* ---------- レイヤー構成 ---------- */

export class InsertLayer implements Command {
  readonly bytes: number;
  constructor(readonly label: string, private docId: string, private layer: Layer, private index: number) {
    this.bytes = layer.weights.data.length;
  }
  apply(store: Store): void { store.insertLayer(this.docId, this.layer, this.index); }
  revert(store: Store): void { store.removeLayer(this.layer.id); }
}

export class RemoveLayer implements Command {
  readonly label = 'レイヤーを削除';
  readonly bytes: number;
  private docId: string;
  private layer: Layer;
  private index: number;
  constructor(store: Store, layerId: string) {
    const f = store.findLayer(layerId);
    if (!f) throw new Error(`layer not found: ${layerId}`);
    this.docId = f.doc.id; this.layer = f.layer; this.index = f.index;
    this.bytes = f.layer.weights.data.length;
  }
  apply(store: Store): void { store.removeLayer(this.layer.id); }
  revert(store: Store): void { store.insertLayer(this.docId, this.layer, this.index); }
}

export class MoveLayer implements Command {
  readonly label = 'レイヤーを並べ替え';
  readonly bytes = OBJ_BYTES;
  constructor(private layerId: string, private from: number, private to: number) {}
  apply(store: Store): void { store.moveLayer(this.layerId, this.to); }
  revert(store: Store): void { store.moveLayer(this.layerId, this.from); }
}

/* ---------- ウェイトの編集(64px 角のタイル差分) ---------- */

export interface TileDiff { tx: number; ty: number; before: Uint8Array; after: Uint8Array }

export class WeightEdit implements Command {
  readonly bytes: number;
  constructor(readonly label: string, private layerId: string, readonly tiles: TileDiff[]) {
    this.bytes = tiles.reduce((s, t) => s + t.before.length + t.after.length, 0) + OBJ_BYTES;
  }
  private write(store: Store, which: 'before' | 'after'): void {
    const f = store.findLayer(this.layerId); if (!f) return;
    const wm = f.layer.weights;
    let rect: Rect | null = null;
    for (const t of this.tiles) {
      const r = wm.tileRect(t.tx, t.ty);
      wm.writeRect(r, t[which]);
      rect = rect ? union(rect, r) : r;
    }
    if (rect) store.weightsChanged(this.layerId, rect);
  }
  apply(store: Store): void { this.write(store, 'after'); }
  revert(store: Store): void { this.write(store, 'before'); }
}

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** before(同サイズのコピー)と現在のマップを比べ、変わったタイルだけを差分にする。 */
export function diffTiles(before: Uint8Array, after: WeightMap, only?: Iterable<number>): TileDiff[] {
  const tiles: TileDiff[] = [];
  const W = after.width, tx = after.tilesX;
  const indices = only ?? Array.from({ length: tx * after.tilesY }, (_, i) => i);
  for (const i of indices) {
    const r = after.tileRect(i % tx, Math.floor(i / tx));
    let changed = false;
    for (let y = 0; y < r.h && !changed; y++) {
      const o = (r.y + y) * W + r.x;
      for (let x = 0; x < r.w; x++) if (before[o + x] !== after.data[o + x]) { changed = true; break; }
    }
    if (!changed) continue;
    const b = new Uint8Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) b.set(before.subarray((r.y + y) * W + r.x, (r.y + y) * W + r.x + r.w), y * r.w);
    tiles.push({ tx: i % tx, ty: Math.floor(i / tx), before: b, after: after.readRect(r) });
  }
  return tiles;
}

/** レイヤー全体への一括処理(なめらかに・正規化・反転など)をコマンドとして実行する。 */
export function weightOperation(store: Store, layerId: string, label: string, op: (wm: WeightMap) => void): WeightEdit | null {
  const f = store.findLayer(layerId); if (!f) return null;
  const before = f.layer.weights.data.slice();
  op(f.layer.weights);
  const tiles = diffTiles(before, f.layer.weights);
  // op で書き換え済みなので、表示を更新する。アンドゥ記録は呼び出し側で push する。
  // 何も変わらなかったときは「未保存」にしない
  store.weightsChanged(layerId, f.layer.weights.fullRect, tiles.length > 0);
  return tiles.length ? new WeightEdit(label, layerId, tiles) : null;
}

export { TILE };
