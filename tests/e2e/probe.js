// E2E user-flow probe. Run with: python3 tests/e2e/run.py tests/e2e/probe.js
//
// Drives the real page the way a person does — pick a photo, drop stickers,
// export — and reports a boolean per acceptance criterion. Nothing here is
// mocked: the export path really runs canvas.toBlob at natural size.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);
  const px = (bmp, x, y) => {
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const cx = c.getContext('2d');
    cx.drawImage(bmp, 0, 0);
    return Array.from(cx.getImageData(x, y, 1, 1).data);
  };
  const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2);

  try {
    // --- 1. the page wires up at all -----------------------------------------
    const pickerButtons = document.querySelectorAll('#emoji-picker button').length;
    r.pickerCountIsOnePerEmoji = pickerButtons === 76;
    log('pickerButtons', pickerButtons);

    // --- 2. load a photo ------------------------------------------------------
    // Relative path: the app is served at the origin root locally but under
    // /stickerface/ on GitHub Pages (a root-absolute path 404s there).
    const fixtureRes = await fetch(`tests/e2e/fixture.jpg?cb=${Date.now()}`, { cache: 'no-store' });
    const blob = await fixtureRes.blob();
    r.fixtureLoaded = fixtureRes.ok && blob.size > 1000 && blob.type.startsWith('image/');
    log('fixture', [fixtureRes.status, blob.type, blob.size]);
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'fixture.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 80 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);
    r.imageLoads = !document.getElementById('canvas-wrap').hidden;
    log('canvasVisible', r.imageLoads);

    const canvas = document.getElementById('stage-canvas');
    const rect = canvas.getBoundingClientRect();
    log('previewSize', [canvas.width, canvas.height]);

    // --- 3a. preview geometry: what you see must be the photo, undistorted ---
    // A CSS box with a different aspect ratio than the backing store stretches
    // the preview vertically: you then place stickers against a squashed face.
    const distortion = (rect.width / rect.height) / (canvas.width / canvas.height);
    r.previewAspectPreserved = Math.abs(distortion - 1) < 0.02;
    log('previewBox', [Math.round(rect.width), Math.round(rect.height), 'distortion=' + distortion.toFixed(3)]);
    r.canvasFitsViewport = rect.height <= window.innerHeight + 1 && rect.width <= window.innerWidth + 1;
    log('viewport', [window.innerWidth, window.innerHeight]);

    // --- 3. EXPORT MUST BE POSSIBLE once a photo is loaded --------------------
    // This is the criterion the first build failed: export stayed gated forever
    // because SVG bitmaps never decoded.
    r.exportEnabledAfterImage = !document.getElementById('btn-export-png').disabled;
    log('exportEnabledAfterImage', r.exportEnabledAfterImage);
    log('exportStatusText', document.getElementById('export-status').textContent);

    // --- 4. drop stickers -----------------------------------------------------
    // v1 shows emoji + custom-image stickers only: blur/mosaic/About are hidden
    // (user request 2026-11-13). The probe asserts they are UNREACHABLE and then
    // places two emoji stickers, so the multi-sticker/export criteria still run.
    const unreachable = (id) => {
      const el = document.getElementById(id);
      return !!el && (el.hidden || el.offsetParent === null);
    };
    r.blurControlHidden = unreachable('tool-blur');
    r.mosaicControlHidden = unreachable('tool-mosaic');
    r.aboutControlHidden = unreachable('btn-about');
    r.blurSettingsHidden = unreachable('tool-settings');
    r.aboutPanelHidden = document.getElementById('about-panel').hidden;
    r.customStickerHidden = unreachable('custom-label') && unreachable('custom-input');
    r.attributionVisible = !!document.querySelector('.footer a[href*="twemoji"]');
    const at = (nx, ny) => ({ clientX: rect.left + (nx / 1200) * rect.width, clientY: rect.top + (ny / 800) * rect.height });
    const place = async (nx, ny) => {
      const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', ...at(nx, ny) };
      canvas.dispatchEvent(new PointerEvent('pointerdown', o));
      canvas.dispatchEvent(new PointerEvent('pointerup', o));
      await sleep(150);
    };
    await place(600, 380);
    r.emojiStickerDrops = document.getElementById('layer-list').children.length === 1;
    r.selectionChromeShown = !document.getElementById('select-box').hidden;
    await place(280, 240);
    await place(920, 620);
    r.threeStickers = document.getElementById('layer-list').children.length === 3;
    r.activeToolStaysEmoji = document.getElementById('tool-emoji').getAttribute('aria-pressed') === 'true';

    // Hiding is not disabling: a hidden control still fires its handler when
    // clicked/patched programmatically. Assert the app refuses.
    const layersBeforeHiddenClicks = document.getElementById('layer-list').children.length;
    document.getElementById('tool-blur').click();
    document.getElementById('tool-mosaic').click();
    await place(760, 150);
    r.toolCannotBeActivatedWhileHidden =
      document.getElementById('tool-emoji').getAttribute('aria-pressed') === 'true' &&
      document.getElementById('layer-list').children.length === layersBeforeHiddenClicks + 1;
    const kindsAfterHiddenClicks = [...document.querySelectorAll('#layer-list .layer-row .label')]
      .map((el) => el.textContent.trim().toLowerCase());
    r.hiddenToolPlacedEmojiNotPatch = !kindsAfterHiddenClicks.some((t) => t === 'blur' || t === 'mosaic');
    log('kindsAfterHiddenClicks', kindsAfterHiddenClicks);

    // The hidden custom-image input must not add a sticker either.
    const custom = document.getElementById('custom-input');
    const beforeCustom = document.getElementById('layer-list').children.length;
    const dtCustom = new DataTransfer();
    dtCustom.items.add(new File([await blob.arrayBuffer()], 'custom.png', { type: 'image/png' }));
    custom.files = dtCustom.files;
    custom.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(300);
    r.customStickerCannotBeLoadedWhileHidden =
      document.getElementById('layer-list').children.length === beforeCustom;
    log('layersAfterHiddenCustomChange', document.getElementById('layer-list').children.length);
    log('layers', document.getElementById('layer-list').children.length);

    // --- 5. keyboard nudge + undo --------------------------------------------
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await sleep(80);
    document.getElementById('btn-undo').click();
    r.undoWorks = !document.getElementById('btn-undo').disabled;
    log('undoEnabled', r.undoWorks);

    // --- 6. export at full resolution ----------------------------------------
    let captured = null;
    let downloadName = null;
    const realCreate = URL.createObjectURL.bind(URL);
    const realClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (b) => { if (b instanceof Blob) captured = b; return realCreate(b); };
    HTMLAnchorElement.prototype.click = function () { downloadName = this.download; };
    document.getElementById('btn-export-png').click();
    for (let i = 0; i < 120 && !captured; i++) await sleep(100);
    URL.createObjectURL = realCreate;
    HTMLAnchorElement.prototype.click = realClick;

    r.exportProducesBlob = !!captured;
    log('pngBlob', captured ? [captured.type, captured.size] : null);
    log('downloadName', downloadName);

    if (captured) {
      const out = await createImageBitmap(captured);
      const src = await createImageBitmap(blob);
      r.exportDimensionsMatchSource = out.width === src.width && out.height === src.height;
      log('exportSize', [out.width, out.height]);

      // the sticker area must differ, an untouched area must not
      r.stickerAreaChanged = !same(px(out, 600, 380), px(src, 600, 380));
      r.untouchedAreaIntact = same(px(out, 20, 780), px(src, 20, 780));
      log('centreExport', px(out, 600, 380));
      log('centreSource', px(src, 600, 380));
      log('cornerExport', px(out, 20, 780));
      log('cornerSource', px(src, 20, 780));

      // --- 7. metadata is stripped on the JPEG path ---------------------------
      let jpeg = null;
      URL.createObjectURL = (b) => { if (b instanceof Blob) jpeg = b; return realCreate(b); };
      document.getElementById('btn-export-jpeg').click();
      for (let i = 0; i < 120 && !jpeg; i++) await sleep(100);
      URL.createObjectURL = realCreate;
      if (jpeg) {
        const buf = new Uint8Array(await jpeg.arrayBuffer());
        let hasExif = false;
        for (let i = 2; i < Math.min(buf.length - 4, 8000); i++) {
          if (buf[i] === 0xff && buf[i + 1] === 0xe1) { hasExif = true; break; }
          if (buf[i] === 0xff && buf[i + 1] === 0xda) break;
        }
        r.jpegHasNoExif = !hasExif;
        log('jpegBlob', [jpeg.type, jpeg.size, 'app1=' + hasExif]);
      } else {
        r.jpegHasNoExif = false;
      }
    }
    // --- 8. reorder reaches the layer list ------------------------------------
    // raise/lower change the array order, so the rows must follow it. NOTE: this
    // criterion passes even if the store reports the reorder as a plain 'change',
    // because _push emits a history event first and that already forces a rebuild -
    // verified by reverting the event type and re-running. It asserts the visible
    // behaviour, not the event plumbing.
    // Two stickers are added through the store (this criterion is about the list and
    // the store agreeing, not about placement, and the canvas is already crowded).
    const app = window.__stickerface;
    const rowLabels = () => [...document.querySelectorAll('#layer-list .layer-row .label')]
      .map((el) => el.textContent.trim());
    const pickerSrc = (i) => app.els.picker.children[i].dataset.src;
    app.store.add({ kind: 'emoji', src: pickerSrc(3), cx: 0.25, cy: 0.3 });
    app.store.add({ kind: 'emoji', src: pickerSrc(7), cx: 0.7, cy: 0.6 });
    await sleep(200);
    const rowsBeforeReorder = rowLabels();
    const n = rowsBeforeReorder.length;
    const distinctLabels = n >= 2 && rowsBeforeReorder[n - 1] !== rowsBeforeReorder[n - 2];
    // Bring the SECOND-TO-BOTTOM row forward (the bottom one is already on top):
    // the last two rows must SWAP.
    const rowEls = [...document.querySelectorAll('#layer-list .layer-row')];
    rowEls[n - 2].querySelector('button[title^="Bring forward"]').click();
    await sleep(250);
    const rowsAfterReorder = rowLabels();
    r.reorderReachesLayerList = distinctLabels && rowsAfterReorder.length === n &&
      rowsAfterReorder[n - 1] === rowsBeforeReorder[n - 2] &&
      rowsAfterReorder[n - 2] === rowsBeforeReorder[n - 1];
    log('rowsBeforeReorder', rowsBeforeReorder.slice(-2));
    log('rowsAfterReorder', rowsAfterReorder.slice(-2));

    log('done', true);
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
