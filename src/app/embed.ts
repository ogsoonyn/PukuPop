/**
 * 埋め込みモード(Issue #146)。ファイルをサーバーで管理するアプリが、自分と同じオリジンの下から編集画面を配信し、
 * URL のクエリで開くファイルと保存先を渡す。埋め込み用のビルド(vite build --mode embed)でだけ有効になる(main.ts)。
 * 埋め込む側の開発者向けの説明は docs/embed.md。
 *
 *   既存の .pukupop を編集: ?src=<URL>[&save=<URL>]  … src を GET で開き、保存は save(省けば src)へ PUT で上書きする
 *   画像から新しく作る:     ?image=<URL>&create=<URL> … image を GET で開き、最初の保存は create へ POST。
 *                                                    応答の Location を保存先にし、以後は PUT で上書きする
 *   どちらにも付けられる:   &back=<URL>(戻るボタンの行き先)、&name=<名前>(見出しに出す名前)
 *
 * クエリで受け取る URL・POST の応答の Location は、ページと同じオリジンの http(s) のものだけを使う。
 * クエリ付きのリンクは誰でも作れるので、別のオリジンを許すと、保存した時点で中身が外へ出る(?src=社内のファイル&save=外のサーバー)。
 * DOM に触らない(fetch は引数で差し替えられる)ので、ブラウザ無しで単体テストできる。
 */
import { SaveConflictError, type SaveTarget } from './saveTarget';
import { FILE_EXTENSION } from '../storage/popstage';

/** 埋め込みのクエリや、サーバーの応答が使えない(開く前に止める) */
export class EmbedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbedError';
  }
}

/** 何を開くか(クエリを確かめたあと)。URL はどれも絶対 URL */
export type EmbedOpen =
  | { kind: 'project'; src: string; save: string; name: string; back: string | null }
  | { kind: 'image'; image: string; create: string; name: string; back: string | null };

/** 見出しに出す名前の長さの上限(クエリの name・URL の最後の部分) */
export const EMBED_NAME_MAX = 200;

/**
 * value を base で解決し、page と同じオリジンの http(s) の URL なら絶対 URL を返す。そうでなければ EmbedError を投げる。
 * what はエラーの文言に出す、何の URL か
 */
export function sameOriginUrl(value: string, base: string, page: string, what: string): string {
  let u: URL;
  try { u = new URL(value, base); } catch { throw new EmbedError(`${what}の URL を読めません。`); }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.origin !== new URL(page).origin) {
    throw new EmbedError(`${what}の URL が、この画面と同じオリジンではありません。同じオリジンの URL だけを使えます。`);
  }
  return u.href;
}

/** URL のパスの最後の部分(%エンコードを戻す)。空なら null */
function lastSegment(url: string): string | null {
  const seg = new URL(url).pathname.split('/').pop() ?? '';
  let name = seg;
  try { name = decodeURIComponent(seg); } catch { /* 戻せなければそのまま */ }
  return name.trim() || null;
}

/** 見出しに出す名前に整える(制御文字を除き、長さを抑える) */
function cleanName(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, EMBED_NAME_MAX);
}

/**
 * 戻り先(back)だけを読む。無い・使えない URL なら null。
 * ほかのクエリが合わずに開けなかったときも、戻るボタンを出せるようにするため
 */
export function backUrl(search: string, page: string): string | null {
  const v = new URLSearchParams(search).get('back');
  if (!v) return null;
  try { return sameOriginUrl(v, page, page, '戻り先(back)'); } catch { return null; }
}

/**
 * 埋め込みのクエリを読む。page はページの URL(location.href)。
 * 組み合わせが合わない・URL が同じオリジンでないときは EmbedError を投げる
 */
export function parseEmbedParams(search: string, page: string): EmbedOpen {
  const q = new URLSearchParams(search);
  const get = (k: string): string | null => { const v = q.get(k); return v === null || v === '' ? null : v; };
  const url = (k: string, what: string): string | null => { const v = get(k); return v === null ? null : sameOriginUrl(v, page, page, what); };
  const src = url('src', '開くファイル(src)'), image = url('image', '開く画像(image)');
  const save = url('save', '保存先(save)'), create = url('create', '新しく作る保存先(create)');
  const back = url('back', '戻り先(back)');
  const named = get('name');
  if (src && image) throw new EmbedError('src と image は、どちらか1つだけを指定してください。');
  if (src) {
    if (create) throw new EmbedError('create は image と組み合わせて使います(src には save を使います)。');
    const name = cleanName(named ?? lastSegment(save ?? src) ?? '') || `untitled${FILE_EXTENSION}`;
    return { kind: 'project', src, save: save ?? src, name, back };
  }
  if (image) {
    if (save) throw new EmbedError('save は src と組み合わせて使います(image には create を使います)。');
    if (!create) throw new EmbedError('画像から新しく作るときは、保存先(create)も指定してください。');
    const name = cleanName(named ?? lastSegment(image) ?? '') || 'image';
    return { kind: 'image', image, create, name, back };
  }
  throw new EmbedError('開くファイルが指定されていません(src か image を指定してください)。');
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: Fetch = (input, init) => fetch(input, init);

/** 応答の失敗を、状態のコード付きの文言にする */
function httpError(what: string, res: Response): Error {
  return new Error(`${what}(HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''})`);
}

/** 通信そのものの失敗(つながらない・リダイレクトを断ったなど) */
function networkError(what: string, e: unknown): Error {
  return new Error(`${what}(${e instanceof Error ? e.message : String(e)})`);
}

/**
 * 強い ETag だけを返す。弱い ETag(W/"…")は If-Match では一致しない決まり(強い比較)なので、確かめに使わない
 * (使うと毎回 412 になる)。無ければ null
 */
export function strongEtag(res: Response): string | null {
  const e = res.headers.get('ETag');
  return e && !e.startsWith('W/') ? e : null;
}

/**
 * 開くファイルを取る(GET)。中身と、上書きの確かめに使う ETag を返す。page はページの URL。
 * リダイレクトは追うが、行き着いた先も page と同じオリジンでなければ開かない
 * (同じオリジンの転送の口を使って、外の中身を開かせ、本人のファイルへ保存させないように)
 */
export async function fetchForOpen(url: string, page: string, fetchFn: Fetch = defaultFetch): Promise<{ bytes: Uint8Array; type: string; etag: string | null }> {
  let res: Response;
  try { res = await fetchFn(url, { credentials: 'same-origin', cache: 'no-store' }); } catch (e) { throw networkError('ファイルを読み込めませんでした', e); }
  if (res.redirected) sameOriginUrl(res.url, res.url, page, 'ファイルの転送先(リダイレクト)');
  if (!res.ok) throw httpError('ファイルを読み込めませんでした', res);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { bytes, type: res.headers.get('Content-Type')?.split(';')[0].trim() ?? '', etag: strongEtag(res) };
}

/**
 * サーバーの保存先。url があれば PUT で上書きし、無ければ create へ POST して、応答の Location を以後の url にする。
 * 開いたとき・前に保存したときの ETag を覚え、PUT に If-Match を付ける(412 なら SaveConflictError)。
 * サーバーが ETag を返さなければ、確かめずに上書きする。
 * PUT・POST はリダイレクトを追わない(同じオリジンの URL が別のオリジンへ転送して、中身が外へ出ないように)
 */
export class ServerTarget implements SaveTarget {
  readonly kind = 'server';
  private url: string | null;
  private etag: string | null;
  private readonly create: string | null;

  constructor(
    readonly name: string,
    opts: { url: string; etag?: string | null } | { create: string },
    /** ページの URL(Location が同じオリジンかを確かめる) */
    private readonly page: string,
    private readonly fetchFn: Fetch = defaultFetch,
  ) {
    this.url = 'url' in opts ? opts.url : null;
    this.etag = 'url' in opts ? opts.etag ?? null : null;
    this.create = 'create' in opts ? opts.create : null;
  }

  /** 今の上書き先(まだ一度も保存していない新規なら null) */
  get location(): string | null { return this.url; }

  async isSame(other: SaveTarget): Promise<boolean> {
    return other instanceof ServerTarget && this.url !== null && other.url === this.url;
  }

  async write(blob: Blob, opts: { force?: boolean } = {}): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/zip' };
    if (this.url) {
      if (this.etag && !opts.force) headers['If-Match'] = this.etag;
      const res = await this.send(this.url, 'PUT', blob, headers);
      if (res.status === 412) throw new SaveConflictError();
      if (!res.ok) throw httpError('サーバーに保存できませんでした', res);
      this.etag = strongEtag(res);
      return;
    }
    const create = this.create!;
    const res = await this.send(create, 'POST', blob, headers);
    if (!res.ok) throw httpError('サーバーに保存できませんでした', res);
    const loc = res.headers.get('Location');
    if (!loc) throw new Error('サーバーが保存先(Location)を返しませんでした。');
    this.url = sameOriginUrl(loc, create, this.page, 'サーバーが返した保存先(Location)');
    this.etag = strongEtag(res);
  }

  private async send(url: string, method: 'PUT' | 'POST', body: Blob, headers: Record<string, string>): Promise<Response> {
    try {
      return await this.fetchFn(url, { method, body, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    } catch (e) { throw networkError('サーバーに保存できませんでした', e); }
  }
}
