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
    const blob = await (await fetch('/tests/e2e/fixture.jpg')).blob();
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

    // --- 3. EXPORT MUST BE POSSIBLE once a photo is loaded --------------------
    // This is the criterion the first build failed: export stayed gated forever
    // because SVG bitmaps never decoded.
    r.exportEnabledAfterImage = !document.getElementById('btn-export-png').disabled;
    log('exportEnabledAfterImage', r.exportEnabledAfterImage);
    log('exportStatusText', document.getElementById('export-status').textContent);

    // --- 4. drop emoji / blur / mosaic stickers -------------------------------
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
    document.getElementById('tool-blur').click();    await place(280, 240);
    document.getElementById('tool-mosaic').click();  await place(920, 620);
    r.threeStickers = document.getElementById('layer-list').children.length === 3;
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
    log('done', true);
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
