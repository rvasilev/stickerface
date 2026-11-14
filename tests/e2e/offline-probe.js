// Gate — with the network OFF, the app still starts, still places a sticker, still exports,
// and nothing it needed came from outside its own origin. Requires the harness's
// E2E_PROBE_OFFLINE phase, which reloads and then emulates offline BEFORE evaluating this
// file. That file's source is captured while still online and evaluated from memory, because
// a cache-busted fetch of it cannot work offline by design.
//
// The photo is synthesised in-page (canvas → toBlob → File) because tests/e2e/fixture.jpg is
// a TEST asset and is deliberately not precached: if this probe needed it, it would only be
// testing its own fixture.
//
// The harness clears every cache and unregisters every worker before this runs, then seeds a
// stale 'sf-v0' and a neighbour's 'other-repo-v1' BEFORE the reload that installs the worker.
// That ordering is what makes the cleanup rule testable: activate() runs once, so anything
// created after it is never considered. Without the clear, the browser profile persisting
// between runs means the previous run's cache masks a change to what gets precached.
(async () => {
  const r = { steps: [], errors: [] };
  const log = (k, v) => r.steps.push([k, v]);
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  // Declared false first: a throw below leaves a RED probe, never a missing key that reads
  // as "not tested".
  r.weAreActuallyOffline = false;
  r.workerIsOffline = false;
  r.updateBarHiddenByDefault = false;
  r.appBootedOffline = false;
  r.shellServedByWorker = false;
  r.serviceWorkerControls = false;
  r.emojiCacheComplete = false;
  r.staleCacheCleaned = false;
  r.foreignCacheUntouched = false;
  r.placedStickerOffline = false;
  r.stickerRenderedOffline = false;
  r.exportedOffline = false;

  try {
    const app = window.__stickerface;
    const canvas = document.getElementById('stage-canvas');

    r.weAreActuallyOffline = navigator.onLine === false;
    r.serviceWorkerControls = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    // Precondition, and the one that would have caught the flaw this gate shipped with: does the
    // WORKER have network? Ask it for something deliberately not cached. A worker that can still
    // reach the server answers 404 — a real response; a genuinely offline worker falls into the
    // handler's catch and answers 504. CDP network emulation is per-target and was applied to the
    // page alone, so the worker stayed online, proxied everything to the live server, and the
    // offline test measured nothing at all. Strict on purpose: anything but an explicit 504
    // means the worker's state is unproven.
    try {
      const res = await fetch('./not-cached-' + Date.now(), { cache: 'no-store' });
      r.workerIsOffline = res.status === 504;
    } catch (err) {
      r.workerIsOffline = false;
    }
    log('workerNetwork', { offline: r.workerIsOffline, controlled: r.serviceWorkerControls });
    // A FIRST install must offer no update. Checked by rendered state, not just the attribute:
    // this app once shipped seven elements that were "hidden" and rendered anyway, because an
    // author rule setting `display` outranks the UA's `[hidden] { display: none }`. The bar is
    // hidden and must actually be invisible.
    const bar = document.getElementById('update-bar');
    r.updateBarHiddenByDefault = !!bar && bar.hidden && getComputedStyle(bar).display === 'none';
    log('updateBar', { present: !!bar, hidden: bar ? bar.hidden : null,
      display: bar ? getComputedStyle(bar).display : null });
    // Two separate facts, because they have different causes. This one is "the document in front
    // of us loaded with no network" — real, but satisfiable by Chrome's own caches, so on its
    // own it proves nothing about precaching. The marker guards the other failure: when a reload
    // cannot commit, Chrome keeps the current document, and the probe would then be measuring
    // the ONLINE-loaded page and calling it an offline boot.
    r.appBootedOffline = !window.__sfPreOffline && !!canvas && !!app;
    // The decisive one. `cache: 'no-store'` rules out any browser cache, and the worker
    // intercepts the request, so an ok response means the worker served it from its own
    // CacheStorage — provided the worker is genuinely offline (asserted above).
    try {
      const res = await fetch('./index.html', { cache: 'no-store' });
      r.shellServedByWorker = res.ok;
    } catch (err) {
      r.shellServedByWorker = false;
    }
    log('boot', {
      freshDocument: !window.__sfPreOffline,
      onLine: navigator.onLine,
      controlled: r.serviceWorkerControls,
      canvas: !!canvas,
      app: !!app,
      url: location.pathname,
    });
    log('shellFetch', { servedByWorker: r.shellServedByWorker });

    const names = await caches.keys();
    log('caches', names);
    const mine = names.filter((n) => n.startsWith('sf-'));
    // Both halves of the cleanup rule, and both are observable because the harness seeds them
    // BEFORE this worker's first activation — the only moment activate() can see anything. The
    // stale version of this app must be gone; the neighbouring app's cache must survive, since
    // the origin is shared (user.github.io hosts many repositories) and an unscoped delete
    // wipes a neighbour's offline data. Exactly one app cache also means they do not pile up.
    r.staleCacheCleaned = !names.includes('sf-v0') && mine.length === 1;
    r.foreignCacheUntouched = names.includes('other-repo-v1');

    if (mine.length) {
      // The expected list comes from the worker's own source, which it caches for exactly
      // this purpose. A worker and the page share NO globals, so it cannot hand the list
      // over; sw.js is the single source of truth and tests/sw.test.js asserts that list
      // against the filesystem. Parse the PRECACHE array itself — the fetch handler also
      // mentions './index.html', and a loose whole-file match counts it twice.
      const swText = await (await fetch('./sw.js')).text();
      const expected = [...swText.match(/const PRECACHE = \[([\s\S]*?)\];/)[1]
        .matchAll(/'([^']+)'/g)].map((m) => m[1]);
      const cache = await caches.open(mine[0]);
      const have = new Set((await cache.keys()).map((rq) => new URL(rq.url).pathname));
      const missing = expected.filter((u) => !have.has(new URL(u, location.href).pathname));
      // `expected.length > 80` guards the absent-subject pass: if the parse found nothing,
      // `missing` would be empty and this would go green measuring no cache at all.
      r.emojiCacheComplete = expected.length > 80 && missing.length === 0;
      log('cacheAudit', { expectedCount: expected.length, cachedCount: have.size, missing });
    }

    // A photo, built locally — no fixture, no network.
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 480;
    const cx = c.getContext('2d');
    cx.fillStyle = '#8a6a4a';
    cx.fillRect(0, 0, 640, 480);
    cx.fillStyle = '#e0b090';
    cx.beginPath();
    cx.arc(320, 240, 90, 0, Math.PI * 2);
    cx.fill();
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'offline.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 100 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);
    await sleep(300);

    // Place a sticker. This fetch comes from the CACHE — which is the whole point.
    const rect = canvas.getBoundingClientRect();
    const at = {
      bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse',
      clientX: rect.left + rect.width * 0.5, clientY: rect.top + rect.height * 0.45,
    };
    canvas.dispatchEvent(new PointerEvent('pointerdown', at));
    canvas.dispatchEvent(new PointerEvent('pointerup', at));
    await sleep(400);

    // Two oracles, and the second proves the CACHE works: the store says a sticker exists,
    // and the pixels say its artwork was really drawn from a cached SVG — not inlined. A
    // cached-but-truncated SVG passes the first and fails the second.
    const yellow = (() => {
      const probe = document.createElement('canvas');
      probe.width = canvas.width;
      probe.height = canvas.height;
      const pc = probe.getContext('2d');
      pc.drawImage(canvas, 0, 0);
      const d = pc.getImageData(0, 0, probe.width, probe.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] >= 235 && d[i] <= 255 && d[i + 1] >= 184 && d[i + 1] <= 224 && d[i + 2] >= 57 && d[i + 2] <= 97) n++;
      }
      return n;
    })();
    r.placedStickerOffline = app.store.state.stickers.length > 0;
    r.stickerRenderedOffline = yellow > 100;
    log('offlineSticker', { count: app.store.state.stickers.length, yellow });

    // Export, with the download intercepted exactly as tests/e2e/probe.js does it.
    let downloadName = null;
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { downloadName = this.download; };
    document.getElementById('btn-export-png').click();
    await sleep(1500);
    HTMLAnchorElement.prototype.click = realClick;
    r.exportedOffline = !!downloadName;
    log('exportDownload', downloadName);
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
