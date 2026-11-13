// Diagnostic (NOT a gate): reproduce the tap-after-pan sequence and dump the
// app's own tap/pointer bookkeeping around each tap. Requires E2E_MOBILE=1.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);
  const canvas = document.getElementById('stage-canvas');

  const state = () => {
    const app = window.__stickerface;
    const p = document.createElement('canvas');
    p.width = canvas.width; p.height = canvas.height;
    const c = p.getContext('2d');
    c.drawImage(canvas, 0, 0);
    const d = c.getImageData(0, 0, p.width, p.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] >= 235 && d[i] <= 255 && d[i + 1] >= 184 && d[i + 1] <= 224 && d[i + 2] >= 57 && d[i + 2] <= 97) n++;
    }
    return {
      yellowPixels: n,
      layers: document.getElementById('layer-list').children.length,
      storeCount: app?.store?.state?.stickers?.length ?? null,
      tap: app?._tap ? { x: Math.round(app._tap.x), y: Math.round(app._tap.y), cancelled: app._tap.cancelled } : null,
      lastTap: app?._lastTap ? { x: Math.round(app._lastTap.x), y: Math.round(app._lastTap.y) } : null,
      drag: app?.drag ? app.drag.mode : null,
      pointers: canvas.dataset.pointers,
      view: app?.view ? { dx: Math.round(app.view.dx), dy: Math.round(app.view.dy), scale: app.view.scale } : null,
      stickers: (app?.store?.state?.stickers ?? []).map((s) => [
        s.id, Math.round(s.cx * app.image.naturalWidth), Math.round(s.cy * app.image.naturalHeight),
      ]),
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
    const C = P(0.2, 0.8), D = P(0.75, 0.7), Q1 = P(0.25, 0.5), Q2 = P(0.85, 0.5);

    const tapAt = (pt) => [
      { t: 'touchStart', pts: [pt], ms: 70 },
      { t: 'touchEnd', pts: [], ms: 200 },
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

    window.__sfSnaps = {};
    window.__sfSnap = (name) => { window.__sfSnaps[name] = state(); return true; };

    window.__sfNextInput = [
      { t: 'read', name: 't0' },
      ...tapAt(C), { t: 'read', name: 'tapC' },
      ...tapAt(D), { t: 'read', name: 'tapD' },
      ...pan(P(0.5, 0.6), P(0.7, 0.8)), { t: 'read', name: 'pan' },
      // second finger mid-drag (the interrupt phase)
      { t: 'touchStart', pts: [C], ms: 90 },
      { t: 'touchMove', pts: [[C[0] + 20, C[1] + 20]], ms: 60 },
      { t: 'touchMove', pts: [[C[0] + 40, C[1] + 40]], ms: 60 },
      { t: 'touchStart', pts: [C, [C[0] + 70, C[1] + 50]], ms: 90 },
      { t: 'touchMove', pts: [[C[0] + 40, C[1] + 40], [C[0] + 110, C[1] + 90]], ms: 60 },
      { t: 'touchEnd', pts: [], ms: 300 },
      { t: 'read', name: 'interrupt' },
      ...tapAt(Q1), { t: 'read', name: 'tapQ1' },
      ...tapAt(Q2), { t: 'read', name: 'tapQ2' },
      ...tapAt(Q1), { t: 'read', name: 'tapQ1b' },
    ];

    window.__sfReadTouch = () => {
      const out = { steps: [] };
      for (const k of ['t0', 'tapC', 'tapD', 'pan', 'interrupt', 'tapQ1', 'tapQ2', 'tapQ1b']) {
        out.steps.push([k, window.__sfSnaps[k]]);
      }
      out.diagnosticOnly = true;
      return JSON.stringify(out);
    };
    log('armed', true);
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
