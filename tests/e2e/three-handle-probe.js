// Three-handle chrome probe. The selected sticker carries exactly TWO interactive
// handles — one resize (SE corner) and one rotate (above top-centre) — plus a
// decorative move mark at the centre, because the BODY is the move handle. There is
// no mode: the chrome does not depend on a Move/Resize switch, so the whole
// "what does a press do?" question is answered by WHERE the press lands.
//
// Why the chrome can hide at all: below ~36 CSS px the SE handle's 32 px hit area
// reaches the frame's centre (the measured free-at-36 / blocked-at-30 band), so at
// that size the handles step aside — the body drag and the panel's pad take over —
// and they come back when the sticker grows. Nineteen handlers' worth of modal
// state is replaced by one threshold.
//
// Three phases, in the harness's own order:
//   1. page JS  — setup + the static claims (handle inventory, computed styles,
//                 the move mark's hit-testability, the absent mode row)
//   2. drag     — ONE real SE-handle drag (Input.dispatchMouseEvent) into the band
//   3. steps    — real clicks/holds/drags/moves: the tiny-sticker body drag, the
//                 pad regrow, and the hover cursor
// Criteria are declared false up front and overwritten by whichever phase measures
// them, so a phase that never runs leaves them FAILING instead of absent.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);

  const rect = (el) => {
    const b = el.getBoundingClientRect();
    return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height,
             cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
  };

  r.oneResizeAndOneRotateHandle = false;
  r.handlesShownWithoutAnyModeSwitch = false;
  r.modeRowIsGone = false;
  r.moveMarkIsNotAHitTarget = false;
  r.cornerDragResizesWithoutAMode = false;
  r.chromeHidesWhenFrameIsTiny = false;
  r.moveMarkHidesWhenFrameIsTiny = false;
  r.hintNamesThePadWhenChromeIsHidden = false;
  r.bodyDragMovesAtAnySize = false;
  r.regrowingRestoresTheHandles = false;
  r.hoverOverStickerSignalsMove = false;

  const FRAME_MIN_CHROME_PX = 36;   // the app's own threshold, mirrored for guards

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
    const box = document.getElementById('select-box');
    const canvas = document.getElementById('stage-canvas');
    const pad = document.getElementById('sticker-pad');
    const hint = document.getElementById('stage-hint');

    const handles = () => [...document.querySelectorAll('#select-box .handle')]
      .map((el) => ({ h: el.dataset.handle, d: getComputedStyle(el).display, hidden: el.hidden }));
    const allHidden = (d) => d.length > 0 && d.every((x) => x.d === 'none' && x.hidden === true);
    const allShown = (d) => d.length > 0 && d.every((x) => x.d !== 'none' && x.hidden === false);
    const mark = () => box.querySelector('.move-mark');
    const markDisplay = () => { const m = mark(); return m ? getComputedStyle(m).display : 'ABSENT'; };
    const st = () => app.store.state.stickers[0];

    // ---- one sticker, placed high on the canvas so the coach card (bottom-anchored)
    // never sits under the point the move mark is measured at -------------------
    const cr = rect(canvas);
    const tap = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse',
                  clientX: cr.l + cr.w * 0.5, clientY: cr.t + cr.h * 0.28 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', tap));
    canvas.dispatchEvent(new PointerEvent('pointerup', tap));
    await sleep(300);

    const placed = app.store.state.stickers.length === 1;
    const hs = handles();
    const keys = hs.map((x) => x.h).sort().join(',');
    const b0 = rect(box);

    r.oneResizeAndOneRotateHandle = placed && keys === 'rotate,se' && hs.length === 2;
    // "No mode switch" is true by construction here (this probe never presses a
    // mode control). Guarded on the frame being big enough that they MUST be out.
    r.handlesShownWithoutAnyModeSwitch = placed && allShown(hs) && Math.min(b0.w, b0.h) >= FRAME_MIN_CHROME_PX;
    r.modeRowIsGone = placed && pad.hidden === false
      && !document.getElementById('mode-move') && !document.getElementById('mode-resize');

    // The move mark is chrome, not a control: it must render, and a press at its
    // own centre must reach the CANVAS — the body is the move handle.
    const m0 = mark();
    const mr0 = m0 ? rect(m0) : null;
    const atMark = mr0 ? document.elementFromPoint(mr0.cx, mr0.cy) : null;
    r.moveMarkIsNotAHitTarget = !!mr0 && mr0.w >= 8 && mr0.h >= 8
      && atMark === canvas;
    log('static', { placed, handles: hs, frame: [Math.round(b0.w), Math.round(b0.h)],
                    mark: mr0 ? [Math.round(mr0.w), Math.round(mr0.h)] : null,
                    atMark: atMark ? (atMark.id || atMark.className) : null,
                    markDisplay: markDisplay(), hint: hint.textContent });

    if (!placed || hs.length !== 2) {
      log('bail', ['no sticker, or the chrome is not the three-handle shape']);
      return JSON.stringify(r);
    }

    // ---- phase 2: ONE real SE-handle drag, into the blocking band -------------
    // Static endpoints are safe: nothing has moved yet. The target is the frame's
    // own left+22 / top+22 — the proven ~22 px trick, which lands inside the band
    // whatever the initial sticker size is.
    r.nextDrag = { x0: b0.r, y0: b0.b, x1: b0.l + 22, y1: b0.t + 22 };
    window.__sfShrinkBefore = { w: st().w, h: st().h, box: rect(box), undo: app.store._undo.length,
                                hint: hint.textContent, mark: markDisplay() };

    // ---- phase 3 shape -------------------------------------------------------
    window.__sfAt = (fx, fy) => { const b = rect(box); return [b.l + b.w * fx, b.t + b.h * fy]; };
    window.__sfAtOff = (fx, fy, dx, dy) => { const b = rect(box); return [b.l + b.w * fx + dx, b.t + b.h * fy + dy]; };
    window.__sfPadBtn = (id) => { const el = document.getElementById(id); return el ? [rect(el).cx, rect(el).cy] : null; };

    const snaps = {};
    window.__sfSnaps = snaps;
    window.__sfSnap = async (name) => {
      snaps[name] = {
        box: rect(box), w: st().w, h: st().h, rot: st().rot || 0, cx: st().cx, cy: st().cy,
        undo: app.store._undo.length,
        handles: handles(), mark: markDisplay(), hint: hint.textContent,
        cursor: getComputedStyle(canvas).cursor,
      };
      return true;
    };

    // ---- phase 2 reader ------------------------------------------------------
    window.__sfRead = () => {
      const out = { steps: [] };
      const before = window.__sfShrinkBefore;
      const b = rect(box);
      const shrinkK = before.w ? st().w / before.w : undefined;
      const asp = (x) => (x.h ? x.box.w / x.box.h : undefined);
      const aspKept = Math.abs(asp({ box: b, h: st().h }) / asp(before) - 1) < 0.05;
      // A handle drag that merely "did not throw" proves nothing: require the box
      // to have actually shrunk, kept its pixel aspect, and landed as ONE undo step.
      out.cornerDragResizesWithoutAMode = shrinkK !== undefined && shrinkK < 0.6 && aspKept
        && app.store._undo.length === before.undo + 1;
      out.steps.push(['shrink', { fromW: Math.round(before.box.w), toW: Math.round(b.w), shrinkK, aspKept,
                                  undo: [before.undo, app.store._undo.length] }]);

      // Arm phase 3: the tiny-sticker body drag, the pad regrow, then the hover
      // cursor at both a sticker and an empty point.
      const empty = [Math.round(cr.l + 14), Math.round(cr.t + 14)];
      window.__sfNextInput = [
        { t: 'read', name: 'afterShrink' },
        // THE claim: at a size where the old chrome covered the interior, the
        // centre press must reach the canvas and move the sticker.
        { t: 'drag', fns: ['window.__sfAt(0.5, 0.5)', 'window.__sfAtOff(0.5, 0.5, 0, -14)'], steps: 8, ms: 320 },
        { t: 'read', name: 'tinyMoved' },
        // Grow it back with the panel's size button: the handles must return.
        { t: 'hold', fns: ["window.__sfPadBtn('pad-size-up')"], holdMs: 1600, ms: 300 },
        { t: 'read', name: 'afterGrow' },
        { t: 'move', fns: ['window.__sfAt(0.5, 0.5)'], ms: 220 },
        { t: 'read', name: 'hoverSticker' },
        { t: 'move', pts: [empty], ms: 220 },
        { t: 'read', name: 'hoverEmpty' },
      ];
      return JSON.stringify(out);
    };

    // ---- phase 3 reader ------------------------------------------------------
    window.__sfReadTouch = () => {
      const s = window.__sfSnaps || {};
      const out = { steps: [] };
      const need = ['afterShrink', 'tinyMoved', 'afterGrow', 'hoverSticker', 'hoverEmpty'];
      const missing = need.filter((k) => !s[k]);
      if (missing.length) { out.steps.push(['missingSnaps', missing]); return JSON.stringify(out); }

      const sides = (x) => Math.min(x.box.w, x.box.h);
      const tiny = sides(s.afterShrink);
      const grown = sides(s.afterGrow);

      out.chromeHidesWhenFrameIsTiny = tiny < FRAME_MIN_CHROME_PX && allHidden(s.afterShrink.handles);
      out.moveMarkHidesWhenFrameIsTiny = s.afterShrink.mark === 'none'
        && window.__sfShrinkBefore.mark !== 'none';
      out.hintNamesThePadWhenChromeIsHidden = tiny < FRAME_MIN_CHROME_PX
        && s.afterShrink.hint !== window.__sfShrinkBefore.hint
        && /pad|panel|arrows/i.test(s.afterShrink.hint);

      // Guarded on the size the blocking band was measured in: a drag that left a
      // 70 px box would say nothing about the defect it exists to catch.
      const moveY = s.tinyMoved.box.cy - s.afterShrink.box.cy;
      const sizeSame = Math.abs(s.tinyMoved.w - s.afterShrink.w) < 1e-9
        && Math.abs(s.tinyMoved.h - s.afterShrink.h) < 1e-9;
      const rotSame = Math.abs((s.tinyMoved.rot || 0) - (s.afterShrink.rot || 0)) < 1e-9;
      out.bodyDragMovesAtAnySize = tiny <= 32 && moveY <= -8 && sizeSame && rotSame
        && Math.abs(s.tinyMoved.box.cx - s.afterShrink.box.cx) <= 3
        && s.tinyMoved.undo === s.afterShrink.undo + 1;

      out.regrowingRestoresTheHandles = grown >= FRAME_MIN_CHROME_PX && grown > tiny
        && allShown(s.afterGrow.handles) && s.afterGrow.mark !== 'none';

      // The body is the move handle, so the cursor is its only desktop affordance.
      out.hoverOverStickerSignalsMove = s.hoverSticker.cursor === 'move'
        && s.hoverEmpty.cursor !== 'move';

      out.steps.push(['afterShrink', { sides: tiny, handles: s.afterShrink.handles, mark: s.afterShrink.mark,
                                       hint: s.afterShrink.hint }]);
      out.steps.push(['tinyMove', { moveY, sizeSame, rotSame, undo: [s.afterShrink.undo, s.tinyMoved.undo] }]);
      out.steps.push(['afterGrow', { sides: grown, handles: s.afterGrow.handles, mark: s.afterGrow.mark }]);
      out.steps.push(['cursors', { overSticker: s.hoverSticker.cursor, overEmpty: s.hoverEmpty.cursor }]);
      return JSON.stringify(out);
    };

    log('armed', { nextDrag: r.nextDrag, handles: hs.length });
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
