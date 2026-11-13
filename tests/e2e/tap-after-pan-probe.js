// Diagnostic: does a one-finger tap still place a sticker AFTER a two-finger pan?
// Requires E2E_MOBILE=1. Not a gate - it localises the touch-path regression.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);
  const canvas = document.getElementById('stage-canvas');

  const count = () => {
    const rect = canvas.getBoundingClientRect();
    const p = document.createElement('canvas');
    p.width = canvas.width; p.height = canvas.height;
    const c = p.getContext('2d');
    c.drawImage(canvas, 0, 0);
    const d = c.getImageData(0, 0, p.width, p.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] >= 235 && d[i] <= 255 && d[i + 1] >= 184 && d[i + 1] <= 224 && d[i + 2] >= 57 && d[i + 2] <= 97) n++;
    }
    const app = window.__stickerface;
    return {
      yellowPixels: n,
      layers: document.getElementById('layer-list').children.length,
      selectionVisible: !document.getElementById('select-box').hidden,
      canvasing: canvas.dataset.panning === '1',
      pointers: canvas.dataset.pointers === undefined ? null : Number(canvas.dataset.pointers),
      tapState: app?._tap ? { x: Math.round(app._tap.x), y: Math.round(app._tap.y), cancelled: app._tap.cancelled } : null,
      lastTap: app?._lastTap ? { x: Math.round(app._lastTap.x), y: Math.round(app._lastTap.y) } : null,
      view: app?.view ? { dx: Math.round(app.view.dx), dy: Math.round(app.view.dy) } : null,
      stickers: (app?.store?.state?.stickers ?? []).map((s) => [s.id, Math.round(s.cx * app.image.naturalWidth), Math.round(s.cy * app.image.naturalHeight)]),
    };
  };

  try {
    const blob = await (await fetch('tests/e2e/fixture.jpg?cb=' + Date.now(), { cache: 'no-store' })).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'fixture.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 100 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);

    const rect = canvas.getBoundingClientRect();
    const P = (fx, fy) => [rect.left + rect.width * fx, rect.top + rect.height * fy];
    // Screen point for a NATURAL image point, using the app's own projection
    // (natural -> backing px -> CSS px, plus the current pan).
    const screenForNatural = (nx, ny) => {
      const app = window.__stickerface;
      const k = rect.width / canvas.width;
      return [rect.left + nx * app.scale * k + app.view.dx,
              rect.top + ny * app.scale * k + app.view.dy];
    };
    const naturalForScreen = (sx, sy) => {
      const app = window.__stickerface;
      const k = rect.width / canvas.width;
      return { x: (sx - rect.left - app.view.dx) / (k * app.scale),
               y: (sy - rect.top - app.view.dy) / (k * app.scale) };
    };
    // Pick the emptiest ON-SCREEN spot: a grid search in screen space, scoring
    // each candidate by its distance from every sticker centre in image space.
    // Searching in screen space matters — after a pan, a natural point can map
    // outside the canvas, and a tap there never reaches the canvas at all.
    const freeSpot = () => {
      const app = window.__stickerface;
      const W = app.image.naturalWidth;
      const H = app.image.naturalHeight;
      const spots = app.store.state.stickers;
      let best = null;
      for (let fx = 0.07; fx <= 0.94; fx += 0.055) {
        for (let fy = 0.1; fy <= 0.92; fy += 0.08) {
          const sx = rect.left + rect.width * fx;
          const sy = rect.top + rect.height * fy;
          const nat = naturalForScreen(sx, sy);
          const dmin = spots.length
            ? Math.min(...spots.map((s) => Math.hypot(nat.x - s.cx * W, nat.y - s.cy * H)))
            : Infinity;
          if (!best || dmin > best.d) best = { d: dmin, screen: [sx, sy] };
        }
      }
      return { screen: best.screen, clearance: best.d };
    };
    const A = P(0.3, 0.35), B = P(0.75, 0.7), C = P(0.2, 0.8), D = P(0.55, 0.2);

    window.__sfSnaps = {};
    window.__sfSnap = (name) => { window.__sfSnaps[name] = count(); return true; };
    // Called by the driver at dispatch time (see the tapPagePoint step).
    window.__sfFreeSpot = () => {
      const spot = freeSpot();
      window.__sfLastClearance = spot.clearance;
      window.__sfLastSpot = spot.screen.map((v) => Math.round(v));
      return spot.screen;
    };

    const tap = (pt) => [
      { t: 'touchStart', pts: [pt], ms: 70 },
      { t: 'touchEnd', pts: [], ms: 200 },
      // Consecutive taps inside the 350ms double-tap window ARE a double-tap
      // (they delete). Space standalone taps beyond it.
      { t: 'settle', ms: 400 },
    ];
    const pan = (a, b) => {
      const out = [{ t: 'touchStart', pts: [a, b], ms: 90 }];
      for (let i = 1; i <= 6; i++) {
        out.push({ t: 'touchMove', pts: [[a[0] + i * 8, a[1] + i * 6], [b[0] + i * 8, b[1] + i * 6]], ms: 45 });
      }
      out.push({ t: 'touchEnd', pts: [], ms: 300 });
      return out;
    };

    window.__sfNextInput = [
      { t: 'read', name: 't0' },
      ...tap(C), { t: 'read', name: 'tap1' },
      ...tap(D), { t: 'read', name: 'tap2' },
      ...pan(P(0.5, 0.6), P(0.7, 0.8)), { t: 'read', name: 'pan' },
      // second finger lands mid-drag -> the drag must be cancelled; then a plain
      // tap must still place a sticker (this is the mobile-probe sequence).
      { t: 'touchStart', pts: [C], ms: 90 },
      { t: 'touchMove', pts: [[C[0] + 20, C[1] + 20]], ms: 60 },
      { t: 'touchMove', pts: [[C[0] + 40, C[1] + 40]], ms: 60 },
      { t: 'touchStart', pts: [C, [C[0] + 70, C[1] + 50]], ms: 90 },
      { t: 'touchMove', pts: [[C[0] + 40, C[1] + 40], [C[0] + 110, C[1] + 90]], ms: 60 },
      { t: 'touchEnd', pts: [], ms: 300 },
      { t: 'read', name: 'interrupt' },
      // Two taps after the pan + cancel. Their points are computed by the page at
      // dispatch time from the CURRENT pan, so the tap cannot land on a sticker
      // that drifted under a hardcoded coordinate.
      { t: 'tapPagePoint', fn: 'window.__sfFreeSpot()', ms: 420 },
      { t: 'read', name: 'tapAfterInterrupt' },
      { t: 'tapPagePoint', fn: 'window.__sfFreeSpot()', ms: 420 },
      { t: 'read', name: 'tapAfterInterrupt2' },
    ];

    window.__sfReadTouch = () => {
      const s = window.__sfSnaps;
      const out = { steps: [] };
      out.tapBeforePanPlaces = !!s.tap1 && s.tap1.layers === 1;
      out.secondTapBeforePanPlaces = !!s.tap2 && s.tap2.layers === 2;
      out.twoFingerPanWorks = !!s.pan && s.pan.layers === (s.tap2 && s.tap2.layers);
      out.tapAfterPanPlaces = !!s.tapAfterInterrupt && !!s.pan && s.tapAfterInterrupt.layers === s.pan.layers + 1;
      out.tapAfterPanPlacesAgain = !!s.tapAfterInterrupt2 && !!s.tapAfterInterrupt &&
        s.tapAfterInterrupt2.layers === s.tapAfterInterrupt.layers + 1;
      out.dragCancelledBySecondFinger = !!s.interrupt && !!s.pan && s.interrupt.layers === s.pan.layers;
      // The taps after the pan must have been aimed at a genuinely empty spot:
      // a sticker is 216 natural px wide, so require real clearance, else the
      // criterion would be measuring "the tap hit a sticker" (which correctly
      // selects instead of placing).
      out.freeSpotHadClearance = (window.__sfLastClearance ?? 0) > 150;
      out.steps.push(['freeSpot', [window.__sfLastSpot, window.__sfLastClearance,
        { rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
          scale: window.__stickerface?.scale, view: window.__stickerface?.view,
          canvas: [canvas.width, canvas.height] }]]);
      // The app must expose the live pointer count as canvas.dataset.pointers so a
      // leak is measurable: after EVERY gesture ends, zero contacts may remain
      // tracked. A stale entry makes the next one-finger tap look like a
      // two-finger pan, which silently kills tap-to-place.
      const clean = ['tap1', 'tap2', 'pan', 'interrupt', 'tapAfterInterrupt', 'tapAfterInterrupt2'];
      out.pointersCleanAfterGestures = clean.every((k) => s[k] && s[k].pointers === 0);
      out.steps.push(['pointerCounts', clean.map((k) => [k, s[k] && s[k].pointers])]);
      for (const k of ['t0', 'tap1', 'tap2', 'pan', 'interrupt', 'tapAfterInterrupt', 'tapAfterInterrupt2']) out.steps.push([k, s[k]]);
      return JSON.stringify(out);
    };
    log('armed', true);
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
