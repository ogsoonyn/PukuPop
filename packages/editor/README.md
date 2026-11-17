# pukupop-editor

[PukuPop](https://github.com/ogsoonyn/PukuPop) の編集画面を、ほかの Web アプリに埋め込むための静的ファイル一式です。ファイルをサーバーで管理するアプリ(画像のアーカイブなど)から、`.pukupop` を開いて編集し、保存したらそのサーバーへ書き戻せます。画像を渡して、新しい `.pukupop` を作ることもできます。

- 埋め込む側のアプリと**同じオリジン**の下(例: `https://archive.example/pukupop/`)から配信します。別のオリジンからの埋め込み(iframe など)には対応していません。
- どのパスの下に置いても動きます(読み込むファイルは相対パスで参照しています)。
- 開くファイルと保存先は、編集画面を開く URL のクエリで渡します。サーバー側では、ファイルを返す口(GET)と、書き戻す口(PUT・POST)を用意します。形は [docs/embed.md](https://github.com/ogsoonyn/PukuPop/blob/main/docs/embed.md) にあります。

## 入れ方

npm には公開していません。GitHub のリリースに、同じ中身を2つの形で添付しています。リリースの一覧: <https://github.com/ogsoonyn/PukuPop/releases>(タグは `editor-v<版>`)。リリースの本文に、それぞれの sha256 を載せています。

### Node で組んだアプリ(`.tgz`)

`package.json` の依存に、`.tgz` の URL を書きます。

```json
{
  "dependencies": {
    "pukupop-editor": "https://github.com/ogsoonyn/PukuPop/releases/download/editor-v0.1.0/pukupop-editor-0.1.0.tgz"
  }
}
```

`package-lock.json` に中身のハッシュ(integrity)が記録されるので、あとは `npm ci` で同じものが入ります。`node_modules/pukupop-editor/app/` の中身を、静的ファイルとして配信します。たとえば Express なら次のようにします。

```js
app.use('/pukupop', express.static('node_modules/pukupop-editor/app'));
```

### 静的ファイルを置くだけのサーバー(`.zip`)

`pukupop-editor-0.1.0.zip` を展開し、`pukupop-editor-0.1.0/app/` の中身を、配信したいパス(例: `/pukupop/`)に置きます。

同じ版(同じタグ)の `.tgz`・`.zip` は差し替えません。不具合を直したものは新しい版として出すので、URL の版を上げて入れ直してください。

## 中身

```
app/                      配信するファイル(index.html・assets/・icons/)
README.md                 このファイル
LICENSE                   PukuPop のライセンス(MIT)
THIRD-PARTY-LICENSES.txt  同梱したパッケージ(three.js・daisyUI など)のライセンス
```

`app/` の外のファイルは配信しなくてかまいません。

## 開き方

編集画面の URL に、クエリで開くファイルと保存先を付けて開きます(リンクにする・`location` を変えるなど)。URL は、編集画面と同じオリジンのものだけを使えます(パスだけでもかまいません)。値は `encodeURIComponent` などで符号化してください。

既存の `.pukupop` を編集する:

```
/pukupop/?src=/files/cat.pukupop&back=/files/
```

`src` を GET で取って開き、「保存」で同じ URL へ PUT で上書きします。上書きする先を分けるときは `save` を付けます。

画像から新しく作る:

```
/pukupop/?image=/files/cat.png&create=/files/&back=/files/
```

`image` を GET で取って開き、最初の「保存」で `create` へ POST します。応答の `Location` を保存先にし、以後は PUT で上書きします。

| クエリ | 意味 |
| --- | --- |
| `src` | 開く `.pukupop` の URL |
| `save` | `src` の上書き先(省くと `src`) |
| `image` | 開く画像(PNG・JPEG・WebP)の URL |
| `create` | `image` から作った `.pukupop` を、最初に保存する先(POST) |
| `back` | 「戻る」ボタンの行き先(省くとボタンを出さない) |
| `name` | 見出しに出す名前(省くと URL の最後の部分) |

`src` と `image` は、どちらか1つを付けます。サーバーとのやりとり(応答・エラー・上書きの衝突の見つけ方)は [docs/embed.md](https://github.com/ogsoonyn/PukuPop/blob/main/docs/embed.md) を見てください。

## 埋め込んだときの動き

- 開くのは、クエリで渡したファイル1つだけです。ほかのファイルを開く・最近開いたファイル・サンプル・タブを増やす操作はありません。
- 「保存」はサーバーへの上書きです(スマホでも同じです)。「名前を付けて保存」はありません。動画や GIF への書き出しは、ふつうの PukuPop と同じくダウンロードになります。
- 保存していない変更があるまま「戻る」を押すと、確かめます。ブラウザの戻る・タブを閉じるときは、ブラウザの確認が出ます。
- service worker は登録せず、アプリとしてのインストール(PWA のマニフェスト)もしません。自動保存(IndexedDB)と最近開いたファイルも使いません。ブラシの大きさなどの設定は、ふつうの PukuPop と同じく localStorage(キー `popstage.prefs.v1`)に覚えます。
