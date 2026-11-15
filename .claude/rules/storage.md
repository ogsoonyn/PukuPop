---
paths:
  - "src/storage/**"
  - "src/model/**"
  - "src/physics/take.ts"
  - "src/app.ts"
  - "src/main.ts"
  - "src/ui/panels.ts"
  - "src/ui/toolOptions.ts"
  - "src/ui/exportDialog.ts"
  - "src/ui/recentDialog.ts"
  - "src/ui/imageio.ts"
  - "tests/unit/storage.test.ts"
  - "tests/unit/take.test.ts"
  - "tests/e2e/storage.spec.ts"
  - "tests/e2e/helpers.ts"
---

# 保存形式と、ブラウザに残すデータ

## 公開済みのファイルは開けるまま保つ

- `main` に出した(公開した)形式で保存した `.pukupop` / `.popstage` は、いつまでも開けるようにする。項目が無い・知らない値のときは既定値で読む。
- 古いファイルの読み込みを変えたら、`tests/unit/storage.test.ts` にそのテストを足す。
- 項目を足すだけなら `FORMAT_VERSION` は据え置く。版を上げると、古いアプリでは開けなくなるため。作りを変えるときだけ版を上げ、古い版から順に移す処理を足す。
- 操作の記録(`motion/take.json`)は、`FORMAT_VERSION` とは別に自分の `version` を持つ。合わないと記録は黙って捨てられるので、上げるときは古い版を読む処理も足す。お気に入りが持つ記録(`motion/favorite-N.json`)も同じ形なので、同じ扱いにする。
- お気に入り(`project.favorites`)は、レイヤーを id で指す。レイヤーの id の付け方を変えるときは、お気に入りの突き合わせも合わせる(読み込みで振り直した id は、`deserializeProject` がお気に入りにも当てている)。
- `develop` にしか入っていない(まだ公開していない)形式には、互換を残さなくてよい。

## 名前を変えない

アプリ名を PopStage から PukuPop に変えたときも、次は変えなかった。

- 利用者のブラウザに残る作業内容や設定が消えるので、変えない: IndexedDB の `popstage`(自動保存)と `popstage-recent`(最近開いたファイル)、localStorage の `popstage.prefs.v1`(設定)。
- E2E とデバッグで使っていて、変える手間に見合わないので据え置いた: `window.popstage`、`src/storage/popstage.ts` のファイル名。

`prefs` のキーを変えるときは、前のキーの値を引き継ぐ(例: `src/ui/panels.ts` は前のキー `popstage.physDetails` も読む)。

## 自動保存はタブごと

- IndexedDB `popstage` のストア `autosave` に、アプリの中のタブの id をキーにして1件ずつ入れる(`src/storage/autosave.ts`)。タブに分ける前の版はキー `'current'` の1件だけだったので、キーは何でも読めるようにしてある。起動時は全部を読み、タブの上限(`MAX_TABS`)まで新しいものから戻す。
- 戻したタブは、自動保存のキーをそのままタブの id にする(保存し直しても件数が増えないように)。タブを閉じたら、そのタブの分を消す。

## 保存領域の永続化

- `src/storage/persist.ts` が `navigator.storage.persist()` を頼む。頼むのは最初の自動保存の成功かファイルの保存のあとで、ページを開いている間に1回だけ。起動直後には頼まない。
- 断られた日時は prefs の `storagePersistDeniedAt`(ミリ秒。通ったら `null`)。30 日は頼み直さない。

## どこに覚えるか

- ファイル(`.pukupop`)に入れるのは `Project` の中身だけ。
- ブラウザだけに覚える設定(ブラシ、選んだタブ、新しい画像の既定など)は `src/storage/prefs.ts`。
- 一時的な切り替え(ポップを一時OFF、揺れを一時停止)は、どちらにも覚えない。

## 読み込むファイルは信用しない

ブラインドレビューで、細工したファイルを開くだけで起きる問題がいくつも見つかった(Issue #1〜#4、#11)。読み込みを書くときは次を守る。

- ZIP・PNG は展開する前に、宣言サイズで上限を確かめる。
- 値を確かめるときは自分のプロパティだけを見る(`in` はプロトタイプの `constructor` なども拾う)。
- 色などの文字列は、検証してから CSS や DOM に入れる。
- 読み込みが途中で失敗しても、モデルと描画を食い違ったまま残さない。
