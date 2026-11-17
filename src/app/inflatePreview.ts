/**
 * 膨らませる(編集アプリだけの機能): 範囲(楕円・矩形・カマボコ)を、指定した高さと断面で一括して膨らませる。
 * プレビューしながら数値を決め、適用で1手として記録する。
 * 高さが範囲を描いたレイヤーのポップ量を超えるときは、そのレイヤーには触れず、ポップ量 = 高さの新しいレイヤーに作る
 * (今の塗りを縮めてポップ量を上げると、揺れも小さくなり、8 ビットのウェイトの階調も粗くなるため)。
 * 新しいレイヤーはプレビューの間だけ仮に挿入し、アンドゥにも「未保存」にも数えない。
 * 「新しいレイヤーに作る」(settings.newLayer)をオンにすると、高さにかかわらず新しいレイヤーに作る。
 * 膨らませる先のレイヤーの重ね方(加算・最大)もプレビュー中に変えられる。同じレイヤーなら、右パネルの重ね方と同じくその場で
 * 別の1手として変える(キャンセルしても残る)。新しいレイヤーなら、そのレイヤーに当て、適用でレイヤーごと1手になる(選ばなければ加算)。
 * App とは InflateHost の分だけでつながる。始まり・変更の知らせと、始めてよいかの確かめは App が受け持つ。
 */
import { createLayer, LIMITS, type Store, type Document, type Layer, type BlendMode } from '../model/project';
import { InsertLayer, PatchLayer, WeightEdit, diffTiles } from '../commands/commands';
import type { History } from '../commands/history';
import { inflateShape, INFLATE_KINDS, type InflateKind, type InflateProfile, type InflateBlend } from '../paint/inflate';
import { toast } from '../ui/dom';

/** 「膨らませる」の範囲。中心と幅・縦は元画像のピクセル単位(中心が原点、y は上向き) */
export interface InflateArea { x: number; y: number; w: number; h: number }
export interface InflateSettings {
  shape: InflateKind;
  /** 頂上の高さ(元画像のピクセル)。null はレイヤーのポップ量と同じ */
  height: number | null;
  softness: number; // 0〜1
  /** 形の傾き(度、-90〜90)。正で時計回り */
  angle: number;
  profile: InflateProfile;
  /** ウェイトの重ね方(今回の膨らみを、レイヤーの今のウェイトとどう重ねるか) */
  blend: InflateBlend;
  /** 仕上げのぼかしの半径(元画像のピクセル)。0 でぼかさない */
  blur: number;
  /** 高さにかかわらず、新しいレイヤーに作る */
  newLayer: boolean;
}
/** 形の傾きの範囲(度) */
export const INFLATE_ANGLE = { min: -90, max: 90 };
/** 仕上げのぼかしの半径の範囲(元画像のピクセル) */
export const INFLATE_BLUR = { min: 0, max: 100 };
export interface InflateState {
  /** 範囲を描いたレイヤー */
  readonly layerId: string;
  readonly area: InflateArea;
  readonly settings: InflateSettings & { height: number };
  /** 範囲を描いたレイヤーのポップ量(プレビュー中は変えない) */
  readonly sourcePop: number;
  /** 高さがポップ量を超えるので新しいレイヤーに作るときの、そのレイヤーの名前とポップ量 */
  readonly newLayer: { readonly name: string; readonly pop: number } | null;
  /** 高さがポップ量を超えるが、レイヤーが上限の枚数なので新しいレイヤーを作れない(ポップ量の高さで止まる) */
  readonly limited: boolean;
  /** 膨らませる先のレイヤー(新しいレイヤーに作るならそのレイヤー)の重ね方 */
  readonly layerBlend: BlendMode;
}

/** プレビュー中に変えられるもの */
export interface InflatePatch { area?: Partial<InflateArea>; settings?: Partial<InflateSettings>; layerBlend?: BlendMode }

export interface InflateHost {
  readonly store: Store;
  readonly history: History;
  /** 前回の「膨らませる」の設定(次に範囲を描いたときの初期値)。適用したら書き戻す */
  inflateSettings: InflateSettings;
  /** そのレイヤーだけを選ぶ(新しいレイヤーに作ったとき) */
  setActiveLayer(id: string): void;
  /** プレビューを終えた(適用・キャンセル) */
  ended(): void;
}

interface InflateSession {
  layerId: string; original: Uint8Array; area: InflateArea; settings: InflateSettings & { height: number };
  sourcePop: number;
  /** プレビュー中に仮に挿入している新しいレイヤー(同じレイヤーに作るときは null) */
  newLayer: Layer | null;
  /** 新しいレイヤーに作るときの名前(仮に挿入していなくても決めておく) */
  newName: string;
  limited: boolean;
  /** 新しいレイヤーに作るときの重ね方(パネルで選ぶまでは加算) */
  newBlend: BlendMode;
}

export class InflatePreview {
  private session: InflateSession | null = null;

  constructor(private readonly host: InflateHost) {}

  get active(): boolean { return !!this.session; }

  get state(): InflateState | null {
    const s = this.session; if (!s) return null;
    return { layerId: s.layerId, area: s.area, settings: s.settings, sourcePop: s.sourcePop, limited: s.limited, layerBlend: this.targetBlend(s), newLayer: s.newLayer && { name: s.newLayer.name, pop: s.newLayer.pop } };
  }

  /** プレビューで仮に入れているレイヤーの id(入れていなければ undefined) */
  get tempLayerId(): string | undefined { return this.session?.newLayer?.id; }

  /** 膨らませる先のレイヤーの重ね方(同じレイヤーなら、そのレイヤーの今の重ね方) */
  private targetBlend(s: InflateSession): BlendMode {
    return s.newLayer ? s.newBlend : this.host.store.findLayer(s.layerId)?.layer.blend ?? 'add';
  }

  /** layer の上に範囲を描き始める(始めてよいかは呼ぶ側が確かめる) */
  begin(layer: Layer, doc: Document, area: InflateArea): void {
    const st = this.host.inflateSettings;
    this.session = {
      layerId: layer.id, original: layer.weights.data.slice(), area: { ...area },
      // 高さの初期値は前回の値、初めてならポップ量と同じ(ポップ量が 0 なら既定のポップ量)
      // 前回の高さは引き継ぐが、このレイヤーのポップ量は超えない(いきなり新しいレイヤーに作らない)
      settings: { ...st, height: layer.pop > 0 ? Math.min(st.height ?? layer.pop, layer.pop) : (st.height ?? LIMITS.pop.def) },
      sourcePop: layer.pop, newLayer: null, newName: nextInflateLayerName(doc), limited: false,
      newBlend: 'add',
    };
    this.render();
  }

  update(patch: InflatePatch): void {
    const s = this.session; if (!s) return;
    if (patch.area) s.area = { ...s.area, ...patch.area };
    if (patch.layerBlend) {
      // 同じレイヤーに作る間は、右パネルと同じくその場で変える(別の1手で、キャンセルしても残る)
      if (s.newLayer) s.newBlend = patch.layerBlend;
      else if (this.host.store.findLayer(s.layerId)?.layer.blend !== patch.layerBlend) {
        this.host.history.execute(PatchLayer.from(this.host.store, s.layerId, { blend: patch.layerBlend }, '重ね方'));
      }
    }
    if (patch.settings) s.settings = { ...s.settings, ...patch.settings, height: patch.settings.height ?? s.settings.height };
    this.render();
  }

  /**
   * プレビュー用の新しいレイヤーを、範囲を描いたレイヤーのすぐ上に仮に入れる / 外す。
   * 構成が変わったことだけを知らせ(GPU への全面転送とレイヤー一覧の更新)、変更としては数えない
   */
  private setPreviewLayer(on: boolean): void {
    const store = this.host.store, s = this.session, doc = store.doc; if (!s || !doc) return;
    if (on && !s.newLayer) {
      const f = store.findLayer(s.layerId); if (!f) return;
      const layer = createLayer(doc, s.newName);
      // 揺れ方は元のレイヤーにそろえる(同じ物の一部として揺れるように)
      layer.physics = { ...f.layer.physics, motionParams: { ...f.layer.physics.motionParams } };
      layer.blend = s.newBlend;
      doc.layers.splice(f.index + 1, 0, layer);
      s.newLayer = layer;
      store.emit('layers', { docId: doc.id });
    } else if (!on && s.newLayer) {
      const i = doc.layers.indexOf(s.newLayer);
      if (i >= 0) doc.layers.splice(i, 1);
      s.newLayer = null;
      store.emit('layers', { docId: doc.id });
    }
  }

  private render(): void {
    const store = this.host.store, s = this.session, doc = store.doc; if (!s || !doc) return;
    const source = store.findLayer(s.layerId)?.layer; if (!source) return;
    const st = s.settings;
    // 仮のレイヤーは数えずに、もう1枚足せるか
    const layerCount = doc.layers.length - (s.newLayer ? 1 : 0);
    const over = st.height > s.sourcePop, room = layerCount < LIMITS.maxLayers, useNew = (over || st.newLayer) && room;
    s.limited = (over || st.newLayer) && !room;
    // 範囲を描いたレイヤーは、新しいレイヤーに作るときは元のまま、そうでなければ元の上に重ねる
    source.weights.data.set(s.original);
    store.weightsChanged(s.layerId, source.weights.fullRect, false);
    this.setPreviewLayer(useNew);
    const target = s.newLayer ?? source, wm = target.weights;
    if (s.newLayer) {
      // 新しいレイヤーの重ね方はプレビューに当てるだけ(適用でレイヤーごと1手になる)
      if (s.newLayer.blend !== s.newBlend) { s.newLayer.blend = s.newBlend; store.emit('layer', { layerId: s.newLayer.id, keys: ['blend'] }); }
      wm.data.fill(0);
      const pop = Math.min(LIMITS.pop.max, Math.ceil(st.height));
      if (s.newLayer.pop !== pop) { s.newLayer.pop = pop; store.emit('layer', { layerId: s.newLayer.id, keys: ['pop'] }); }
    }
    const base = s.newLayer ? wm.data.slice() : s.original;
    const a = s.area, kx = wm.width / doc.image.width, ky = wm.height / doc.image.height;
    const level = target.pop > 0 ? Math.min(1, st.height / target.pop) : 0;
    inflateShape(wm, base, {
      kind: st.shape, cx: (a.x / doc.image.width + 0.5) * wm.width, cy: (0.5 - a.y / doc.image.height) * wm.height, rx: a.w / 2 * kx, ry: a.h / 2 * ky,
      angle: st.angle * Math.PI / 180,
    }, { level, softness: st.softness, profile: st.profile, blend: st.blend, blur: st.blur * kx });
    store.weightsChanged(target.id, wm.fullRect, false);
  }

  /** プレビューを終える。apply なら1手として記録し、そうでなければ元に戻す */
  end(apply: boolean): void {
    const h = this.host, store = h.store, s = this.session, doc = store.doc; if (!s) return;
    const source = store.findLayer(s.layerId)?.layer, newLayer = s.newLayer;
    if (!apply || !doc || !source) {
      this.setPreviewLayer(false);
      if (source) { source.weights.data.set(s.original); store.weightsChanged(s.layerId, source.weights.fullRect, false); }
      this.session = null;
      h.ended();
      return;
    }
    this.session = null;
    const st = s.settings;
    h.inflateSettings = { ...st }; // 次に描くときも同じ設定で始める
    const shape = `${INFLATE_KINDS[st.shape]} ${Math.round(s.area.w)}×${Math.round(s.area.h)}px${st.angle ? `・${st.angle}°` : ''}${st.blur ? `・ぼかし ${st.blur}px` : ''}`;
    if (newLayer && !newLayer.weights.data.some(v => v > 0)) {
      // 範囲がすべて画像の外などで何も膨らまなかったときは、空のレイヤーを残さない
      this.session = s;
      this.end(false);
      toast('変化はありませんでした。');
      return;
    }
    if (newLayer) {
      // 仮に入れたレイヤーをそのまま正式に追加する。戻すとレイヤーごと消え、元のレイヤーは触れていないので元どおり
      const index = doc.layers.indexOf(newLayer);
      h.history.push(new InsertLayer(`膨らませる(${shape}・高さ ${st.height}px・新しいレイヤー「${newLayer.name}」)`, doc.id, newLayer, index));
      store.emit('change', undefined);
      h.setActiveLayer(newLayer.id);
    } else {
      const tiles = diffTiles(s.original, source.weights);
      const height = s.limited && st.height > s.sourcePop ? s.sourcePop : st.height; // 上限の枚数で新しいレイヤーを作れないときは、ポップ量で止まる
      if (!tiles.length) toast('変化はありませんでした。');
      else {
        h.history.push(new WeightEdit(`膨らませる(${shape}・高さ ${height}px)`, s.layerId, tiles));
        store.emit('change', undefined);
      }
    }
    h.ended();
  }
}

/** 膨らませるで作るレイヤーの名前(膨らみ1, 膨らみ2, …のうち、まだ無いもの) */
function nextInflateLayerName(doc: Document): string {
  let n = 1;
  while (doc.layers.some(l => l.name === `膨らみ${n}`)) n++;
  return `膨らみ${n}`;
}
