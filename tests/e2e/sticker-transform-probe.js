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
      imageX: rn > 50 ? rect.left + rx * csx : null,
      imageY: rn > 50 ? rect.top + ry * csy : null,
      selectionVisible: !document.getElementById('select-box').hidden,
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
    const PINCH_IN = P(0, Math.max(6, arm * 0.25), (35 * Math.PI) / 180);
    const PAN_FROM = TWO_EMPTY;
    const PAN_TO = [[TWO_EMPTY[0][0] + 60, TWO_EMPTY[0][1]], [TWO_EMPTY[1][0] + 60, TWO_EMPTY[1][1]]];

    window.__sfSnaps = {};
    window.__sfSnap = (name) => { window.__sfSnaps[name] = measure(); return true; };

    window.__sfNextInput = [
      { t: 'read', name: 't0' },
      // 1) pinch out inside the frame
      { t: 'touchStart', pts: PINCH_FROM, ms: 90 },
      ...lerp(PINCH_FROM, PINCH_OUT, 8),
      { t: 'touchEnd', pts: [], ms: 260 },
      { t: 'read', name: 'afterPinch' },
      // 2) twist inside the (now larger) frame
      { t: 'touchStart', pts: PINCH_OUT, ms: 90 },
      ...lerp(PINCH_OUT, TWIST, 8),
      { t: 'touchEnd', pts: [], ms: 260 },
      { t: 'read', name: 'afterTwist' },
      // 3) one undo must restore size AND angle together
      { t: 'key', key: 'z', code: 'KeyZ', vk: 90, modifiers: 2, ms: 320 },
      { t: 'read', name: 'afterUndo' },
      // 4) two fingers OUTSIDE the frame still pan the image
      { t: 'touchStart', pts: PAN_FROM, ms: 90 },
      ...lerp(PAN_FROM, PAN_TO, 8),
      { t: 'touchEnd', pts: [], ms: 260 },
      { t: 'read', name: 'afterPan' },
      // 5) pinch in hard: the sticker must not vanish or invert
      { t: 'touchStart', pts: PINCH_OUT, ms: 90 },
      ...lerp(PINCH_OUT, PINCH_IN, 8),
      { t: 'touchEnd', pts: [], ms: 260 },
      { t: 'read', name: 'afterPinchIn' },
    ];

    window.__sfReadTouch = () => {
      const s = window.__sfSnaps;
      const out = { steps: [] };
      const t0 = s.t0, pin = s.afterPinch, tw = s.afterTwist, un = s.afterUndo,
            pan = s.afterPan, pinIn = s.afterPinchIn;
      const imgMove = (a, b) => (a && b && a.imageX !== null && b.imageX !== null)
        ? Math.hypot(b.imageX - a.imageX, b.imageY - a.imageY) : null;
      const dAng = (a, b) => (a && b && a.orientation !== null && b.orientation !== null)
        ? Math.abs(((b.orientation - a.orientation) % 90 + 90) % 90) : null;
      out.steps.push(['t0', t0]);
      out.steps.push(['afterPinch', pin]);
      out.steps.push(['afterTwist', tw]);
      out.steps.push(['afterUndo', un]);
      out.steps.push(['afterPan', pan]);
      out.steps.push(['afterPinchIn', pinIn]);

      const grow = (t0 && pin && t0.yellowW > 0) ? pin.yellowW / t0.yellowW : null;
      out.pinchScalesSticker = !!grow && grow > 1.6;
      out.steps.push(['sizeRatio', grow]);
      const gw = (t0 && pin && t0.yellowW > 0) ? pin.yellowW / t0.yellowW : null;
      const gh = (t0 && pin && t0.yellowH > 0) ? pin.yellowH / t0.yellowH : null;
      out.pinchScalesUniformly = !!gw && !!gh && Math.abs(gw - gh) / gw < 0.2;
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
      out.steps.push(['undoSize', [t0 && t0.yellowW, un && un.yellowW], 'undoOrientation', [t0 && t0.orientation, un && un.orientation]]);
      const panMove = imgMove(un, pan);
      out.twoFingerOutsideFrameStillPans = panMove !== null && panMove > 25;
      out.steps.push(['imageMoveDuringPan', panMove]);
      out.pinchClampsSize = !!pinIn && pinIn.yellowPixels > 200 && pinIn.yellowW > 6;
      out.steps.push(['afterPinchInW', pinIn && pinIn.yellowW]);
      return JSON.stringify(out);
    };

    log('armed', true);
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
