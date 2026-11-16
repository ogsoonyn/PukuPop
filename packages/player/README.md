# pukupop-player

[PukuPop](https://github.com/ogsoonyn/PukuPop) で作った `.pukupop` ファイルを、ほかの Web アプリの `<canvas>` に揺れたまま描く、再生専用の部品です。編集の画面は持ちません。

- 渡された `<canvas>` に描くだけで、キャンバスの外(`window`・`document`・親要素・CSS・保存領域)には触りません。
- three.js と fflate を同梱した ESM 1本です。依存は無く、埋め込み先で three.js を入れる必要はありません。
- 型定義(`index.d.ts`)が入っています。
- React などのフレームワークには依存しません(React での使い方は下にあります)。

## 入れ方

npm には公開していません。GitHub のリリースに添付した `.tgz` を、`package.json` の依存に URL で書きます。

```json
{
  "dependencies": {
    "pukupop-player": "https://github.com/ogsoonyn/PukuPop/releases/download/player-v0.2.0/pukupop-player-0.2.0.tgz"
  }
}
```

または、次のように入れます。

```sh
npm install https://github.com/ogsoonyn/PukuPop/releases/download/player-v0.2.0/pukupop-player-0.2.0.tgz
```

`package-lock.json` に中身のハッシュ(integrity)が記録されるので、あとは `npm ci` で同じものが入ります。

- 同じ版(同じタグ)の `.tgz` は差し替えません(差し替えると `package-lock.json` の integrity と食い違い、`npm ci` が失敗するため)。不具合を直したものは新しい版として出すので、URL の版を上げて入れ直してください。
- リリースの一覧: <https://github.com/ogsoonyn/PukuPop/releases>(タグは `player-v<版>`)。リリースの本文に、`.tgz` の sha256 と integrity を載せています。

TypeScript では、`moduleResolution` を `bundler`・`node16`・`nodenext` のどれかにしてください(`package.json` の `exports` で型を見つけるため)。

## 使い方

`.pukupop` のバイト列(`Uint8Array` か `ArrayBuffer`)とキャンバスを `createPlayer` に渡します。キャンバスの大きさは CSS で決めます。

```html
<canvas id="preview" style="display: block; width: 100%; aspect-ratio: 4 / 3"></canvas>
```

```ts
import { createPlayer, type Player, type PlayerErrorCode } from 'pukupop-player';

const canvas = document.querySelector<HTMLCanvasElement>('#preview')!;
const res = await fetch('/assets/sample.pukupop');
const bytes = new Uint8Array(await res.arrayBuffer());

/** 失敗の種類。instanceof ではなく name で見分ける(ライブラリが2つ読まれても効くように) */
function errorCode(e: unknown): PlayerErrorCode | null {
  return e instanceof Error && e.name === 'PlayerError' ? (e as Error & { code: PlayerErrorCode }).code : null;
}

let player: Player | null = null;
try {
  player = await createPlayer(canvas, bytes, { interaction: 'view' });
  console.log(`${player.info.width}×${player.info.height}`, player.info.favorites.map(f => f.name));
} catch (e) {
  const code = errorCode(e);
  if (code === 'unsupported-version') console.warn('新しい版のファイルです');
  // message は画面にそのまま出せる日本語
  if (code) document.querySelector('#error')!.textContent = (e as Error).message;
  else throw e;
}

// 再生・停止のボタン
document.querySelector('#toggle')?.addEventListener('click', () => {
  if (!player) return;
  if (player.playing) player.pause();
  else player.play();
});

// 記録(アニメーション)の再生・停止と、自動で揺らすの切り替え。記録が無いファイルではアニメーションのボタンを出さない
const anim = document.querySelector<HTMLButtonElement>('#anim');
if (anim) anim.hidden = !player?.info.takeSeconds;
anim?.addEventListener('click', () => player?.setTakePlaying(!player.takePlaying));
document.querySelector('#swing')?.addEventListener('click', () => player?.setAutoSwing(!player.autoSwing));

// お気に入り(揺れと動きの組み合わせ)に切り替える
const first = player?.info.favorites[0];
if (player && first) player.setFavorite(first.id);

// 片付ける。dispose() したキャンバスは使い回せないので、次は新しい <canvas> を渡す
function close(): void {
  player?.dispose();
  player = null;
  canvas.remove();
}
document.querySelector('#close')?.addEventListener('click', close);
```

### React

読み込む URL ごとに新しい `<canvas>` を使います(`key` と `useEffect` の依存の両方に同じ `url` を入れるので、Player を作り直すときはいつもキャンバスも新しくなる)。`useEffect` の中で `AbortController` を作って `signal` を渡し、片付けで `abort()` と `dispose()` を呼びます。Player は `import()` で遅らせて読むと、最初の読み込みを軽くできます。

```tsx
import { useEffect, useRef, useState } from 'react';
import type { Player } from 'pukupop-player';

/**
 * url が変わると、key で新しい <canvas> になり、effect もその新しいキャンバスで作り直す。
 * dispose() したキャンバスは使い回せないので、effect の依存に足すものは key にも入れる
 */
export function PukuPopPreview({ url }: { url: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ac = new AbortController();
    let player: Player | null = null;
    setError(null);
    (async () => {
      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok) throw new Error(`${url} を読み込めませんでした(HTTP ${res.status})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const { createPlayer } = await import('pukupop-player');
      const p = await createPlayer(canvas, bytes, { signal: ac.signal });
      // 返ったあとの abort は何もしないので、片付けが先に走っていたらここで捨てる
      if (ac.signal.aborted) p.dispose();
      else player = p;
    })().catch((e: unknown) => {
      if (ac.signal.aborted) return; // 取り消した(StrictMode の2回目・素材の切り替え)
      setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      ac.abort();
      player?.dispose();
    };
  }, [url]);

  return (
    <div>
      <canvas key={url} ref={ref} style={{ display: 'block', width: '100%', aspectRatio: '4 / 3' }} />
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
```

StrictMode で effect が2回走っても動きます(1回目は片付けの `abort()` で取り消され(`fetch` の `AbortError` か `PlayerError` の `aborted`)、同じキャンバスで2回目が作られる)。

## API

### `createPlayer(canvas, bytes, options?): Promise<Player>`

| 引数 | 型 | 内容 |
| --- | --- | --- |
| `canvas` | `HTMLCanvasElement` | 描くキャンバス。まだ使っていないもの(`dispose()` したもの・2D などで使っているもの・ほかの Player が使っているものは断る) |
| `bytes` | `Uint8Array \| ArrayBuffer` | `.pukupop` ファイルの中身(旧形式の `.popstage` も読める) |
| `options` | `PlayerOptions` | 下の表 |

| オプション | 既定 | 内容 |
| --- | --- | --- |
| `autoplay` | `true` | 作ったらすぐ再生するか。記録があればループ再生し、無ければファイルの「自動で揺らす」の設定に従う(切ってあるファイルは止まった絵のまま)。`false` なら最初の1フレームを描いて止まった状態で始まり、`play()` で動き出す |
| `interaction` | `'view'` | キャンバスの上で受ける操作。`'view'` は下の表のとおり(ただのホイールはページのスクロールに任せる)。`'none'` は何も受けない |
| `autoResize` | `true` | キャンバスの大きさの変化を自動で追うか。`false` なら、大きさが変わったら `resize()` を呼ぶ |
| `signal` | なし | 読み込みの取り消し(`AbortSignal`)。読み込み・デコードの間に abort されると `aborted` で失敗する |

`interaction: 'view'` の操作:

| 操作 | マウス | 指 |
| --- | --- | --- |
| 平行移動 | 左ドラッグ | 2本指でなぞる |
| 回す | 右ドラッグ | 1本指でなぞる |
| ズーム | Ctrl(⌘)+ホイール、タッチパッドのピンチ | ピンチ |
| 視点を戻す | ダブルクリック | ダブルタップ |

視点を戻すと、記録をループ再生しているときは記録の初めの視点に、そうでなければ作ったとき(`setFavorite` を呼んだならそのとき)の視点に戻ります。

### `Player`

| メンバー | 内容 |
| --- | --- |
| `info` | ファイルの中身の要約(下)。凍結したオブジェクトで、`setFavorite` で中身が変わるときだけ別のオブジェクトに差し替わる(React の依存配列にそのまま入れてよい) |
| `playing` | 動かす状態か(`pause()` していないか)。絵が実際に動いているかではない(下の「知っておくこと」) |
| `play()` | 動かす。止めていたなら、止めた姿の続きから動く |
| `pause()` | その姿のまま止める(動画の一時停止と同じ)。止めている間は物理も描画も進めない |
| `takePlaying` | 記録(ループ再生する動き)を再生しているか。記録が無ければいつも `false` |
| `setTakePlaying(on)` | 記録のループ再生を始める(初めから)・止める。止めても自動で揺らすの揺れは続く。`play()`・`pause()` とは別。記録が無ければ何もせず `false` を返す |
| `autoSwing` | 自動で揺らすが入っているか(初めはファイルの設定) |
| `setAutoSwing(on)` | 自動で揺らすを入れる・切る(ファイルには書き戻さない)。`setFavorite` を呼ぶと、そのお気に入りの設定に変わる |
| `setFavorite(id)` | お気に入りの揺れ・動きに切り替える。知らない id なら何もせず `false` を返す。動いているか止めているかは変えない |
| `resize()` | キャンバスの大きさと画面の倍率を測り直す。CSS の大きさは書かない |
| `dispose()` | 描画を止め、受け口を外し、WebGL のコンテキストまで手放す。2回目以降と、そのあとのメソッドの呼び出しは何もしない |

`info` の中身:

| プロパティ | 内容 |
| --- | --- |
| `width` / `height` | 元画像の大きさ(ピクセル) |
| `takeSeconds` | 記録(ループ再生する動き)の長さ(秒)。記録が無ければ 0 |
| `favorites` | お気に入りの一覧(`{ id, name }`)。`setFavorite` に `id` を渡す |

### `PlayerError`

`createPlayer` の失敗です。`Error` を継いでいて、`name` は `'PlayerError'`、`message` は画面にそのまま出せる日本語、元の例外があれば `cause` に入ります。種類は `code` で見分けます。

| `code` | 内容 |
| --- | --- |
| `'aborted'` | `signal` で取り消された |
| `'invalid-file'` | 読めない・壊れているファイル |
| `'unsupported-version'` | この Player より新しい版の形式で保存されている(新しい版の Player を入れる) |
| `'canvas-unusable'` | キャンバスが使えない(`dispose()` したもの、ほかのライブラリが WebGL を手放したもの、2D などほかの用途で使われているもの、ほかの Player が使っているもの) |
| `'webgl-unavailable'` | WebGL2 を使えない(ブラウザ・端末が対応していない) |

## 知っておくこと

- **キャンバスは使い回せません。** `dispose()` したキャンバスで `createPlayer` を呼ぶと `canvas-unusable` で失敗します。作り直すときは新しい `<canvas>` を渡してください(React なら `<canvas key={url} />`。上の例)。
  `createPlayer` が失敗したあとに同じキャンバスを使えるのは、WebGL を作る前に失敗したときだけです。取り消し(`aborted`)と新しい版の形式(`unsupported-version`)のあとは、いつでも同じキャンバスを使えます。`invalid-file` は、ファイルを読む・画像をデコードする段階で見つかったものなら同じキャンバスを使えますが、WebGL を作ったあとの組み立て(テクスチャを作るなど)で失敗したものは、コンテキストを手放すのでそのキャンバスはもう使えません(次の `createPlayer` は `canvas-unusable` で失敗します)。どちらの段階かは外から見分けられないので、`invalid-file` のあとに作り直すときは新しい `<canvas>` を渡してください。
- **キャンバスの大きさは CSS で決めます**(例: `width: 100%; aspect-ratio: 4 / 3`)。Player はキャンバスの CSS の大きさを書かず、描画の大きさだけを合わせます。CSS で決めていない(`width`・`height` の属性に任せた)キャンバスでも動きますが、大きさが変わり続けないよう、画面の倍率を掛けた高精細では描きません。
- **画面の倍率だけが変わったとき**(ウィンドウを別のモニターへ移したなど)は、大きさの変化として届かないので `resize()` を呼んでください。
- `interaction: 'view'`(既定)では、キャンバスに `touch-action: none` と `cursor: grab` が付きます(`dispose()` で元に戻ります)。1本指の縦の動きも回すのに使うので、**スマホではキャンバスの上から指で縦にスクロールできません**。困るときは `'none'` にしてください。
- `signal` の abort が効くのは `createPlayer` が返るまでです。返ったあとの abort は何もしないので、`dispose()` で捨ててください。
- エラーの `message` は日本語です。種類は `code` で見分けてください。`instanceof PlayerError` は、ライブラリが2つ読まれると(別々のバンドルに入るなど)効かないので、`e.name === 'PlayerError'` を見てから `e.code` を読むのが確実です。
- `playing` は「`pause()` していないか」です。自動で揺らすが切れていて記録も無いファイルでも、視点を回した勢いで揺れるので `true` のままで、描画も毎フレーム回ります。
- **渡されたキャンバスの外には触りません。** `window`・`document` に受け口を付けず、キャンバスの親要素のクラス・スタイルを変えず、CSS を足さず、service worker・IndexedDB・localStorage を使いません。大きさを追う `ResizeObserver` はキャンバスだけを見ます。console へは失敗のときだけ出します。ただし同梱した three.js は、読み込んだときに `window.__THREE__` に自分の版を書きます(three.js の決まりの動き)。埋め込み先でも three.js を読んでいると、three.js が「Multiple instances of Three.js being imported」と console に警告を出します。
- モジュールを読み込んだだけでは何もしません(DOM の無い環境で `import` しても落ちません。描くには WebGL2 のあるブラウザが要ります)。

## 動作環境

- WebGL2 が使えるブラウザ。確かめているのは Chrome(デスクトップ。スマホは画面の大きさとタッチを真似たもの)です。
- ES2022 の構文で出しています。

## 大きさの目安

| | そのまま | gzip |
| --- | --- | --- |
| `pukupop-player.js`(three.js と fflate を含む) | 約 610 KB | 約 160 KB |

three.js の大部分を含むため、埋め込み先では `import()` で遅らせて読むことをおすすめします。

## 版

版は semver で付けます。0.x の間は、**API が変わるときに真ん中の数字を上げます**(例: 0.1.x → 0.2.0)。右の数字だけが上がるときは、API は変わりません。版は PukuPop のファイルの保存形式の版(`project.json` の `formatVersion`)とは別です。保存形式は項目を足すだけなら版を上げないので、そのようなファイルは古い Player でも開けます。ただし、足された項目や知らない値は使われず既定の値になるので、新しい Player と見え方・揺れ方が違うことがあります。保存形式の版が上がったファイルは、古い Player では `unsupported-version` で失敗するので、新しい Player を入れてください。

`.pukupop` の中身(ZIP の中のパス、`project.json` の項目、元画像のパスと寸法、読むときの上限、版と互換)は [保存形式の文書](https://github.com/ogsoonyn/PukuPop/blob/main/docs/format.md) にあります。サーバー側で一覧用の画像を作る・ファイルを検査するときに使えます。

## ライセンス

MIT License(`LICENSE`)。同梱した three.js(MIT)と fflate(MIT)の著作権表示とライセンス文は `THIRD-PARTY-LICENSES.txt` にあります。
