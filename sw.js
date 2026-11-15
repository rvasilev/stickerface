// The app's offline cache. Scope and cleanup both follow this file's own location: GitHub Pages
// cannot send Service-Worker-Allowed, and its origins host many repositories, so a worker must
// never reach past its own directory or delete a cache it does not own.
//
// The constants must precede PRECACHE: touching it earlier throws a TDZ ReferenceError during
// install, whose only symptom is a worker that never activates.
const CACHE_PREFIX = 'sf-';   // every cache this app owns starts with this
// GENERATED, not chosen: the name is a hash of the bytes of everything in PRECACHE, so that
// changing any shipped file necessarily changes THIS FILE's bytes. The browser installs a new
// worker only when the script's content differs, so an edit by hand here — or a release that
// forgets to re-stamp — is a release that reaches nobody: no updatefound, no prompt, no error.
// Re-stamp with `npm run release`; `tests/sw.test.js` recomputes it and fails if it is stale.
// activation deletes the older sf- caches this name replaces.
const CACHE = 'sf-19ff7412f3cd';

const PRECACHE = [
  // Every file the app serves, so one list answers "what works offline".
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
  // Every emoji the picker can fetch. A missing entry is a face that cannot be hidden offline,
  // and `addAll` fails the whole install if one of them does not exist.
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
  // Everything, at install: the picker fetches emoji on demand, so cache-on-first-use would
  // leave a fresh install broken offline for any face never picked while online. No
  // skipWaiting(): an update waits to be asked for, so a running page is never taken over.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // `cache: 'reload'` on every entry: addAll() otherwise fetches THROUGH the HTTP cache, and
    // GitHub Pages sends max-age=600 on everything it serves. Inside that window a fresh
    // install would fill the new cache with the previous release's bytes — a multi-version
    // install that reports success.
    await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
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
    // Take control of the page that just registered us, so the next navigation is served from
    // cache without needing its own reload.
    await self.clients.claim();
  })());
});

// The update bar posts this on the user's click — the only moment a new version may take over.
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

  // A navigation gets the cached shell, so a cold offline start works.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match('./index.html')) || fetch(request);
    })());
    return;
  }

  // Cache-first, then network. Only PRECACHE is ever stored, so a miss means the request was not
  // meant to work offline — a runtime cache.put would blur that line.
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
