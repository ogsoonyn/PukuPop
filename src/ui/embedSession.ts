/**
 * 埋め込みモードの画面(Issue #146)。起動時にクエリのファイルを開き、埋め込み元へ戻るボタンと、離れる前の確認を受け持つ。
 * クエリの読み方とサーバーとのやりとりは src/app/embed.ts(App を通して使う)。
 */
import { parseEmbedParams, backUrl, type App } from '../app';
import { ui } from './ids';
import { ask } from './dom';

export interface EmbedSession {
  /** 戻るボタンで離れているところ(確かめ済みなので、ページを閉じるときの確認を出さない) */
  readonly leaving: boolean;
  /** クエリで受け取ったファイルを開く。開けなければ理由を出し、戻り先があれば戻れるようにする */
  open(): Promise<void>;
}

export function bindEmbed(app: App): EmbedSession {
  const page = location.href, search = location.search;
  const back = backUrl(search, page);
  let leaving = false;

  /** 埋め込み元へ戻る。保存していない変更があれば確かめる */
  const leave = async (): Promise<void> => {
    if (!back || leaving) return;
    if (app.anyDirty) {
      const r = await ask({ title: '保存していない変更があります', body: '変更を破棄して戻りますか?', yes: '破棄して戻る' });
      if (!r.ok) return;
    }
    leaving = true;
    location.assign(back);
    // 戻り先が 204 やダウンロードを返すと、ページは変わらない。そのときは印を戻し、ページを閉じるときの確認をまた出す
    setTimeout(() => { leaving = false; }, 1000);
  };
  for (const b of [ui.embedBack, ui.mBack]) {
    b.hidden = !back;
    b.addEventListener('click', () => void leave());
  }
  // スマホのファイルの操作の「保存」の補足(ふだんはダウンロード)
  const note = document.querySelector('.m-pane [data-cmd="save"] span');
  if (note) note.textContent = 'サーバーへ上書き';

  return {
    get leaving() { return leaving; },
    async open() {
      let reason: string;
      try {
        if (await app.openEmbedded(parseEmbedParams(search, page))) return;
        reason = 'ファイルの中身を読めませんでした。';
      } catch (e) { reason = e instanceof Error ? e.message : String(e); }
      const r = await ask({ title: 'ファイルを開けませんでした', body: reason, yes: back ? '戻る' : 'OK', no: null });
      if (r.ok) void leave();
    },
  };
}
