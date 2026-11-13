// Gate: desktop wheel-zoom and middle-button pan.
//
// One transition function, three input adapters. `focalZoomView` already says
// "distances unchanged reduces to a plain pan", so the mouse must not get its own
// pan/zoom maths — that is how the mouse view silently drifts from the touch one.
//
// Oracles, and why:
//   * `wheelZoomsIn` reads BOTH the selection frame's width (DOM, never clipped,
//     projected through the same view) and the fixture's red block on the CANVAS
//     (a view-only assertion would pass a build that repaints wrongly).
//   * `wheelZoomsAboutCursor` puts the wheel ON the red block's centre: exact
//     focal invariance means that point does not move, and everything around it
//     grows.
//   * `middleDragPans` proves the DRAWN image moved, not just `view.dx`.
//   * `middleDragClampsPan` measures how much of the canvas still paints the
//     photo, which is what "at least 25% of the scaled image stays visible"
//     actually means on screen.
//   * `ctrlWheelZoomsToo` also asserts the BROWSER did not zoom
//     (`visualViewport.scale` unchanged) — a ctrl-wheel that zooms the page
//     instead of the canvas would otherwise look like a pass.
//
// Every criterion is declared FALSE up front: a phase that never runs must leave
// its criterion failing rather than absent.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);
  const canvas = document.getElementById('stage-canvas');

  r.wheelZoomsIn = false;
  r.ctrlWheelZoomsToo = false;
  r.wheelZoomsAboutCursor = false;
  r.middleDragPans = false;
  r.middleDragDoesNotSelect = false;
  r.middleDragClampsPan = false;
  r.middleDragCleansUp = false;
  r.frameTracksWheelZoom = false;
  r.wheelDoesNotScrollPage = false;
  r.wheelZoomDoesNotHitExport = false;

  const measure = () => {
    const rect = canvas.getBoundingClientRect();
    const p = document.createElement('canvas');
    p.width = canvas.width; p.height = canvas.height;
    const c = p.getContext('2d');
    c.drawImage(canvas, 0, 0);
    const d = c.getImageData(0, 0, p.width, p.height).data;
    let painted = 0, rn = 0, rminX = 1e9, rmaxX = -1, rminY = 1e9, rmaxY = -1;
    for (let y = 0; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        const i = (y * p.width + x) * 4;
        if (d[i + 3] > 0) painted++;
        // The fixture's red corner block: a stable IMAGE feature, so it is the
        // honest witness for "the drawn image moved / grew".
        if (d[i] > 200 && d[i + 1] < 80 && d[i + 2] < 80) {
          rn++;
          if (x < rminX) rminX = x; if (x > rmaxX) rmaxX = x;
          if (y < rminY) rminY = y; if (y > rmaxY) rmaxY = y;
        }
      }
    }
    const sx = rect.width / canvas.width, sy = rect.height / canvas.height;
    const fb = document.getElementById('select-box').getBoundingClientRect();
    const app = window.__stickerface;
    return {
      redPixels: rn,
      redCentre: rmaxX >= 0
        ? [rect.left + ((rminX + rmaxX) / 2) * sx, rect.top + ((rminY + rmaxY) / 2) * sy] : null,
      painted, coverage: painted / (p.width * p.height),
      frameW: fb.width, frameH: fb.height,
      frameCentre: [fb.left + fb.width / 2, fb.top + fb.height / 2],
      viewScale: app.view.scale, viewDx: app.view.dx, viewDy: app.view.dy,
      pointers: canvas.dataset.pointers === undefined ? null : Number(canvas.dataset.pointers),
      panning: canvas.dataset.panning || null,
      scrollY: window.scrollY,
      visualScale: window.visualViewport ? window.visualViewport.scale : null,
      layers: document.getElementById('layer-list').children.length,
      selection: app.store.state.selection,
    };
  };

  // Export the current state through the app's own button and return the
  // sticker's NORMALIZED centre in the exported, full-resolution image. Same
  // approach as zoom-probe.js: the export must not care about the view.
  const exportNormalizedStickerCentre = async () => {
    const realCreate = URL.createObjectURL;
    let captured = null;
    URL.createObjectURL = (blob) => { captured = blob; return realCreate.call(URL, blob); };
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    try {
      document.getElementById('btn-export-png').click();
      for (let i = 0; i < 80 && !captured; i++) await sleep(60);
    } finally {
      URL.createObjectURL = realCreate;
      HTMLAnchorElement.prototype.click = realClick;
    }
    if (!captured) return null;
    const bmp = await createImageBitmap(captured);
    const p = document.createElement('canvas');
    p.width = bmp.width; p.height = bmp.height;
    const c = p.getContext('2d');
    c.drawImage(bmp, 0, 0);
    const d = c.getImageData(0, 0, p.width, p.height).data;
    let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = 0; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        const i = (y * p.width + x) * 4;
        if (d[i] >= 235 && d[i] <= 255 && d[i + 1] >= 184 && d[i + 1] <= 224 && d[i + 2] >= 57 && d[i + 2] <= 97) {
          n++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    return {
      w: bmp.width, h: bmp.height, stickerPixels: n,
      nx: maxX >= 0 ? (minX + maxX) / 2 / bmp.width : null,
      ny: maxY >= 0 ? (minY + maxY) / 2 / bmp.height : null,
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
    await sleep(300);

    // One sticker, placed and selected through the app's own pointer path.
    const rect0 = canvas.getBoundingClientRect();
    const at = (fx, fy) => ({
      clientX: rect0.left + rect0.width * fx, clientY: rect0.top + rect0.height * fy,
    });
    const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', ...at(0.42, 0.4) };
    canvas.dispatchEvent(new PointerEvent('pointerdown', o));
    canvas.dispatchEvent(new PointerEvent('pointerup', o));
    await sleep(300);

    const m0 = measure();
    log('m0', { redCentre: m0.redCentre, redPixels: m0.redPixels, frameW: m0.frameW, scale: m0.viewScale, coverage: m0.coverage });
    r.exportBefore = await exportNormalizedStickerCentre();
    log('exportBefore', r.exportBefore);

    if (!m0.redCentre) throw new Error('the fixture has no red block to anchor the wheel on');
    const RED = m0.redCentre;

    // Whether the app suppressed the wheel's default. `scrollY` alone is a weak
    // witness — at this viewport the page may have nothing to scroll, so the
    // assertion would hold even with no preventDefault at all (measured: it did).
    // A listener registered AFTER the app's sees `defaultPrevented` set by the
    // app's own handler, which is the mechanism that actually protects the page
    // wherever there IS a scroll to steal.
    let wheelSeen = 0, wheelPrevented = 0;
    canvas.addEventListener('wheel', (ev) => {
      wheelSeen++;
      if (ev.defaultPrevented) wheelPrevented++;
    }, { passive: true });
    const scrollable = document.documentElement.scrollHeight > window.innerHeight;

    // Live points for the middle drags, so the drag starts on the canvas whatever
    // the scroll position is by then.
    window.__sfPanFrom = () => {
      const b = canvas.getBoundingClientRect();
      const p = [b.left + b.width / 2, b.top + b.height / 2];
      return [p[0], p[1]];
    };
    window.__sfPanTo = (dx, dy) => {
      const b = canvas.getBoundingClientRect();
      // Deliberately allowed to leave the viewport: the app captures the pointer,
      // so moves outside the canvas still arrive — and a drag that never leaves
      // the canvas cannot demand more than the clamp allows.
      return [b.left + b.width / 2 + dx, b.top + b.height / 2 + dy];
    };

    window.__sfSnaps = {};
    window.__sfSnap = (name) => { window.__sfSnaps[name] = measure(); return true; };

    window.__sfNextInput = [
      { t: 'read', name: 't0' },
      // 1) plain wheel, ON the red block: the image grows about that point
      { t: 'wheel', pts: [[RED[0], RED[1]]], deltaY: -120, ms: 250 },
      { t: 'read', name: 'afterWheel' },
      // 2) ctrl+wheel = the trackpad-pinch path. Zooms the canvas, NOT the page.
      //    Anchored on the same feature as (1) so the block stays in view for the
      //    pan measurements — the cursor's position is irrelevant to what this
      //    step asserts.
      { t: 'wheel', pts: [[RED[0], RED[1]]], deltaY: -120, modifiers: 2, ms: 250 },
      { t: 'read', name: 'afterCtrlWheel' },
      // 3) middle-drag pan. SMALL on purpose: the claim being tested is the
      //    "distances unchanged reduces to a plain pan" identity, which only holds
      //    1:1 while the clamp is not biting. The huge drag below tests the clamp.
      { t: 'drag', fns: ['window.__sfPanFrom()', 'window.__sfPanTo(60, 40)'], steps: 8, button: 'middle', ms: 400 },
      { t: 'read', name: 'afterPan' },
      // 4) a drag far past the clamp must stop at the clamp, not run away
      { t: 'drag', fns: ['window.__sfPanFrom()', 'window.__sfPanTo(-900, -700)'], steps: 6, button: 'middle', ms: 400 },
      { t: 'read', name: 'afterHugePan' },
    ];

    window.__sfReadTouch = () => {
      const s = window.__sfSnaps || {};
      const t0 = s.t0, w = s.afterWheel, c = s.afterCtrlWheel, pan = s.afterPan, huge = s.afterHugePan;
      const out = { steps: [] };
      const frameR = t0 && w && t0.frameW > 0 ? w.frameW / t0.frameW : null;
      const scaleR = t0 && w && t0.viewScale > 0 ? w.viewScale / t0.viewScale : null;
      const dist = (s2, p) => (s2 && s2.redCentre && p) ? Math.hypot(s2.redCentre[0] - p[0], s2.redCentre[1] - p[1]) : null;

      out.wheelZoomsIn = !!(t0 && w && scaleR > 1.05 && frameR > 1.05 && w.redPixels > t0.redPixels);
      out.steps.push(['wheelZoom', { scaleR, frameR, redPixels: [t0 && t0.redPixels, w && w.redPixels] }]);

      out.ctrlWheelZoomsToo = !!(w && c && c.viewScale > w.viewScale
        && c.visualScale === t0.visualScale && c.frameW > w.frameW);
      out.steps.push(['ctrlWheel', {
        scale: [w && w.viewScale, c && c.viewScale],
        visualScale: [t0 && t0.visualScale, c && c.visualScale],
      }]);

      // Exact focal invariance: a point under the cursor does not move. The
      // tolerance is the MEASUREMENT's, not the maths': the anchor is the red
      // block's bounding-box centre read at canvas resolution, so its anti-aliased
      // edges quantise to ~3 CSS px of drift (measured 3.2). A zoom that was not
      // focal would move it by ~0.2 x its distance to the canvas centre — ~49px
      // here — so 8px separates the two cleanly and is falsifiable either way.
      const d0 = dist(t0, RED), d1 = dist(w, RED);
      out.wheelZoomsAboutCursor = !!(d0 !== null && d1 !== null && scaleR > 1.05
        && d0 >= 0 && d1 <= 8);
      out.steps.push(['focal', { cursor: RED.map((v) => Math.round(v)), dBefore: d0, dAfter: d1 }]);

      // Both sides measured from the snapshot taken JUST BEFORE the drag
      // (`afterCtrlWheel`): comparing against `t0` folds the two wheel zooms into
      // the "pan" and the numbers stop meaning anything (measured: the view delta
      // read -34 where the drag was +60).
      // Null-safe: a wheel can carry the anchor feature off the canvas, and a
      // reader that throws turns every criterion false instead of explaining which
      // measurement was missing (it did exactly that once).
      const rel = (a, b) => (a && b && a.redCentre && b.redCentre)
        ? [a.redCentre[0] - b.redCentre[0], a.redCentre[1] - b.redCentre[1]] : null;
      const mv = rel(pan, c);
      out.middleDragPans = !!(mv && mv[0] > 40 && mv[1] > 25
        && Math.abs((pan.viewDx - c.viewDx) - mv[0]) < 6
        && Math.abs((pan.viewDy - c.viewDy) - mv[1]) < 6);
      out.steps.push(['pan', {
        redMoved: mv,
        viewDelta: pan && c ? [pan.viewDx - c.viewDx, pan.viewDy - c.viewDy] : null,
      }]);

      // Negative criteria carry a POSITIVE precondition: with no drag to observe,
      // "it did not select" and "it cleaned up" are vacuously true and prove
      // nothing. They must fail while the gesture is unimplemented.
      const dragged = !!(mv && (Math.abs(mv[0]) > 1 || Math.abs(mv[1]) > 1));

      out.middleDragDoesNotSelect = !!(t0 && pan && huge && dragged
        && pan.selection === t0.selection && huge.selection === t0.selection
        && pan.layers === t0.layers && huge.layers === t0.layers);
      out.steps.push(['panSelection', {
        selection: [t0 && t0.selection, pan && pan.selection, huge && huge.selection],
        layers: [t0 && t0.layers, pan && pan.layers, huge && huge.layers],
      }]);

      // The clamp, measured as what is still on screen: the drag demands far more
      // than the clamp allows, so the photo must still cover the canvas.
      out.middleDragClampsPan = !!(pan && huge
        && (huge.viewDx !== pan.viewDx || huge.viewDy !== pan.viewDy)
        && huge.coverage >= 0.2);
      out.steps.push(['panClamp', {
        coverage: [t0 && t0.coverage, huge && huge.coverage],
        view: huge && [huge.viewDx, huge.viewDy],
      }]);

      out.middleDragCleansUp = !!(pan && huge && dragged
        && pan.pointers === 0 && huge.pointers === 0
        && pan.panning === null && huge.panning === null);
      out.steps.push(['panCleanup', {
        pointers: [pan && pan.pointers, huge && huge.pointers],
        panning: [pan && pan.panning, huge && huge.panning],
      }]);

      out.frameTracksWheelZoom = !!(t0 && w && frameR && scaleR
        && frameR > 1.05 && Math.abs(frameR - scaleR) / scaleR < 0.1);
      out.steps.push(['frameTracks', { frameR, scaleR }]);

      // ...and the wheel must actually have zoomed, or "the page did not scroll"
      // passes for a listener that is simply absent.
      out.wheelDoesNotScrollPage = !!(t0 && w && c && scaleR > 1.05
        && w.scrollY === t0.scrollY && c.scrollY === t0.scrollY
        && wheelSeen >= 2 && wheelPrevented === wheelSeen);
      out.steps.push(['pageScroll', {
        scrollY: [t0 && t0.scrollY, w && w.scrollY, c && c.scrollY],
        wheelSeen, wheelPrevented, pageScrollable: scrollable,
      }]);

      const before = r.exportBefore, after = r.exportAfter;
      out.wheelZoomDoesNotHitExport = !!(before && after && scaleR > 1.05
        && after.w === before.w && after.h === before.h
        && Math.abs(after.nx - before.nx) < 0.01 && Math.abs(after.ny - before.ny) < 0.01);
      out.steps.push(['export', { before, after }]);
      return JSON.stringify(out);
    };

    log('armed', { steps: window.__sfNextInput.length, criteria: 10 });

    window.__sfFinishZoom = async () => {
      r.exportAfter = await exportNormalizedStickerCentre();
      return true;
    };
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
