// Diagnostic: at what on-screen size do a sticker's own resize handles make it
// immovable? Sweeps the selected box down through a series of sizes and, at each
// one, reports what a real press at the sticker's centre would hit.
//
// Handles carry a 32 CSS px hit area (12 px marker + a 10 px ::before inset) and sit
// at the 4 corners plus the 4 edge midpoints, so their union can cover the whole
// interior of a small box. This finds where that starts.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);

  const rectEl = (el) => {
    const b = el.getBoundingClientRect();
    return { l: b.left, t: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
  };
  const HANDLE_PAD = 10;   // the ::before inset that extends the hit area

  try {
    const res = await fetch(`tests/e2e/fixture.jpg?cb=${Date.now()}`, { cache: 'no-store' });
    const blob = await res.blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'fixture.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 80 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);
    await sleep(300);

    const canvas = document.getElementById('stage-canvas');
    const box = document.getElementById('select-box');
    const app = window.__stickerface;

    // Place one sticker with a synthetic tap on empty canvas.
    const cr = rectEl(canvas);
    const tap = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse',
                  clientX: cr.l + cr.w * 0.5, clientY: cr.t + cr.h * 0.4 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', tap));
    canvas.dispatchEvent(new PointerEvent('pointerup', tap));
    await sleep(200);
    log('placedStickers', app.store.state.stickers.length);

    // Both remaining handles are the selected sticker's chrome — nothing to switch
    // into (three-handle-probe.js gates that they are out at a grabbable size).

    // Drag the SE handle so the box becomes ~target px, keeping the NW corner pinned.
    const shrinkTo = async (targetPx) => {
      const h = box.querySelector('.handle[data-handle="se"]');
      const hb = rectEl(h);
      const bb = rectEl(box);
      const wantX = bb.l + targetPx;
      const wantY = bb.t + targetPx;
      const o = { bubbles: true, cancelable: true, pointerId: 7, isPrimary: true, pointerType: 'mouse' };
      h.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: hb.cx, clientY: hb.cy }));
      h.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: wantX, clientY: wantY }));
      h.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: wantX, clientY: wantY }));
      await sleep(120);
      return rectEl(box);
    };

    const sweep = [];
    for (const target of [160, 120, 90, 70, 55, 45, 36, 30, 24, 18]) {
      const b = await shrinkTo(target);
      const cx = b.cx;
      const cy = b.cy;
      const at = document.elementFromPoint(cx, cy);
      const covering = [];
      let nearest = Infinity;
      for (const h of box.querySelectorAll('.handle')) {
        if (h.hidden) continue;
        const hb = rectEl(h);
        const dx = Math.max(hb.l - HANDLE_PAD - cx, 0, cx - (hb.l + hb.w + HANDLE_PAD));
        const dy = Math.max(hb.t - HANDLE_PAD - cy, 0, cy - (hb.t + hb.h + HANDLE_PAD));
        const d = Math.hypot(dx, dy);
        if (d === 0) covering.push(h.dataset.handle);
        nearest = Math.min(nearest, d);
      }
      sweep.push({
        onScreenPx: Math.round(b.w),
        pressHits: at ? (at.dataset?.handle ? `handle:${at.dataset.handle}` : (at.id || at.tagName)) : null,
        handlesCoveringCentre: covering,
        nearestHandleEdgePx: Math.round(nearest),
      });
    }
    log('sweep', sweep);

    // The first size (largest) at which the centre is no longer the sticker.
    const firstBlocked = sweep.find((s) => s.pressHits !== 'stage-canvas');
    log('blockedFromPx', firstBlocked ? firstBlocked.onScreenPx : null);
    log('freeAbovePx', (() => {
      const ok = sweep.filter((s) => s.pressHits === 'stage-canvas');
      return ok.length ? ok[ok.length - 1].onScreenPx : null;
    })());

    // Same 8 handles, same 32 px hit area: the CSS that fixes the hit size.
    const h0 = box.querySelector('.handle');
    log('handleMarkerCss', [getComputedStyle(h0).width, getComputedStyle(h0).height]);
    log('handleHitInsetCss', getComputedStyle(h0, '::before').inset);
    log('selectBoxPointerEvents', getComputedStyle(box).pointerEvents);

    r.measuredAThreshold = firstBlocked !== undefined && firstBlocked !== null;
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
