// Mobile gesture probe. Requires E2E_MOBILE=1 (the driver then emulates a
// 390x844 touch device and applies it BEFORE the page loads).
//
// Product rule under test:
//   ONE finger  -> sticker operations (tap to place, drag to move, handles)
//   TWO fingers -> scroll/pan the image; never add or move a sticker
//   a second finger landing mid-drag cancels the sticker drag
//
// Everything is measured from the canvas pixels, never from the app's own
// geometry: the fixture's red block at natural (0..60) tracks the IMAGE position,
// the Twemoji yellow tracks the STICKER.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);

  const measure = () => {
    const canvas = document.getElementById('stage-canvas');
    const rect = canvas.getBoundingClientRect();
    const probe = document.createElement('canvas');
    probe.width = canvas.width; probe.height = canvas.height;
    const ctx = probe.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
    const box = { red: null, yellow: null, yellowPixels: 0 };
    let rminX = 1e9, rminY = 1e9, rmaxX = -1, rmaxY = -1, rn = 0;
    let yminX = 1e9, yminY = 1e9, ymaxX = -1, ymaxY = -1, yn = 0;
    for (let y = 0; y < probe.height; y++) {
      for (let x = 0; x < probe.width; x++) {
        const i = (y * probe.width + x) * 4;
        const R = d[i], G = d[i + 1], B = d[i + 2];
        if (R > 200 && G < 80 && B < 80) { rn++; if (x < rminX) rminX = x; if (x > rmaxX) rmaxX = x; if (y < rminY) rminY = y; if (y > rmaxY) rmaxY = y; }
        else if (R >= 235 && R <= 255 && G >= 184 && G <= 224 && B >= 57 && B <= 97) { yn++; if (x < yminX) yminX = x; if (x > ymaxX) ymaxX = x; if (y < yminY) yminY = y; if (y > ymaxY) ymaxY = y; }
      }
    }
    box.yellowPixels = yn;
    const sx = rect.width / canvas.width, sy = rect.height / canvas.height;
    if (rn > 50) box.red = { x: rect.left + rminX * sx, y: rect.top + rminY * sy };
    if (yn > 50) box.yellow = {
      x: rect.left + yminX * sx, y: rect.top + yminY * sy,
      w: (ymaxX - yminX + 1) * sx, h: (ymaxY - yminY + 1) * sy,
    };
    box.canvasLeft = rect.left; box.canvasTop = rect.top;
    return box;
  };

  try {
    const blob = await (await fetch('tests/e2e/fixture.jpg?cb=' + Date.now(), { cache: 'no-store' })).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'fixture.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 100 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);

    const canvas = document.getElementById('stage-canvas');
    const rect = canvas.getBoundingClientRect();
    r.isTouchViewport = window.innerWidth <= 500;
    log('viewport', [window.innerWidth, window.innerHeight]);
    log('canvasBox', [Math.round(rect.width), Math.round(rect.height), 'backing', canvas.width, canvas.height]);
    const ta = getComputedStyle(canvas).touchAction;
    r.canvasHasTouchActionNone = ta === 'none';
    log('touchAction', ta);

    const before = measure();
    log('before', before);

    // --- arm the gesture script -------------------------------------------
    window.__sfSnaps = {};
    window.__sfSnap = (name) => { window.__sfSnaps[name] = measure(); return true; };

    const cx = rect.left + rect.width * 0.45;
    const cy = rect.top + rect.height * 0.40;
    const drag = (dx, dy) => ({ dx, dy });
    const one = [[cx, cy]];
    const move = (pts, dx, dy, n = 6) => {
      const out = [];
      for (let i = 1; i <= n; i++) out.push({ t: 'touchMove', pts: pts.map(([x, y]) => [x + (dx * i) / n, y + (dy * i) / n]), ms: 40 });
      return out;
    };

    const imgDx = 60, imgDy = 40;      // two-finger pan delta
    const stickerDx = 50, stickerDy = 30; // one-finger drag delta

    window.__sfNextInput = [
      { t: 'read', name: 't0' },
      // 1) ONE finger tap on empty canvas -> place a sticker
      { t: 'touchStart', pts: one, ms: 90 },
      { t: 'touchEnd', pts: [], ms: 250 },
      { t: 'read', name: 'afterTap' },
      // 2) ONE finger drag from the sticker -> sticker moves, image does NOT
      { t: 'touchStart', pts: one, ms: 90 },
      ...move(one, stickerDx, stickerDy),
      { t: 'touchEnd', pts: [], ms: 250 },
      { t: 'read', name: 'afterOneFingerDrag' },
      // 3) TWO fingers together -> image pans; no sticker added or moved
      { t: 'touchStart', pts: [[cx, cy], [cx + 60, cy + 40]], ms: 90 },
      ...move([[cx, cy], [cx + 60, cy + 40]], imgDx, imgDy),
      { t: 'touchEnd', pts: [], ms: 250 },
      { t: 'read', name: 'afterTwoFingerPan' },
      // 4) second finger landing mid-drag must cancel the sticker drag
      { t: 'touchStart', pts: [[cx + stickerDx, cy + stickerDy]], ms: 90 },
      ...move([[cx + stickerDx, cy + stickerDy]], 40, 40, 3),
      { t: 'touchStart', pts: [[cx + stickerDx, cy + stickerDy], [cx + stickerDx + 70, cy + stickerDy + 50]], ms: 90 },
      ...move([[cx + stickerDx, cy + stickerDy], [cx + stickerDx + 70, cy + stickerDy + 50]], 40, 40),
      { t: 'touchEnd', pts: [], ms: 250 },
      { t: 'read', name: 'afterInterrupt' },
      // 5) double-tap on the sticker removes it (two taps inside the window)
      { t: 'touchStart', pts: [[cx, cy]], ms: 60 },
      { t: 'touchEnd', pts: [], ms: 70 },
      { t: 'touchStart', pts: [[cx, cy]], ms: 60 },
      { t: 'touchEnd', pts: [], ms: 260 },
      { t: 'read', name: 'afterDoubleTap' },
    ];

    window.__sfReadTouch = () => {
      const s = window.__sfSnaps;
      const out = { steps: [] };
      const b = s.t0, tap = s.afterTap, one1 = s.afterOneFingerDrag, pan = s.afterTwoFingerPan, interrupt = s.afterInterrupt;
      const shift = (a, c) => (a && c ? { dx: c.x - a.x, dy: c.y - a.y } : null);

      out.tapPlacesSticker = !!tap && tap.yellowPixels > 100 && (!b || b.yellowPixels <= 100);
      out.steps.push(['yellowPixels', [b && b.yellowPixels, tap && tap.yellowPixels]]);

      const yd = shift(tap && tap.yellow, one1 && one1.yellow);
      const rd = shift(tap && tap.red, one1 && one1.red);
      out.oneFingerMovesSticker = !!yd && yd.dx > 25 && yd.dy > 10;
      out.oneFingerDoesNotPan = !!rd && Math.abs(rd.dx) < 4 && Math.abs(rd.dy) < 4;
      out.steps.push(['oneFingerStickerShift', yd]);
      out.steps.push(['oneFingerImageShift', rd]);

      const pd = shift(one1 && one1.red, pan && pan.red);
      const ps = shift(one1 && one1.yellow, pan && pan.yellow);
      out.twoFingerPansImage = !!pd && Math.hypot(pd.dx, pd.dy) > 25;
      out.steps.push(['twoFingerImageShift', pd]);
      out.steps.push(['twoFingerStickerShift', ps]);
      const sizeKept = one1 && one1.yellow && pan && pan.yellow
        ? Math.abs(one1.yellow.w - pan.yellow.w) <= 4 && Math.abs(one1.yellow.h - pan.yellow.h) <= 4 : false;
      out.twoFingerDoesNotResizeSticker = sizeKept;
      out.twoFingerDoesNotAddSticker = !!pan && !!one1 &&
        Math.abs(pan.yellowPixels - one1.yellowPixels) < Math.max(120, one1.yellowPixels * 0.35);

      const id = shift(pan && pan.yellow, interrupt && interrupt.yellow);
      out.secondFingerCancelsDrag = !!id && Math.hypot(id.dx, id.dy) < 12;
      out.steps.push(['interruptStickerShift', id]);
      out.steps.push(['interruptImageShift', shift(pan && pan.red, interrupt && interrupt.red)]);

      const dt = s.afterDoubleTap;
      out.doubleTapDeletesSticker = !!dt && !!interrupt &&
        dt.yellowPixels < Math.max(200, interrupt.yellowPixels * 0.05);
      out.steps.push(['afterDoubleTap', dt]);
      return JSON.stringify(out);
    };

    // A tap must not need a synthetic event: the driver sends real touches.
    log('armed', true);
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
