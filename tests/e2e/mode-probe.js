// Move/Resize modes probe. The selected sticker has an explicit mode — Move or
// Resize — chosen from the pad's mode row, so the 8 resize handles and the rotate
// handle are no longer always-on chrome.
//
// Why it exists: at and below ~32 CSS px the 8 handles' hit areas cover the
// sticker's whole interior (measured by diag-small-sticker-probe: free at 36 px,
// blocked at 30, the centre press landing on handle:w), so a move drag is
// impossible. The pad (option 6) made a tiny sticker movable by ARROWS; the mode
// pair makes the DIRECT gesture work at any size, and keeps the handles out of
// the way the rest of the time.
//
// Criteria are declared false up front and overwritten by the input phase, so a
// phase that never runs leaves them FAILING instead of absent (an absent
// criterion would report "10/10 passed" for work that was never measured).
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);

  const rect = (el) => {
    const b = el.getBoundingClientRect();
    return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height,
             cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
  };

  // Declared before anything runs.
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

    // ---- the chrome itself, before anything is selected -----------------------
    const modeMove = document.getElementById('mode-move');
    const modeResize = document.getElementById('mode-resize');
    const hiddenWithNoSelection = !!pad && pad.hidden === true;
    const padWasHidden = !!pad && !!modeMove && !!modeResize;
    log('controls', { pad: !!pad, modeMove: !!modeMove, modeResize: !!modeResize,
                      padHiddenBefore: pad ? pad.hidden : null });

    // One sticker, placed with a real press/release on the canvas (the app's own
    // placement path).
    const cr = rect(canvas);
    const tap = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse',
                  clientX: cr.l + cr.w * 0.5, clientY: cr.t + cr.h * 0.35 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', tap));
    canvas.dispatchEvent(new PointerEvent('pointerup', tap));
    await sleep(300);

    const placed = app.store.state.stickers.length === 1;
    r.modeControlAppearsWithSelection = hiddenWithNoSelection && padWasHidden && placed
      && pad.hidden === false
      && modeMove.getAttribute('aria-pressed') === 'true'
      && modeResize.getAttribute('aria-pressed') === 'false';

    if (!placed || !modeMove || !modeResize) {
      log('bail', ['no sticker, or no mode control in the DOM']);
      return JSON.stringify(r);
    }

    // ---- helpers the input plan resolves LIVE at dispatch time ---------------
    // Every endpoint is computed from the page when the step fires: the box moves
    // (mode switches, drags), so a coordinate baked at arm time can land on
    // nothing and read as a failure of the app.
    const handleDisplays = () => [...document.querySelectorAll('#select-box .handle')]
      .map((el) => ({ h: el.dataset.handle, d: getComputedStyle(el).display, hidden: el.hidden }));
    const stemDisplay = () => getComputedStyle(box, '::after').display;
    const st = () => app.store.state.stickers[0];

    window.__sfBox = () => rect(box);
    window.__sfModeBtn = (id) => { const el = document.getElementById(id); return el ? (() => { const b = rect(el); return [b.cx, b.cy]; })() : null; };
    // Points as FRACTIONS of the frame rect, resolved from the page when the step
    // fires. The frame moves (mode switches, drags), so a coordinate baked at arm
    // time can land on nothing and read as a failure of the app.
    window.__sfAt = (fx, fy) => { const b = rect(box); return [b.l + b.w * fx, b.t + b.h * fy]; };
    window.__sfAtOff = (fx, fy, dx, dy) => { const b = rect(box); return [b.l + b.w * fx + dx, b.t + b.h * fy + dy]; };
    // An ABSOLUTE point measured from the frame's own top-left. The shrink target
    // is absolute on purpose: a fraction of the current box depends on the initial
    // sticker size, and landing a few px above the 32 px band would leave the
    // defect's precondition unmet while the criteria still reported numbers.
    window.__sfAtAbs = (dx, dy) => { const b = rect(box); return [b.l + dx, b.t + dy]; };

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
        const at = window.__sfAt(1, 1);   // the SE corner: the frame rect, not the
                                          // handle element (a hidden handle still
                                          // has a rect — that is the trap here)
        el.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: at[0], clientY: at[1] }));
        el.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: at[0] + 40, clientY: at[1] + 40 }));
        el.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: at[0] + 40, clientY: at[1] + 40 }));
        await sleep(120);
        snaps[name] = { before, after: { w: st().w, h: st().h, rot: st().rot || 0, undo: app.store._undo.length },
                        hiddenAtPress: el.hidden, display: getComputedStyle(el).display };
        return true;
      }
      snaps[name] = {
        box: rect(box), w: st().w, h: st().h, rot: st().rot || 0,
        undo: app.store._undo.length,
        movePressed: modeMove.getAttribute('aria-pressed'),
        resizePressed: modeResize.getAttribute('aria-pressed'),
        handles: handleDisplays(), stem: stemDisplay(), hint: document.getElementById('stage-hint').textContent,
      };
      return true;
    };

    window.__sfNextInput = [
      { t: 'read', name: 't0' },
      { t: 'click', fns: ["window.__sfModeBtn('mode-resize')"], ms: 200 },
      { t: 'read', name: 'resizeOn' },
      // Shrink the sticker with the SE handle to inside the blocking band. A
      // corner drag targets the CORNER (the NW corner is pinned): a centre
      // target silently leaves a box too big to test the defect. The target is
      // the frame's own left+22 — the pad probe's proven ~22 px trick, which
      // lands inside the band whatever the initial size is.
      { t: 'drag', fns: ['window.__sfAt(1, 1)', 'window.__sfAtAbs(22, 22)'], steps: 8, ms: 300 },
      { t: 'read', name: 'small' },
      { t: 'click', fns: ["window.__sfModeBtn('mode-move')"], ms: 200 },
      { t: 'read', name: 'moveOn' },
      // THE DEFECT: at this size the old chrome covered the interior and the
      // press landed on handle:w. In Move mode the press must reach the canvas
      // and drag the sticker.
      { t: 'drag', fns: ['window.__sfAt(0.5, 0.5)', 'window.__sfAtOff(0.5, 0.5, 0, -14)'], steps: 8, ms: 300 },
      { t: 'read', name: 'tinyMoved' },
      // Same size, same gesture, aimed at the corner the SE handle occupies in
      // Resize mode: it must MOVE and must not resize or rotate.
      { t: 'drag', fns: ['window.__sfAt(0.94, 0.94)', 'window.__sfAtOff(0.94, 0.94, -14, -14)'], steps: 8, ms: 300 },
      { t: 'read', name: 'cornerMoved' },
      { t: 'read', name: 'pressHiddenHandle' },
      { t: 'key', key: 'r', code: 'KeyR', vk: 82, text: 'r', ms: 200 },
      { t: 'read', name: 'keyR' },
      { t: 'key', key: 'm', code: 'KeyM', vk: 77, text: 'm', ms: 200 },
      { t: 'read', name: 'keyM' },
    ];

    window.__sfReadTouch = () => {
      const s = window.__sfSnaps || {};
      const out = { steps: [] };
      const need = ['t0', 'resizeOn', 'small', 'moveOn', 'tinyMoved', 'cornerMoved', 'pressHiddenHandle', 'keyR', 'keyM'];
      const missing = need.filter((k) => !s[k]);
      if (missing.length) { out.steps.push(['missingSnaps', missing]); return JSON.stringify(out); }

      const none = (snap) => snap.handles.length === 9 && snap.handles.every((h) => h.d === 'none');
      const shown = (snap) => snap.handles.length === 9 && snap.handles.every((h) => h.d !== 'none');

      out.moveModeHidesEveryHandle = none(s.t0) && none(s.moveOn) && none(s.tinyMoved);
      out.moveModeHidesTheRotateStem = s.t0.stem === 'none' && s.moveOn.stem === 'none';
      out.resizeModeRevealsEveryHandle = shown(s.resizeOn) && s.resizeOn.stem !== 'none'
        && !['t0', 'moveOn'].some((k) => shown(s[k]));

      // Shrink: the handle drag must have changed the box (not just "not thrown"),
      // and kept the pixel aspect — the criterion a dead drag cannot satisfy.
      const shrinkK = s.resizeOn.w ? s.small.w / s.resizeOn.w : undefined;
      const aspect = (snap) => (snap.h ? snap.box.w / snap.box.h : undefined);
      const aspKept = s.moveOn && s.resizeOn ? Math.abs(aspect(s.small) / aspect(s.resizeOn) - 1) < 0.05 : false;
      out.resizeModeHandleDragResizes = shrinkK !== undefined && shrinkK < 0.6 && aspKept
        && s.small.undo === s.resizeOn.undo + 1;

      // The reported bug. Guarded on the size the blocking band was measured in:
      // if the drag left a 70 px box, "it moved" says nothing about the defect.
      const smallW = s.small.box.w;
      const moveY = s.tinyMoved.box.cy - s.small.box.cy;
      out.dragMovesAnySizeSticker = smallW <= 32 && Math.abs(moveY + 14) <= 3
        && s.tinyMoved.undo === s.small.undo + 1;

      // "In place of sizing and rotating handles": at the corner the SE handle
      // occupies in Resize mode, a Move-mode drag translates — no resize, no
      // rotation.
      const rotSame = Math.abs((s.cornerMoved.rot || 0) - (s.tinyMoved.rot || 0)) < 1e-9;
      const sizeSame = Math.abs(s.cornerMoved.w - s.tinyMoved.w) < 1e-9 && Math.abs(s.cornerMoved.h - s.tinyMoved.h) < 1e-9;
      const moved = Math.hypot(s.cornerMoved.box.cx - s.tinyMoved.box.cx, s.cornerMoved.box.cy - s.tinyMoved.box.cy) > 6;
      out.moveModeDragDoesNotRotate = rotSame && sizeSame && moved;

      // The back door, one measurement at a time (no unconditional undo step:
      // this repo has already been bitten by a silent no-op making a probe
      // destructive).
      const bh = s.pressHiddenHandle;
      out.hiddenHandleRefusesActivation = !!bh && !bh.missing && bh.hiddenAtPress === true
        && bh.display === 'none'
        && bh.after.w === bh.before.w && bh.after.h === bh.before.h
        && bh.after.rot === bh.before.rot && bh.after.undo === bh.before.undo;

      // A mode switch is VIEW state: no document change, no undo entry.
      out.modeSwitchIsViewOnly = s.t0.undo === s.moveOn.undo
        && s.t0.w === s.moveOn.w && s.t0.h === s.moveOn.h && s.t0.rot === s.moveOn.rot
        && s.t0.box.w === s.moveOn.box.w && s.t0.box.h === s.moveOn.box.h
        && s.t0.movePressed === 'true' && s.resizeOn.resizePressed === 'true';

      out.keyboardSwitchesMode = s.keyR.resizePressed === 'true' && shown(s.keyR)
        && s.keyM.movePressed === 'true' && none(s.keyM)
        && s.keyR.undo === s.keyM.undo;

      out.steps.push(['modes', { t0: [s.t0.movePressed, s.t0.handles[0].d], resizeOn: [s.resizeOn.resizePressed, s.resizeOn.handles[0].d],
                                 moveOn: [s.moveOn.movePressed, s.moveOn.handles[0].d], stem: [s.t0.stem, s.resizeOn.stem] }]);
      out.steps.push(['sizes', { start: s.resizeOn.box.w, small: smallW, shrinkK }]);
      out.steps.push(['tinyMove', { moveY, undo: [s.small.undo, s.tinyMoved.undo] }]);
      out.steps.push(['cornerMove', { rotSame, sizeSame, moved }]);
      out.steps.push(['hiddenHandle', { before: bh && bh.before, after: bh && bh.after, hidden: bh && bh.hiddenAtPress }]);
      out.steps.push(['keys', { r: s.keyR.resizePressed, m: s.keyM.movePressed }]);
      out.steps.push(['hint', { move: s.t0.hint, resize: s.resizeOn.hint }]);
      return JSON.stringify(out);
    };

    log('armed', true);
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()