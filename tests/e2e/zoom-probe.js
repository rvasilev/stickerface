// Two-finger image pinch-zoom probe (M7). Requires E2E_MOBILE=1.
//
// Product rule: two fingers whose centroid is OUTSIDE the selected sticker's frame
// pan AND pinch-zoom the PHOTO (focal-point zoom about the gesture centroid,
// clamped). Zoom is view-only: it must never change sticker geometry, the undo
// stack, or the exported file.
//
// Oracles (canvas pixels / the exported blob, never the app's own geometry):
//   zoom ratio        -> the sticker's on-screen width (it rides the image)
//   focal invariance  -> distance from the gesture centroid to the sticker centre
//                        must scale by the same ratio (zoom about the centroid,
//                        not about the canvas corner)
//   image            -> the fixture's red corner block (position)
//   export           -> the exported PNG is decoded and the sticker's NORMALIZED
//                        centre is compared with the pre-zoom export
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);
  const canvas = document.getElementById('stage-canvas');

  const measure = () => {
    const rect = canvas.getBoundingClientRect();
    const p = document.createElement('canvas');
    p.width = canvas.width; p.height = canvas.height;
    const c = p.getContext('2d');
    c.drawImage(canvas, 0, 0);
    const d = c.getImageData(0, 0, p.width, p.height).data;
    let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    let rn = 0, rw = 0, rminX = 1e9, rmaxX = -1, rminY = 1e9;
    for (let y = 0; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        const i = (y * p.width + x) * 4;
        const R = d[i], G = d[i + 1], B = d[i + 2];
        if (R > 200 && G < 80 && B < 80) { rn++; if (x < rminX) rminX = x; if (x > rmaxX) rmaxX = x; if (y < rminY) rminY = y; }
        else if (R >= 235 && R <= 255 && G >= 184 && G <= 224 && B >= 57 && B <= 97) {
          n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    const sx = rect.width / canvas.width, sy = rect.height / canvas.height;
    const box = document.getElementById('select-box').getBoundingClientRect();
    return {
      yellowPixels: n,
      yellowW: maxX >= 0 ? (maxX - minX + 1) * sx : 0,
      yellowH: maxY >= 0 ? (maxY - minY + 1) * sy : 0,
      stickerCentre: maxX >= 0
        ? [rect.left + ((minX + maxX) / 2) * sx, rect.top + ((minY + maxY) / 2) * sy] : null,
      redLeft: rmaxX >= 0 ? rect.left + rminX * sx : null,
      redTop: rmaxX >= 0 ? rect.top + rminY * sy : null,
      frameW: box.width, frameH: box.height,
      layers: document.getElementById('layer-list').children.length,
      pointers: canvas.dataset.pointers === undefined ? null : Number(canvas.dataset.pointers),
      canvasLeft: rect.left, canvasTop: rect.top, canvasW: rect.width, canvasH: rect.height,
    };
  };

  // Export the current state through the app's own button, capturing the blob
  // (probe.js does the same) and returning the sticker's NORMALIZED centre in the
  // exported, full-resolution image.
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
          n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    return {
      w: bmp.width, h: bmp.height, yellowPixels: n,
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

    const rect = canvas.getBoundingClientRect();
    const P = (fx, fy) => [rect.left + rect.width * fx, rect.top + rect.height * fy];
    const at = (fx, fy) => ({ clientX: rect.left + rect.width * fx, clientY: rect.top + rect.height * fy });
    const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', ...at(0.45, 0.4) };
    canvas.dispatchEvent(new PointerEvent('pointerdown', o));
    canvas.dispatchEvent(new PointerEvent('pointerup', o));
    await sleep(250);

    r.exportBefore = await exportNormalizedStickerCentre();
    log('exportBefore', r.exportBefore);

    const CENTRE = [rect.left + rect.width / 2, rect.top + rect.height / 2];
    const seg = (dist, rot) => [
      [CENTRE[0] + Math.cos(rot) * dist / 2, CENTRE[1] + Math.sin(rot) * dist / 2],
      [CENTRE[0] - Math.cos(rot) * dist / 2, CENTRE[1] - Math.sin(rot) * dist / 2],
    ];
    // Centroid stays at the canvas centre; the sticker sits near 45%/40% of the
    // canvas, so the centroid is OUTSIDE its frame -> image zoom mode.
    const ZOOM_MIN = seg(30, 0);
    const ZOOM_OUT = seg(90, 0);
    const ZOOM_MAX = seg(300, 0);
    const lerp = (from, to, n) => {
      const out = [];
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        out.push({ t: 'touchMove', pts: [0, 1].map((j) => [
          from[j][0] + (to[j][0] - from[j][0]) * t, from[j][1] + (to[j][1] - from[j][1]) * t]), ms: 45 });
      }
      return out;
    };

    window.__sfSnaps = {};
    window.__sfSnap = (name) => { window.__sfSnaps[name] = measure(); return true; };

    window.__sfNextInput = [
      { t: 'read', name: 't0' },
      { t: 'touchStart', pts: ZOOM_MIN, ms: 90 },
      ...lerp(ZOOM_MIN, ZOOM_OUT, 8),
      { t: 'touchEnd', pts: [], ms: 300 },
      { t: 'read', name: 'afterZoomIn' },
      { t: 'touchStart', pts: ZOOM_OUT, ms: 90 },
      ...lerp(ZOOM_OUT, ZOOM_MAX, 10),
      { t: 'touchEnd', pts: [], ms: 300 },
      { t: 'read', name: 'afterZoomMax' },
      { t: 'touchStart', pts: ZOOM_MIN, ms: 90 },
      ...lerp(ZOOM_MIN, [CENTRE, [CENTRE[0] + 6, CENTRE[1]]], 10),
      { t: 'touchEnd', pts: [], ms: 300 },
      { t: 'read', name: 'afterZoomMin' },
    ];

    window.__sfReadTouch = () => {
      const s = window.__sfSnaps;
      const out = { steps: [] };
      const t0 = s.t0, zin = s.afterZoomIn, zmax = s.afterZoomMax, zmin = s.afterZoomMin;
      const ratio = (a, b) => (a && b && a.yellowW > 0) ? b.yellowW / a.yellowW : null;
      const before = r.exportBefore;
      const after = r.exportAfter;

      out.pinchZoomsImage = (ratio(t0, zin) || 0) > 1.8;
      out.steps.push(['zoomRatio', ratio(t0, zin)]);
      out.steps.push(['t0', t0]);
      out.steps.push(['afterZoomIn', zin]);
      out.steps.push(['afterZoomMax', zmax]);
      out.steps.push(['afterZoomMin', zmin]);

      // Focal invariance: the sticker's distance from the gesture centroid must
      // scale by the same factor as its size. Guarded on the zoom actually
      // happening -- otherwise "nothing moved" would pass as focal invariance.
      const dist = (s) => (s && s.stickerCentre) ? Math.hypot(s.stickerCentre[0] - CENTRE[0], s.stickerCentre[1] - CENTRE[1]) : null;
      const d0 = dist(t0), d1 = dist(zin);
      const r0 = ratio(t0, zin);
      out.pinchZoomsAboutFocalPoint = !!d0 && !!d1 && !!r0 && r0 > 1.5 && d0 > 5 &&
        Math.abs(d1 / d0 - r0) / r0 < 0.25;
      out.steps.push(['focalDistance', [d0, d1]]);
      out.steps.push(['sizeRatio', r0]);

      const maxR = ratio(t0, zmax);
      out.pinchClampsZoomRange = !!maxR && maxR <= 8.6 && maxR > 1.5;
      out.steps.push(['maxZoomRatio', maxR]);
      const minR = ratio(t0, zmin);
      out.pinchClampsMinZoom = !!maxR && maxR > 1.5 && !!minR && minR >= 0.95 && minR <= 1.6;
      out.steps.push(['minZoomRatio', minR]);

      // The sticker rides the image: frame width / sticker width stays constant.
      const f0 = (t0 && t0.yellowW) ? t0.frameW / t0.yellowW : null;
      const f1 = (zin && zin.yellowW) ? zin.frameW / zin.yellowW : null;
      out.selectionFrameTracksZoom = !!f0 && !!f1 && Math.abs(f1 - f0) / f0 < 0.2;
      out.steps.push(['frameOverSticker', [f0, f1]]);

      out.zoomDoesNotAddStickers = !!zin && !!t0 && zin.layers === t0.layers;
      out.stickersStillDrawnAtZoom = !!zin && zin.yellowPixels > 200;
      out.exportUnaffectedByZoom = !!before && !!after && !!r0 && r0 > 1.5 &&
        after.w === before.w && after.h === before.h &&
        Math.abs(after.nx - before.nx) < 0.01 && Math.abs(after.ny - before.ny) < 0.01;
      out.steps.push(['exportBefore', before]);
      out.steps.push(['exportAfter', after]);
      out.pointersCleanAfterZoom = !!zin && zin.pointers === 0 && !!zmax && zmax.pointers === 0;
      return JSON.stringify(out);
    };

    log('armed', true);

    // Second export, taken after the gesture script has run (the driver calls
    // window.__sfFinishZoom once the input plan is done).
    window.__sfFinishZoom = async () => {
      r.exportAfter = await exportNormalizedStickerCentre();
      return true;
    };
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
