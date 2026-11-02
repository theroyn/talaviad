// Keeps the app itself (pages, scripts, episode list) available offline.
// Audio is not handled here: saved episodes live in IndexedDB, everything else streams from the station.
const CACHE = 'talaviad-v4';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'episodes.json', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's HTTP cache, so a new version never stores stale files
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// same-origin files: answer from the cache at once, refresh it in the background
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    // 'no-cache' = always ask the server (cheap when unchanged), never trust the browser's own cache
    const fresh = fetch(url.href, { cache: 'no-cache' }).then(r => {
      if (r.ok) cache.put(e.request, r.clone());
      return r;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
