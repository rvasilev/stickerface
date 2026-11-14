// Service worker: the app's offline promise, and nothing else.
//
// Scope, deliberately: this file sits at the app root, so its default scope is the whole app.
// On GitHub Pages that is /stickerface/, and `Service-Worker-Allowed` cannot be sent there —
// correctly, because user.github.io hosts other people's repositories.
//
// Cache cleanup is scoped to CACHE_PREFIX for the same reason: activate() runs on an origin
// shared with other apps, and a worker that deletes "every cache I do not recognise" wipes a
// neighbour. The offline gate seeds a fake neighbour's cache to prove this filter holds.
//
// ORDER MATTERS: the constants come first. A worker that touches PRECACHE before its
// declaration throws a TDZ ReferenceError during install, and the only symptom is "the
// service worker never activates".
//
// A worker and the page share NO globals — `window` does not exist in here — so the offline
// gate learns what it needs from two sources of truth that do exist: the cache names in
// `caches.keys()`, and this file's own list, parsed out of the served sw.js. That is why
// './sw.js' appears in its own precache list: it is what the gate reads, offline.
const CACHE_PREFIX = 'sf-';   // every cache this app owns starts with this
const CACHE = 'sf-v1';        // bump on release: activate() deletes older sf- caches

const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './sw.js',
  './css/style.css',
  './js/ui.js',
  './js/pwa.js',
  './js/emoji.js',
  './js/store.js',
  './js/render.js',
  './js/export.js',
  './js/geometry.js',
  './js/pointer-tracker.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/apple-touch-icon.png',
  // Every emoji the picker can fetch. tests/sw.test.js diffs this list against the filesystem,
  // so a 77th emoji cannot be added without this list noticing — and `addAll` would fail
  // install outright if an entry here went missing.
  './assets/emoji/1f3ad.svg', './assets/emoji/1f416.svg', './assets/emoji/1f428.svg', './assets/emoji/1f42d.svg', './assets/emoji/1f42e.svg', './assets/emoji/1f42f.svg', './assets/emoji/1f430.svg', './assets/emoji/1f431.svg',
  './assets/emoji/1f435.svg', './assets/emoji/1f436.svg', './assets/emoji/1f437.svg', './assets/emoji/1f438.svg', './assets/emoji/1f439.svg', './assets/emoji/1f43c.svg', './assets/emoji/1f453.svg', './assets/emoji/1f479.svg',
  './assets/emoji/1f47a.svg', './assets/emoji/1f47b.svg', './assets/emoji/1f47d.svg', './assets/emoji/1f480.svg', './assets/emoji/1f576.svg', './assets/emoji/1f600.svg', './assets/emoji/1f601.svg', './assets/emoji/1f602.svg',
  './assets/emoji/1f603.svg', './assets/emoji/1f604.svg', './assets/emoji/1f605.svg', './assets/emoji/1f606.svg', './assets/emoji/1f609.svg', './assets/emoji/1f60a.svg', './assets/emoji/1f60b.svg', './assets/emoji/1f60c.svg',
  './assets/emoji/1f60d.svg', './assets/emoji/1f60f.svg', './assets/emoji/1f610.svg', './assets/emoji/1f611.svg', './assets/emoji/1f612.svg', './assets/emoji/1f61b.svg', './assets/emoji/1f61d.svg', './assets/emoji/1f62c.svg',
  './assets/emoji/1f634.svg', './assets/emoji/1f636.svg', './assets/emoji/1f637.svg', './assets/emoji/1f638.svg', './assets/emoji/1f63a.svg', './assets/emoji/1f63b.svg', './assets/emoji/1f642.svg', './assets/emoji/1f643.svg',
  './assets/emoji/1f644.svg', './assets/emoji/1f911.svg', './assets/emoji/1f912.svg', './assets/emoji/1f914.svg', './assets/emoji/1f915.svg', './assets/emoji/1f916.svg', './assets/emoji/1f920.svg', './assets/emoji/1f921.svg',
  './assets/emoji/1f922.svg', './assets/emoji/1f923.svg', './assets/emoji/1f925.svg', './assets/emoji/1f927.svg', './assets/emoji/1f928.svg', './assets/emoji/1f929.svg', './assets/emoji/1f92a.svg', './assets/emoji/1f92e.svg',
  './assets/emoji/1f92f.svg', './assets/emoji/1f970.svg', './assets/emoji/1f971.svg', './assets/emoji/1f973.svg', './assets/emoji/1f974.svg', './assets/emoji/1f975.svg', './assets/emoji/1f976.svg', './assets/emoji/1f978.svg',
  './assets/emoji/1f981.svg', './assets/emoji/1f98a.svg', './assets/emoji/2b1b.svg', './assets/emoji/2b1c.svg',
];

self.addEventListener('install', (event) => {
  // Precache EVERYTHING at install. The picker fetches emoji on demand, so a
  // cache-on-first-use strategy leaves a fresh install broken offline for any face the user
  // never happened to pick while online — which is the whole failure this feature exists to
  // prevent.
  //
  // NO skipWaiting() here: an update waits until the page asks for it (see the message
  // handler). Taking over under a running page would make the update bar's promise — that
  // nothing is lost until you click — a lie.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(PRECACHE);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE)
        .map((name) => caches.delete(name)),
    );
    // Take control of the page that just registered us, so the very next navigation is
    // served from cache without needing its own reload.
    await self.clients.claim();
  })());
});

// The update bar asks for this on the user's click, which is the only moment a new version
// may take over.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const scope = self.registration.scope;
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(new URL(scope).pathname)) return;

  // Navigations: the cached shell, so a cold offline start works.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match('./index.html')) || fetch(request);
    })());
    return;
  }

  // Everything else in scope: cache-first, then network.
  //
  // Deliberately NO cache.put() on a miss: the cache holds exactly PRECACHE, so "what works
  // offline" and "the precache list" are the same set, and the list is therefore falsifiable.
  // Runtime caching defeats that — the harness's own online reload cached './index.html' even
  // when it had been removed from the list, so the offline gate could not tell a complete
  // precache list from an incomplete one. Watched by mutation; see docs/VERIFICATION.md.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(request);
    if (hit) return hit;
    try {
      return await fetch(request);
    } catch (err) {
      return new Response('', { status: 504, statusText: 'offline' });
    }
  })());
});
