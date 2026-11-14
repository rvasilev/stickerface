// Two-finger sticker transform probe (M6). Requires E2E_MOBILE=1.
//
// Product rule: two fingers whose centroid starts INSIDE the selected sticker's
// sizing frame scale (pinch) and rotate (twist) that sticker, Instagram-like;
// the image must not pan while that happens, and the whole gesture is ONE undo
// step. Two fingers outside the frame keep panning the image.
//
// Oracles (all from canvas pixels):
//   - the sticker: Twemoji yellow -- bbox (size) + pixel count
//   - its ROTATION: second-moment orientation of those pixels. A square's pixel
//     bbox cannot see a twist (90-deg symmetric), so the covariance eigenvector
//     is the honest measure.
//   - the image: the fixture's red corner block (position => pan).
// The frame's screen box (getBoundingClientRect of #select-box) is used only to
// AIM the fingers -- its correctness is gated separately by selection-probe.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);
  const canvas = document.getElementById('stage-canvas');

  const measure = () => {
    const rect = canvas.getBoundingClientRect();
    const probe = document.createElement('canvas');
    probe.width = canvas.width; probe.height = canvas.height;
    const ctx = probe.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
    let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    let rn = 0, rx = 1e9, ry = 1e9;
    for (let y = 0; y < probe.height; y++) {
      for (let x = 0; x < probe.width; x++) {
        const i = (y * probe.width + x) * 4;
        const R = d[i], G = d[i + 1], B = d[i + 2];
        if (R > 200 && G < 80 && B < 80) { rn++; if (x < rx) rx = x; if (y < ry) ry = y; }
        else if (R >= 235 && R <= 255 && G >= 184 && G <= 224 && B >= 57 && B <= 97) {
          n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
          if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    const csx = rect.width / canvas.width, csy = rect.height / canvas.height;
    let angle = null;
    if (n > 200) {
      const mx = sx / n, my = sy / n;
      const vxx = sxx / n - mx * mx, vyy = syy / n - my * my, vxy = sxy / n - mx * my;
      // principal axis of a square is defined mod 90 deg
      angle = (0.5 * Math.atan2(2 * vxy, vxx - vyy)) * 180 / Math.PI;
      angle = ((angle % 90) + 90) % 90;
    }
    return {
      yellowPixels: n,
      yellowW: maxX >= 0 ? (maxX - minX + 1) * csx : 0,
      yellowH: maxY >= 0 ? (maxY - minY + 1) * csy : 0,
      orientation: angle === null ? null : Math.round(angle * 10) / 10,
      // Centre of the sticker in canvas-relative CSS px. Only DIFFERENCES are
      // used, so the shared origin cancels.
      yellowCx: maxX >= 0 ? ((minX + maxX) / 2) * csx : null,
      yellowCy: maxY >= 0 ? ((minY + maxY) / 2) * csy : null,
      imageX: rn > 50 ? rect.left + rx * csx : null,
      imageY: rn > 50 ? rect.top + ry * csy : null,
      selectionVisible: !document.getElementById('select-box').hidden,
      // Which gesture mode the app is in RIGHT NOW. Only readable while the
      // fingers are still down (the flags are cleared on release), so the probe
      // takes a mid-gesture read — without it, an inert gesture and a clamped
      // one are indistinguishable from the pixels alone.
      mode: [canvas.dataset.pointers, canvas.dataset.transforming || '', canvas.dataset.panning || ''],
      // Diagnosis only (not a criterion): the app's own geometry for the
      // selected sticker. Splits "the transform never ran" from "it ran and the
      // canvas did not redraw".
      store: (() => {
        const app = window.__stickerface;
        const st = app && app.store.state.stickers.find((x) => x.id === app.store.state.selection);
        return st ? { w: Math.round(st.w * 10000) / 10000, rot: Math.round(st.rot * 1000) / 1000 } : null;
      })(),
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
    const at = (nx, ny) => ({ clientX: rect.left + (nx / 1200) * rect.width, clientY: rect.top + (ny / 800) * rect.height });
    const tap = async (nx, ny) => {
      const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', ...at(nx, ny) };
      canvas.dispatchEvent(new PointerEvent('pointerdown', o));
      canvas.dispatchEvent(new PointerEvent('pointerup', o));
      await sleep(180);
    };

    await tap(600, 400);                       // place + select a sticker
    const f = document.getElementById('select-box').getBoundingClientRect();
    r.frameVisible = f.width > 20 && f.height > 20;
    log('frameBox', [Math.round(f.left), Math.round(f.top), Math.round(f.width), Math.round(f.height)]);

    const cx = f.left + f.width / 2, cy = f.top + f.height / 2;
    const arm = Math.min(f.width, f.height) * 0.22;   // both points stay inside the frame
    const P = (a, dist, rot) => [
      [cx + Math.cos(rot) * dist / 2, cy + Math.sin(rot) * dist / 2],
      [cx - Math.cos(rot) * dist / 2, cy - Math.sin(rot) * dist / 2],
    ];
    const EMPTY = [rect.left + 25, rect.top + rect.height - 25];   // clear of the sticker
    const TWO_EMPTY = [EMPTY, [EMPTY[0] + 55, EMPTY[1] - 45]];

    const lerp = (from, to, n, extra = {}) => {
      const out = [];
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        out.push({
          t: 'touchMove',
          pts: [0, 1].map((j) => [
            from[j][0] + (to[j][0] - from[j][0]) * t,
            from[j][1] + (to[j][1] - from[j][1]) * t,
          ]),
          ms: 45,
          ...extra,
        });
      }
      return out;
    };

    const PINCH_FROM = P(0, arm, 0);
    const PINCH_OUT = P(0, arm * 2.6, 0);
    const TWIST = P(0, arm * 2.6, (35 * Math.PI) / 180);
    // Hard enough to drive k BELOW the clamp's floor: separation / 40px start
    // distance must be under the floor (16 natural px / 216 natural px = 0.074),
    // so without the clamp this shrinks to a 1-2 px smudge. That is what makes
    // the "did not vanish" criterion falsifiable instead of trivially true.
    //
    // Aimed from the LIVE selection frame, not from arm-time coordinates: an
    // earlier gesture in this probe (the two-finger drag) has moved the sticker
    // by the time this runs, so absolute points no longer sit on it — measured,
    // that turned this criterion into a pan of the photo. The frame's CENTRE is
    // stable through a pinch (scaling happens about it), so frame-relative
    // offsets are valid for the whole gesture.
    window.__sfAt = (dx, dy) => {
      const f = document.getElementById('select-box').getBoundingClientRect();
      return [f.left + f.width / 2 + dx, f.top + f.height / 2 + dy];
    };
    const ARM_HALF = arm * 1.3;                    // = the holding distance's half
    const pinchInStep = (half) => ({
      t: 'touchMove',
      fns: [`window.__sfAt(${-half}, 0)`, `window.__sfAt(${half}, 0)`],
      ms: 45,
    });
    const PAN_FROM = TWO_EMPTY;
    const PAN_TO = [[TWO_EMPTY[0][0] + 60, TWO_EMPTY[0][1]], [TWO_EMPTY[1][0] + 60, TWO_EMPTY[1][1]]];
    // A two-finger DRAG inside the frame: both points shift by the same vector,
    // so the separation and the angle are unchanged — pure translation.
    const DRAG_BY = [44, 30];
    const DRAG_FROM = P(0, arm, 0);
    const DRAG_TO = DRAG_FROM.map(([x, y]) => [x + DRAG_BY[0], y + DRAG_BY[1]]);

    window.__sfSnaps = {};
    window.__sfSnap = (name) => { window.__sfSnaps[name] = measure(); return true; };

    window.__sfNextInput = [
      { t: 'read', name: 't0' },
      // 1) ONE continuous two-finger gesture: pinch out, then twist, without
      //    lifting. The spec is one undo entry per press-release ("press ->
      //    release is one command"), so a plan that lifts between the two makes
      //    them two commands and cannot support the one-undo claim at all —
      //    which is exactly how this criterion first failed.
      { t: 'touchStart', pts: PINCH_FROM, ms: 90 },
      ...lerp(PINCH_FROM, PINCH_OUT, 8),
      { t: 'read', name: 'afterPinch' },
      ...lerp(PINCH_OUT, TWIST, 8),
      { t: 'read', name: 'afterTwist' },
      { t: 'touchEnd', pts: [], ms: 260 },
      // 3) one undo must restore size AND angle together — the whole gesture
      { t: 'key', key: 'z', code: 'KeyZ', vk: 90, modifiers: 2, ms: 320 },
      { t: 'read', name: 'afterUndo' },
      // 4) two-finger DRAG inside the frame: the centroid moves while the
      //    fingers keep their distance and angle, so this is pure translation —
      //    the third half of the spec'd gesture, and nothing else covers it.
      { t: 'touchStart', pts: DRAG_FROM, ms: 90 },
      ...lerp(DRAG_FROM, DRAG_TO, 8),
      { t: 'touchEnd', pts: [], ms: 260 },
      { t: 'read', name: 'afterDrag' },
      // 5) pinch in hard: the sticker must not vanish or invert. BEFORE the pan
      //    step on purpose: the pan moves the view, and then the frame's screen
      //    coordinates (computed once, at arm time) no longer sit on the sticker
      //    — the gesture silently becomes a pan and the criterion passes while
      //    testing nothing. That is exactly how this failed the first time.
      { t: 'touchStart', fns: [`window.__sfAt(${-ARM_HALF}, 0)`, `window.__sfAt(${ARM_HALF}, 0)`], ms: 90 },
      ...[ARM_HALF * 0.85, ARM_HALF * 0.7, ARM_HALF * 0.55].map(pinchInStep),
      { t: 'read', name: 'duringPinchIn' },
      ...[ARM_HALF * 0.4, ARM_HALF * 0.25, ARM_HALF * 0.1, 0.75].map(pinchInStep),
      { t: 'touchEnd', pts: [], ms: 260 },
      { t: 'read', name: 'afterPinchIn' },
      // 5) two fingers OUTSIDE the frame still pan the image
      { t: 'touchStart', pts: PAN_FROM, ms: 90 },
      ...lerp(PAN_FROM, PAN_TO, 8),
      { t: 'touchEnd', pts: [], ms: 260 },
      { t: 'read', name: 'afterPan' },
    ];

    window.__sfReadTouch = () => {
      const s = window.__sfSnaps;
      const out = { steps: [] };
      const t0 = s.t0, pin = s.afterPinch, tw = s.afterTwist, un = s.afterUndo,
            dr = s.afterDrag, pan = s.afterPan, pinIn = s.afterPinchIn;
      const imgMove = (a, b) => (a && b && a.imageX !== null && b.imageX !== null)
        ? Math.hypot(b.imageX - a.imageX, b.imageY - a.imageY) : null;
      const dAng = (a, b) => (a && b && a.orientation !== null && b.orientation !== null)
        ? Math.abs(((b.orientation - a.orientation) % 90 + 90) % 90) : null;
      out.steps.push(['t0', t0]);
      out.steps.push(['afterPinch', pin]);
      out.steps.push(['afterTwist', tw]);
      out.steps.push(['afterUndo', un]);
      out.steps.push(['afterDrag', dr]);
      out.steps.push(['duringPinchIn', s.duringPinchIn]);
      out.steps.push(['afterPan', pan]);
      out.steps.push(['afterPinchIn', pinIn]);

      const grow = (t0 && pin && t0.yellowW > 0) ? pin.yellowW / t0.yellowW : null;
      out.pinchScalesSticker = !!grow && grow > 1.6;
      out.steps.push(['sizeRatio', grow]);
      const gw = (t0 && pin && t0.yellowW > 0) ? pin.yellowW / t0.yellowW : null;
      const gh = (t0 && pin && t0.yellowH > 0) ? pin.yellowH / t0.yellowH : null;
      out.pinchScalesUniformly = !!gw && !!gh && gw > 1.2 && Math.abs(gw - gh) / gw < 0.2;
      out.steps.push(['growthWH', [gw, gh]]);
      const da = dAng(pin, tw);
      out.twistRotatesSticker = !!da && da > 18;
      out.steps.push(['orientationDelta', da]);
      const panDuringStickerGestures = imgMove(t0, tw);
      out.twoFingerOnStickerDoesNotPanImage = panDuringStickerGestures !== null && panDuringStickerGestures < 5;
      out.steps.push(['imageMoveDuringTransform', panDuringStickerGestures]);
      out.pinchIsOneUndoStep = !!un && !!t0 &&
        Math.abs(un.yellowW - t0.yellowW) / Math.max(1, t0.yellowW) < 0.15 &&
        (dAng(t0, un) === null || dAng(t0, un) < 6);
      out.steps.push(['undoSize', [t0 && t0.yellowW, un && un.yellowW]]);
      out.steps.push(['undoOrientation', [t0 && t0.orientation, un && un.orientation]]);
      // Two-finger DRAG is pure translation: the sticker's centre follows the
      // centroid by the drag vector, the sticker does not resize, and the photo
      // does not move. Covers the spec's "centroid drag = move" half, which had
      // no criterion at all (a build with no translate step passed everything).
      const tr = (un && dr && un.yellowCx !== null && dr.yellowCx !== null)
        ? [dr.yellowCx - un.yellowCx, dr.yellowCy - un.yellowCy] : null;
      const sizeKept = !!(un && dr && un.yellowW > 0) && Math.abs(dr.yellowW / un.yellowW - 1) < 0.1;
      out.twoFingerDragMovesSticker = !!(tr && sizeKept
        && Math.abs(tr[0] - DRAG_BY[0]) < 8 && Math.abs(tr[1] - DRAG_BY[1]) < 8
        && imgMove(un, dr) < 5);
      out.steps.push(['dragOnSticker', {
        moved: tr, sizeKept, imageMoved: imgMove(un, dr), mode: dr && dr.mode,
      }]);
      // Measured from the HARD pinch-in, and now falsifiable: it must have
      // actually shrunk the sticker (an inert gesture is trivially "not
      // vanished") and stopped at the floor rather than collapsing to a smudge.
      // The floor is 16 natural px; the sticker is 216 natural px at placement
      // and reads as 70 CSS px, so the floor is ~5 CSS px — hence >= 4, which a
      // clamp-less build (1.5/40 x 70 = 2.6 px) fails.
      const shrank = !!pinIn && !!un && un.yellowW > 0 && pinIn.yellowW < un.yellowW * 0.8;
      out.pinchClampsSize = !!(pinIn && shrank && pinIn.yellowPixels > 10 && pinIn.yellowW >= 4);
      out.steps.push(['afterPinchInW', pinIn && pinIn.yellowW]);
      out.steps.push(['pinchInContext', {
        from: un && un.yellowW,
        to: pinIn && pinIn.yellowW,
        yellowPixels: pinIn && pinIn.yellowPixels,
        mode: pinIn && pinIn.mode,
        imageMoved: imgMove(un, pinIn),
      }]);
      const panMove = imgMove(pinIn, pan);
      out.twoFingerOutsideFrameStillPans = panMove !== null && panMove > 25;
      out.steps.push(['imageMoveDuringPan', panMove]);
      return JSON.stringify(out);
    };

    log('armed', true);
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
