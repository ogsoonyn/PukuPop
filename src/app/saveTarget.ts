/**
 * タブの保存先(編集アプリだけの機能、Issue #146)。
 *   ファイル: ブラウザのファイルの場所(FileSystemFileHandle。Chrome 系)に書く。今までの動き。
 *   サーバー: 埋め込みモードで、同じオリジンの URL へ HTTP で書く(PUT で上書き、新規は最初だけ POST)。
 * 「保存」は今の保存先へ書き、保存先が無いとき・「名前を付けて保存」は、保存先を選ぶ画面(かダウンロード)にする(App.save)。
 */

export interface SaveTarget {
  readonly kind: 'file' | 'server';
  /** 見出しに出す名前 */
  readonly name: string;
  /**
   * 上書きする。サーバーの保存先は、開いたあとに別の所で上書きされていたら SaveConflictError を投げる。
   * force なら確かめずに上書きする
   */
  write(blob: Blob, opts?: { force?: boolean }): Promise<void>;
  /** 同じ保存先か(同じファイルを2つのタブで開かないため) */
  isSame(other: SaveTarget): Promise<boolean>;
  /** ファイルの場所(ファイルの保存先だけ。最近開いたファイルに覚える) */
  readonly handle?: FileSystemFileHandle;
}

/** 保存先が、開いたあと(前に保存したあと)に別の所で上書きされていた(サーバーが 412 を返した) */
export class SaveConflictError extends Error {
  constructor() {
    super('保存先のファイルが、開いたあとに別の所で上書きされています');
    this.name = 'SaveConflictError';
  }
}

/** ブラウザのファイルの場所への保存先 */
export function fileTarget(handle: FileSystemFileHandle): SaveTarget {
  return {
    kind: 'file',
    get name() { return handle.name; },
    handle,
    async write(blob) {
      const w = await handle.createWritable();
      await w.write(blob); await w.close();
    },
    async isSame(other) {
      if (!other.handle) return false;
      try { return await handle.isSameEntry(other.handle); } catch { return false; } // 比べられなければ別のファイルとみなす
    },
  };
}
