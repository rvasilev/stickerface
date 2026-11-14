// Move/Resize modes probe. The selected sticker has an explicit mode — Move or
// Resize — chosen from the pad's mode row, so the 8 resize handles and the rotate
// handle are no longer always-on chrome.
//
// Why it exists: at and below ~32 CSS px the 8 handles' hit areas cover the
// sticker's whole interior (measured by diag-small-sticker-probe: free at 36 px,
// blocked at 30, the centre press landing on handle:w), so a move drag is
// impossible. The pad (option 6) made a tiny sticker movable by ARROWS; the mode
// pair makes the DIRECT gesture work at any size, and keeps the handles out of the
// way the rest of the time.
//
// Three phases, because the harness runs them in this order and each can only do
// what it is good at:
//   1. page JS   — setup + the static measurements (computed styles, aria state)
//   2. drag      — ONE real handle drag (Input.dispatchMouseEvent). Handle drags
//                  need a genuine active pointer, so the top-level `nextDrag` plan
//                  is what drives it.
//   3. steps     — real clicks, real mouse drags and real key events
// Criteria are declared false up front and overwritten by whichever phase measures
// them, so a phase that never runs leaves them FAILING instead of absent (an
// absent criterion would report "10/10 passed" for work that was never measured).
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);

  const rect = (el) => {
    const b = el.getBoundingClientRect();
    return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height,
             cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
  };

  r.modeControlAppearsWithSelection = false;
  r.moveModeHidesEveryHandle = false;
  r.moveModeHidesTheRotateStem = false;
  r.resizeModeRevealsEveryHandle = false;
  r.dragMovesAnySizeSticker = false;
  r.resizeModeHandleDragResizes = false;
  r.moveModeDragDoesNotRotate = false;
  r.hiddenHandleRefusesActivation = false;
  r.modeSwitchIsViewOnly = false;
  r.keyboardSwitchesMode = false;

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
    const pad = document.getElementById('sticker-pad');
    const box = document.getElementById('select-box');
    const canvas = document.getElementById('stage-canvas');
    const modeMove = document.getElementById('mode-move');
    const modeResize = document.getElementById('mode-resize');
    const hint = document.getElementById('stage-hint');

    const handleDisplays = () => [...document.querySelectorAll('#select-box .handle')]
      .map((el) => ({ h: el.dataset.handle, d: getComputedStyle(el).display, hidden: el.hidden }));
    const stemDisplay = () => getComputedStyle(box, '::after').display;
    const st = () => app.store.state.stickers[0];
    const none = (d) => d.length === 9 && d.every((x) => x.d === 'none');
    const shown = (d) => d.length === 9 && d.every((x) => x.d !== 'none');

    const controlsPresent = !!pad && !!modeMove && !!modeResize;
    const controlsHiddenBefore = !!pad && pad.hidden === true;
    log('controls', { pad: !!pad, modeMove: !!modeMove, modeResize: !!modeResize, hiddenBefore: pad ? pad.hidden : null });

    // ---- one sticker, through the app's own placement path --------------------
    const cr = rect(canvas);
    const tap = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse',
                  clientX: cr.l + cr.w * 0.5, clientY: cr.t + cr.h * 0.35 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', tap));
    canvas.dispatchEvent(new PointerEvent('pointerup', tap));
    await sleep(300);

    const placed = app.store.state.stickers.length === 1;
    const moveDisplays = handleDisplays();
    const moveStem = stemDisplay();

    r.modeControlAppearsWithSelection = controlsHiddenBefore && controlsPresent && placed
      && pad.hidden === false
      && modeMove.getAttribute('aria-pressed') === 'true'
      && modeResize.getAttribute('aria-pressed') === 'false';
    // Move is the default, so the chrome must already be out of the way.
    r.moveModeHidesEveryHandle = none(moveDisplays);
    r.moveModeHidesTheRotateStem = moveStem === 'none';
    log('moveDefault', { handles: moveDisplays, stem: moveStem, hint: hint.textContent });

    if (!placed || !controlsPresent) {
      log('bail', ['no sticker, or no mode control in the DOM']);
      return JSON.stringify(r);
    }

    // The mode row is the modification toolbar; the real click on it is exercised
    // in the steps phase. This one is SETUP, so that the drag phase below has a
    // reachable handle — and whether the handles really appear is asserted from a
    // computed-style read, not from this call.
    modeResize.click();
    await sleep(120);
    const resizeDisplays = handleDisplays();
    if (shown(resizeDisplays)) r.resizeModeRevealsEveryHandle = true;
    log('afterSyntheticResize', { handles: resizeDisplays, stem: stemDisplay() });

    // ---- phase 2: ONE real handle drag, shrinking into the blocking band ------
    // Static endpoints are safe here: nothing has moved yet. The target is the
    // frame's own left+22 — the pad probe's proven ~22 px trick — which lands
    // inside the band whatever the initial sticker size is. (A fraction of the
    // current box would depend on that size and could stop a few px above 32.)
    const b0 = rect(box);
    r.nextDrag = { x0: b0.r, y0: b0.b, x1: b0.l + 22, y1: b0.t + 22 };
    window.__sfShrinkBefore = { w: st().w, h: st().h, box: rect(box), undo: app.store._undo.length };

    // ---- phase 3 shape: real clicks, drags and keys ---------------------------
    window.__sfAt = (fx, fy) => { const b = rect(box); return [b.l + b.w * fx, b.t + b.h * fy]; };
    window.__sfAtOff = (fx, fy, dx, dy) => { const b = rect(box); return [b.l + b.w * fx + dx, b.t + b.h * fy + dy]; };
    window.__sfModeBtn = (id) => { const el = document.getElementById(id); return el ? [rect(el).cx, rect(el).cy] : null; };

    const snaps = {};
    window.__sfSnaps = snaps;
    window.__sfSnap = async (name) => {
      if (name === 'pressHiddenHandle') {
        // The back door: `hidden` removes reach, not the handler. A press
        // dispatched at a hidden handle must not resize anything. Synthetic on
        // purpose — a hidden element cannot be pressed through real input, and
        // "we removed the affordance" is untested until the app REFUSES.
        const el = box.querySelector('.handle[data-handle="se"]');
        const before = { w: st().w, h: st().h, rot: st().rot || 0, undo: app.store._undo.length };
        if (!el) { snaps[name] = { missing: true, before }; return true; }
        const o = { bubbles: true, cancelable: true, pointerId: 91, isPrimary: true, pointerType: 'mouse' };
        const at = window.__sfAt(1, 1);   // the SE corner of the frame — not the handle
                                          // element, which still has a rect while hidden
        el.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: at[0], clientY: at[1] }));
        el.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: at[0] + 40, clientY: at[1] + 40 }));
        el.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: at[0] + 40, clientY: at[1] + 40 }));
        await sleep(120);
        snaps[name] = { before, after: { w: st().w, h: st().h, rot: st().rot || 0, undo: app.store._undo.length },
                        hiddenAtPress: el.hidden, display: getComputedStyle(el).display,
                        handles: handleDisplays() };
        return true;
      }
      snaps[name] = {
        box: rect(box), w: st().w, h: st().h, rot: st().rot || 0, cx: st().cx, cy: st().cy,
        undo: app.store._undo.length,
        movePressed: modeMove.getAttribute('aria-pressed'),
        resizePressed: modeResize.getAttribute('aria-pressed'),
        handles: handleDisplays(), stem: stemDisplay(), hint: hint.textContent,
      };
      return true;
    };

    // ---- phase 2 reader: is the sticker now inside the blocking band? ---------
    window.__sfRead = () => {
      const out = { steps: [] };
      const before = window.__sfShrinkBefore;
      const b = rect(box);
      const shrinkK = before.w ? st().w / before.w : undefined;
      const asp = (r1) => (r1.h ? r1.box.w / r1.box.h : undefined);
      const aspKept = Math.abs(asp({ box: b, h: st().h }) / asp(before) - 1) < 0.05;
      // A handle drag that "did not throw" proves nothing: require the box to have
      // actually shrunk, keep its pixel aspect, and land as ONE undo step.
      out.resizeModeHandleDragResizes = shrinkK !== undefined && shrinkK < 0.6 && aspKept
        && app.store._undo.length === before.undo + 1;
      out.steps.push(['shrink', { fromW: before.w, toW: st().w, shrinkK: aspKept, undo: [before.undo, app.store._undo.length] }]);

      // Arm phase 3: the real mode click, the two Move-mode drags, the back door
      // and the two mode keys.
      window.__sfNextInput = [
        { t: 'read', name: 'resizeOn' },
        { t: 'click', fns: ["window.__sfModeBtn('mode-move')"], ms: 220 },
        { t: 'read', name: 'moveOn' },
        // THE DEFECT: at this size the old chrome covered the interior and the
        // press landed on handle:w. In Move mode the press must reach the canvas
        // and drag the sticker.
        { t: 'drag', fns: ['window.__sfAt(0.5, 0.5)', 'window.__sfAtOff(0.5, 0.5, 0, -14)'], steps: 8, ms: 320 },
        { t: 'read', name: 'tinyMoved' },
        // Same size, same gesture, aimed at the corner the SE handle occupies in
        // Resize mode: it must MOVE and must not resize or rotate.
        { t: 'drag', fns: ['window.__sfAt(0.88, 0.88)', 'window.__sfAtOff(0.88, 0.88, -14, -14)'], steps: 8, ms: 320 },
        { t: 'read', name: 'cornerMoved' },
        { t: 'read', name: 'pressHiddenHandle' },
        { t: 'key', key: 'r', code: 'KeyR', vk: 82, text: 'r', ms: 220 },
        { t: 'read', name: 'keyR' },
        { t: 'key', key: 'm', code: 'KeyM', vk: 77, text: 'm', ms: 220 },
        { t: 'read', name: 'keyM' },
      ];
      return JSON.stringify(out);
    };

    // ---- phase 3 reader ------------------------------------------------------
    window.__sfReadTouch = () => {
      const s = window.__sfSnaps || {};
      const out = { steps: [] };
      const need = ['resizeOn', 'moveOn', 'tinyMoved', 'cornerMoved', 'pressHiddenHandle', 'keyR', 'keyM'];
      const missing = need.filter((k) => !s[k]);
      if (missing.length) { out.steps.push(['missingSnaps', missing]); return JSON.stringify(out); }

      // The mode switch is VIEW state: measured across `resizeOn` -> click(move)
      // -> `moveOn`, which is a mode switch and nothing else. (Comparing the run's
      // first snapshot instead would fold the shrink's own undo entry into it.)
      out.modeSwitchIsViewOnly = s.resizeOn.undo === s.moveOn.undo
        && s.resizeOn.w === s.moveOn.w && s.resizeOn.h === s.moveOn.h && s.resizeOn.rot === s.moveOn.rot
        && s.resizeOn.cx === s.moveOn.cx && s.resizeOn.cy === s.moveOn.cy
        && s.resizeOn.box.w === s.moveOn.box.w && s.resizeOn.box.h === s.moveOn.box.h
        && s.resizeOn.resizePressed === 'true' && s.moveOn.movePressed === 'true'
        && shown(s.resizeOn.handles) && none(s.moveOn.handles);

      // The reported bug. Guarded on the size the blocking band was measured in: a
      // drag that left a 70 px box would say nothing about the defect.
      const smallW = s.moveOn.box.w;
      const moveY = s.tinyMoved.box.cy - s.moveOn.box.cy;
      out.dragMovesAnySizeSticker = smallW <= 32 && moveY <= -8
        && Math.abs(s.tinyMoved.box.cx - s.moveOn.box.cx) <= 3
        && s.tinyMoved.undo === s.moveOn.undo + 1;

      // "In place of sizing and rotating handles": at the corner the SE handle
      // occupies in Resize mode, a Move-mode drag translates — no resize, no
      // rotation, and it still commits exactly one undo step.
      const rotSame = Math.abs((s.cornerMoved.rot || 0) - (s.tinyMoved.rot || 0)) < 1e-9;
      const sizeSame = Math.abs(s.cornerMoved.w - s.tinyMoved.w) < 1e-9 && Math.abs(s.cornerMoved.h - s.tinyMoved.h) < 1e-9;
      const moved = Math.hypot(s.cornerMoved.box.cx - s.tinyMoved.box.cx, s.cornerMoved.box.cy - s.tinyMoved.box.cy) > 6;
      out.moveModeDragDoesNotRotate = rotSame && sizeSame && moved
        && s.cornerMoved.undo === s.tinyMoved.undo + 1;

      const bh = s.pressHiddenHandle;
      out.hiddenHandleRefusesActivation = !!bh && !bh.missing && bh.hiddenAtPress === true
        && bh.display === 'none'
        && bh.after.w === bh.before.w && bh.after.h === bh.before.h
        && bh.after.rot === bh.before.rot && bh.after.undo === bh.before.undo
        && none(bh.handles);

      out.keyboardSwitchesMode = s.keyR.resizePressed === 'true' && shown(s.keyR.handles)
        && s.keyR.stem !== 'none'
        && s.keyM.movePressed === 'true' && none(s.keyM.handles) && s.keyM.stem === 'none'
        && s.keyR.undo === s.keyM.undo && s.keyM.hint !== s.keyR.hint;

      out.steps.push(['modes', { resizeOn: [s.resizeOn.resizePressed, s.resizeOn.handles[0].d, s.resizeOn.stem],
                                 moveOn: [s.moveOn.movePressed, s.moveOn.handles[0].d, s.moveOn.stem],
                                 keyR: [s.keyR.resizePressed, s.keyR.handles[0].d], keyM: [s.keyM.movePressed, s.keyM.handles[0].d] }]);
      out.steps.push(['sizes', { moveOnW: smallW, tinyW: s.tinyMoved.box.w, tinyH: s.tinyMoved.box.h, cornerW: s.cornerMoved.box.w }]);
      out.steps.push(['tinyMove', { moveY, moveX: s.tinyMoved.box.cx - s.moveOn.box.cx, undo: [s.moveOn.undo, s.tinyMoved.undo] }]);
      out.steps.push(['cornerMove', { rotSame, sizeSame, moved, undo: s.cornerMoved.undo }]);
      out.steps.push(['hiddenHandle', { before: bh && bh.before, after: bh && bh.after, hidden: bh && bh.hiddenAtPress, display: bh && bh.display }]);
      out.steps.push(['hint', { move: s.moveOn.hint, resize: s.keyR.hint }]);
      return JSON.stringify(out);
    };

    log('armed', { nextDrag: r.nextDrag, moveHandles: moveDisplays.length });
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()