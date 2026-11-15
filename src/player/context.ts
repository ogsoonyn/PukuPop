/**
 * Player が手放した WebGL のコンテキストを、同じキャンバスでもう一度使えるようにする。
 *
 * dispose() はブラウザのコンテキスト数の上限(Chrome は 16)に当たらないよう、コンテキストまで手放す(Stage.dispose)。
 * 手放したキャンバスで getContext を呼ぶと、失われたままの同じコンテキストが返り、描けない。埋め込み先が同じキャンバスを
 * 使い回して作り直すこと(React で、モーダルを開いたまま素材だけを送るなど)はよくあるので、作るときに戻してから使う。
 *
 * 失われている間は getExtension('WEBGL_lose_context') が null を返すので、拡張は生きている間(作った直後)に取って控える。
 * 戻せるのは、失われたときの webglcontextlost が preventDefault されたときだけなので、手放す前に受け口を1回だけ付ける。
 * 受け口はどれもキャンバスに付け、すぐ外れる(window・document には付けない)。
 */

interface Released {
  ext: WEBGL_lose_context;
  /** 手放したときの webglcontextlost が届いたら解決する */
  lost: Promise<void>;
}

const released = new WeakMap<HTMLCanvasElement, Released>();

/** 戻すのを待つ長さ(ミリ秒)。届かなければ、使い直せないものとして理由付きで失敗する */
const RESTORE_TIMEOUT = 5000;

/** 生きているコンテキストから、手放す・戻すための拡張を取る(無い環境では null。そのときは手放さず、使い直しもしない) */
export function loseExtension(gl: WebGLRenderingContext | WebGL2RenderingContext): WEBGL_lose_context | null {
  return gl.isContextLost() ? null : gl.getExtension('WEBGL_lose_context');
}

/**
 * これからコンテキストを手放す(Stage.dispose の直前に呼ぶ)。戻せるよう、失われたときの既定の動きを止める受け口を1回だけ付け、
 * 次にこのキャンバスで作るときに戻せるよう拡張を控える
 */
export function willRelease(canvas: HTMLCanvasElement, ext: WEBGL_lose_context | null): void {
  if (!ext) return;
  const lost = new Promise<void>(resolve => {
    // 戻してよいかはこの受け口を呼び終えたあとに決まるので、解決は次のタスクまで遅らせる
    // (すぐ解決すると、戻す処理がその前に走って「戻せない」になる)
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); setTimeout(resolve, 0); }, { once: true });
  });
  released.set(canvas, { ext, lost });
}

/**
 * 前の Player が手放したキャンバスなら、コンテキストを戻してから返る。手放していない(初めて使う)キャンバスなら何もしない。
 * 戻せなければ、理由付きで失敗する
 */
export async function reclaim(canvas: HTMLCanvasElement): Promise<void> {
  const r = released.get(canvas);
  if (!r) return;
  released.delete(canvas);
  const fail = () => new Error('このキャンバスの WebGL を使い直せませんでした。新しいキャンバスを渡してください。');
  // 手放したときの知らせがまだ届いていなければ待つ(届く前に戻すと、戻せないことがある)
  await withTimeout(r.lost, fail);
  const gl = canvas.getContext('webgl2');
  if (!gl) throw fail();
  if (!gl.isContextLost()) return;
  const ac = new AbortController();
  try {
    await withTimeout(new Promise<void>((resolve, reject) => {
      canvas.addEventListener('webglcontextrestored', () => resolve(), { once: true, signal: ac.signal });
      try { r.ext.restoreContext(); } catch { reject(fail()); }
    }), fail);
  } finally { ac.abort(); }
}

function withTimeout(p: Promise<void>, fail: () => Error): Promise<void> {
  let timer = 0;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<void>((_, reject) => { timer = window.setTimeout(() => reject(fail()), RESTORE_TIMEOUT); }),
  ]);
}
