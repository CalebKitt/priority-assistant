/* Offline shell for the phone app: the app files load from cache when there is no signal.
   Mail and AI requests always go to the network (they are on other origins and never cached). */
const CACHE = 'pa-shell-v1';
const SHELL = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icons/icon192.png', 'icons/icon512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.search.includes('code=')) return;
  // network first so updates show up right away; cache when offline
  event.respondWith(
    fetch(event.request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => undefined);
      return response;
    }).catch(() => caches.match(event.request).then((hit) => hit || caches.match('index.html'))),
  );
});
