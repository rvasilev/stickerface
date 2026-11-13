// Delete-by-double-click probe (desktop, mouse).
//
// Product rule: double-clicking a sticker removes it (one undoable step); a
// single click only selects. The click must come from the BROWSER
// (Input.dispatchMouseEvent with clickCount 1 then 2) — a synthetic `dblclick`
// would not prove the handler is wired to real input.
//
// Two stickers are placed far apart, so the yellow pixel count of a single
// sticker (~27k at preview scale) is a clean oracle for "which ones survive".
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);
  const canvas = document.getElementById('stage-canvas');

  const measure = () => {
    const rect = canvas.getBoundingClientRect();
    const probe = document.createElement('canvas');
    probe.width = canvas.width; probe.height = canvas.height;
    const ctx = probe.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    const d = ctx.getImageData(0, 0, probe.width, probe.height).data;
    let n = 0;
    for (let y = 0; y < probe.height; y++) {
      for (let x = 0; x < probe.width; x++) {
        const i = (y * probe.width + x) * 4;
        const R = d[i], G = d[i + 1], B = d[i + 2];
        if (R >= 235 && R <= 255 && G >= 184 && G <= 224 && B >= 57 && B <= 97) n++;
      }
    }
    const box = document.getElementById('select-box');
    const boxRect = box.getBoundingClientRect();
    const hs = [...document.querySelectorAll('#select-box .handle')];
    return {
      yellowPixels: n,
      selectionVisible: !box.hidden && boxRect.width > 0,
      handles: hs.length,
      handlesVisible: box.hidden ? 0 : hs.filter((el) => el.getBoundingClientRect().width > 0).length,
      layers: document.getElementById('layer-list').children.length,
    };
  };

  try {
    const blob = await (await fetch('tests/e2e/fixture.jpg?cb=' + Date.now(), { cache: 'no-store' })).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'fixture.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 100 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);

    const rect = canvas.getBoundingClientRect();
    const p = (nx, ny) => [rect.left + (nx / 1200) * rect.width, rect.top + (ny / 800) * rect.height];
    const at = (nx, ny) => {
      const [cx, cy] = p(nx, ny);
      return { clientX: cx, clientY: cy };
    };
    const place = async (nx, ny) => {
      const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', ...at(nx, ny) };
      canvas.dispatchEvent(new PointerEvent('pointerdown', o));
      canvas.dispatchEvent(new PointerEvent('pointerup', o));
      await sleep(180);
    };

    // Two stickers on empty canvas, far apart so their pixels never overlap.
    await place(300, 250);
    await place(900, 600);
    r.twoStickersPlaced = document.getElementById('layer-list').children.length === 2;
    log('layersAfterPlace', document.getElementById('layer-list').children.length);

    const A = p(300, 250);         // sticker A centre
    const B = p(900, 600);         // sticker B centre
    const EMPTY = p(650, 120);     // empty canvas, clear of both

    window.__sfSnaps = {};
    window.__sfSnap = (name) => { window.__sfSnaps[name] = measure(); return true; };

    window.__sfNextInput = [
      { t: 'read', name: 't0' },
      // 1) single click on A: selects, must NOT delete
      { t: 'click', pts: [A], count: 1, ms: 220 },
      { t: 'read', name: 'afterSingleClick' },
      // 2) double click on A: A goes, B stays, selection clears
      { t: 'click', pts: [A], count: 1, ms: 60 },
      { t: 'click', pts: [A], count: 2, ms: 260 },
      { t: 'read', name: 'afterDeleteA' },
      // 3) Ctrl+Z restores A (one undoable step)
      { t: 'key', key: 'z', code: 'KeyZ', vk: 90, modifiers: 2, ms: 320 },
      { t: 'read', name: 'afterUndo' },
      // 4) double click on B: B goes, A stays
      { t: 'click', pts: [B], count: 1, ms: 60 },
      { t: 'click', pts: [B], count: 2, ms: 260 },
      { t: 'read', name: 'afterDeleteB' },
      // 5) double click on EMPTY canvas: place+delete nets to no change
      { t: 'click', pts: [EMPTY], count: 1, ms: 60 },
      { t: 'click', pts: [EMPTY], count: 2, ms: 260 },
      { t: 'read', name: 'afterEmptyDoubleClick' },
    ];

    window.__sfReadTouch = () => {
      const s = window.__sfSnaps;
      const out = { steps: [] };
      const t0 = s.t0, single = s.afterSingleClick, da = s.afterDeleteA,
            undo = s.afterUndo, db = s.afterDeleteB, empty = s.afterEmptyDoubleClick;
      const one = t0 && t0.yellowPixels / 2;   // one sticker's worth of pixels

      out.steps.push(['yellowPixels', ['start', t0 && t0.yellowPixels, 'single', single && single.yellowPixels,
        'delA', da && da.yellowPixels, 'undo', undo && undo.yellowPixels, 'delB', db && db.yellowPixels,
        'empty', empty && empty.yellowPixels]]);
      out.steps.push(['layers', ['start', t0 && t0.layers, 'delA', da && da.layers, 'undo', undo && undo.layers,
        'delB', db && db.layers, 'empty', empty && empty.layers]]);

      out.singleClickKeepsSticker = !!single && !!t0 &&
        single.yellowPixels > t0.yellowPixels * 0.9 && single.layers === 2;
      out.doubleClickDeletesSticker = !!da && da.yellowPixels < one * 1.5 && da.yellowPixels > one * 0.5;
      out.doubleClickDeletesOnlyTheClickedSticker = !!da && da.layers === 1;
      out.deleteClearsSelection = !!da && (da.selectionVisible === false || da.handlesVisible === 0);
      out.steps.push(['afterDeleteHandles', [da && da.handles, da && da.handlesVisible]]);
      out.undoRestoresDeletedSticker = !!undo && t0 &&
        undo.yellowPixels > t0.yellowPixels * 0.9 && undo.layers === 2;
      out.doubleClickDeletesSecondSticker = !!db && undo &&
        db.yellowPixels < undo.yellowPixels * 0.6 && db.layers === 1;
      out.doubleClickOnEmptyLeavesNoSticker = !!empty && !!db && empty.layers === db.layers &&
        Math.abs(empty.yellowPixels - db.yellowPixels) < 500;
      out.steps.push(['final', [empty && empty.layers, empty && empty.selectionVisible]]);
      out.steps.push(['afterDeleteA', da]);
      out.steps.push(['afterSingleClick', single]);
      return JSON.stringify(out);
    };

    log('armed', true);
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
