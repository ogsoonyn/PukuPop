# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

README は使う人向けに書き、開発者向けの詳細(テスト、公開の仕組み、構成など)は書かない。開発者向けの詳細は、ここと `.claude/rules/` に書く。機能の一覧は README の「主な機能」を見る。

`docs/` は、使う人向けの README とも、エージェント向けの `.claude/` とも別の、`.pukupop` を自分のプログラムで読む・PukuPop を自分のアプリに埋め込む開発者向けの文書を置く(保存形式の `docs/format.md` と、編集画面を埋め込むときの保存の口の `docs/embed.md`)。保存形式(`src/storage/popstage.ts`・`project.json` に入る型・記録の形・上限)を変えたら、`docs/format.md` も直す(版・上限・パスの名前は `tests/unit/formatDoc.test.ts` が実装と突き合わせる)。

## 開発の手がかり

ビルドの手順は README の「ビルド」にある。テストは次のとおり。

```sh
npm test           # 単体テスト(Vitest)
npm run e2e        # E2E テスト(Playwright。エージェントは下の「手元の動作確認を乱さない」に従う)
```

Player(`src/player`)のライブラリのビルドと配布(Issue #127)は次のとおり。

```sh
npm run build:player       # vite.player.config.ts で dist-player/ に ESM を1本出し、package.json・README・index.d.ts・ライセンスをそろえる
npm run check:player       # ビルドの確かめ(外のモジュールの参照・export・編集アプリの部品・大きさの上限)
npm run pack:player        # dist-player/ を npm pack して、直下に pukupop-player-<版>.tgz を作る(sha256・integrity を出す)
npm run check:player-pack  # .tgz を OS の一時ディレクトリの空のプロジェクトに入れ、Node で import し、README のコードを型検査する
```

- 配り方: npm には公開しない。`main` のコミットに `player-v<版>` のタグを打って push すると、`.github/workflows/release-player.yml` が確かめのあと GitHub のリリースを作り、`.tgz` を添付する。使う側は `package.json` の依存に tarball の URL を書く。
- 同じタグのリリースの `.tgz` は差し替えない(使う側の `package-lock.json` の integrity と食い違う)。直すときは版を上げて新しいタグを打つ。ワークフローも、同じタグのリリースがあれば失敗する。
- 版の元は `packages/player/package.json` の `version` だけ(アプリの `package.json` の版とも、保存形式の `FORMAT_VERSION` とも別)。semver で、0.x の間は API を変えるときに真ん中の数字を上げる。上げたら `packages/player/README.md` の入れ方の URL も直す(`tests/unit/playerDts.test.ts` が確かめる)。
- 型定義は手書き(`packages/player/index.d.ts`。内部の型・`inspect` を載せない)。実装と食い違うと、`npm run typecheck` が `tests/types/player-dts.ts` で、入口の名前の一覧の食い違いは `tests/unit/playerDts.test.ts` が見つける。Player の API を変えたら、d.ts・README・型のコメントを一緒に直す。
- CI(`ci.yml`)も Player のビルド・確かめ・npm pack・空のプロジェクトでの確かめまで流す。ビルドした1本がブラウザで動くことは `tests/e2e/playerDist.spec.ts`(確認用のページに `?dist`)が見る。

埋め込み用の編集画面(pukupop-editor、Issue #146)のビルドと配布は次のとおり。編集アプリそのものを `vite build --mode embed` でビルドし、埋め込みモード(`src/app/embed.ts`)を有効にしたもの。

```sh
npm run build:editor       # dist-editor/app/ に出し(vite.config.ts の --mode embed)、package.json・README・ライセンスを dist-editor/ にそろえる
npm run check:editor       # ビルドの確かめ(相対パスの参照・sw.js が無い・埋め込みの口が入っている。dist/ があれば公開版に入っていないことも)
npm run pack:editor        # 直下に pukupop-editor-<版>.tgz(npm pack)と .zip(同じ中身。静的ファイルを置くだけのサーバー向け)を作る
npm run check:editor-pack  # .tgz を空のプロジェクトに入れ、.zip と中身が同じことを確かめる
```

- 配り方は Player と同じ(`editor-v<版>` のタグ → `.github/workflows/release-editor.yml` が `.tgz` と `.zip` を添付する。同じタグは差し替えない。タグの確かめは Player と共有の `scripts/release-tag-check.mjs`)。
- 版の元は `packages/editor/package.json` の `version` だけ。上げたら `packages/editor/README.md` の入れ方の URL も直す(`tests/unit/editorPackage.test.ts` が確かめる)。埋め込みのクエリ・サーバーとのやりとりを変えたら、README の表と `docs/embed.md` も直す。
- 埋め込みモードは、ビルドの `__EMBED__`(`--mode embed` のときだけ true)で有効になる。公開版のビルドには入らない(`check:editor` が見る)。開発用のサーバーでは `?embed` でも試せる(`tests/e2e/embed.spec.ts`)。ビルドしたものをサブパスに置いて動くことは `tests/e2e/embedDist.spec.ts` が見る。

| ディレクトリ | 役割 |
| --- | --- |
| `src/model` | ドキュメントモデル(Project / Document / Layer)、ウェイトマップ、変更通知 |
| `src/commands` | 変更操作とアンドゥ(100手 / 256MB まで。塗りは 64px タイルの差分で持つ) |
| `src/paint` | ストローク処理(補間、ブラシ・消しゴム・ぼかし、筆圧)、範囲を膨らませる処理 |
| `src/physics` | 揺れの計算(レイヤーごとのバネ・ダンパ、固定 120Hz)、揺らし方のパターン、操作の記録 |
| `src/stage` | three.js の描画。ウェイトをテクスチャ配列にまとめ、頂点シェーダで持ち上げる |
| `src/storage` | `.pukupop`(旧 `.popstage`)の読み書き、IndexedDB への自動保存 |
| `src/export` | フレーム単位の書き出し |
| `src/playback` | 再生のつなぎ(物理の結果を Stage へ当てる、記録のループ再生)。編集アプリと再生専用の部品で共有する |
| `src/ui` | 画面の部品(入力、パネル、ダイアログ、3面図) |
| `src/app` | 編集アプリだけの部品(タブ、保存先(ファイル・サーバー)、埋め込みモードのクエリとサーバーとのやりとり、自動保存、記録を取る側、キーフレームの下書き、膨らませる・全体ぼかしのプレビュー、新しい画像の既定) |
| `src/player` | 埋め込み用の再生専用の部品(Player、Issue #127)。`index.ts` が入口。リポジトリの直下の `player.html` と `src/player/demo.ts` は、開発用のサーバーで開く確認用のページ(`/player.html`。本番のビルドには入らない。`?e2e` で自動の読み込みを止める) |
| `packages/player` | Player のライブラリの配布物の元: `package.json`(名前 `pukupop-player`・版の元)、埋め込み先の開発者向けの `README.md`、手書きの型定義 `index.d.ts` |
| `packages/editor` | 埋め込み用の編集画面の配布物の元: `package.json`(名前 `pukupop-editor`・版の元)、埋め込む側の開発者向けの `README.md` |
| `scripts` | アイコンの生成と、Player のライブラリ(`player-*.mjs`)・埋め込み用の編集画面(`editor-*.mjs`)のスクリプト(配布物をそろえる・ビルドの確かめ・npm pack・空のプロジェクトでの確かめ・リリースのタグの確かめ)、同梱したパッケージのライセンスの表記を出す Vite のプラグイン(`third-party-licenses.ts`) |
| `src/app.ts` | 各モジュールをつなぐ本体。画面の部品と E2E(`window.popstage`)が使う公開面を持ち、中身は `src/playback`・`src/app` へ委ねる |

- `model` / `commands` / `paint` / `physics` / `storage` は DOM と three.js を参照しない。ブラウザ無しで単体テストできるようにするため。
- `playback` は `model` / `physics` と、Stage の要るメソッドだけのインターフェース(`src/playback/stageApi.ts`)だけを参照し、`App`・アンドゥ・タブ・DOM(`src/ui`)・`prefs`・自動保存に依存しない。再生専用の部品(Issue #127)と共有するため。外の世界(今のプロジェクト・状態が変わったことの知らせ)は引数・関数・フックで受ける。
- `src/player` は `model`・`physics`・`stage`・`storage/popstage`(と zip・png)・`playback` と、`model` から辿れる `src/util/emitter.ts` と、DOM の部品でない `src/ui/imageio.ts` だけを使う。`App`・`src/app`・`commands`(アンドゥ)・`export`・`src/ui` の画面の部品・CSS・`prefs` / 自動保存 / 最近開いたファイル / 永続化は使わない(入口から辿れるものは `tests/unit/player.test.ts` が確かめる)。あとでライブラリとして出すため。
- `src/player` は渡されたキャンバスの外に触らない。`window` / `document` に受け口を付けず(ポインタはキャンバスで受けて `setPointerCapture`)、キャンバスの親要素のクラス・スタイルを変えず(背景は WebGL の消去の色だけ)、service worker・IndexedDB・localStorage を使わない。console へは失敗のときだけ出す。モジュールを読んだだけで `window` に受け口を付けるファイル(`src/ui/fine.ts` など)も import しない。大きさを追う `ResizeObserver` はキャンバスの要素だけを見るので約束の範囲(`window` の `resize` は使わない。通知の中では大きさを当てず次のフレームに回し(埋め込み先の `window` に ResizeObserver のループのエラーを出さないため)、変えるのは描画バッファの大きさだけで、CSS の大きさは書かない)。
- Player の API の決まり: `dispose()` したキャンバスは使い回さない(使えないキャンバス・ほかの Player が使っているキャンバスは `PlayerError` の `canvas-unusable` で断る。自分が `dispose()` したキャンバスは覚えておき、three.js を呼ぶ前に断る)。キャンバスの大きさは埋め込み先が CSS で決める(CSS で決めていないキャンバスでは、大きさが変わり続けないよう倍率を掛けずに描く)。大きさは既定で自動で追い(`autoResize`)、`resize()` は引数なしで測り直すだけ。`signal` で読み込みを取り消せ、失敗は `code` 付きの `PlayerError`。`createPlayer` は WebGL を作ってから返すまで await を挟まない(取り消し・読み込みの失敗でキャンバスを使えなくしないため)。返すオブジェクトは API だけにし、中身は確認用のページだけが `src/player/player.ts` の `inspect`(入口からは出さない)で見る。
- `src/app` の部品は `App` の型を import せず、要る分だけの小さなインターフェースで受ける。
- タブの保存先は `SaveTarget`(`src/app/saveTarget.ts`。ファイルの場所か、埋め込みモードのサーバー)。「保存」は保存先へ上書きし、保存先が無いとき・名前を付けて保存は選ぶ画面(かダウンロード)にする。同じファイルのタブの判定も `SaveTarget.isSame` で行う。
- 埋め込みモード(`App.embedded`、Issue #146)では、クエリで受け取ったファイル1つだけを開く。サンプル・自動保存(と復元)・最近開いたファイル・保存領域の永続化・service worker・タブを増やす・閉じる・ほかのファイルを開く(メニュー・ドロップ・貼り付け)・名前を付けて保存を使わない。使わないコマンドは `actions.ts` の表の `noEmbed`。クエリとサーバーから受け取る URL は同じオリジンだけにする(`src/app/embed.ts`。外すと保存した中身が外へ出る)。
- `develop` / `main` 向けの PR と `develop` への push では、GitHub Actions(`.github/workflows/ci.yml`)が型検査・単体テスト・ビルド(Player・埋め込み用の編集画面の配布物まで)を流す。E2E は流れない。
- `main` へ push すると、GitHub Actions(`.github/workflows/deploy-pages.yml`)がテストとビルドを行い、GitHub Pages へ公開する(リポジトリを作り直したときは、Settings → Pages で Source を「GitHub Actions」にする)。ビルド結果は相対パスで参照し合う(`base: './'`)。
- アプリアイコンは `scripts/icon-art.mjs` の SVG から作る。絵を変えたら `node scripts/make-icons.mjs` で `public/icons/` を作り直す。
- service worker は `public/sw.js`。本番ビルドのときだけ登録する(`?e2e` 付きのとき・埋め込みモードでは登録しない。埋め込み用の配布物には `sw.js` を入れない)。

## やりとり

- 報告・説明・質問、コミットメッセージ、PR、Issue、コードのコメントは日本語で書く。
- ライブラリ・実行環境・ブラウザなどを入れる前に、名前と用途を示して確認を取る。指示がない限り自動で入れない。依存はなるべく増やさない。

## ブランチと PR

- 既定のブランチは `develop`。作業は `develop` から切ったブランチ(`claude/<内容>`)で行う。
- 実装が済んだら別のエージェントにレビューさせる。PR 前のレビューの指摘は、その PR の中で直す。直したら `develop` 向けの PR を作り、報告する。許可があれば、 `gh pr merge --merge` でマージする。
- 頼まれたレビューで見つけた課題と、作業の範囲の外で見つけた課題は Issue に立てる。`develop` にマージして直った Issue は、PR の番号をコメントに書いて閉じてよい。
- `main` へは `develop` からのリリース PR(タイトルは「リリース: …」)だけを、頼まれたときに作る。`main` への push はそのまま GitHub Pages への公開になる。
- Player・埋め込み用の編集画面のリリースも頼まれたときだけ行う(編集画面はタグが `editor-v<版>`、版の元が `packages/editor/package.json` で、手順は Player と同じ)。`packages/player/package.json` の版(と README の URL)を上げた変更を `develop` → `main` のリリース PR で入れたあと、`main` のそのコミットに `player-v<版>` のタグを打って push する(`git tag player-v0.1.0 <main のコミット>` → `git push origin player-v0.1.0`)。タグは1つずつ push する(`git push --tags` などでまとめて push しない。GitHub は一度に3つを超えるタグの push ではワークフローを動かさない)。タグが `main` の履歴に無い・版が食い違う・形が違うと、ワークフローはリリースを作らずに失敗する。
- PR の本文には、変えたこと、動きが変わるところ、確認したこと(テストの件数と、落ちたテストとその理由)を書く。

## 手元の動作確認を乱さない

メインの作業ツリーからはポート 5173 の dev サーバーで動作確認をしている。エージェントの作業がそれを止めたり重くしたりしないようにする(E2E の Chrome は SwiftShader で描くので CPU を大きく使い、5173 が固まったことがある)。

- 実装は `.claude/worktrees/<名前>` の git worktree で行う(node_modules は親から解決される)。
- 自分で立てる Vite はポート 5175〜5179 にし、`cacheDir` を分ける。設定ファイルは `vite.<名前>.config.ts` / `playwright.<名前>.config.ts`、キャッシュは `.vite-<名前>/` という名前にする(`.gitignore` で追跡外になる)。`vite.player.config.ts` は Player のライブラリのビルドの設定で追跡しているので、作業用の名前に使わない(`<名前>` を `player` にしない)。
- E2E に既定の `playwright.config.ts` は使わない(ポート 5174 のサーバーを使い回す設定のため)。自分の Playwright の設定は既定の設定を広げて作り(`{ ...base, ... }`)、`webServer: undefined` にし、`use.baseURL` を自分で立てたポートにする。`workers` と `grepInvert` は上書きしない(手元では Playwright の既定の並列数で流す。並列で流すと 5173 が重くなることがある。クラウドでは既定の設定が 1 にする)。
- 作業中は、変えた機能の spec だけを流す。全件の E2E は最後に1回だけ流す。
- クラウド環境では、E2E は自動で 1 並列になり、`@local` の付いたテストは外れる(`.claude/rules/testing.md`)。外れたテストに関わる変更は、手元で流すよう報告に書く。
- Playwright のブラウザはダウンロードしない(`npx playwright install` をしない)。インストール済みの Chrome を使う。
- Windows では、バックグラウンドのコマンドを TaskStop で止めても vite の node 子プロセスが残る。残すとワークツリーを削除できない。PowerShell で `Get-NetTCPConnection -LocalPort <port> -State Listen | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }` のようにポートから止める。

## 公開リポジトリとして書く

- 手元の環境に依存した記述(パス、自分の PC の事情など)を、README、コードのコメント、PR、Issue に書かない。`.claude/` の中のエージェント向けの資料は、作業に要るので除く。

## 話題ごとのルールと経緯

関係するファイルを読むと、Claude Code が `.claude/rules/` から読み込む。

- `.claude/rules/storage.md`: 保存形式と、ブラウザに残すデータの互換
- `.claude/rules/ui.md`: 画面の作り(画面まわりの定義の元のファイル、説明の出し方、置き場所、スマホ、状態の変え方)
- `.claude/rules/testing.md`: E2E の書き方と、既知の不安定なテスト

なぜそう決めたかの経緯は `.claude/docs/decisions.md` にある(自動では読み込まない)。過去の判断を覆しそうなときや、背景を知りたいときに読む。新しく決めたことがあれば、ルールはこれらのファイルに、経緯は decisions.md に足す。
