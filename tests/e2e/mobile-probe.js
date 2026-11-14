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
    box.pointers = canvas.dataset.pointers === undefined ? null : Number(canvas.dataset.pointers);
    box.mode = [canvas.dataset.transforming || '', canvas.dataset.panning || '', canvas.dataset.dragging || ''];
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
    const DOT = [rect.left + rect.width * 0.18, rect.top + rect.height * 0.82]; // clear of the first sticker
    // Two-finger pan points, clear of the sticker: fingers whose centroid sits
    // inside the SELECTED sticker's frame transform that sticker (M6), so a
    // pan probe must aim away from it. The old pair straddled the canvas centre,
    // which is where the sticker was placed.
    const PAN_FROM = [DOT, [DOT[0] + 55, DOT[1] - 45]];
    // Live point resolution for the interrupt case below. `__sfFreeze` reads the
    // selection frame ONCE and then offsets from that fixed base — the press must
    // land on the sticker where it actually IS (step 2 dragged it), while the
    // MOVE steps must stay absolute, or the finger would chase the sticker and
    // no drag delta would ever accumulate.
    window.__sfFreeze = (dx, dy) => {
      if (!window.__sfBase) {
        const f = document.getElementById('select-box').getBoundingClientRect();
        window.__sfBase = [f.left + f.width / 2, f.top + f.height / 2];
      }
      return [window.__sfBase[0] + dx, window.__sfBase[1] + dy];
    };

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
      { t: 'touchStart', pts: PAN_FROM, ms: 90 },
      ...move(PAN_FROM, imgDx, imgDy),
      { t: 'touchEnd', pts: [], ms: 250 },
      { t: 'read', name: 'afterTwoFingerPan' },
      // 4) second finger landing mid-drag must cancel the sticker drag. Aimed
      //    with live resolution: the sticker sits wherever step 2 left it, and a
      //    point captured at arm time misses it (measured: no drag was live at
      //    the second press, so the criterion had quietly stopped testing a
      //    mid-drag interrupt at all).
      { t: 'touchStart', fns: ['window.__sfFreeze(0, 0)'], ms: 90 },
      ...[1, 2, 3].map((i) => ({ t: 'touchMove', fns: [`window.__sfFreeze(${13 * i}, ${13 * i})`], ms: 40 })),
      { t: 'read', name: 'midInterruptDrag' },
      { t: 'touchAdd', fns: ['window.__sfFreeze(110, 90)'], ms: 90 },
      ...[1, 2, 3, 4].map((i) => ({
        t: 'touchMove',
        fns: [
          `window.__sfFreeze(${40 + 10 * i}, ${40 + 10 * i})`,
          `window.__sfFreeze(${110 + 10 * i}, ${90 + 10 * i})`,
        ],
        ms: 40,
      })),
      { t: 'read', name: 'duringInterrupt' },
      { t: 'touchEnd', pts: [], ms: 250 },
      { t: 'read', name: 'afterInterrupt' },
      // 5) tap an empty spot to place a fresh sticker, then double-tap THAT spot:
      //    targeting the sticker we just placed removes the coordinate guesswork
      //    (the first sticker has drifted with the image by now).
      { t: 'touchStart', pts: [DOT], ms: 70 },
      { t: 'touchEnd', pts: [], ms: 260 },
      // Close the double-tap window before the pair below: taps closer together
      // than 350ms ARE a double-tap (correctly), so a placement tap followed
      // immediately by a pair would pair up, delete, and place again — net zero.
      { t: 'settle', ms: 450 },
      { t: 'read', name: 'afterTapForDelete' },
      { t: 'touchStart', pts: [DOT], ms: 70 },
      { t: 'touchEnd', pts: [], ms: 70 },
      { t: 'touchStart', pts: [DOT], ms: 70 },
      { t: 'touchEnd', pts: [], ms: 260 },
      { t: 'read', name: 'afterDoubleTap' },
      // 6) ONE finger drag RELEASED ON EMPTY CANVAS is a drag, not a tap: the tap
      //    guard (`> 8px`, js/ui.js:912) must refuse the placement. Every other
      //    criterion in this file stays green if that guard is deleted — no other
      //    probe drives a one-finger drag across empty canvas — so this is the only
      //    thing pinning it. DOT is empty here precisely because step 5's double-tap
      //    deleted the sticker that was there.
      { t: 'read', name: 'beforeEmptyDrag' },
      { t: 'touchStart', pts: [DOT], ms: 90 },
      ...move([DOT], 42, 26),
      { t: 'touchEnd', pts: [], ms: 260 },
      { t: 'read', name: 'afterEmptyDrag' },
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

      // A drag is cancelled iff the sticker has NOT moved RELATIVE TO THE PHOTO. The
      // interruption legitimately pans the image, and a sticker rides the image, so the
      // screen-space shift must be compared against the image's OWN shift. Comparing it
      // to zero (the previous bound) measured the pan, and reported ~40px - the pan
      // distance - as a failed cancel while the sticker's image-space position was
      // unchanged to within 0.4px.
      const imgShift = shift(pan && pan.red, interrupt && interrupt.red);
      const id = shift(pan && pan.yellow, interrupt && interrupt.yellow);
      const rel = id && imgShift ? { dx: id.dx - imgShift.dx, dy: id.dy - imgShift.dy } : null;
      // NOT asserted here, on purpose. This case used to pass — but only because
      // NO drag was ever live: the press missed the sticker, two empty-canvas
      // fingers panned, and the sticker rode the image so `rel` stayed ~0. It
      // asserted nothing. Aiming it correctly (live resolution, above) makes a
      // drag live, and then the real blocker appears: CDP cannot add a finger to
      // a live touch gesture through this harness — a touchStart carrying the
      // active point is dropped (measured twice: pointersDuring stayed 1), so no
      // implementation could cancel anything. The gesture steps stay (they keep
      // the pointer bookkeeping honest), the assertion is gone, and the gap is
      // recorded in docs/VERIFICATION.md. Cover the cancel from the other side
      // in the M6 gate, which drives a two-finger start and the mode decision.
      out.steps.push(['interruptStickerShift', id]);
      out.steps.push(['interruptStickerShiftRelImage', rel]);
      out.steps.push(['interruptImageShift', imgShift]);
      out.steps.push(['interruptModes', {
        beforeSecondFinger: (s.midInterruptDrag || {}).mode,
        during: (s.duringInterrupt || {}).mode,
        pointersDuring: (s.duringInterrupt || {}).pointers,
      }]);

      const dt = s.afterDoubleTap;
      const pre = s.afterTapForDelete;
      out.tapPlacesSecondSticker = !!dt && !!pre && pre.yellowPixels > (interrupt && interrupt.yellowPixels || 0) * 1.5;
      out.doubleTapDeletesSticker = !!dt && !!pre &&
        dt.yellowPixels < Math.max(200, pre.yellowPixels * 0.62);

      // The release lands ~49px from the press, so the app must call it a drag. A
      // placed sticker adds well over 100 yellow px (the placement criterion above
      // uses the same threshold); the tolerance below is resample noise, since the
      // same untouched sticker re-measured is identical.
      const bed = s.beforeEmptyDrag, aed = s.afterEmptyDrag;
      out.emptyCanvasDragDoesNotPlace = !!aed && !!bed &&
        aed.yellowPixels <= bed.yellowPixels + 60;
      out.steps.push(['emptyCanvasDrag', [bed && bed.yellowPixels, aed && aed.yellowPixels]]);
      const pcounts = ['tap', 'oneFingerDrag', 'twoFingerPan', 'interrupt', 'tapForDelete', 'doubleTap']
        .map((k) => [k, (s['after' + k[0].toUpperCase() + k.slice(1)] || {}).pointers]);
      out.pointersCleanAfterGestures = pcounts.every(([, n]) => n === 0);
      out.steps.push(['pointerCounts', pcounts]);
      out.steps.push(['afterTapForDelete', pre]);
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
