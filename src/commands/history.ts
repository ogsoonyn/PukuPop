/**
 * アンドゥスタック。変更はすべてコマンドとして記録する。
 * 100手まで、または差分の合計が 256MB まで保持する。
 */
import { Emitter } from '../util/emitter';
import type { Store } from '../model/project';

export interface Command {
  readonly label: string;
  /** 保持しているデータ量の目安(バイト) */
  readonly bytes: number;
  /** 元に戻す・やり直すで、選んでいたレイヤーが消えたときに選ぶレイヤー(LayerSelect) */
  readonly select?: LayerSelect;
  apply(store: Store): void;
  revert(store: Store): void;
}

/**
 * レイヤーを消す・作る操作で、元に戻す(undo)・やり直す(redo)によって選んでいたレイヤーが消えたときに選ぶレイヤーの id。
 * 消す操作のやり直しは実行したときに選んだもの(削除はすぐ上、結合はまとめた先)、作る操作の元に戻すは作る前に選んでいたもの。
 * History は `undo` / `redo` で知らせるだけで、消えたかを見て選ぶのは受けた側(App)。選ぶものはモデルに無いので、id だけを持つ
 */
export interface LayerSelect { readonly undo?: string; readonly redo?: string }

export interface HistoryOptions { maxSteps: number; maxBytes: number }

/** 裏のタブに預けておくアンドゥの積み(History.take で取り出し、restore で戻す) */
export interface HistoryState { undo: Command[]; redo: Command[]; bytes: number }

export const emptyHistory = (): HistoryState => ({ undo: [], redo: [], bytes: 0 });

/**
 * 預けてある積みを、古い手から捨てて bytes 以下にする(全部のタブの合計を上限に収めるため)。
 * やり直しの積みは、やり直すまで最も遠いもの(積みの底)から捨てる。捨てた量を返す
 */
export function shrinkHistory(s: HistoryState, bytes: number): number {
  let freed = 0;
  while (s.bytes > bytes && (s.undo.length || s.redo.length)) {
    const c = s.undo.length ? s.undo.shift()! : s.redo.shift()!;
    s.bytes -= c.bytes; freed += c.bytes;
  }
  return freed;
}

/** undo / redo は、戻した・やり直したコマンドを change より先に知らせる(App は change で「選んでいたレイヤーが消えた」印を下ろすため) */
export class History extends Emitter<{ change: void; undo: Command; redo: Command }> {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private totalBytes = 0;
  readonly options: HistoryOptions;

  constructor(private store: Store, options: Partial<HistoryOptions> = {}) {
    super();
    this.options = { maxSteps: 100, maxBytes: 256 * 1024 * 1024, ...options };
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoLabel(): string | undefined { return this.undoStack.at(-1)?.label; }
  get redoLabel(): string | undefined { return this.redoStack.at(-1)?.label; }
  get size(): number { return this.undoStack.length; }
  get bytes(): number { return this.totalBytes; }

  /** コマンドを実行して記録する。 */
  execute(cmd: Command): void {
    cmd.apply(this.store);
    this.push(cmd);
  }

  /** すでに反映済みの変更を記録だけする(スライダーのドラッグや塗りのストローク)。 */
  push(cmd: Command): void {
    for (const c of this.redoStack) this.totalBytes -= c.bytes;
    this.redoStack = [];
    this.undoStack.push(cmd);
    this.totalBytes += cmd.bytes;
    while (this.undoStack.length > this.options.maxSteps || (this.totalBytes > this.options.maxBytes && this.undoStack.length > 1)) {
      this.totalBytes -= this.undoStack.shift()!.bytes;
    }
    this.emit('change', undefined);
  }

  undo(): boolean {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    cmd.revert(this.store);
    this.redoStack.push(cmd);
    this.emit('undo', cmd);
    this.emit('change', undefined);
    return true;
  }

  redo(): boolean {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    cmd.apply(this.store);
    this.undoStack.push(cmd);
    this.emit('redo', cmd);
    this.emit('change', undefined);
    return true;
  }

  /** 積みを取り出して空にする(タブを裏へ回すとき)。変更の通知は restore でまとめて送る */
  take(): HistoryState {
    const s = { undo: this.undoStack, redo: this.redoStack, bytes: this.totalBytes };
    this.undoStack = []; this.redoStack = []; this.totalBytes = 0;
    return s;
  }

  /** 預けておいた積みに入れ替える(タブを表に出すとき) */
  restore(s: HistoryState): void {
    this.undoStack = s.undo; this.redoStack = s.redo; this.totalBytes = s.bytes;
    this.emit('change', undefined);
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.totalBytes = 0;
    this.emit('change', undefined);
  }
}
