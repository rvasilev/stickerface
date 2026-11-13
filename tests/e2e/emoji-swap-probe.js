// Gate: clicking a picker emoji EDITS the selected sticker.
//
// With a sticker selected, clicking a different emoji replaces that sticker's
// artwork in place — same position, size, rotation and z — instead of only arming
// the next drop. With nothing selected the click must keep its old meaning (arm
// the drop) and change nothing on the canvas.
//
// Two traps this gate exists to catch, both confirmed in source before writing it:
//   * `store.move(id, { src })` is a SILENT no-op — `_applyGeom` writes only
//     cx/cy/w/h/rot/radius/strength and `_geomChanged` returns false for a
//     src-only patch. An implementation built on `move` would look right in review
//     and do nothing at runtime. `clickSwapsSelectedSticker` reads the CANVAS, so
//     it fails for that build while a state-only assertion would pass.
//   * the layer row's VISIBLE text is the emoji's name, and the geometry fast path
//     (`change`) only rewrites the TOOLTIP — so a swap that emits `change` ships a
//     row still naming the old emoji. `layerRowLabelFollowsSwap` reads the row's
//     textContent, never `labelFor`.
//
// Every criterion is declared FALSE up front: a phase that never runs must leave
// its criterion failing rather than absent.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);

  r.clickSwapsSelectedSticker = false;
  r.geometryUnchangedBySwap = false;
  r.swapIsOneUndoStep = false;
  r.layerRowLabelFollowsSwap = false;
  r.pickerHighlightFollowsSelection = false;
  r.swapWithoutSelectionStillArms = false;
  r.swapDoesNotAddOrPlace = false;

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
    const picker = document.getElementById('emoji-picker');
    const box = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { cx: b.left + b.width / 2, cy: b.top + b.height / 2, w: b.width, h: b.height };
    };
    // Compared RELATIVE to the canvas, not to the viewport: resolving a picker
    // button's point scrolls the page (the picker now scrolls in place, so the
    // target emoji can sit outside its visible box), which moves the select box's
    // viewport rect without moving anything about the sticker. A viewport
    // comparison would read my own measurement as a geometry change.
    const rectRel = (el, ref) => {
      const b = el && el.getBoundingClientRect();
      const r0 = ref && ref.getBoundingClientRect();
      return b && r0
        ? [Math.round(b.left - r0.left), Math.round(b.top - r0.top), Math.round(b.width), Math.round(b.height)]
        : null;
    };
    const sameRect = (a, b) => !!a && !!b && a.every((v, i) => Math.abs(v - b[i]) <= 1);

    // --- fixture photo: the canvas must be real for a pixel assertion ---------
    const blob = await (await fetch('tests/e2e/fixture.jpg?cb=' + Date.now(), { cache: 'no-store' })).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'fixture.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 100 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);
    await sleep(300);

    const imgW = app.image.naturalWidth;
    const imgH = app.image.naturalHeight;
    const w = 0.18;
    const h = (w * imgW) / imgH;
    const CX = 0.45;
    const CY = 0.45;

    // Real rendered colour per emoji, read with that sticker ALONE — no threshold.
    // (Twemoji 2b1b renders (49,55,61) and 2b1c (230,231,232); a "< 60" test called
    // the first one "other", and an oracle that cannot name the colour it just drew
    // is the oracle's bug.)
    const pixelRGB = () => {
      const d = ctx.getImageData(Math.round(CX * canvas.width), Math.round(CY * canvas.height), 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const probeColour = async (src) => {
      const st = app.store.add({ kind: 'emoji', src, cx: CX, cy: CY, w, h });
      app._draw();
      await sleep(250);            // the paint is rAF-coalesced: read after a frame
      const rgb = pixelRGB();
      app.store.remove(st.id);
      app._draw();
      await sleep(150);
      return rgb;
    };
    const REF = { black: await probeColour(BLACK), white: await probeColour(WHITE) };
    const meanOf = (c) => (c[0] + c[1] + c[2]) / 3;
    // Guard: if the two references were indistinguishable, "the pixel changed"
    // would prove nothing.
    const refsDistinct = Math.abs(meanOf(REF.black) - meanOf(REF.white)) > 60;
    const sameAs = (rgb, ref) => !!(rgb && ref) && rgb.every((v, i) => Math.abs(v - ref[i]) <= 8);
    const pixelClass = () => {
      const rgb = pixelRGB();
      if (sameAs(rgb, REF.white)) return 'white';
      if (sameAs(rgb, REF.black)) return 'black';
      return `other(${rgb.join(',')})`;
    };

    // --- the subject: ONE black sticker, selected ---------------------------
    const subject = app.store.add({ kind: 'emoji', src: BLACK, cx: CX, cy: CY, w, h });
    app.store.select(subject.id);
    app._draw();
    await sleep(300);

    const stNow = () => app.store.state.stickers.find((s) => s.id === subject.id) || {};
    const geomOf = () => {
      const s = stNow();
      return { cx: s.cx, cy: s.cy, w: s.w, h: s.h, rot: s.rot, z: s.z };
    };
    const rowLabel = () => {
      const row = list.querySelector('.layer-row .label');
      return row ? row.textContent.trim() : null;
    };
    const highlighted = () => {
      const btn = [...picker.children].find((b) => b.getAttribute('aria-selected') === 'true');
      return btn ? btn.dataset.src : null;
    };
    const targetBtn = (src) => [...picker.children].find((b) => b.dataset.src === src) || null;

    // Live, viewport-guarded point for a picker button: the picker now scrolls in
    // place, so the target emoji may be outside its visible box, and a click at a
    // stale or off-screen point would prove nothing.
    window.__sfPickPoint = (src) => {
      const btn = targetBtn(src);
      if (!btn) return null;
      btn.scrollIntoView({ block: 'center' });
      const b = box(btn);
      if (!b || b.cy < 0 || b.cy > window.innerHeight) return null;
      const p = [b.cx, b.cy];
      (window.__sfPts = window.__sfPts || []).push({
        src, p: [Math.round(p[0]), Math.round(p[1])],
        hit: (() => { const h = document.elementFromPoint(p[0], p[1]); return h ? `${h.tagName}.${h.className || ''}` : null; })(),
      });
      return p;
    };

    const snaps = {};
    window.__sfSnaps = snaps;
    window.__sfSnap = (name) => {
      if (name === 'deselect') app.store.select(null);
      snaps[name] = {
        src: stNow().src,
        kind: stNow().kind,
        pixel: pixelClass(),
        geom: geomOf(),
        selBox: rectRel(document.getElementById('select-box'), canvas),
        undo: app.store._undo.length,
        label: rowLabel(),
        highlight: highlighted(),
        count: app.store.state.stickers.length,
        selection: app.store.state.selection,
      };
      return true;
    };

    // --- the gesture sequence ----------------------------------------------
    window.__sfNextInput = [
      { t: 'read', name: 'before' },
      // 1) with the sticker selected, the picker EDITS it
      { t: 'click', fns: [`window.__sfPickPoint('${WHITE}')`], ms: 400 },
      { t: 'read', name: 'afterSwap' },
      // 2) one undo restores the artwork and the pixel
      { t: 'key', key: 'z', code: 'KeyZ', vk: 90, modifiers: 2, ms: 400 },
      { t: 'read', name: 'afterUndo' },
      // 3) nothing selected: the click only ARMS the next drop
      { t: 'read', name: 'deselect' },
      { t: 'settle', ms: 200 },
      { t: 'click', fns: [`window.__sfPickPoint('${THIRD}')`], ms: 400 },
      { t: 'read', name: 'afterArmOnly' },
    ];

    window.__sfReadTouch = () => {
      const s = snapshots();
      const b = s.before;
      const a = s.afterSwap;
      const u = s.afterUndo;
      const arm = s.afterArmOnly;
      const out = { steps: [] };
      const px = (n) => (s[n] && s[n].pixel);

      out.clickSwapsSelectedSticker = !!(refsDistinct && b && a
        && b.src !== a.src && a.src === WHITE
        && px('before') === 'black' && px('afterSwap') === 'white');

      out.geometryUnchangedBySwap = !!(b && a
        && JSON.stringify(b.geom) === JSON.stringify(a.geom)
        && sameRect(b.selBox, a.selBox) && sameRect(b.selBox, u && u.selBox));

      out.swapIsOneUndoStep = !!(b && a && u
        && a.undo === b.undo + 1 && u.undo === b.undo
        && u.src === b.src && px('afterUndo') === 'black');

      out.layerRowLabelFollowsSwap = !!(b && a
        && b.label === LABEL[BLACK] && a.label === LABEL[WHITE]);

      out.pickerHighlightFollowsSelection = !!(b && a
        && b.highlight === BLACK && a.highlight === WHITE);

      // Compared against the concrete pre-state, never `undefined === undefined`:
      // an equality between two missing stickers passes for a build that deleted
      // the sticker instead of arming the drop.
      out.swapWithoutSelectionStillArms = !!(u && arm
        && u.selection === null
        && u.src === BLACK && arm.src === BLACK
        && px('afterUndo') === 'black' && arm.pixel === 'black'
        && arm.highlight === THIRD);

      out.swapDoesNotAddOrPlace = !!(b && a && u && arm
        && [b, a, u, arm].every((x) => x.count === 1));

      out.steps.push(['refs', { black: REF.black, white: REF.white, distinct: refsDistinct }]);
      out.steps.push(['sequence', ['before', 'afterSwap', 'afterUndo', 'afterArmOnly'].map((n) => ({
        n, src: s[n] && s[n].src, pixel: s[n] && s[n].pixel, label: s[n] && s[n].label,
        highlight: s[n] && s[n].highlight, undo: s[n] && s[n].undo, count: s[n] && s[n].count,
      }))]);
      out.steps.push(['geometry', { before: b && b.geom, after: a && a.geom, selBox: [b && b.selBox, a && a.selBox] }]);
      out.steps.push(['points', window.__sfPts || []]);
      return JSON.stringify(out);
    };
    function snapshots() { return window.__sfSnaps || {}; }
    log('armed', { steps: window.__sfNextInput.length, criteria: 7 });
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
