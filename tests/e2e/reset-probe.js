// Gate — "Start over": the control that gives INSTALLED mode what a page reload gives a browser.
//
// In a browser you can refresh: the photo and the stickers live in memory only, so a reload IS a
// reset. An installed app has no browser chrome at all — no reload button, no address bar — so
// once a photo is loaded the empty stage (the only place "choose a photo" lives) is unreachable,
// and the only re-pick paths left are drag-and-drop and "keep this layout → next photo", which
// deliberately keeps the stickers. This gate covers the replacement control.
//
// The criterion that matters is not "a button exists" — it is that a reset is COMPLETE. The
// controller holds 24 mutable fields and the dangerous ones are invisible: leave `pendingLayout`
// set and the next photo silently inherits the old photo's sticker layout. So the probe captures a
// VIRGIN-STATE SIGNATURE before any photo is loaded, does as much as it can to the app, presses
// Start over, and diffs the signature field by field. A forgotten field therefore fails the gate
// and NAMES ITSELF in the report, which is what makes this worth more than a hand-written list.
//
// Two deliberate limits:
//  * The harness releases every pointer before the next step (run.py's click/move/hold all press
//    and release), so a live gesture cannot span steps from the desktop path. The mid-gesture
//    refusal is therefore exercised by seeding the app's own PointerTracker — the exact predicate
//    the guard reads — rather than by a second finger, which exists only under touch emulation.
//  * The button is pressed twice on purpose: it arms, then discards. A single press that wiped the
//    photo and every sticker would be one-tap data loss on a touch screen, and this app already
//    warns before losing work elsewhere (the update bar relabels itself rather than acting blind).
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);

  r.startOverControlExists = false;
  r.startOverIsDisabledWithNoPhoto = false;
  r.startOverIsEnabledWithAPhoto = false;
  r.firstPressOnlyArmsAndDiscardsNothing = false;
  r.resetReturnsToTheVirginState = false;
  r.resetIsRefusedWhileAGestureIsLive = false;
  r.photoAfterResetStartsClean = false;

  // One definition, used twice: called here so the signature exists for the virgin capture, and
  // handed to the step list as SOURCE (`String(fn)`) so the same hooks exist in the document the
  // steps end in. No duplicated copy of the signature to drift.
  const installHooks = () => {
    const app = () => window.__stickerface;
    const $ = (id) => document.getElementById(id);
    // Everything the app looks like when nothing has ever been loaded. Only values a fresh page
    // has, so "equals virgin" is a claim about completeness, not about one particular field. The
    // canvas BACKING size is deliberately out: it starts at the element default and nothing can
    // see it once the wrap is hidden.
    window.__sfSig = () => {
      const a = app();
      return {
        emptyVisible: !$('stage-empty').hidden,
        wrapHidden: $('canvas-wrap').hidden,
        hintHidden: $('stage-hint').hidden,
        selectBoxHidden: $('select-box').hidden,
        padHidden: $('sticker-pad').hidden,
        layerEmptyVisible: !$('layer-empty').hidden,
        layerRows: document.querySelectorAll('#layer-list .layer-row').length,
        undoDisabled: $('btn-undo').disabled,
        redoDisabled: $('btn-redo').disabled,
        pngDisabled: $('btn-export-png').disabled,
        applyNextDisabled: $('btn-apply-next').disabled,
        startOverDisabled: $('btn-start-over') ? $('btn-start-over').disabled : 'MISSING',
        stickers: a.store.state.stickers.length,
        selection: a.store.state.selection,
        view: JSON.stringify(a.view),
        pendingLayout: a.pendingLayout === null ? 'null' : 'SET',
        pointers: $('stage-canvas').dataset.pointers,
        padStep: a._padStep,
        tool: a.store.state.tool,
        imageLoaded: !!a.image,
      };
    };
    window.__sfStash = () => JSON.parse(sessionStorage.getItem('sf-reset-probe') || '{}');
    window.__sfSave = (stash) => sessionStorage.setItem('sf-reset-probe', JSON.stringify(stash));

    window.__sfSnap = async (name) => {
      const a = app();
      const stash = window.__sfStash();
      if (name === 'mutated') {
        stash.mutated = { sig: window.__sfSig() };
      } else if (name === 'gesturing') {
        // A live contact, recorded the way the app records its own: the tracker IS the state.
        const before = window.__sfSig();
        a._pointers.add(9001, 10, 10);
        const accepted = typeof a.resetSession === 'function' ? a.resetSession() : null;
        const after = window.__sfSig();
        a._pointers.clear();
        $('stage-canvas').dataset.pointers = '0';
        stash.gesture = {
          hasResetMethod: typeof a.resetSession === 'function',
          accepted,
          photoSurvived: after.imageLoaded === true,
          untouched: JSON.stringify(after) === JSON.stringify(before),
        };
      } else if (name === 'armed') {
        const btn = $('btn-start-over');
        stash.armed = {
          sig: window.__sfSig(),
          label: btn ? (btn.textContent || '').trim() : null,
          imageLoaded: !!a.image,
          stickers: a.store.state.stickers.length,
        };
      } else if (name === 'afterReset') {
        stash.afterReset = { sig: window.__sfSig() };
      } else if (name === 'reloaded') {
        // Load a photo again through the empty state the reset restored — the "load new image" verb.
        const res = await fetch('tests/e2e/fixture.jpg?cb=' + Date.now(), { cache: 'no-store' });
        const blob = await res.blob();
        const dtr = new DataTransfer();
        dtr.items.add(new File([blob], 'again.jpg', { type: 'image/jpeg' }));
        const input = $('file-input');
        input.files = dtr.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        for (let i = 0; i < 80 && $('canvas-wrap').hidden; i++) await new Promise((s) => setTimeout(s, 100));
        stash.reloaded = {
          canvasVisible: !$('canvas-wrap').hidden,
          stickers: a.store.state.stickers.length,
          pendingLayoutSet: a.pendingLayout !== null,
          layerRows: document.querySelectorAll('#layer-list .layer-row').length,
        };
      }
      window.__sfSave(stash);
      return true;
    };

    window.__sfReadTouch = () => {
      const stash = window.__sfStash();
      const virgin = stash.virgin || {};
      const after = (stash.afterReset || {}).sig || {};
      const mutated = (stash.mutated || {}).sig || {};
      const armed = stash.armed || {};
      const gesture = stash.gesture || {};
      const reloaded = stash.reloaded || {};
      // The diff, and the reason this gate earns its weight: a reset that forgets a field fails
      // here, and the report names the field.
      const diff = Object.keys(virgin).filter(
        (k) => JSON.stringify(virgin[k]) !== JSON.stringify(after[k]),
      );
      return JSON.stringify({
        steps: [['virgin', virgin], ['mutated', mutated], ['armed', armed], ['gesture', gesture],
          ['afterReset', after], ['reloaded', reloaded], ['virginDiff', diff]],
        errors: [],
        startOverControlExists: stash.controlExists === true,
        startOverIsDisabledWithNoPhoto: virgin.startOverDisabled === true,
        startOverIsEnabledWithAPhoto: mutated.startOverDisabled === false,
        // `controlExists` is part of the claim: with no button at all, "the label is not the
        // resting label" and "nothing changed" are both true for the wrong reason.
        firstPressOnlyArmsAndDiscardsNothing: stash.controlExists === true
          && armed.imageLoaded === true
          && armed.stickers === mutated.stickers
          && typeof armed.label === 'string' && armed.label.length > 0 && armed.label !== 'Start over'
          && JSON.stringify(armed.sig) === JSON.stringify(mutated),
        // The control must exist, or "the signature matches" is vacuous — both sides would read
        // MISSING and the diff would be empty. Measured, not assumed.
        resetReturnsToTheVirginState: stash.controlExists === true && diff.length === 0,
        resetIsRefusedWhileAGestureIsLive: gesture.hasResetMethod === true
          && gesture.accepted === false
          && gesture.photoSurvived === true
          && gesture.untouched === true,
        photoAfterResetStartsClean: reloaded.canvasVisible === true
          && reloaded.stickers === 0
          && reloaded.pendingLayoutSet === false
          && reloaded.layerRows === 0,
      });
    };
    return [1, 1];
  };

  try {
    installHooks();
    const canvasCentre = () => {
      const c = document.getElementById('stage-canvas').getBoundingClientRect();
      return [c.left + c.width / 2, c.top + c.height / 2];
    };
    // Absent control: aim at the canvas centre so the RED run stays readable and the criteria
    // simply stay false, rather than the step exploding.
    window.__sfAtButton = () => {
      const b = document.getElementById('btn-start-over');
      if (!b || b.hidden) return canvasCentre();
      const q = b.getBoundingClientRect();
      return [q.left + q.width / 2, q.top + q.height / 2];
    };
    window.__sfAt = (dx, dy) => {
      const c = document.getElementById('stage-canvas').getBoundingClientRect();
      return [c.left + c.width / 2 + dx, c.top + c.height / 2 + dy];
    };
    window.__sfAtPad10 = () => {
      const b = document.getElementById('pad-step-10');
      const q = b.getBoundingClientRect();
      return [q.left + q.width / 2, q.top + q.height / 2];
    };
    // The carried layout is the field with a silent consequence (the next photo inherits it) and
    // the only one no step can reach: the UI path to it clicks a file input, which opens a native
    // dialog. Seeded directly, then asserted gone — documented rather than pretended.
    window.__sfSeedPending = () => {
      window.__stickerface.pendingLayout = [{
        id: 'seed', kind: 'emoji', src: 'seed/a.svg', cx: 0.5, cy: 0.5,
        size: 0.2, rot: 0, z: 0, strength: 0, radius: 0.5,
      }];
      return [1, 1];
    };

    const virgin = window.__sfSig();
    const controlExists = !!document.getElementById('btn-start-over');
    log('atBoot', { controlExists, startOverDisabled: virgin.startOverDisabled });
    window.__sfSave({ virgin, controlExists });
    r.startOverControlExists = controlExists;
    r.startOverIsDisabledWithNoPhoto = virgin.startOverDisabled === true;

    const res = await fetch(`tests/e2e/fixture.jpg?cb=${Date.now()}`, { cache: 'no-store' });
    const blob = await res.blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'fixture.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 80 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);
    log('photoLoaded', { visible: !document.getElementById('canvas-wrap').hidden });

    window.__sfNextInput = [
      { t: 'click', fns: ['window.__sfAt(0, 0)'], ms: 90 },        // a real click places sticker 1
      { t: 'click', fns: ['window.__sfAt(150, -120)'], ms: 140 },  // clear of sticker 1: a 2nd sticker
      { t: 'click', fns: ['window.__sfAtPad10()'], ms: 80 },       // pad step 10: a pure-UI field
      { t: 'move', fns: ['window.__sfSeedPending()'] },            // the carried layout (see above)
      { t: 'read', name: 'mutated' },
      { t: 'read', name: 'gesturing' },                            // the guard, before the reset
      { t: 'click', fns: ['window.__sfAtButton()'], ms: 120 },     // press 1: arms
      { t: 'read', name: 'armed' },
      { t: 'click', fns: ['window.__sfAtButton()'], ms: 200 },     // press 2: discards
      { t: 'settle', ms: 400 },
      { t: 'read', name: 'afterReset' },
      { t: 'read', name: 'reloaded' },
      // The hooks again, in whatever document this ends in.
      { t: 'move', fns: [`(${String(installHooks)})()`] },
    ];
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
