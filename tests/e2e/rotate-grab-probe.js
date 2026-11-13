// Rotate-handle probe. Reported bug: "when rotation handle is selected, sticker
// rotates 90 degrees counterclockwise".
//
// Cause: the handle sits ABOVE top-centre, so the pointer's ABSOLUTE angle from
// the sticker's centre is -90° at the grab. The drag wrote that absolute angle
// straight into `rot`, so grabbing and moving 1 px snapped the sticker to -90°
// instead of rotating it BY the drag. Rotation has to be a delta from the grab
// angle — which also means the wrap at +/-PI must not spin a full turn.
//
// Real mouse input throughout: a synthetic pointerdown has no active pointer, so
// setPointerCapture throws and the handle drag never starts.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);

  const rect = (el) => {
    const b = el.getBoundingClientRect();
    return { l: b.left, t: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
  };

  r.dragHandleClickDoesNotRotate = false;
  r.tinyMoveAfterGrabDoesNotJump = false;
  r.quarterTurnDragRotatesBy90 = false;
  r.wrapAcrossPiDoesNotSpin = false;
  r.shiftDragSnapsTo15 = false;
  r.rotateDragIsOneUndoStep = false;
  r.noStickersAddedByRotate = false;

  try {
    const blob = await (await fetch('tests/e2e/fixture.jpg?cb=' + Date.now(), { cache: 'no-store' })).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'fixture.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 100 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);
    await sleep(200);

    const app = window.__stickerface;
    const canvas = document.getElementById('stage-canvas');

    const cr = rect(canvas);
    const tap = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse',
                  clientX: cr.l + cr.w * 0.5, clientY: cr.t + cr.h * 0.45 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', tap));
    canvas.dispatchEvent(new PointerEvent('pointerup', tap));
    await sleep(250);

    const sel = app.store.state.selection;
    const st0 = app.store.state.stickers.find((s) => s.id === sel);
    const box = document.getElementById('select-box');
    const handle = box.querySelector('[data-handle="rotate"]');
    const h = rect(handle);
    const b = rect(box);
    // The handle TRAVELS with the rotation — the select-box is rotated by a CSS
    // transform — so every drag endpoint is resolved from the page at dispatch
    // time. Static coordinates miss the handle after the first rotation, which
    // silently made three criteria measure nothing.
    const liveHandle = () => rect(box.querySelector('[data-handle="rotate"]'));
    const liveCentre = () => rect(box);
    window.__sfGrab = () => { const hb = liveHandle(); return [hb.cx, hb.cy]; };
    window.__sfTiny = () => { const hb = liveHandle(); return [hb.cx, hb.cy - 2]; };
    window.__sfTo = (deg) => {
      const bb = liveCentre(), hb = liveHandle();
      const radius = Math.hypot(hb.cx - bb.cx, hb.cy - bb.cy);
      const a = (deg * Math.PI) / 180;
      return [bb.cx + radius * Math.cos(a), bb.cy + radius * Math.sin(a)];
    };
    log('geometry', {
      centre: [Math.round(liveCentre().cx), Math.round(liveCentre().cy)],
      radius: Math.round(Math.hypot(liveHandle().cx - liveCentre().cx, liveHandle().cy - liveCentre().cy)),
      handle: [Math.round(liveHandle().cx), Math.round(liveHandle().cy)],
      startRot: st0 && st0.rot,
    });

    const snaps = {};
    window.__sfSnaps = snaps;
    window.__sfSnap = (name) => {
      if (name === 'resetRot') {
        // Probe setup, not an app action: put the sticker back to 0° so the wrap
        // drag's geometry — and therefore its expected sweep — is fixed. Written
        // straight to state, with no store call, so it adds no undo entry and the
        // undo-count criterion stays meaningful.
        const s = app.store.state.stickers.find((x) => x.id === app.store.state.selection);
        if (s) s.rot = 0;
        app._draw();
      }
      const st = app.store.state.stickers.find((s) => s.id === app.store.state.selection);
      snaps[name] = {
        rot: st ? st.rot : null,
        id: st ? st.id : null,
        undo: app.store._undo.length,
        count: app.store.state.stickers.length,
        sel: app.store.state.selection,
      };
      return true;
    };

    window.__sfNextInput = [
      { t: 'read', name: 't0' },
      // 1. Click the handle and release without moving: nothing may change.
      { t: 'click', pts: [[h.cx, h.cy]], ms: 200 },
      { t: 'read', name: 'afterClick' },
      // 2. The reported bug: grab, then move 2 px straight up. The pointer stays
      //    at -90°, so a correct implementation rotates by ~0°.
      { t: 'drag', fns: ['window.__sfGrab()', 'window.__sfTiny()'], steps: 2, ms: 200 },
      { t: 'read', name: 'afterTinyMove' },
      // 3. A quarter turn: handle (top) -> right of centre. Rotate BY +90°.
      { t: 'drag', fns: ['window.__sfGrab()', 'window.__sfTo(0)'], steps: 8, ms: 250 },
      { t: 'read', name: 'afterQuarter' },
      // Back to 0° so the wrap drag is the fixed configuration it was designed
      // around: the handle sits above the centre, and a sweep to the 170° point
      // travels ~100° through the ±PI axis.
      { t: 'read', name: 'resetRot' },
      // 4. A long sweep that CROSSES the ±PI axis. The path really turns ~100°,
      //    so a correct accumulator lands near -100° while a full-turn error (a
      //    naive angle subtraction) lands near +260°.
      { t: 'drag', fns: ['window.__sfGrab()', 'window.__sfTo(170)'], steps: 10, ms: 250 },
      { t: 'read', name: 'afterWrap' },
      // 5. Shift: the resulting rotation snaps to a multiple of 15°.
      { t: 'drag', fns: ['window.__sfGrab()', 'window.__sfTo(45)'], steps: 8, modifiers: 8, ms: 250 },
      { t: 'read', name: 'afterShift' },
    ];

    window.__sfReadTouch = () => {
      const s = window.__sfSnaps || {};
      const out = { steps: [] };
      const DEG = 180 / Math.PI;
      const d = (a, b2) => (a && b2 && a.rot !== null && b2.rot !== null ? (b2.rot - a.rot) * DEG : undefined);

      const grabDelta = d(s.t0, s.afterClick);
      out.dragHandleClickDoesNotRotate = grabDelta !== undefined && Math.abs(grabDelta) < 1;

      const tiny = d(s.afterClick, s.afterTinyMove);
      out.tinyMoveAfterGrabDoesNotJump = tiny !== undefined && Math.abs(tiny) < 10;

      const quarter = d(s.afterTinyMove, s.afterQuarter);
      out.quarterTurnDragRotatesBy90 = quarter !== undefined && Math.abs(quarter - 90) < 12;

      const wrap = d(s.resetRot, s.afterWrap);
      // Guarded both ways: a drag that missed the handle gives 0 (proving
      // nothing), and a full-turn error gives ~260 — so the band is the sweep the
      // path actually made, not "anything small".
      out.wrapAcrossPiDoesNotSpin = wrap !== undefined && Math.abs(wrap) >= 60 && Math.abs(wrap) <= 130;

      // Multiple of 15° with a small float tolerance.
      const sr = s.afterShift && s.afterShift.rot !== null ? s.afterShift.rot * DEG : undefined;
      const shiftDelta = d(s.afterWrap, s.afterShift);
      out.shiftDragSnapsTo15 = sr !== undefined && Math.abs(sr / 15 - Math.round(sr / 15)) < 0.05
        && shiftDelta !== undefined && Math.abs(shiftDelta) >= 1;

      // One entry per DRAG, not per pointer move: each drag interpolates 8–10
      // moves, so a missing beginDrag/commitDrag pair would show as 8–10 here.
      // The 2 px jitter is a real (if negligible) rotation and does commit — the
      // same rule the canvas move drag already follows.
      const undoClick = s.t0 && s.afterClick ? s.afterClick.undo - s.t0.undo : undefined;
      const undoTiny = s.afterClick && s.afterTinyMove ? s.afterTinyMove.undo - s.afterClick.undo : undefined;
      const undoQuarter = s.afterTinyMove && s.afterQuarter ? s.afterQuarter.undo - s.afterTinyMove.undo : undefined;
      const undoWrap = s.resetRot && s.afterWrap ? s.afterWrap.undo - s.resetRot.undo : undefined;
      const undoShift = s.afterWrap && s.afterShift ? s.afterShift.undo - s.afterWrap.undo : undefined;
      out.rotateDragIsOneUndoStep = undoClick === 0 && undoTiny === 1 && undoQuarter === 1
        && undoWrap === 1 && undoShift === 1;

      out.noStickersAddedByRotate = !!s.afterShift && s.t0 && s.afterShift.count === s.t0.count
        && s.afterShift.sel === s.t0.sel;

      out.steps.push(['rotDeg', {
        t0: s.t0 && s.t0.rot !== null ? +(s.t0.rot * DEG).toFixed(2) : null,
        afterClick: s.afterClick && +(s.afterClick.rot * DEG).toFixed(2),
        afterTinyMove: s.afterTinyMove && +(s.afterTinyMove.rot * DEG).toFixed(2),
        afterQuarter: s.afterQuarter && +(s.afterQuarter.rot * DEG).toFixed(2),
        afterWrap: s.afterWrap && +(s.afterWrap.rot * DEG).toFixed(2),
        afterShift: s.afterShift && +(s.afterShift.rot * DEG).toFixed(2),
      }]);
      out.steps.push(['deltas', { grab: grabDelta, tiny, quarter, wrap, snappedDeg: sr }]);
      out.steps.push(['undo', { click: undoClick, tiny: undoTiny, quarter: undoQuarter, wrap: undoWrap, shift: undoShift }]);
      return JSON.stringify(out);
    };

    log('armed', true);
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
