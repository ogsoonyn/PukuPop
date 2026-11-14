/**
 * ドキュメントモデル。DOM と Three.js を参照しない。
 * 状態の変更はコマンド(commands/)経由で行い、ここは保持と変更通知だけを担う。
 */
import { Emitter } from '../util/emitter';
import { WeightMap, weightSizeFor, type Rect } from './weightmap';
import type { Take } from '../physics/take';

export interface Vec3 { x: number; y: number; z: number }

/**
 * 揺らし方。自動揺らしのとき、塗った部分を支える土台(アンカー)をどう動かすか。
 * 塗った部分はバネで土台に繋がっていて、遅れて付いてくる(physics/motion.ts)。
 * ピストンだけは土台ではなく画像全体を動かし、塗った部分はその動きに慣性で遅れて付いてくる。
 * ためて膨らむ2・ふわっと膨らむ・一瞬膨らむは、土台の動きに加えて、塗った範囲を中心から外へ広げる(physics/motion.ts の SPREAD_MOTIONS)。
 */
export type MotionPattern = 'charge' | 'charge2' | 'jiggle' | 'jump' | 'bounce' | 'piston' | 'shiver' | 'float' | 'sway' | 'shake' | 'circle' | 'heartbeat' | 'stretch' | 'puff' | 'pulse' | 'none';

export const MOTIONS: Record<MotionPattern, { label: string; desc: string }> = {
  jiggle: { label: '上下に小刻み', desc: '上下に軽くつついて揺らす' },
  jump: { label: 'ジャンプ', desc: '沈み込んで跳び、着地で弾む' },
  bounce: { label: '連続ジャンプ', desc: '小さく弾み続ける' },
  piston: { label: 'ピストン', desc: '画像ごと上下に動き、塗った所が遅れて付いてきて弾む' },
  shiver: { label: '震え', desc: '細かく速く震える' },
  float: { label: '漂う', desc: 'ゆっくり8の字に漂う' },
  sway: { label: 'ゆっくり左右', desc: '左右にゆったり揺れる' },
  shake: { label: '左右に振る', desc: '左右に素早く振る' },
  circle: { label: '回転', desc: '円を描いて回る' },
  heartbeat: { label: '鼓動', desc: 'ドクン、ドクンと手前にふくらむ' },
  charge: { label: 'ためて膨らむ', desc: 'ポップ量をぐーっと縮めてから、いっきにぼよんと膨らませる' },
  charge2: { label: 'ためて膨らむ2', desc: '塗った範囲ごと内へ縮めてから、手前にも横にもいっきにぼよんと広げる' },
  stretch: { label: '伸びて戻る', desc: 'ゆっくり引き伸ばして、ぱっと離す' },
  puff: { label: 'ふわっと膨らむ', desc: '一瞬だけふわっと上下に揺れて、同時に塗った範囲が横にも膨らむ' },
  pulse: { label: '一瞬膨らむ', desc: '手前に少し膨らんですぐ戻り、同時に塗った範囲が横にも膨らむ' },
  none: { label: 'なし(つかむ操作だけ)', desc: '自動では揺らさない' },
};

/**
 * 揺らし方ごとの固有の設定。値は unit が '%' のとき割合(1 = 100%)、'Hz' は周波数、'select' は options の値。
 * 「〜の長さ」「〜の時間」は周期に対する割合。
 */
export interface MotionParamDef {
  key: string;
  label: string;
  unit: '%' | 'Hz' | 'select';
  min: number;
  max: number;
  step: number;
  def: number;
  options?: [number, string][];
  hint?: string;
}

const pct = (key: string, label: string, def: number, max = 3, min = 0, hint?: string): MotionParamDef =>
  ({ key, label, unit: '%', min, max, step: 0.01, def, hint });

export const MOTION_PARAMS: Record<MotionPattern, MotionParamDef[]> = {
  charge: [
    pct('depth', 'ためる深さ', 0.7, 1, 0, 'ポップ量をどこまで縮めるか(100% で平らになる)'),
    pct('time', 'ためる時間', 0.6, 0.9, 0.2, '周期のうち、縮めている時間の割合'),
    pct('bulge', '膨らみの強さ', 0.3, 2, 0, '離した瞬間に、さらに押し出す量(ポップ量に対する割合)。0% でもバネの勢いで少し膨らむ'),
  ],
  charge2: [
    pct('depth', 'ためる深さ', 0.7, 1, 0, 'ポップ量をどこまで縮めるか(100% で平らになる)'),
    pct('time', 'ためる時間', 0.6, 0.9, 0.2, '周期のうち、縮めている時間の割合'),
    pct('bulge', '膨らみの強さ', 0.3, 2, 0, '離した瞬間に、さらに手前へ押し出す量(ポップ量に対する割合)'),
    pct('spread', '横の広がり', 0.2, 0.5, 0, '離した瞬間に、塗った範囲を中心から外へ広げる量(中心からの距離に対する割合)'),
    pct('pinch', '横の縮み', 0.5, 1, 0, 'ためている間に、塗った範囲を内へ縮める量(横の広がりに対する割合)'),
  ],
  jump: [
    pct('height', '高さ', 1),
    pct('crouch', '沈み込み', 0.15, 1, 0, '踏み切る前に沈む深さ(高さに対する割合)'),
    pct('air', '滞空時間', 0.42, 0.85, 0.15, '周期のうち、跳んでいる時間の割合'),
  ],
  bounce: [
    pct('height', '高さ', 1),
    pct('ground', '接地の長さ', 0.3, 0.6, 0.05, '周期のうち、着地している時間の割合'),
  ],
  piston: [
    pct('height', 'ストローク', 1, 3, 0, '画像全体が上下する幅'),
    pct('up', '上がる時間', 0.15, 0.6, 0.05, '周期のうち、上がっている時間の割合'),
    pct('top', '上で止まる時間', 0.3, 0.5, 0, '周期のうち、上で止まっている時間の割合。残りは下で止まっている'),
    pct('down', '下がる時間', 0.15, 0.6, 0.05, '周期のうち、下がっている時間の割合'),
    pct('sharp', '止まり方の鋭さ', 0.8, 1, 0, '100% で同じ速さのまま急に止まる(塗った所が大きく弾む)。0% でなめらかに止まる'),
  ],
  jiggle: [
    pct('amp', '振れ幅', 1),
    pct('second', '2回目の強さ', 0.6, 1.5),
    pct('width', 'つつく長さ', 0.1, 0.3, 0.04, '1回のつつきにかける時間(周期に対する割合)。短いほど鋭い'),
  ],
  shiver: [
    pct('amp', '振れ幅', 1),
    { key: 'freq', label: '細かさ', unit: 'Hz', min: 2, max: 20, step: 0.5, def: 9, hint: '1秒あたりの震えの回数' },
    pct('vertical', '縦の揺れ', 0.6, 2),
    pct('wave', 'むら', 0.4, 1, 0, '震えの強弱の波'),
  ],
  float: [pct('amp', '振れ幅', 1), pct('side', '横の揺れ', 0.4, 2)],
  sway: [pct('amp', '振れ幅', 1)],
  shake: [pct('amp', '振れ幅', 1), pct('hop', '跳ね上がり', 0.3, 2), pct('width', '振る長さ', 0.12, 0.4, 0.04)],
  circle: [
    pct('radius', '半径', 1),
    { key: 'dir', label: '向き', unit: 'select', min: -1, max: 1, step: 2, def: 1, options: [[1, '反時計回り'], [-1, '時計回り']] },
  ],
  heartbeat: [pct('amp', '膨らみ', 1), pct('second', '2拍目の強さ', 0.7, 1.5), pct('gap', '拍の間隔', 0.2, 0.45, 0.08)],
  stretch: [
    pct('amp', '伸ばす量', 1),
    pct('time', '伸ばす時間', 0.65, 0.9, 0.2),
    { key: 'dir', label: '向き', unit: 'select', min: 0, max: 4, step: 1, def: 0, options: [[0, '上'], [1, '下'], [2, '左'], [3, '右'], [4, '手前']] },
  ],
  puff: [
    pct('height', '上下の幅', 1),
    pct('down', '下がる深さ', 0.5, 1.5, 0, '上がったあとに下がる深さ(上がる高さに対する割合)'),
    pct('spread', '横の広がり', 0.2, 0.5, 0, '上がるのと同時に、塗った範囲を中心から外へ広げる量(中心からの距離に対する割合)'),
    pct('time', '揺れる長さ', 0.3, 0.8, 0.1, '周期のうち、上下に揺れている時間の割合。残りは止まっていて、余韻だけが残る'),
  ],
  pulse: [
    pct('bulge', '膨らみ', 0.3, 2, 0, '手前に膨らむ量(ポップ量に対する割合)'),
    pct('spread', '横の広がり', 0.15, 0.5, 0, '同時に、塗った範囲を中心から外へ広げる量(中心からの距離に対する割合)'),
    pct('time', '膨らむ長さ', 0.15, 0.6, 0.04, '周期のうち、膨らんで戻るまでの時間の割合。短いほどすぐ戻る'),
  ],
  none: [],
};

/** 揺らし方の固有設定の値(未設定なら既定値)。保存時のキーは「揺らし方.項目」。 */
export function motionParam(values: Record<string, number> | undefined, motion: MotionPattern, key: string): number {
  const v = values?.[`${motion}.${key}`];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return MOTION_PARAMS[motion].find(d => d.key === key)?.def ?? 0;
}

export type PresetName = 'puru' | 'bain' | 'poyo' | 'zun' | 'buru' | 'fuwa' | 'yura' | 'furi' | 'guru' | 'doki' | 'tame' | 'puku' | 'biyo' | 'pofu' | 'pon' | 'custom';

/** 揺れのパラメータ。数値はすべて 0〜1 の正規化値。 */
export interface PhysicsParams {
  enabled: boolean;
  preset: PresetName;
  hardness: number; // 硬さ → バネ定数 k
  mass: number;     // 質量 → m
  weight: number;   // 重さ → 重力の係数
  damping: number;  // おさまり → 減衰係数 c
  motion: MotionPattern; // 揺らし方
  motionParams: Record<string, number>; // 揺らし方ごとの固有設定(キーは「揺らし方.項目」、未設定は既定値)
}

/**
 * 重ね方。一覧の下から順に、下までの結果にこのレイヤーをどう重ねるか。
 * add: 下の高さに足す。max: 下と比べて高い所だけ、このレイヤーの形と揺れを使う(膨らみを1つずつ別レイヤーで作って重ねる)。
 */
export type BlendMode = 'add' | 'max';

export const BLENDS: Record<BlendMode, { label: string; short: string; desc: string }> = {
  add: { label: '加算', short: '+', desc: '下のレイヤーの高さに足します' },
  max: { label: '最大(高い方)', short: '最大', desc: '下のレイヤーと比べて高い所だけ、このレイヤーの形と揺れを使います。膨らみを1つずつ別のレイヤーで作って重ねるときに' },
};

export const BLEND_ORDER = Object.keys(BLENDS) as BlendMode[];

/**
 * ウェイトの重ね表示で、レイヤーごとに塗る色(一覧の下から順。一覧の色の印も同じ)。
 * 先頭は1枚だけ重ねていたころの色。ファイルには保存せず、並びで決める
 */
export const LAYER_COLORS = ['#ff3380', '#ff8a00', '#e0b800', '#22b573', '#00a9cc', '#3d6bff', '#9b59ff', '#a0673f'] as const;
export const layerColor = (index: number): string => LAYER_COLORS[((index % LAYER_COLORS.length) + LAYER_COLORS.length) % LAYER_COLORS.length];

/**
 * 複数のレイヤーのポップ量を、比率を保ったまま伸び縮みさせる。基準は一番高いレイヤーで、それが target になる。
 * 0 のレイヤーは 0 のまま、0 より大きいレイヤーは 1 より小さくしない。全部 0 のときだけ、全部を target に揃える。target は呼び出し側で上限に収めておく
 */
export function scalePops(start: readonly number[], target: number): number[] {
  const top = Math.max(0, ...start);
  if (top === 0) return start.map(() => target);
  // 0 より大きいレイヤーは、丸めで 0 にしない(0 は「伸び縮みしない」なので、一度 0 になると戻らなくなる)
  return start.map(p => p > 0 && target > 0 ? Math.max(1, Math.round(p * target / top)) : Math.round(p * target / top));
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  pop: number; // ポップ量(元画像のピクセル単位)
  blend: BlendMode;
  physics: PhysicsParams;
  weights: WeightMap;
}

export interface ImageAsset {
  bytes: Uint8Array; // 読み込んだバイト列をそのまま持つ
  mime: string;
  ext: string;
  width: number;
  height: number;
}

export interface Document {
  id: string;
  name: string;
  image: ImageAsset;
  position: Vec3;
  rotation: Vec3; // ラジアン
  scale: number;
  meshDensity: number;
  opacity: number;
  layers: Layer[];
}

export interface CameraState {
  fov: number;
  yaw: number;
  pitch: number;
  /** 視点の傾き(ラジアン、-π 以上 π 未満)。正で画像が画面上で時計回りに傾く。古いファイルには無く、0 として読む */
  roll: number;
  zoom: number;
  target: Vec3; // 元画像のピクセル単位
}

/** 角度を -π 以上 π 未満へ丸める(視点の傾きに使う) */
export function wrapAngle(a: number): number {
  const TAU = Math.PI * 2;
  const r = a - TAU * Math.floor((a + Math.PI) / TAU);
  return r >= Math.PI ? r - TAU : r;
}

export interface AutoSwing {
  enabled: boolean;
  period: number;   // 秒
  strength: number; // 0〜1
}

export interface Project {
  background: string | null; // null で透過
  camera: CameraState;
  /** 3面図の「自由角度」の視点(保存する。正面・右・下の拡大と平行移動は画面だけの設定で保存しない) */
  multiCamera: CameraState;
  fps: number;
  autoSwing: AutoSwing;
  /** 操作の記録(ループ再生・書き出し用)。無ければ null */
  take: Take | null;
  /** お気に入り(揺れと動きの組み合わせ。model/favorites.ts) */
  favorites: Favorite[];
  documents: Document[];
}

/** お気に入りに入れるレイヤーの設定。id で今のレイヤーと突き合わせる */
export interface FavoriteLayer { id: string; pop: number; blend: BlendMode; physics: PhysicsParams }

/**
 * お気に入り。いい揺れや動きを見つけたときに、その組み合わせだけを残す(画像とウェイトは入れない)。
 * 作ったあとは書き換えない(名前を変える・上書きするときは作り直す)ので、アンドゥの記録でもコピーせずに持てる。
 */
export interface Favorite {
  readonly id: string;
  readonly name: string;
  /** 残した日時(ISO 8601) */
  readonly createdAt: string;
  readonly layers: readonly FavoriteLayer[];
  readonly autoSwing: AutoSwing;
  /** 視点と画角 */
  readonly camera: CameraState;
  /** そのときの操作の記録(キーフレームを含む)。記録は書き換えないので、今の記録と同じものを指していてよい */
  readonly take: Take | null;
  /** 残したときにループ再生していたか(適用したら再生を始める) */
  readonly playing: boolean;
}

export const LIMITS = {
  maxLayers: 8,
  pop: { min: 0, max: 1500, def: 80 },
  density: { min: 16, max: 512, def: 128 },
  fov: { min: 10, max: 90, def: 40 },
  period: { min: 0.3, max: 10, def: 1.2 },
  /** お気に入りの数 */
  favorites: 30,
} as const;

/** メッシュの分割数。長い辺を density 分割し、短い辺はマスがほぼ正方形になるよう決める(stage のメッシュと同じ)。 */
export function meshSegments(imageW: number, imageH: number, density: number): { nx: number; ny: number } {
  const nx = imageW >= imageH ? density : Math.max(2, Math.round((density * imageW) / imageH));
  const ny = imageH > imageW ? density : Math.max(2, Math.round((density * imageH) / imageW));
  return { nx, ny };
}

/**
 * 「アルファから生成」でウェイトを輪郭の外へ広げる幅(ウェイトマップの画素)。
 * 頂点の位置でしかウェイトを読まないので、境目はメッシュ1マス分の斜面になる。
 * 不透明な画素を含むマスの頂点がどれも塗った側に入るよう、1マス分に、頂点で読むときに隣の画素と混ざる分の1画素を足す。
 */
export function alphaSpreadPx(weightW: number, weightH: number, seg: { nx: number; ny: number }): number {
  return Math.ceil(Math.max(weightW / seg.nx, weightH / seg.ny)) + 1;
}

export interface Preset {
  label: string;
  desc: string;
  hardness: number;
  mass: number;
  damping: number;
  motion: MotionPattern;
  period: number; // おすすめの自動揺らしの周期(秒)
  params?: Record<string, number>; // 揺らし方の固有設定(項目名だけで書く。省略時は既定値)
}

/** 揺れのプリセット。材質(硬さ・質量・おさまり)と揺らし方の組み合わせ。 */
export const PRESETS: Record<Exclude<PresetName, 'custom'>, Preset> = {
  puru: { label: 'ぷるぷる', desc: '上下につついて、細かく震える余韻が残る', hardness: 0.6, mass: 0.04, damping: 0.13, motion: 'jiggle', period: 1.2 },
  bain: { label: 'ばいんばいん', desc: 'ジャンプして着地すると、どすんと沈んで上下に弾む', hardness: 0.25, mass: 0.25, damping: 0.1, motion: 'jump', period: 1.8 },
  poyo: { label: 'ぽよんぽよん', desc: '小さく弾み続ける', hardness: 0.4, mass: 0.15, damping: 0.19, motion: 'bounce', period: 0.8 },
  zun: { label: 'ずんずん', desc: '画像ごと上下に突き上げられ、塗った所が遅れて付いてきて弾む', hardness: 0.3, mass: 0.25, damping: 0.12, motion: 'piston', period: 1.2 },
  buru: { label: 'ぶるぶる', desc: '細かく速く震える', hardness: 0.9, mass: 0.05, damping: 0.3, motion: 'shiver', period: 2 },
  fuwa: { label: 'ふわふわ', desc: 'ゆっくり漂って、すぐに落ち着く', hardness: 0.1, mass: 0.3, damping: 0.6, motion: 'float', period: 3 },
  yura: { label: 'ゆらゆら', desc: '左右にゆったり揺れる', hardness: 0.15, mass: 0.4, damping: 0.25, motion: 'sway', period: 2.5 },
  furi: { label: 'ふりふり', desc: '左右に素早く振る', hardness: 0.45, mass: 0.35, damping: 0.12, motion: 'shake', period: 1.6 },
  guru: { label: 'ぐるぐる', desc: '円を描いて回る', hardness: 0.2, mass: 0.3, damping: 0.3, motion: 'circle', period: 2 },
  doki: { label: 'どきどき', desc: 'ドクン、ドクンと手前にふくらむ', hardness: 0.55, mass: 0.1, damping: 0.35, motion: 'heartbeat', period: 1 },
  tame: { label: 'ためてぼよん', desc: 'ぐーっと縮んでから、いっきにぼよんと膨らんで弾む', hardness: 0.3, mass: 0.2, damping: 0.1, motion: 'charge', period: 2 },
  puku: { label: 'ぷっくり', desc: '塗った範囲ごとぐーっと縮んでから、手前にも横にもいっきにぼよんと広がって弾む', hardness: 0.3, mass: 0.2, damping: 0.1, motion: 'charge2', period: 2 },
  biyo: { label: 'びよーん', desc: 'ゆっくり引き伸ばされて、離すと大きく弾む', hardness: 0.35, mass: 0.2, damping: 0.08, motion: 'stretch', period: 2.4 },
  pofu: { label: 'ぽふん', desc: '一瞬ふわっと上下に揺れて、同時に塗った範囲が横にもぽよんと膨らむ', hardness: 0.3, mass: 0.2, damping: 0.25, motion: 'puff', period: 1.6 },
  pon: { label: 'ぽんっ', desc: '一瞬だけ手前にも横にも少し膨らんで、すぐ戻って弾む', hardness: 0.45, mass: 0.12, damping: 0.25, motion: 'pulse', period: 1.2 },
};

export const PRESET_ORDER = Object.keys(PRESETS) as Exclude<PresetName, 'custom'>[];

/** プリセットの値を物理パラメータに当てはめる(重さと有効/無効はそのまま)。 */
export function applyPreset(p: PhysicsParams, name: Exclude<PresetName, 'custom'>): PhysicsParams {
  const pr = PRESETS[name];
  const motionParams: Record<string, number> = {};
  for (const [k, v] of Object.entries(pr.params ?? {})) motionParams[`${pr.motion}.${k}`] = v;
  return { ...p, preset: name, hardness: pr.hardness, mass: pr.mass, damping: pr.damping, motion: pr.motion, motionParams };
}

let idSeq = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export function defaultPhysics(): PhysicsParams {
  const p = PRESETS.puru;
  return { enabled: true, preset: 'puru', hardness: p.hardness, mass: p.mass, weight: 0.15, damping: p.damping, motion: p.motion, motionParams: {} };
}

export function createLayer(doc: Pick<Document, 'image' | 'layers'>, name?: string): Layer {
  const { w, h } = weightSizeFor(doc.image.width, doc.image.height);
  return {
    id: newId('L'),
    name: name ?? `レイヤー${doc.layers.length + 1}`,
    visible: true,
    pop: LIMITS.pop.def,
    blend: 'add',
    physics: defaultPhysics(),
    weights: new WeightMap(w, h),
  };
}

export function cloneLayer(layer: Layer, name: string): Layer {
  return { ...layer, id: newId('L'), name, physics: { ...layer.physics, motionParams: { ...layer.physics.motionParams } }, weights: layer.weights.clone() };
}

export function createDocument(image: ImageAsset, name: string): Document {
  const doc: Document = {
    id: newId('D'), name, image,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1,
    meshDensity: LIMITS.density.def, opacity: 1, layers: [],
  };
  doc.layers.push(createLayer(doc));
  return doc;
}

export function defaultCamera(): CameraState {
  return { fov: LIMITS.fov.def, yaw: -0.35, pitch: 0.25, roll: 0, zoom: 1, target: { x: 0, y: 0, z: 0 } };
}

/** 視点リセットで戻す正面の視点(回転・平行移動なし、等倍) */
export function frontCamera(fov: number = LIMITS.fov.def): CameraState {
  return { fov, yaw: 0, pitch: 0, roll: 0, zoom: 1, target: { x: 0, y: 0, z: 0 } };
}

/** 3面図の「自由角度」の初期視点。膨らみが分かるよう斜め上から見る */
export function defaultMultiCamera(): CameraState {
  return { fov: LIMITS.fov.def, yaw: 0.7, pitch: 0.45, roll: 0, zoom: 1.5, target: { x: 0, y: 0, z: 0 } };
}

/** 3面図の正投影の図(正面・右から・下から)の見え方。3つの図で共有し、縮尺と位置の対応をそろえる */
export interface OrthoView {
  /** 拡大率。1 で全体が収まり、大きいほど拡大する */
  zoom: number;
  /** 図の中心のずれ(画像のローカル座標、元画像のピクセル単位) */
  pan: Vec3;
}

export function defaultOrthoView(): OrthoView {
  return { zoom: 1, pan: { x: 0, y: 0, z: 0 } };
}

export function createProject(doc?: Document): Project {
  return {
    background: null,
    camera: defaultCamera(),
    multiCamera: defaultMultiCamera(),
    fps: 60,
    autoSwing: { enabled: true, period: LIMITS.period.def, strength: 0.5 },
    take: null,
    favorites: [],
    documents: doc ? [doc] : [],
  };
}

/* ---------- 変更通知付きの入れ物 ---------- */

export type StoreEvents = {
  replace: Project;                                   // プロジェクトごと差し替え
  project: { keys: (keyof Project)[] };
  document: { docId: string; keys: (keyof Document)[] };
  layer: { layerId: string; keys: (keyof Layer)[] };
  layers: { docId: string };                          // 追加・削除・並べ替え
  weights: { layerId: string; rect: Rect };
  change: void;                                       // いずれかが変わった(自動保存用)
};

export class Store extends Emitter<StoreEvents> {
  project: Project;

  constructor(project: Project = createProject()) {
    super();
    this.project = project;
  }

  get doc(): Document | undefined { return this.project.documents[0]; }

  replace(project: Project): void {
    this.project = project;
    this.emit('replace', project);
    this.emit('change', undefined);
  }

  findLayer(layerId: string): { doc: Document; layer: Layer; index: number } | undefined {
    for (const doc of this.project.documents) {
      const index = doc.layers.findIndex(l => l.id === layerId);
      if (index >= 0) return { doc, layer: doc.layers[index], index };
    }
    return undefined;
  }

  findDoc(docId: string): Document | undefined { return this.project.documents.find(d => d.id === docId); }

  /* 以下はコマンドから呼ぶ低レベル操作 */

  patchProject(patch: Partial<Project>): void {
    Object.assign(this.project, patch);
    this.emit('project', { keys: Object.keys(patch) as (keyof Project)[] });
    this.emit('change', undefined);
  }

  patchDocument(docId: string, patch: Partial<Document>): void {
    const doc = this.findDoc(docId); if (!doc) return;
    Object.assign(doc, patch);
    this.emit('document', { docId, keys: Object.keys(patch) as (keyof Document)[] });
    this.emit('change', undefined);
  }

  patchLayer(layerId: string, patch: Partial<Layer>): void {
    const f = this.findLayer(layerId); if (!f) return;
    Object.assign(f.layer, patch);
    this.emit('layer', { layerId, keys: Object.keys(patch) as (keyof Layer)[] });
    this.emit('change', undefined);
  }

  insertLayer(docId: string, layer: Layer, index: number): void {
    const doc = this.findDoc(docId); if (!doc) return;
    doc.layers.splice(index, 0, layer);
    this.emit('layers', { docId });
    this.emit('change', undefined);
  }

  removeLayer(layerId: string): void {
    const f = this.findLayer(layerId); if (!f) return;
    f.doc.layers.splice(f.index, 1);
    this.emit('layers', { docId: f.doc.id });
    this.emit('change', undefined);
  }

  moveLayer(layerId: string, toIndex: number): void {
    const f = this.findLayer(layerId); if (!f) return;
    f.doc.layers.splice(f.index, 1);
    f.doc.layers.splice(toIndex, 0, f.layer);
    this.emit('layers', { docId: f.doc.id });
    this.emit('change', undefined);
  }

  /** ウェイトの直接書き換え後に呼ぶ(塗りの途中など、アンドゥ記録とは別)。 */
  weightsChanged(layerId: string, rect: Rect, persistent = true): void {
    this.emit('weights', { layerId, rect });
    if (persistent) this.emit('change', undefined);
  }
}
