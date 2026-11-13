// Gate: the Layers list as a sticker selector.
//
// Three asks, one list: rows read TOPMOST-FIRST (today they are bottom-first, so
// the ⤴ glyph contradicts its own motion), the section collapses, and a row can be
// dragged to restack.
//
// What this measures, and why the shapes are what they are:
//   * `dragReordersPixels` reads the CANVAS, not the store. A state-only assertion
//     would pass a build that reorders the array and paints nothing — the repo's
//     standing rule is that ordering is only proven by the pixels.
//   * The two probe stickers are Twemoji's black and white large squares (2b1b /
//     2b1c): solid tiles, so a single centre pixel is unambiguously one or the
//     other and order is decidable without a threshold.
//   * Every criterion is declared FALSE up front. A phase that never runs (no
//     grip yet, no disclosure yet) must leave its criterion failing rather than
//     absent, or a missing measurement reads as "not applicable".
//   * `dragWorksWithTouch` needs real touch input, which only exists under
//     E2E_MOBILE=1; a desktop run reports 7/8 with it failing by design. CI runs
//     this probe in mobile mode.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);

  r.topmostIsFirstRow = false;
  r.arrowsMatchVisualOrder = false;
  r.sectionCollapses = false;
  r.dragReordersPixels = false;
  r.dragIsOneUndoStep = false;
  r.dragWorksWithTouch = false;
  r.dragDoesNotScrollPanel = false;
  r.keyboardReorderStillWorks = false;

  const BLACK = 'assets/emoji/2b1b.svg';  // black large square — solid tile
  const WHITE = 'assets/emoji/2b1c.svg';  // white large square — solid tile
  const THIRD = 'assets/emoji/1f600.svg'; // grinning face
  const LABEL = {};
  LABEL[BLACK] = 'black large square';
  LABEL[WHITE] = 'white large square';
  LABEL[THIRD] = 'grinning face';

  try {
    const app = window.__stickerface;
    const canvas = document.getElementById('stage-canvas');
    const ctx = canvas.getContext('2d');
    const list = document.getElementById('layer-list');
    const panel = document.querySelector('aside.panel');

    const rowsEls = () => Array.from(list.querySelectorAll('.layer-row'));
    const labels = () => rowsEls().map((li) => ((li.querySelector('.label') || {}).textContent || '').trim());
    const box = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { cx: b.left + b.width / 2, cy: b.top + b.height / 2, w: b.width, h: b.height };
    };
    const listVisible = () => (list.checkVisibility ? list.checkVisibility() : list.offsetParent !== null);

    // --- the fixture photo (the canvas has to be real for a pixel assertion) ---
    const blob = await (await fetch('tests/e2e/fixture.jpg?cb=' + Date.now(), { cache: 'no-store' })).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'fixture.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 100 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);
    await sleep(300);

    // --- three stickers, deterministic; the first two share a centre ---------
    const imgW = app.image.naturalWidth;
    const imgH = app.image.naturalHeight;
    const w = 0.2;
    const h = (w * imgW) / imgH;
    const CX = 0.4;
    const CY = 0.45;

    // Each square's REAL rendered colour, read with that sticker ALONE — no
    // hardcoded threshold. Twemoji's 2b1b renders (49,55,61) and 2b1c
    // (230,231,232): a channel-wise "< 60" test called the first one "other", and
    // an oracle that cannot name the colour it just drew is the oracle's bug, not
    // the app's. A measured reference also cannot drift if Twemoji ships a
    // different shade.
    const pixelRGB = () => {
      const d = ctx.getImageData(Math.round(CX * canvas.width), Math.round(CY * canvas.height), 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const probeColour = async (src) => {
      const st = app.store.add({ kind: 'emoji', src, cx: CX, cy: CY, w, h });
      app._draw();
      await sleep(250);           // the paint is rAF-coalesced: read after a frame
      const rgb = pixelRGB();
      app.store.remove(st.id);
      app._draw();
      await sleep(150);
      return rgb;
    };
    const REF = { black: await probeColour(BLACK), white: await probeColour(WHITE) };
    const meanOf = (c) => (c[0] + c[1] + c[2]) / 3;
    // Guard: if the two references were ever indistinguishable, "the pixel
    // changed" would prove nothing — so the criteria require this too.
    const refsDistinct = Math.abs(meanOf(REF.black) - meanOf(REF.white)) > 60;
    const sameAs = (rgb, ref) => !!(rgb && ref) && rgb.every((v, i) => Math.abs(v - ref[i]) <= 8);
    const pixelClass = () => {
      const rgb = pixelRGB();
      if (sameAs(rgb, REF.white)) return 'white';
      if (sameAs(rgb, REF.black)) return 'black';
      return `other(${rgb.join(',')})`;
    };

    const black = app.store.add({ kind: 'emoji', src: BLACK, cx: CX, cy: CY, w, h });
    const white = app.store.add({ kind: 'emoji', src: WHITE, cx: CX, cy: CY, w, h });
    const third = app.store.add({ kind: 'emoji', src: THIRD, cx: 0.74, cy: 0.45, w, h });
    app._draw();
    await sleep(400);

    const forwardBtn = (i) => {
      const row = rowsEls()[i];
      if (!row) return null;
      return Array.from(row.querySelectorAll('button')).find((b) => (b.title || '').startsWith('Bring')) || null;
    };
    const openBtn = () => document.querySelector('[aria-controls="layer-list"]')
      || document.querySelector('#layers-heading details > summary')
      || document.querySelector('#layers-heading button');

    // The layers section sits at the bottom of a tall panel: bring it into view
    // BEFORE measuring. Otherwise every click below lands outside the viewport,
    // the ⤴ click silently misses, and a later undo pops the `add` entry off the
    // stack — deleting a sticker and breaking every criterion downstream.
    list.scrollIntoView({ block: 'center' });
    await sleep(250);

    const arrowBtn = box(forwardBtn(1));
    const disc = box(openBtn());
    const gripEl = (i) => {
      const row = rowsEls()[i];
      return row ? row.querySelector('.grip') : null;
    };
    const grip0 = box(gripEl(1));
    const lastRow = box(rowsEls()[rowsEls().length - 1]);
    log('setup', {
      rows: labels(),
      pixel: pixelClass(),
      ids: [black.id, white.id, third.id],
      arrowBtn,
      disclosure: disc,
      grip: grip0,
      lastRow: lastRow && { cy: Math.round(lastRow.cy) },
      panel: { scrollable: panel.scrollHeight > panel.clientHeight + 1, scrollTop: panel.scrollTop },
      rowsInViewport: rowsEls().every((li) => {
        const b = li.getBoundingClientRect();
        return b.top >= 0 && b.bottom <= window.innerHeight;
      }),
      touch: navigator.maxTouchPoints > 0,
    });

    // ---- snapshot + page hooks the driver calls mid-sequence ----------------
    const snaps = {};
    window.__sfSnaps = snaps;
    const snapNow = (name) => {
      snaps[name] = {
        labels: labels(),
        pixel: pixelClass(),
        undo: app.store._undo.length,
        scrollTop: panel.scrollTop,
        rowsPresent: list.children.length,
        listVisible: listVisible(),
        ariaExpanded: discRoot ? discRoot.getAttribute('aria-expanded') : null,
        detailsOpen: discRoot && discRoot.tagName === 'DETAILS' ? discRoot.open
          : (detailsFor(openBtn()) ? detailsFor(openBtn()).open : null),
        order: app.store.state.stickers.map((s) => s.id),
      };
      return true;
    };
    const detailsFor = (el) => (el && (el.tagName === 'DETAILS' ? el : el.closest('details'))) || null;
    const discRoot = detailsFor(openBtn());

    window.__sfSnap = (name) => {
      if (name === 'reset') {
        // Force the array back to [black, white, third] through the PUBLIC API
        // that already exists (lower/raise), so the drag's precondition is
        // identical every run and independent of what the earlier steps did.
        const idx = (id) => app.store.state.stickers.findIndex((s) => s.id === id);
        let guard = 0;
        while (idx(black.id) > 0 && guard++ < 12) app.store.lower(black.id);
        guard = 0;
        while (idx(white.id) > 1 && guard++ < 12) app.store.lower(white.id);
        guard = 0;
        while (idx(third.id) < app.store.state.stickers.length - 1 && guard++ < 12) app.store.raise(third.id);
        app._draw();
      }
      if (name === 'selectWhite') app.store.select(white.id);
      return snapNow(name);
    };

    // The grip TRAVELS as rows move (a reorder rebuilds the list), and the panel
    // may scroll, so the drag endpoints are resolved from the page at dispatch
    // time rather than precomputed. Centre the LIST first — a drag needs BOTH
    // endpoints on-screen at once — and refuse a point outside the viewport: an
    // off-screen dispatch hits nothing and the gesture scrolls the panel instead.
    const onList = (fn) => { list.scrollIntoView({ block: 'center' }); return fn(); };
    const evidence = (cls, p, el) => {
      const hit = document.elementFromPoint(p[0], p[1]);
      (window.__sfPts = window.__sfPts || []).push({
        cls, p: [Math.round(p[0]), Math.round(p[1])],
        hit: hit ? `${hit.tagName}.${hit.className || ''}`.slice(0, 40) : null,
        scroll: panel.scrollTop, vh: window.innerHeight,
      });
      return p;
    };
    const onScreen = (b) => !!b && b.cy >= 0 && b.cy <= window.innerHeight;
    window.__sfGripPoint = () => onList(() => {
      const el = gripEl(1);
      const b = box(el);
      return onScreen(b) ? evidence(el.className, [b.cx, b.cy], el) : null;
    });
    window.__sfDropPoint = () => onList(() => {
      const row = rowsEls()[rowsEls().length - 1];
      const b = box(row);
      const g = box(gripEl(1));
      if (!onScreen(b) || !g) return null;
      // The pointer must stay over the GRIP for the whole gesture: the grip owns
      // the pointermove handler and there is NO pointer capture, so a path that
      // drifts sideways off it stops delivering moves and the drop never commits.
      // Measured: returning the row's centre X instead of the grip's X killed the
      // mouse reorder outright (rows unchanged, no undo entry) while the touch
      // path — which holds x fixed — still worked. Keep x on the grip.
      return evidence(row.className, [g.cx, b.cy], row);
    });

    // The disclosure's position moves when it closes: the panel's scroll clamps to
    // the shorter content, so a precomputed point for the SECOND click lands on
    // whatever slid up into that spot (measured: the second click missed, the
    // section stayed collapsed, and the rows' grips were then unmeasurable — every
    // drag criterion downstream failed). Re-centre and re-measure per click.
    window.__sfDiscPoint = () => {
      const el = openBtn();
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const b = box(el);
      return b ? [b.cx, b.cy] : null;
    };

    // --- the gesture sequence ----------------------------------------------
    const seq = [
      { t: 'settle', ms: 350 },
      { t: 'read', name: 't0' },
      // 1) the ⤴ in the SECOND visual row must move that row UP one slot
      arrowBtn ? { t: 'click', pts: [[arrowBtn.cx, arrowBtn.cy]], ms: 300 } : { t: 'settle', ms: 10 },
      { t: 'read', name: 'afterArrow' },
      // NO Ctrl+Z here. Before any reorder the top of the undo stack is an `add`,
      // so a stray undo DELETES a sticker rather than un-raising one — which is
      // exactly what the first RED run did. The reset hook re-establishes the
      // order with lower/raise, which cannot remove anything.
      { t: 'read', name: 'reset' },
      { t: 'settle', ms: 300 },
      { t: 'read', name: 'beforeDrag' },
    ];
    if (disc) {
      // 2) collapse and restore, checking the rows survive either way
      seq.push({ t: 'click', fns: ['window.__sfDiscPoint()'], ms: 350 });
      seq.push({ t: 'read', name: 'afterCollapse' });
      seq.push({ t: 'click', fns: ['window.__sfDiscPoint()'], ms: 350 });
      seq.push({ t: 'read', name: 'afterExpand' });
    }
    seq.push(
      // 3) the keyboard reorder path still restacks (regression guard)
      { t: 'read', name: 'selectWhite' },
      { t: 'key', key: ']', code: 'BracketRight', vk: 221, ms: 300 },
      { t: 'read', name: 'afterBracketRaise' },
      { t: 'key', key: 'z', code: 'KeyZ', vk: 90, modifiers: 2, ms: 300 },
      { t: 'read', name: 'afterKeyUndo' },
    );
    if (grip0 && lastRow) {
      // 4) the real drag: row 1's grip down past the last row
      seq.push({ t: 'drag', fns: ['window.__sfGripPoint()', 'window.__sfDropPoint()'], steps: 10, ms: 400 });
      seq.push({ t: 'read', name: 'afterDrag' });
      seq.push({ t: 'key', key: 'z', code: 'KeyZ', vk: 90, modifiers: 2, ms: 400 });
      seq.push({ t: 'read', name: 'afterDragUndo' });
    }
    // 5) the same gesture under a finger
    if (grip0 && lastRow && navigator.maxTouchPoints > 0) {
      const gx = grip0.cx;
      const gy = grip0.cy;
      const dy = lastRow.cy;
      seq.push({ t: 'settle', ms: 250 });
      seq.push({ t: 'read', name: 'beforeTouchDrag' });
      seq.push({ t: 'touchStart', pts: [[gx, gy]], ms: 90 });
      seq.push({ t: 'touchMove', pts: [[gx, gy + 12]], ms: 50 });
      seq.push({ t: 'touchMove', pts: [[gx, gy + 34]], ms: 50 });
      seq.push({ t: 'touchMove', pts: [[gx, dy]], ms: 60 });
      seq.push({ t: 'touchEnd', pts: [], ms: 450 });
      seq.push({ t: 'read', name: 'afterTouchDrag' });
    }
    window.__sfNextInput = seq;

    // ---- the reader --------------------------------------------------------
    window.__sfReadTouch = () => {
      const s = window.__sfSnaps || {};
      const out = { steps: [] };
      const at = (n) => s[n] || null;
      const labelsOf = (n) => (at(n) ? at(n).labels : null);
      const changed = (a, b) => !!(a && b && a.labels.join('|') !== b.labels.join('|'));

      const t0 = at('t0');
      out.topmostIsFirstRow = !!(t0 && t0.labels[0] === LABEL[THIRD] && t0.labels[2] === LABEL[BLACK]);
      out.steps.push(['rows_t0', labelsOf('t0')]);
      out.steps.push(['colour_refs', { black: REF.black, white: REF.white, distinct: refsDistinct }]);

      // The arrow must move the ROW UP the screen. This is the criterion that
      // fails while the list is still rendered bottom-first: raising the second
      // row then puts it LAST, i.e. visually down.
      const before = labelsOf('t0');
      const after = labelsOf('afterArrow');
      const iBefore = before ? before.indexOf(LABEL[WHITE]) : -1;
      const iAfter = after ? after.indexOf(LABEL[WHITE]) : -1;
      out.arrowsMatchVisualOrder = iBefore > 0 && iAfter === iBefore - 1;
      out.steps.push(['arrow_index', { before: iBefore, after: iAfter }]);

      const c0 = at('beforeDrag');
      const c1 = at('afterCollapse');
      const c2 = at('afterExpand');
      const announcement = c1 && (c1.ariaExpanded === 'false' || c1.detailsOpen === false)
        && c2 && (c2.ariaExpanded === 'true' || c2.detailsOpen === true);
      out.sectionCollapses = !!(c0 && c1 && c2
        && c1.listVisible === false && c2.listVisible === true
        && c1.rowsPresent === c0.rowsPresent && c1.rowsPresent > 0
        && announcement);
      out.steps.push(['collapse', {
        found: !!disc,
        visible: [c0 && c0.listVisible, c1 && c1.listVisible, c2 && c2.listVisible],
        rows: c1 && c1.rowsPresent,
        aria: [c1 && c1.ariaExpanded, c2 && c2.ariaExpanded],
        open: [c1 && c1.detailsOpen, c2 && c2.detailsOpen],
      }]);

      // Pixels, not state: white painted over black before, black over white after.
      const d0 = at('beforeDrag');
      const d1 = at('afterDrag');
      out.dragReordersPixels = !!(refsDistinct && d0 && d1 && d0.pixel === 'white' && d1.pixel === 'black');
      out.steps.push(['drag_pixels', { before: d0 && d0.pixel, after: d1 && d1.pixel,
        rowsBefore: labelsOf('beforeDrag'), rowsAfter: labelsOf('afterDrag') }]);

      const dUndo = at('afterDragUndo');
      const undoDelta = d0 && d1 ? d1.undo - d0.undo : undefined;
      out.dragIsOneUndoStep = !!(undoDelta === 1 && dUndo && d0
        && dUndo.labels.join('|') === d0.labels.join('|'));
      out.steps.push(['drag_undo', { delta: undoDelta, restored: dUndo && d0 ? dUndo.labels.join('|') === d0.labels.join('|') : null }]);

      const sc0 = d0 && d0.scrollTop;
      const sc1 = d1 && d1.scrollTop;
      out.dragDoesNotScrollPanel = sc0 !== undefined && sc0 === sc1;
      out.steps.push(['panel_scroll', { before: sc0, after: sc1,
        scrollable: !!(panel && panel.scrollHeight > panel.clientHeight + 1) }]);

      const kb0 = labelsOf('beforeDrag');
      const kb1 = labelsOf('afterBracketRaise');
      const kbi = kb0 ? kb0.indexOf(LABEL[WHITE]) : -1;
      const kbi2 = kb1 ? kb1.indexOf(LABEL[WHITE]) : -1;
      out.keyboardReorderStillWorks = kbi > 0 && kbi2 === kbi - 1;
      out.steps.push(['bracket_index', { before: kbi, after: kbi2 }]);

      const tb = at('beforeTouchDrag');
      const t1 = at('afterTouchDrag');
      out.dragWorksWithTouch = !!(refsDistinct && tb && t1 && tb.pixel === 'white' && t1.pixel === 'black' && changed(tb, t1));
      out.steps.push(['touch_drag', { before: tb && tb.pixel, after: t1 && t1.pixel,
        rowsBefore: labelsOf('beforeTouchDrag'), rowsAfter: labelsOf('afterTouchDrag') }]);
      out.points = window.__sfPts || [];
      out.steps.push(['points', window.__sfPts || []]);
      return JSON.stringify(out);
    };

    log('armed', { steps: window.__sfNextInput.length });
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
