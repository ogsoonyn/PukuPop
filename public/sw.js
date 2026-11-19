// PukuPop の service worker: 一度開いたら電波がなくても起動できるようにする
// ・ページ(index.html)はネット優先。つながれば毎回最新を取るので、公開した変更はすぐ届く。揺らし方図鑑(guide.html)は覚えない(電波が無いと開けない)
// ・assets/ の JS・CSS はファイル名に中身のハッシュが付くので、一度取ったらキャッシュを使う
// ・アイコンなどその他はキャッシュを先に返し、裏で取り直す
const CACHE = 'pukupop-v1';
const PAGE = new URL('./', self.location).href;

/** index.html が読み込む assets/ のファイルを一覧する */
const assetsOf = html => [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map(m => new URL(m[1], PAGE).href);

/** ページと、それが読み込む JS・CSS をキャッシュに入れ、もう使わない古い assets/ を消す */
async function storePage(res) {
  const cache = await caches.open(CACHE);
  const html = await res.clone().text();
  const keep = new Set(assetsOf(html));
  await cache.put(PAGE, res);
  await Promise.all([...keep].map(async url => { if (!(await cache.match(url))) await cache.add(url); }));
  // 動的に読み込む部品(書き出しなど)は index.html に載らないので消さず、使ったときに入れ直す。
  // 消すのは CSS と、入口(index・guide)と入口どうしで共有する部品(shared-。vite.config.ts が名前を付ける)の古いもの
  for (const req of await cache.keys()) {
    if (req.url.includes('/assets/') && !keep.has(req.url) && /\.css$|\/(index|guide|shared)-[^/]+\.js$/.test(req.url)) await cache.delete(req);
  }
}

self.addEventListener('install', e => {
  e.waitUntil(fetch(PAGE, { cache: 'no-cache' }).then(res => res.ok && storePage(res)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('pukupop-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.registration.scope)) return;

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      if (res.ok && new URL(req.url).pathname === new URL(PAGE).pathname) e.waitUntil(storePage(res.clone()));
      return res;
    }).catch(async () => {
      // 電波が無いとき、編集アプリのページ(./ と index.html)だけ覚えた index.html を返す。
      // 揺らし方図鑑(guide.html)などほかのページは覚えていないので、編集アプリを代わりに出さずにエラーにする
      const path = new URL(req.url).pathname, page = new URL(PAGE).pathname;
      return path === page || path === page + 'index.html' ? ((await caches.match(PAGE)) ?? Response.error()) : Response.error();
    }));
    return;
  }

  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(req);
    // 206(部分応答)などキャッシュに入れられない応答でも、取れたものはそのまま返す
    const net = fetch(req).then(res => { if (res.status === 200) cache.put(req, res.clone()).catch(() => {}); return res; });
    if (hit) {
      if (!req.url.includes('/assets/')) e.waitUntil(net.catch(() => {}));
      return hit;
    }
    return net;
  }));
});
