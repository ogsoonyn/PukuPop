/** E2E の共通の道具(起動・右パネルのタブ・WebGL のエラーの見張り・3Dビューでのドラッグなど)。 */
import { test, expect, type Page } from '@playwright/test';

const glErrors: string[] = [];

/**
 * WebGL のエラー(GL_INVALID_* など)が出たらテストを失敗にする。各テストファイルの先頭で1回呼ぶ
 * (フックはファイルごとに登録する必要があるので、このファイルを読み込むだけでは登録しない)
 */
export function watchGlErrors(): void {
  test.beforeEach(() => { glErrors.length = 0; });
  test.afterEach(() => { expect(glErrors, 'WebGL のエラー').toEqual([]); });
}

/** ページの console に出た WebGL のエラーを、watchGlErrors の見張りへ渡す(boot を使わずに起動する spec 用) */
export function listenGlErrors(page: Page): void {
  page.on('console', m => { if (/GL_INVALID|WebGL: INVALID/.test(m.text())) glErrors.push(m.text()); });
}

/** ?e2e: 自動保存の復元を聞かず、揺れを止めた状態で起動する */
export async function boot(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  listenGlErrors(page);
  await page.goto('/?e2e');
  await page.waitForFunction(() => {
    const a = (window as any).popstage;
    return a?.doc && a.stage.hasDocument && a.paused;
  });
  expect(errors).toEqual([]);
}

/** 右のパネルのタブ(レイヤー・アニメーション・画像と表示)を開く */
export const openTab = (page: Page, tab: 'layer' | 'anim' | 'view') => page.locator(`#pTabs [data-ptab=${tab}]`).click();

/** 選択中のレイヤーのウェイトの合計 */
export const weightSum = (page: Page) => page.evaluate(() => (window as any).popstage.activeLayer.weights.data.reduce((s: number, v: number) => s + v, 0));

/** 3Dビューの上を、割合の座標 from から to へドラッグする */
export async function dragOnStage(page: Page, from: [number, number], to: [number, number], button: 'left' | 'right' = 'left'): Promise<void> {
  const box = (await page.locator('#view').boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down({ button });
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(box.x + box.width * (from[0] + (to[0] - from[0]) * i / 12), box.y + box.height * (from[1] + (to[1] - from[1]) * i / 12));
  }
  await page.mouse.up({ button });
  // ブラシの円カーソルが写り込まないよう、ポインタを画面の外へ逃がす
  await page.mouse.move(1, 1);
  await page.waitForTimeout(100);
}

/** ms ミリ秒の間、先頭レイヤーの揺れ(x)の最小・最大と、最初に ±0.01 を超えた向きを測る */
export const watchSwingX = (page: Page, ms: number) => page.evaluate(ms => new Promise<[number, number, number]>(resolve => {
  const a = (window as any).popstage, t0 = performance.now();
  let lo = 0, hi = 0, first = 0;
  const tick = () => {
    const x = a.world.displacement(a.doc.layers[0].id).x;
    lo = Math.min(lo, x); hi = Math.max(hi, x);
    if (!first && Math.abs(x) > 0.01) first = Math.sign(x);
    if (performance.now() - t0 < ms) requestAnimationFrame(tick); else resolve([lo, hi, first]);
  };
  tick();
}), ms);

/** 描画を n フレーム進める(状態を変えた後、画面に映るのを待つ) */
export const nextFrames = (page: Page, n = 2) => page.evaluate(n => new Promise<void>(r => {
  const step = (k: number) => k ? requestAnimationFrame(() => step(k - 1)) : r();
  step(n);
}), n);

/**
 * ホイールのズームが目標に着くまで待って、値を返す。寄せている間は毎フレーム値が変わるので、
 * 2フレーム進めても変わらなければ着いたとみなす(時間で待つと、描画が遅いときに途中の値を拾う)
 */
export async function settled(page: Page, read: () => Promise<number>): Promise<number> {
  let prev = await read();
  for (let i = 0; i < 100; i++) {
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const v = await read();
    if (v === prev) return v;
    prev = v;
  }
  throw new Error('値が止まらない');
}

/** 自動保存(IndexedDB)を直接読み書きする */
/**
 * 自動保存(IndexedDB)を直接読み書きする。アプリはタブの id をキーにして1件ずつ持つ。
 * key を省くと、タブに分ける前の版のキー 'current'。list は残っている全部の名前
 */
export const autosaveOp = (page: Page, op: 'get' | 'put' | 'clear' | 'list', entry?: { name: string; bytes: number[] }, key = 'current') => page.evaluate(async ([op, entry, key]) => {
  const db: IDBDatabase = await new Promise((res, rej) => {
    const r = indexedDB.open('popstage', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('autosave');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const store = db.transaction('autosave', op === 'get' || op === 'list' ? 'readonly' : 'readwrite').objectStore('autosave');
  const req: IDBRequest = op === 'list' ? store.getAll() : op === 'get' ? store.get(key) : op === 'clear' ? store.delete(key)
    : store.put({ savedAt: Date.now(), name: entry!.name, bytes: new Uint8Array(entry!.bytes) }, key);
  const v = await new Promise(res => { req.onsuccess = () => res(req.result); });
  db.close();
  if (op === 'list') return (v as any[]).map(e => e.name as string).sort();
  return op === 'get' ? (v ? (v as any).name as string : null) : null;
}, [op, entry, key] as const);
