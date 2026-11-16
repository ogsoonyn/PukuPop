/**
 * pukupop-player: PukuPop の .pukupop ファイルを、渡された <canvas> に揺れたまま描く再生専用の部品。
 *
 * この型定義は手で書いている(実装は PukuPop のリポジトリの src/player)。実装と食い違わないことは、
 * リポジトリの型検査(tests/types/player-dts.ts)が確かめる。
 *
 * 埋め込み先を壊さないための約束:
 * - 渡されたキャンバスの外に触らない。window・document に受け口を付けず、キャンバスの親要素のクラス・スタイルも触らない
 *   (背景は WebGL の消去の色だけ)。CSS・service worker・IndexedDB・localStorage を使わない。
 *   大きさを追う ResizeObserver は、キャンバスの要素だけを見る。
 * - console へは失敗のときだけ出す。
 */

/**
 * 失敗の種類。
 * - 'aborted': options.signal で取り消された
 * - 'invalid-file': 読めない・壊れているファイル(ZIP でない、project.json が無い・不正、画像やウェイトが壊れている、上限を超えるなど)。
 *   WebGL を作ったあとの組み立てで失敗したときもこれになり、そのときはキャンバスがもう使えない(createPlayer の説明)
 * - 'unsupported-version': このプレーヤーより新しい版の形式で保存されている
 * - 'canvas-unusable': キャンバスが使えない(dispose() したキャンバス・ほかのライブラリが WebGL を手放したキャンバス、2D などほかの用途で使われている、ほかの Player が使っている)
 * - 'webgl-unavailable': WebGL2 を使えない(ブラウザ・端末が対応していない、作れない)
 */
export type PlayerErrorCode = 'aborted' | 'invalid-file' | 'unsupported-version' | 'canvas-unusable' | 'webgl-unavailable';

/**
 * createPlayer の失敗。code で種類を見分ける。message は画面にそのまま出せる日本語。元の例外があれば cause に入る。
 * name は 'PlayerError'。ライブラリが2つ読まれると instanceof が効かないので、見分けるときは e.code か e.name を見る
 */
export declare class PlayerError extends Error {
  readonly code: PlayerErrorCode;
  constructor(code: PlayerErrorCode, message: string, options?: { cause?: unknown });
}

/**
 * キャンバスの上で受ける操作。'none' は何も受けない(受け口を付けない)。
 * 'view' は、マウスの左ドラッグで平行移動・右ドラッグで回す、1本指で回す・2本指で平行移動とピンチのズーム、
 * Ctrl(⌘)+ホイールでズーム、ダブルクリック・ダブルタップで視点を戻す
 */
export type PlayerInteraction = 'none' | 'view';

export interface PlayerOptions {
  /**
   * 作ったらすぐ再生するか(既定 true)。記録があればループ再生し、無ければファイルの「自動で揺らす」の設定に従う
   * (切ってあるファイルは止まった絵のまま)。false なら最初の1フレームを描いて止まった状態で始め、play() で動き出す
   */
  autoplay?: boolean;
  /**
   * キャンバスの上で受ける操作(既定 'view')。'view' のときは、キャンバスに CSS の touch-action: none と cursor: grab を付ける
   * (1本指の縦の動きも回すのに使うので、キャンバスの上から指で縦にスクロールできなくなる。dispose() で元に戻す)
   */
  interaction?: PlayerInteraction;
  /**
   * キャンバスの大きさの変化を自動で追うか(既定 true)。キャンバスの要素だけを ResizeObserver で見て、描画の大きさ・縦横比を合わせる。
   * キャンバスの CSS の大きさは決して書かない。キャンバスの大きさは埋め込み先が CSS で決める(例: width: 100%; aspect-ratio: 4 / 3)。
   * CSS で決めていない(width・height の属性に任せた)キャンバスでも大きさは変わらずに動くが、画面の倍率を掛けた高精細では描かない。
   * false のときは、大きさが変わったら resize() を呼ぶ。大きさ 0(display: none など)のまま作った場合は、resize() を呼ぶまで正しく描けない
   */
  autoResize?: boolean;
  /**
   * 読み込みの取り消し。createPlayer の読み込み・デコードの間に abort されると、code 'aborted' の PlayerError で失敗する
   * (呼ぶ前から abort 済みなら何もせずに失敗する)。取り消したキャンバスは、そのまま次の createPlayer に使える
   * (React の StrictMode で effect が2回走っても、同じキャンバスで作り直せる)。
   * Player が返ったあとの abort は何もしない(返ったあとは dispose() で捨てる)
   */
  signal?: AbortSignal;
}

/** ファイルに入っているお気に入り(揺れと動きの組み合わせ) */
export interface PlayerFavorite {
  readonly id: string;
  readonly name: string;
}

/** ファイルの中身の要約 */
export interface PlayerInfo {
  /** 元画像の幅(ピクセル) */
  readonly width: number;
  /** 元画像の高さ(ピクセル) */
  readonly height: number;
  /** 記録(ループ再生する動き)の長さ(秒)。記録が無ければ 0。setFavorite で記録が入れ替わると変わる */
  readonly takeSeconds: number;
  /** ファイルに入っているお気に入り(揺れと動きの組み合わせ)。setFavorite に id を渡す */
  readonly favorites: readonly PlayerFavorite[];
}

/** createPlayer が返す、再生を操作するオブジェクト(凍結してあり、ここに書いたものだけを持つ) */
export interface Player {
  /**
   * ファイルの中身の要約。凍結したオブジェクトで、中身が変わるとき(setFavorite)だけ別のオブジェクトに差し替わる
   * (変わっていなければ毎回同じオブジェクトなので、React の依存配列などにそのまま入れてよい)
   */
  readonly info: PlayerInfo;
  /**
   * 動かす状態か(pause() していないか。play() してから pause()・dispose() するまで true)。
   * 絵が実際に動いているかではない(自動で揺らすが切れていて記録も無いファイルでも、視点を回した勢いで揺れるので true のまま)
   */
  readonly playing: boolean;
  /** 動かす。止めていたなら、止めた姿の続きから動く(止めていた間の時間は進めない) */
  play(): void;
  /** その姿のまま止める(動画の一時停止と同じ)。止めている間は物理も描画も進めない(視点の操作と大きさの変化では1回描き直す) */
  pause(): void;
  /** 記録(info.takeSeconds が 0 より大きいときにある動き)をループ再生しているか。記録が無ければいつも false */
  readonly takePlaying: boolean;
  /**
   * 記録のループ再生を始める・止める。始めると記録の初めから再生する。止めると、その時点の視点のまま、
   * 自動で揺らす・視点を動かした勢いの揺れだけになる。play()・pause() とは別(pause() している間に始めても、play() するまで動かない)。
   * 記録が無ければ何もせず false を返す
   */
  setTakePlaying(on: boolean): boolean;
  /** 自動で揺らすが入っているか(初めはファイルの設定) */
  readonly autoSwing: boolean;
  /** 自動で揺らすを入れる・切る(ファイルには書き戻さない)。setFavorite を呼ぶと、そのお気に入りの設定に変わる */
  setAutoSwing(on: boolean): void;
  /**
   * お気に入りの揺れ・動きに切り替える(レイヤーのポップ量・重ね方・揺れ、自動揺らし、記録、画角、視点)。
   * 再生していたときに残したお気に入りなら、記録をループ再生する。動いているか止めているかは変えない。
   * 知らない id なら何もせず false を返す
   */
  setFavorite(id: string): boolean;
  /**
   * キャンバスの大きさと画面の倍率(devicePixelRatio)を測り直す。CSS の大きさは書かない。
   * autoResize: false のときと、倍率だけが変わったとき(ウィンドウを別のモニターへ移したなど)に呼ぶ。止めているときは描き直す
   */
  resize(): void;
  /**
   * 描画を止め、受け口を外し、WebGL のコンテキストまで手放す。2回目以降と、そのあとのメソッドの呼び出しは何もしない。
   * 手放したキャンバスは使い回せない(次の createPlayer には新しい <canvas> を渡す。React なら effect の依存と同じ値を key にして <canvas key={url} /> など)
   */
  dispose(): void;
}

/**
 * .pukupop のバイト列を読み、canvas に描く Player を作る。失敗したときは code 付きの PlayerError で失敗する
 * (作りかけの描画を解放し、キャンバスを使っている最中の印も外してから)。
 * キャンバスの大きさは CSS で決める(例: width: 100%; aspect-ratio: 4 / 3)。CSS で決めていないキャンバスでも動くが、高精細では描かない。
 *
 * 読み込みとデコードは WebGL を作る前に済ませる。WebGL を作る前の失敗(取り消しの 'aborted'、'unsupported-version'、
 * ファイルを読む・デコードする段階の 'invalid-file')では、キャンバスは使えるまま残る(同じキャンバスで次の createPlayer を呼べる)。
 * WebGL を作ったあとの組み立てで失敗したとき('invalid-file' など)は、コンテキストを手放すので、そのキャンバスはもう使えない
 * (次の createPlayer は 'canvas-unusable' で失敗する)。'invalid-file' はどちらの段階かを外から見分けられないので、
 * 作り直すときは新しい <canvas> を渡す。
 */
export declare function createPlayer(canvas: HTMLCanvasElement, bytes: Uint8Array | ArrayBuffer, options?: PlayerOptions): Promise<Player>;
