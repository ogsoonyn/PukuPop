/**
 * お気に入り(揺れと動きの組み合わせ)を作る・今の状態と比べる。DOM と three.js を参照しない。
 * 残すのは全レイヤーのポップ量・重ね方・揺れ、自動揺らし、視点、操作の記録で、画像とウェイトは入れない。
 */
import { newId, type Favorite, type FavoriteLayer, type PhysicsParams, type Project, type Document, type CameraState, type AutoSwing } from './project';
import type { Take } from '../physics/take';

/** 名前の長さの上限 */
export const FAVORITE_NAME_MAX = 40;

/** 今の状態からお気に入りを作る。id・名前・日時を渡すと、それを使う(上書きするとき) */
export function captureFavorite(
  project: Project, doc: Document, opts: { name: string; playing: boolean; id?: string; createdAt?: string },
): Favorite {
  const c = project.camera;
  return {
    id: opts.id ?? newId('F'),
    name: opts.name,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    layers: doc.layers.map((l): FavoriteLayer => ({ id: l.id, pop: l.pop, blend: l.blend, physics: copyPhysics(l.physics) })),
    autoSwing: { ...project.autoSwing },
    camera: { fov: c.fov, yaw: c.yaw, pitch: c.pitch, roll: c.roll, zoom: c.zoom, target: { ...c.target } },
    take: project.take,
    playing: opts.playing && !!project.take,
  };
}

export const copyPhysics = (p: PhysicsParams): PhysicsParams => ({ ...p, motionParams: { ...p.motionParams } });

/** 2つの平たいオブジェクトの値がすべて同じか(キーの並びによらない) */
function sameFlat(a: object, b: object, skip?: string): boolean {
  const ka = Object.keys(a).filter(k => k !== skip), kb = Object.keys(b).filter(k => k !== skip);
  return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

/**
 * 揺れの設定が同じか。項目を足しても比べ忘れないよう、項目を並べずにすべてのキーを比べる
 * (比べ忘れると、適用で「同じ」と見なしてその項目だけ戻らなくなる)。揺らし方の固有設定は中まで比べる
 */
export function samePhysics(a: PhysicsParams, b: PhysicsParams): boolean {
  return sameFlat(a, b, 'motionParams') && sameFlat(a.motionParams, b.motionParams);
}

/** レイヤーの設定がお気に入りと同じか */
export function sameLayer(f: FavoriteLayer, l: Pick<FavoriteLayer, 'pop' | 'blend' | 'physics'>): boolean {
  return f.pop === l.pop && f.blend === l.blend && samePhysics(f.physics, l.physics);
}

/**
 * 今の状態がお気に入りと同じか(一覧で印を付ける)。視点は回すたびに変わるので比べない。
 * お気に入りにあるレイヤーがすべて残っていて、同じ設定のときだけ同じとする(後から足したレイヤーは見ない)。
 */
export function favoriteMatches(f: Favorite, project: Project, doc: Document): boolean {
  const a = f.autoSwing, b = project.autoSwing;
  if (a.enabled !== b.enabled || a.period !== b.period || a.strength !== b.strength || f.take !== project.take) return false;
  return f.layers.every(fl => { const l = doc.layers.find(x => x.id === fl.id); return !!l && sameLayer(fl, l); });
}

/** 新しいお気に入りの名前(「お気に入り 1」から、使われていない番号) */
export function nextFavoriteName(list: readonly Favorite[]): string {
  const used = new Set(list.map(f => f.name));
  let n = list.length + 1;
  while (used.has(`お気に入り ${n}`)) n++;
  return `お気に入り ${n}`;
}

/** 視点(回転・ズーム・注視点)を当てる。画角は別にアンドゥできる形で変える */
export function applyView(c: CameraState, from: CameraState): void {
  c.yaw = from.yaw; c.pitch = from.pitch; c.roll = from.roll; c.zoom = from.zoom; c.target = { ...from.target };
}

/** お気に入りを当てるときに変えるもの(favoriteChanges)。今と同じものは入れない */
export interface FavoriteChanges {
  /** 設定を当てるレイヤー(今と違うものだけ。並びはお気に入りのとおり) */
  layers: { id: string; patch: Pick<FavoriteLayer, 'pop' | 'blend' | 'physics'> }[];
  /** お気に入りにあって今は無いレイヤーの数(飛ばす) */
  missing: number;
  /** 自動揺らし。今と同じなら null */
  autoSwing: AutoSwing | null;
  /** 記録を入れ替えるなら、その記録(null は記録無し)。今と同じなら undefined */
  take: Take | null | undefined;
  /** 画角。今と同じなら null */
  fov: number | null;
  /** 視点(回転・ズーム・注視点)。アンドゥに積まず、いつも当てる */
  view: CameraState;
  /** 残したときに再生していたか(当てたあと、記録があれば再生を始める) */
  play: boolean;
}

/**
 * お気に入りを今の状態に当てると何が変わるか。レイヤー(ポップ量・重ね方・揺れ)・自動揺らし・記録・画角・視点。
 * お気に入りにあって今は無いレイヤーは飛ばして数え、後から足したレイヤーはそのままにする。
 * 何をどう変えるかだけを決め、当て方(アンドゥのコマンドにするかなど)は呼ぶ側が決める
 */
export function favoriteChanges(f: Favorite, project: Project, doc: Document): FavoriteChanges {
  const layers: FavoriteChanges['layers'] = [];
  let missing = 0;
  for (const fl of f.layers) {
    const l = doc.layers.find(x => x.id === fl.id);
    if (!l) { missing++; continue; }
    if (!sameLayer(fl, l)) layers.push({ id: l.id, patch: { pop: fl.pop, blend: fl.blend, physics: copyPhysics(fl.physics) } });
  }
  const a = f.autoSwing, b = project.autoSwing;
  return {
    layers, missing,
    autoSwing: a.enabled !== b.enabled || a.period !== b.period || a.strength !== b.strength ? { ...a } : null,
    take: f.take !== project.take ? f.take : undefined,
    fov: f.camera.fov !== project.camera.fov ? f.camera.fov : null,
    view: f.camera,
    play: f.playing,
  };
}
