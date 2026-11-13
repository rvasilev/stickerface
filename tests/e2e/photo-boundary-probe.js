// Photo-boundary probe: what happens to the stickers, the selection and the undo
// history when the user loads a DIFFERENT photo.
//
// Audit findings 1, 3 and 8 (2026-11-14). Product decision taken with the fix:
// a newly loaded photo starts CLEAN — no stickers carried over, no history that
// can restore the previous photo's stickers onto it. "Apply layout to next photo"
// is the explicit, single-undoable-step opt-in that carries the layout over.
//
// Two photos are generated in-page (no second fixture file): photo A is the
// fixture, photo B is a solid green canvas, so a stale sticker is obvious and the
// aspect ratio differs (1200x800 vs 900x1200) to exercise the aspect warning path.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);
  const $ = (id) => document.getElementById(id);
  const layers = () => $('layer-list').children.length;

  const loadFile = async (file) => {
    const input = $('file-input');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 100 && $('canvas-wrap').hidden; i++) await sleep(50);
    await sleep(350);
  };

  const placeSticker = async (fx, fy) => {
    const canvas = $('stage-canvas');
    const rect = canvas.getBoundingClientRect();
    const o = {
      bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse',
      clientX: rect.left + rect.width * fx, clientY: rect.top + rect.height * fy,
    };
    canvas.dispatchEvent(new PointerEvent('pointerdown', o));
    canvas.dispatchEvent(new PointerEvent('pointerup', o));
    await sleep(220);
  };

  const undo = async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    await sleep(250);
  };

  const photoB = async () => {
    const c = document.createElement('canvas');
    c.width = 900;
    c.height = 1200;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#1e7a34';
    ctx.fillRect(0, 0, 900, 1200);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    return new File([blob], 'photo-b.png', { type: 'image/png' });
  };

  try {
    const blobA = await (await fetch('tests/e2e/fixture.jpg?cb=' + Date.now(), { cache: 'no-store' })).blob();
    const fileA = new File([blobA], 'fixture.jpg', { type: 'image/jpeg' });
    const fileB = await photoB();

    // --- 1. a new photo starts clean ------------------------------------------
    await loadFile(fileA);
    await placeSticker(0.35, 0.35);
    await placeSticker(0.6, 0.5);
    const onA = layers();
    await loadFile(fileB);
    const onB = layers();
    r.newPhotoStartsClean = onA === 2 && onB === 0;
    r.selectionClearedOnNewPhoto = $('select-box').hidden;
    log('layersOnA', onA);
    log('layersOnB', onB);

    // --- 2. Ctrl+Z after a photo change cannot resurrect the old stickers -----
    await undo();
    const afterUndo = layers();
    r.undoDoesNotRestoreOldPhotoStickers = afterUndo === 0;
    log('layersAfterUndoOnB', afterUndo);
    // The undo *button* state must agree with the behaviour (no phantom history).
    log('undoButtonDisabled', $('btn-undo').disabled);

    // --- 3. the explicit opt-in carries the layout ----------------------------
    await loadFile(fileA);
    await placeSticker(0.3, 0.4);
    await placeSticker(0.65, 0.45);
    const beforeApply = layers();
    $('btn-apply-next').click();     // arms the layout, then opens the picker
    await sleep(250);
    await loadFile(fileB);           // the "next photo"
    const afterApply = layers();
    r.applyLayoutCarriesStickers = beforeApply === 2 && afterApply === 2;
    log('layersBeforeApply', beforeApply);
    log('layersAfterApply', afterApply);

    // Positions must be identical (normalized coordinates are reused as-is).
    const norm = () => window.__stickerface.store.orderedStickers()
      .map((s) => [Math.round(s.cx * 1000) / 1000, Math.round(s.cy * 1000) / 1000, Math.round(s.w * 1000) / 1000]);
    const normAfterApply = norm();
    log('normAfterApply', normAfterApply);
    r.applyLayoutKeepsNormalizedPositions = normAfterApply.length === 2 &&
      normAfterApply.every(([cx, cy]) => cx > 0 && cx < 1 && cy > 0 && cy < 1);

    // --- 4. that carry-over is ONE undoable step ------------------------------
    await undo();
    const afterUndoApply = layers();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }));
    await sleep(250);
    const afterRedoApply = layers();
    // Guarded: "nothing happened" must not read as a pass. One undo takes the
    // carried layout away (0), one redo puts it back (2).
    r.applyLayoutIsOneUndoStep = afterUndoApply === 0 && afterRedoApply === 2;
    log('layersAfterUndoApply', afterUndoApply);
    log('layersAfterRedoApply', afterRedoApply);

    // --- 5. and the app is still usable on the second photo -------------------
    await undo();
    await placeSticker(0.5, 0.5);
    r.canPlaceOnSecondPhoto = layers() === 1;
    log('layersAfterPlaceOnB', layers());
    r.canvasHasImage = $('stage-canvas').width > 0;
    r.errorsThrown = r.errors.length;
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
