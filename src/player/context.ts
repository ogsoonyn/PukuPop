/**
 * キャンバスを使っている最中の印。1つのキャンバスを使えるのは、生きている Player(と読み込み中の createPlayer)1つだけ。
 *
 * 同じキャンバスで WebGLRenderer を2つ作ると、1つのコンテキストを共有し、片方を捨てる(コンテキストを手放す)と
 * もう片方が真っ黒のまま戻らない。重なったら後から来た方を断る。
 * 印は createPlayer を呼んだ同期の区間(最初の await より前)で付けるので、2つ目が1つ目の読み込み中に始まっても重なりが分かる。
 * 外すのは dispose()・読み込みの失敗・取り消し(取り消しは abort された時点ですぐ外す)。
 *
 * dispose() したキャンバスは使い回さない(コンテキストを手放しているので描けない)。それは印ではなく、
 * 作ったあとにコンテキストが失われているかで見分けて断る(player.ts)。
 */

const inUse = new WeakMap<HTMLCanvasElement, object>();

/** キャンバスに印を付ける。ほかが使っていれば null。返した関数で外す(自分の印のときだけ外す。何回呼んでもよい) */
export function claimCanvas(canvas: HTMLCanvasElement): (() => void) | null {
  if (inUse.has(canvas)) return null;
  const token = {};
  inUse.set(canvas, token);
  return () => { if (inUse.get(canvas) === token) inUse.delete(canvas); };
}
