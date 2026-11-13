// Selected-sticker pad probe. The pad exists so a sticker rendered below ~32 CSS
// px can still be moved and resized: at that size the 8 handles' hit areas cover
// the sticker's whole interior (measured — free at 36 px, blocked at 30, the
// centre press landing on handle:w), so a move drag is impossible.
//
// Every pad action here uses REAL browser input at the button's own coordinates,
// which is also the proof that the button is hittable rather than covered.
//
// Criteria are declared false up front and overwritten by the input phase, so a
// phase that never runs leaves them FAILING instead of absent (an absent
// criterion would report "5/5 passed" for work that was never measured).
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);

  const rect = (el) => {
    const b = el.getBoundingClientRect();
    return { l: b.left, t: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
  };

  // Declared before anything runs: a probe that never reaches the input phase
  // must not look like a pass.
  r.nudgeMovesSticker = false;
  r.nudgeIsOneUndoStep = false;
  r.stepToggleChangesDistance = false;
  r.sizeButtonsScaleBox = false;
  r.tinyStickerIsMovable = false;

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

    // Nothing selected yet: the pad must not be showing.
    const hiddenWithNoSelection = !!pad && pad.hidden === true;

    const cr = rect(canvas);
    const tap = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse',
                  clientX: cr.l + cr.w * 0.5, clientY: cr.t + cr.h * 0.4 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', tap));
    canvas.dispatchEvent(new PointerEvent('pointerup', tap));
    await sleep(250);

    const placed = app.store.state.stickers.length === 1;
    r.padExistsWithSelection = hiddenWithNoSelection && placed && !!pad && pad.hidden === false;

    const at = (id) => { const el = document.getElementById(id); return el ? rect(el) : null; };
    const up = at('pad-nudge-up'), down = at('pad-nudge-down');
    const s10 = at('pad-step-10'), sizeDown = at('pad-size-down');

    // The button must be the element AT its own centre — a pad covered by the
    // canvas would still exist and still pass a "behaviour" test driven
    // synthetically, which is the failure this criterion is here to catch.
    const owns = (id, b) => {
      if (!b) return false;
      const el = document.getElementById(id);
      const hit = document.elementFromPoint(b.cx, b.cy);
      return !!hit && (hit === el || el.contains(hit));
    };
    r.padButtonsAreHitTestable = owns('pad-nudge-up', up) && owns('pad-size-down', sizeDown);
    log('padButtons', { up, down, s10, sizeDown });

    // Without the pad (or with it unreachable) there is nothing to drive: leave
    // the input-driven criteria failing rather than throwing a null deref.
    if (!up || !down || !s10 || !sizeDown) {
      log('padMissing', ['pad-nudge-up', 'pad-nudge-down', 'pad-step-10', 'pad-size-down']
        .filter((id) => !document.getElementById(id)));
      return JSON.stringify(r);
    }

    const snaps = {};
    window.__sfSnaps = snaps;
    window.__sfSnap = async (name) => {
      if (name === 'shrink') {
        // Shrink to ~22 CSS px by dragging the SE handle. Target the box's OWN
        // left+22, not its centre: the NW corner is the pinned one, and a
        // centre target silently leaves a 70 px box that cannot fail.
        const h = box.querySelector('.handle[data-handle="se"]');
        const hb = rect(h), bb = rect(box);
        const x = bb.l + 22, y = bb.t + 22;
        const o = { bubbles: true, cancelable: true, pointerId: 71, isPrimary: true, pointerType: 'mouse' };
        h.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: hb.cx, clientY: hb.cy }));
        h.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: x, clientY: y }));
        h.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: x, clientY: y }));
        await sleep(150);
        // Same shape as every other snap: the reader addresses .box, and a flat
        // rect here made tinyStickerIsMovable unconditionally false.
        snaps.shrink = { box: rect(box), undo: app.store._undo.length };
        return true;
      }
      snaps[name] = { box: rect(box), undo: app.store._undo.length };
      return true;
    };

    window.__sfNextInput = [
      { t: 'read', name: 't0' },
      { t: 'click', pts: [[up.cx, up.cy]], ms: 140 },
      { t: 'read', name: 'afterNudge1' },
      // A held arrow: repeat must fire (so the box travels > the 1 px step) and
      // the whole hold must still be ONE undo entry.
      { t: 'hold', pts: [[down.cx, down.cy]], holdMs: 900, ms: 140 },
      { t: 'read', name: 'afterHold' },
      { t: 'click', pts: [[s10.cx, s10.cy]], ms: 140 },
      { t: 'click', pts: [[up.cx, up.cy]], ms: 140 },
      { t: 'read', name: 'afterStep10' },
      { t: 'click', pts: [[sizeDown.cx, sizeDown.cy]], ms: 180 },
      { t: 'read', name: 'afterSizeDown' },
      { t: 'read', name: 'shrink' },
      // The reported bug: at ~22 px the handles cover the sticker and a drag
      // cannot move it. The pad must not care how small the sticker is.
      { t: 'click', pts: [[up.cx, up.cy]], ms: 180 },
      { t: 'read', name: 'afterTinyNudge' },
    ];

    window.__sfReadTouch = () => {
      const s = window.__sfSnaps || {};
      const out = { steps: [] };
      const near = (a, b, tol) => a !== undefined && b !== undefined && Math.abs(a - b) <= tol;
      const d = (a, b, key) => (a && b ? b.box[key] - a.box[key] : undefined);

      const t0 = s.t0, n1 = s.afterNudge1, hold = s.afterHold;
      const st10 = s.afterStep10, sz = s.afterSizeDown, small = s.shrink, tiny = s.afterTinyNudge;

      const up1 = d(t0, n1, 't');
      const across1 = Math.abs(d(t0, n1, 'l') || 0);
      out.nudgeMovesSticker = near(up1, -1, 0.7) && across1 <= 0.7;

      const holdTravel = d(n1, hold, 't');
      const undoGrew = (n1 && hold ? hold.undo - n1.undo : undefined);
      out.nudgeIsOneUndoStep = holdTravel !== undefined && holdTravel >= 2 && undoGrew === 1;

      const up10 = d(hold, st10, 't');
      const ratio = up1 && up10 ? Math.abs(up10 / up1) : undefined;
      out.stepToggleChangesDistance = ratio !== undefined && ratio >= 8 && ratio <= 12;

      const shrinkK = st10 && sz ? sz.box.w / st10.box.w : undefined;
      const asp = (s2) => (s2 ? s2.box.w / s2.box.h : undefined);
      const aspKept = st10 && sz ? Math.abs(asp(sz) / asp(st10) - 1) < 0.03 : false;
      out.sizeButtonsScaleBox = shrinkK !== undefined && shrinkK < 0.95 && shrinkK > 0.85 && aspKept;

      // Guarded: the sticker must genuinely be at/below the blocking size, or
      // "it moved" proves nothing about the reported bug.
      const smallW = small ? small.box.w : undefined;
      const tinyMove = d(small, tiny, 't');
      out.tinyStickerIsMovable = smallW !== undefined && smallW <= 32 && tinyMove !== undefined && tinyMove <= -5;

      out.steps.push(['sizes', { t0: t0 && t0.box.w, smallW, afterSizeDown: sz && sz.box.w }]);
      out.steps.push(['nudge1', { up1, across1 }]);
      out.steps.push(['hold', { holdTravel, undoGrew }]);
      out.steps.push(['step10', { up10, ratio }]);
      out.steps.push(['sizeDown', { shrinkK, aspKept }]);
      out.steps.push(['tiny', { tinyMove, smallW }]);
      return JSON.stringify(out);
    };

    log('armed', true);
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
