// Офлайн: оболонку застосунку беремо з кешу, розклад завжди спершу з мережі.
const CACHE = "kino-ua-v2";
const SHELL = ["./", "index.html", "style.css", "fonts.css", "app.js", "manifest.webmanifest", "icon-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Мережа першою (щоб нова версія й свіжий розклад приходили одразу), кеш як запасний варіант.
// Ключ кешу без «?q=...»: інакше кожен запит зберігався б окремою копією сторінки.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const key = url.origin + url.pathname;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(key, copy));
    }
    return r;
  }).catch(() => caches.match(key)));
});
