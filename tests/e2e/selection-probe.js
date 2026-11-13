// Probe: does the selection frame (resize/rotate handles) actually sit around the
// sticker you placed? Reported bug: "resizing and rotation frame placed not around
// the emoji".
//
// Phase 1 (this script, synthetic events): load a photo, drop a sticker by clicking
// a known point, and check that the frame's CENTRE is that point and that the frame
// is the sticker's size at the preview scale.
// Phase 2 (driver, REAL input): a handle drag. Synthetic pointerdown has no active
// pointer, so `setPointerCapture` throws and the drag never starts — handle gestures
// must go through CDP Input.dispatchMouseEvent. We hand the driver `nextDrag` and a
// `window.__sfRead()` reader; the driver performs the drag and prints the outcome.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);
  const frame = () => {
    const el = document.getElementById('select-box');
    if (!el || el.hidden) return null;
    const b = el.getBoundingClientRect();
    return { left: b.left, top: b.top, w: b.width, h: b.height,
             cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
  };
  const canvas = document.getElementById('stage-canvas');
  const down = (x, y) => {
    const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', clientX: x, clientY: y };
    canvas.dispatchEvent(new PointerEvent('pointerdown', o));
    canvas.dispatchEvent(new PointerEvent('pointerup', o));
  };

  try {
    const blob = await (await fetch('tests/e2e/fixture.jpg?cb=' + Date.now(), { cache: 'no-store' })).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'fixture.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 80 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);

    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / canvas.width;
    const scaleY = rect.height / canvas.height;
    log('canvasBox', [Math.round(rect.width), Math.round(rect.height), 'backing', canvas.width, canvas.height]);
    log('scale', ['x=' + scaleX.toFixed(4), 'y=' + scaleY.toFixed(4)]);

    // --- 1. drop a sticker at a known point --------------------------------
    const clickX = rect.left + rect.width * 0.35;
    const clickY = rect.top + rect.height * 0.30;
    down(clickX, clickY);
    await sleep(250);
    window.__sfClick = [clickX, clickY];

    const b = frame();
    r.frameVisible = !!b;
    log('clickedAt', [Math.round(clickX), Math.round(clickY)]);
    log('frameBox', b && { left: Math.round(b.left), top: Math.round(b.top), w: Math.round(b.w), h: Math.round(b.h) });

    // Independent oracle: find the emoji's own pixels in the PREVIEW canvas.
    // Twemoji yellow is #FFCC4D (255,204,77); the fixture's skin blob is
    // (230,180,121), which the B channel separates out.
    const probe = document.createElement('canvas');
    probe.width = canvas.width; probe.height = canvas.height;
    const pctx = probe.getContext('2d');
    pctx.drawImage(canvas, 0, 0);
    const data = pctx.getImageData(0, 0, probe.width, probe.height).data;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, hits = 0;
    for (let y = 0; y < probe.height; y++) {
      for (let x = 0; x < probe.width; x++) {
        const i = (y * probe.width + x) * 4;
        const R = data[i], G = data[i + 1], B = data[i + 2];
        if (R >= 235 && R <= 255 && G >= 184 && G <= 224 && B >= 57 && B <= 97) {
          hits++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    log('stickerPixels', hits);
    let drawn = null;
    if (hits > 200) {
      drawn = {
        cssLeft: rect.left + minX * scaleX,
        cssTop: rect.top + minY * scaleY,
        cssW: (maxX - minX + 1) * scaleX,
        cssH: (maxY - minY + 1) * scaleY,
      };
      drawn.cx = drawn.cssLeft + drawn.cssW / 2;
      drawn.cy = drawn.cssTop + drawn.cssH / 2;
      log('stickerOnScreen', { left: Math.round(drawn.cssLeft), top: Math.round(drawn.cssTop),
                               w: Math.round(drawn.cssW), h: Math.round(drawn.cssH) });
      r.stickerDrawnAtClick = Math.abs(drawn.cx - clickX) <= 6 && Math.abs(drawn.cy - clickY) <= 6;
      log('stickerCentreError', [(drawn.cx - clickX).toFixed(2), (drawn.cy - clickY).toFixed(2)]);
    } else {
      r.stickerDrawnAtClick = false;
    }

    if (b) {
      log('centreError', [(b.cx - clickX).toFixed(2), (b.cy - clickY).toFixed(2)]);
      r.frameCentredOnSticker = Math.abs(b.cx - clickX) <= 4 && Math.abs(b.cy - clickY) <= 4;
      if (drawn) {
        // THE bug: the handles must be drawn around the emoji you can see.
        r.frameMatchesStickerOnScreen =
          Math.abs(b.left - drawn.cssLeft) <= 6 && Math.abs(b.top - drawn.cssTop) <= 6 &&
          Math.abs(b.w - drawn.cssW) <= 8 && Math.abs(b.h - drawn.cssH) <= 8;
        log('frameVsSticker', [
          'dx=' + (b.left - drawn.cssLeft).toFixed(1),
          'dy=' + (b.top - drawn.cssTop).toFixed(1),
          'dw=' + (b.w - drawn.cssW).toFixed(1),
          'dh=' + (b.h - drawn.cssH).toFixed(1),
        ]);
      } else {
        r.frameMatchesStickerOnScreen = false;
      }
    }

    // --- 2. hand a handle drag to the driver (real input) -------------------
    const se = document.querySelector('[data-handle="se"]');
    if (b && se) {
      const sr = se.getBoundingClientRect();
      window.__sfBefore = b;
      window.__sfRead = () => {
        const f = frame();
        const out = { steps: [] };
        if (!f) {
          out.seHandleDragResizes = false;
          out.steps.push(['afterResize', null]);
          return JSON.stringify(out);
        }
        out.steps.push(['beforeResize', [Math.round(window.__sfBefore.w), Math.round(window.__sfBefore.h)]]);
        out.steps.push(['afterResize', [Math.round(f.w), Math.round(f.h)]]);
        out.seHandleDragResizes = f.w > window.__sfBefore.w + 20 && f.h > window.__sfBefore.h + 20;
        // the frame must still be centred where the sticker is (its NW corner pinned)
        out.steps.push(['nwPinnedDelta', [
          (f.left - window.__sfBefore.left).toFixed(1),
          (f.top - window.__sfBefore.top).toFixed(1),
        ]]);
        out.frameStaysAnchored = Math.abs(f.left - window.__sfBefore.left) <= 4 && Math.abs(f.top - window.__sfBefore.top) <= 4;
        return JSON.stringify(out);
      };
      r.nextDrag = {
        x0: sr.left + sr.width / 2,
        y0: sr.top + sr.height / 2,
        x1: sr.left + sr.width / 2 + 160,
        y1: sr.top + sr.height / 2 + 120,
      };
    } else {
      r.seHandleDragResizes = false;
      r.frameStaysAnchored = false;
      log('seHandle', 'missing');
    }
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
