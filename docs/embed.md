# 編集画面を埋め込む: 保存の口

PukuPop の編集画面を、ファイルをサーバーで管理する自分のアプリ(画像のアーカイブなど)に埋め込む開発者向けの文書です。編集画面の入れ方・置き方・URL のクエリは、配布物の [README](../packages/editor/README.md) にあります。ここでは、サーバー側で用意する口(HTTP のやりとり)を書きます。

`.pukupop` の中身(ZIP の作り)は [format.md](format.md) にあります。サーバーは中身を読まずに、バイト列のまま保存して返せば足ります。

## 全体の流れ

```
埋め込む側のアプリ                         編集画面(/pukupop/)
  リンク /pukupop/?src=/files/cat.pukupop&back=/files/
                                    ──▶  GET  /files/cat.pukupop        開く
                                    ──▶  PUT  /files/cat.pukupop        「保存」(何度でも)
  /files/                          ◀──   「戻る」
```

画像から新しく作るとき:

```
  リンク /pukupop/?image=/files/cat.png&create=/files/&back=/files/
                                    ──▶  GET  /files/cat.png            開く
                                    ──▶  POST /files/                   最初の「保存」 → 201 Location: /files/cat.pukupop
                                    ──▶  PUT  /files/cat.pukupop        2回目からの「保存」
  (最初の「保存」が通ると、編集画面の URL は /pukupop/?src=/files/cat.pukupop&back=/files/&name=cat.pukupop になる)
                                    ──▶  GET  /files/cat.pukupop        読み直したとき
```

## 同じオリジンに限る

クエリで受け取る URL(`src`・`save`・`image`・`create`・`back`)と、POST の応答の `Location` は、編集画面と同じオリジンの `http:` / `https:` のものだけを使います。別のオリジンや `javascript:` などの URL を受け取ると、編集画面は開かずにエラーを出します。

クエリ付きのリンクは誰でも作れます。別のオリジンを許すと、たとえば `?src=社内のファイル&save=外のサーバー` を踏ませるだけで、保存した時点で中身が外へ出ます。そのため、この制限は外せません。

- 相対 URL は編集画面のページの URL から、`Location` は POST した URL から解決します。
- PUT・POST はリダイレクトを追いません(3xx は失敗として扱います)。GET はリダイレクトを追いますが、行き着いた先も同じオリジンでなければ開きません(同じオリジンの転送の口を使って外の中身を開かせ、本人のファイルへ保存させないため)。
- Cookie は、同じオリジンのふつうのリクエストと同じく付きます(`credentials: 'same-origin'`)。認証は Cookie のセッションで行ってください。トークンをヘッダーに付ける口はありません。

### サーバー側で確かめてほしいこと

編集画面は「同じオリジンの URL か」までしか確かめません。同じオリジンの中なら、どの URL でも `save`・`create` にできます。たとえば `?src=/files/a.pukupop&save=/api/account/settings` を踏ませると、本人が「保存」を押した時点で、Cookie 付きの PUT がその口へ飛びます(同じオリジンからのリクエストなので、`Origin` ヘッダーで確かめる CSRF 対策も通ります)。保存先の URL は画面に出ないので、本人は気づけません。

- PUT・POST を受けるのは、ファイルを置く口だけにしてください。ほかの API は PUT・POST で `application/zip` の本文を受けないようにします。
- ファイルの口では、書き込む人がそのファイルを書き換えてよいか(権限)と、`Content-Type: application/zip` で `.pukupop` の形をしていること(ZIP の先頭が `PK`)を確かめてください。
- 読み書きのたびにブラウザのキャッシュを使いません(`cache: 'no-store'`)。

## 開く(GET)

`src`(`.pukupop`)か `image`(画像)を GET します。

| 応答 | 編集画面の動き |
| --- | --- |
| 2xx | 本文を開く。`src` の応答に `ETag` があれば覚え、上書きの衝突を見つけるのに使う(下の「上書きの衝突」) |
| それ以外・つながらない | 開かずに「ファイルを開けませんでした」と状態のコード(`HTTP 404` など)を出す。`back` があれば戻るボタンを出す |

- 画像は PNG・JPEG・WebP です。種類は `Content-Type`(`image/png`・`image/jpeg`・`image/webp`)で見分け、無いか違う値なら中身の先頭から見分けます。
- `.pukupop` の `Content-Type` は見ません(`application/zip` か `application/octet-stream` を勧めます)。
- 中身が `.pukupop` として読めない(壊れている・新しすぎる版など)ときも、開かずにエラーを出します。

## 上書き(PUT)

「保存」を押すと、保存先(`save`。省けば `src`。画像から作ったときは POST の応答の `Location`)へ、`.pukupop` の全体を本文にして PUT します。

```
PUT /files/cat.pukupop
Content-Type: application/zip
If-Match: "a1b2c3"          ← 覚えている ETag があるときだけ

<.pukupop のバイト列>
```

| 応答 | 編集画面の動き |
| --- | --- |
| 2xx | 保存できたとする。応答の `ETag` を次の上書きに使う(無ければ、次は確かめずに上書きする) |
| 412 | 上書きの衝突とみなし、上書きするかやめるかを選ばせる(下の「上書きの衝突」) |
| それ以外・つながらない | 保存できなかったと知らせる(`HTTP 403` など)。変更は未保存のまま残る |

本文は毎回ファイルの全体です(差分ではありません)。応答の本文は読みません。

## 新しく作る(POST)

`image` から開いたときの最初の「保存」は、`create` へ `.pukupop` の全体を本文にして POST します。ファイルの名前・置き場所はサーバーが決めます(名前の候補が要るときは、`create` の URL のクエリなどで渡してください)。編集画面の見出しと保存のお知らせには、画像の名前(か `name`)の拡張子を `.pukupop` にしたものを出します。`Location` の名前には変えません(`/files/123` のように名前でない URL もあるため)。

```
POST /files/
Content-Type: application/zip

<.pukupop のバイト列>
```

```
HTTP/1.1 201 Created
Location: /files/cat.pukupop
ETag: "d4e5f6"
```

| 応答 | 編集画面の動き |
| --- | --- |
| 2xx で `Location` あり | 保存できたとする。`Location` を保存先にし、以後の「保存」はそこへ PUT する。`ETag` があれば次の上書きに使う。ページの URL を `?src=<Location>` に置き換える(下の「保存したあとのページの URL」) |
| 2xx で `Location` なし、`Location` が別のオリジン | 保存できなかったと知らせる(次の「保存」も、もう一度 POST する) |
| それ以外・つながらない | 保存できなかったと知らせる(次の「保存」も、もう一度 POST する) |

`Location` は、2xx の応答の `Location` ヘッダーで返してください(リダイレクトではありません)。返さないと、作ったファイルに書き戻せず、保存のたびに新しいファイルができます。

### 保存したあとのページの URL

POST が通ると、編集画面は自分のページの URL を `?src=<Location>` の形に置き換えます(`history.replaceState`。ブラウザの履歴は増えません)。`image`・`create` を外し、`name` には見出しに出している名前(上の、拡張子を `.pukupop` にしたもの)を入れ、`back` などほかのクエリはそのまま残します。

```
/pukupop/?image=/files/cat.png&create=/files/&back=/files/
  ↓ 最初の「保存」(POST → 201 Location: /files/cat.pukupop)
/pukupop/?src=/files/cat.pukupop&back=/files/&name=cat.pukupop
```

ページを読み直したとき(利用者が読み直したときのほか、スマホのブラウザが裏に回したタブを捨てて、戻ったときに読み込み直すこともあります)に、元の画像から作り直さず、保存したファイルを開いて続きを編集できるようにするためです。読み直したあとの「保存」も、POST でなく `Location` への PUT になるので、同じ作業のファイルが増えません。

- そのため、**`Location` の URL は GET でも読めるようにしてください**(上の「開く(GET)」と同じ応答。強い `ETag` を返せば、読み直したあとの上書きの衝突も見つけられます)。読めないと、読み直したときに開けません。
- 保存していない変更は、読み直すと消えます(埋め込みモードでは自動保存を使いません)。保存していない変更があるときは、読み直す前にブラウザの確認が出ます。

## 上書きの衝突

サーバーのファイルは、開いたあとに別の人や別のタブが先に上書きしていることがあります。編集画面は、そのまま上書きして相手の変更を消さないよう、HTTP の条件付きリクエストで確かめます。

1. GET(`src`)と POST の応答の `ETag` を覚える。
2. PUT に `If-Match: <覚えた ETag>` を付ける。
3. サーバーは、今のファイルの ETag が `If-Match` と違えば、書き込まずに `412 Precondition Failed` を返す。
4. 412 を受けた編集画面は「別の所で上書きされています」と出し、次のどちらかを選ばせる。
   - **上書きする**: `If-Match` を付けずに、もう一度 PUT する。
   - **やめる**: 何もしない(変更は未保存のまま残る)。
5. PUT が通ったら、応答の新しい `ETag` を次の `If-Match` に使う。

- サーバーが `ETag` を返さないときは、`If-Match` を付けずに上書きします(確かめません)。
- 弱い ETag(`W/"…"` の形)は確かめに使いません。`If-Match` は強い比較なので、弱い ETag では毎回 412 になるためです。衝突を見つけたいときは、強い ETag を返してください(Express などは既定で弱い ETag を返します)。
- `save` を `src` と別の URL にしたときも、`src` の GET の `ETag` を `save` への最初の PUT の `If-Match` に使います。同じファイルを指す口なら、同じ ETag を返してください。

## 編集画面がしないこと

- 別のオリジンからの埋め込み(iframe と postMessage、CORS)。
- ヘッダーのトークンでの認証や、multipart での送信など、上の形と違う口への読み書き。
- `.pukupop` の形(版)の変換。保存するのは、その編集画面の版の形です([format.md](format.md))。
