# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

README は使う人向けに書き、開発者向けの詳細(テスト、公開の仕組み、構成など)は書かない。開発者向けの詳細は、ここと `.claude/rules/` に書く。機能の一覧は README の「主な機能」を見る。

## 開発の手がかり

ビルドの手順は README の「ビルド」にある。テストは次のとおり。

```sh
npm test           # 単体テスト(Vitest)
npm run e2e        # E2E テスト(Playwright。エージェントは下の「手元の動作確認を乱さない」に従う)
```

| ディレクトリ | 役割 |
| --- | --- |
| `src/model` | ドキュメントモデル(Project / Document / Layer)、ウェイトマップ、変更通知 |
| `src/commands` | 変更操作とアンドゥ(100手 / 256MB まで。塗りは 64px タイルの差分で持つ) |
| `src/paint` | ストローク処理(補間、ブラシ・消しゴム・ぼかし、筆圧)、範囲を膨らませる処理 |
| `src/physics` | 揺れの計算(レイヤーごとのバネ・ダンパ、固定 120Hz)、揺らし方のパターン、操作の記録 |
| `src/stage` | three.js の描画。ウェイトをテクスチャ配列にまとめ、頂点シェーダで持ち上げる |
| `src/storage` | `.pukupop`(旧 `.popstage`)の読み書き、IndexedDB への自動保存 |
| `src/export` | フレーム単位の書き出し |
| `src/ui` | 画面の部品(入力、パネル、ダイアログ、3面図) |
| `src/app.ts` | 各モジュールをつなぐ本体 |

- `model` / `commands` / `paint` / `physics` / `storage` は DOM と three.js を参照しない。ブラウザ無しで単体テストできるようにするため。
- `develop` / `main` 向けの PR と `develop` への push では、GitHub Actions(`.github/workflows/ci.yml`)が型検査・単体テスト・ビルドを流す。E2E は流れない。
- `main` へ push すると、GitHub Actions(`.github/workflows/deploy-pages.yml`)がテストとビルドを行い、GitHub Pages へ公開する(リポジトリを作り直したときは、Settings → Pages で Source を「GitHub Actions」にする)。ビルド結果は相対パスで参照し合う(`base: './'`)。
- アプリアイコンは `scripts/icon-art.mjs` の SVG から作る。絵を変えたら `node scripts/make-icons.mjs` で `public/icons/` を作り直す。
- service worker は `public/sw.js`。本番ビルドのときだけ登録する(`?e2e` 付きのときも登録しない)。

## やりとり

- 報告・説明・質問、コミットメッセージ、PR、Issue、コードのコメントは日本語で書く。
- ライブラリ・実行環境・ブラウザなどを入れる前に、名前と用途を示して確認を取る。指示がない限り自動で入れない。依存はなるべく増やさない。

## ブランチと PR

- 既定のブランチは `develop`。作業は `develop` から切ったブランチ(`claude/<内容>`)で行う。
- 実装が済んだら別のエージェントにレビューさせる。PR 前のレビューの指摘は、その PR の中で直す。直したら `develop` 向けの PR を作り、報告する。許可があれば、 `gh pr merge --merge` でマージする。
- 頼まれたレビューで見つけた課題と、作業の範囲の外で見つけた課題は Issue に立てる。`develop` にマージして直った Issue は、PR の番号をコメントに書いて閉じてよい。
- `main` へは `develop` からのリリース PR(タイトルは「リリース: …」)だけを、頼まれたときに作る。`main` への push はそのまま GitHub Pages への公開になる。
- PR の本文には、変えたこと、動きが変わるところ、確認したこと(テストの件数と、落ちたテストとその理由)を書く。

## 手元の動作確認を乱さない

メインの作業ツリーからはポート 5173 の dev サーバーで動作確認をしている。エージェントの作業がそれを止めたり重くしたりしないようにする(E2E の Chrome は SwiftShader で描くので CPU を大きく使い、5173 が固まったことがある)。

- 実装は `.claude/worktrees/<名前>` の git worktree で行う(node_modules は親から解決される)。
- 自分で立てる Vite はポート 5175〜5179 にし、`cacheDir` を分ける。設定ファイルは `vite.<名前>.config.ts` / `playwright.<名前>.config.ts`、キャッシュは `.vite-<名前>/` という名前にする(`.gitignore` で追跡外になる)。
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
