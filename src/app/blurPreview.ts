/**
 * 全体をぼかす(ガウス)のプレビュー(編集アプリだけの機能)。プレビューしながら半径を決め、適用で1手として記録する。
 * プレビュー中の書き換えは「未保存」にも自動保存の予約にもしない(weightsChanged の persistent = false)。
 * 重ね表示の自動の入・切と、始まり・終わりの知らせは App が受け持つ。
 */
import type { Store, Layer } from '../model/project';
import { WeightEdit, Batch, diffTiles } from '../commands/commands';
import type { History } from '../commands/history';
import { toast } from '../ui/dom';
import { countLabel } from './labels';

interface BlurSession {
  /** ぼかしているレイヤー(選んでいるレイヤー全部)と、それぞれの元のウェイト */
  layers: { layerId: string; original: Uint8Array }[];
}

export class BlurPreview {
  private session: BlurSession | null = null;

  constructor(private readonly store: Store, private readonly history: History) {}

  get active(): boolean { return !!this.session; }

  /** layers(選んでいるレイヤー)のプレビューを始める。始めたら true */
  begin(layers: readonly Layer[]): boolean {
    if (!layers.length || this.session) return false;
    this.session = { layers: layers.map(l => ({ layerId: l.id, original: l.weights.data.slice() })) };
    return true;
  }

  /** radius は元画像のピクセル単位。0 で元に戻した状態を表示する。 */
  preview(radius: number): void {
    const p = this.session, doc = this.store.doc; if (!p || !doc) return;
    for (const e of p.layers) {
      const layer = this.store.findLayer(e.layerId)?.layer; if (!layer) continue;
      const wm = layer.weights;
      wm.data.set(e.original);
      if (radius > 0) wm.gaussianBlur(radius * (wm.width / doc.image.width));
      this.store.weightsChanged(e.layerId, wm.fullRect, false);
    }
  }

  /** プレビューを終える。apply なら1手として記録し、そうでなければ元のウェイトに戻す */
  end(apply: boolean, radius: number): void {
    const p = this.session; if (!p) return;
    this.session = null;
    this.finish(p, apply, radius);
  }

  private finish(p: BlurSession, apply: boolean, radius: number): void {
    const label = `全体をぼかす(半径 ${radius}px)`, cmds: WeightEdit[] = [];
    for (const e of p.layers) {
      const layer = this.store.findLayer(e.layerId)?.layer; if (!layer) continue;
      const wm = layer.weights;
      if (!apply) { wm.data.set(e.original); this.store.weightsChanged(e.layerId, wm.fullRect, false); continue; }
      const tiles = diffTiles(e.original, wm);
      if (tiles.length) cmds.push(new WeightEdit(label, e.layerId, tiles));
    }
    if (!apply) return;
    if (!cmds.length) { toast('変化はありませんでした。'); return; }
    this.history.push(p.layers.length === 1 ? cmds[0] : new Batch(countLabel(label, p.layers.length), cmds));
    this.store.emit('change', undefined);
  }
}
