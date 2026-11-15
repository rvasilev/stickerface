// Gate — the export SIZE, and the lossless tier, through the real UI path.
//
// What only a browser can show: that a size chosen in the panel reaches the ENCODER and changes the
// pixels and the bytes. The pure layer (the size table, longEdge, the lossless entry, the store) is
// unit-tested; a status line naming "1280 px" while the export is still composited at full
// resolution would read as working and be a lie, so the criterion the plan's stop condition hangs on
// (`sizeReachesTheEncoder`) compares the canvas the encoder was handed.
//
// How the truth is read: `HTMLCanvasElement.prototype.toBlob` is wrapped. That captures the export
// canvas's REAL width/height, the mime and quality the app passed, and the produced Blob — the
// encoder's inputs and outputs, without touching the app. `URL.createObjectURL` (which the
// format/level gate uses) is equally valid; the canvas is used here because the DIMENSIONS are the
// claim being tested and only the canvas carries them.
//
// The photo is synthesised IN-PAGE: a gradient with noise, large enough that the size control has
// something to reduce (2600x1800 — every size in EXPORT_SIZES is below that long edge, so a size
// that does NOT reach the encoder is visible as an unchanged canvas).
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);

  r.sizeControlsExist = false;
  r.fullSizeIsTheDefault = false;
  r.sizeReachesTheEncoder = false;
  r.dimensionsAreReported = false;
  r.losslessIsOfferedForWebpOnly = false;
  r.losslessIsLargerThanLossy = false;
  r.losslessBeatsPng = false;
  r.sizeIsRemembered = false;
  r.existingButtonsStillExport = false;

  // One definition, handed to the step list as source so the same hooks exist in the document the
  // steps end in.
  const installHooks = () => {
    const $ = (id) => document.getElementById(id);
    window.__sfStash = () => JSON.parse(sessionStorage.getItem('sf-size-probe') || '{}');
    window.__sfSave = (s) => sessionStorage.setItem('sf-size-probe', JSON.stringify(s));
    // A `<select>` cannot be driven by a synthetic click over CDP (the dropdown is browser chrome,
    // not DOM), so value + change is the accepted way — the same event a real pick fires.
    const setSelect = (id, value) => {
      const sel = $(id);
      if (sel) {
        sel.value = value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };
    window.__sfSetLevel = (format, level) => { setSelect('export-level-' + format, level); return [1, 1]; };
    window.__sfSetSize = (size) => { setSelect('export-size', size); return [1, 1]; };
    window.__sfSnap = async (name) => {
      // The encode is async and its length depends on the format AND the size (a lossless WebP of
      // a megapixel photo is not instant), so a fixed sleep races it. Wait for the capture the
      // wrapped toBlob installs. The capture is cleared by the CLICK step, never here.
      for (let i = 0; i < 400 && !window.__sfLastCanvas; i++) await new Promise((r2) => setTimeout(r2, 50));
      const stash = window.__sfStash();
      const cap = window.__sfLastCanvas;
      const status = $('export-status');
      stash[name] = {
        canvas: cap ? { w: cap.w, h: cap.h, mime: cap.mime, q: cap.q } : null,
        blob: cap && cap.blob ? { type: cap.blob.type, size: cap.blob.size } : null,
        status: status ? (status.textContent || '').trim() : null,
        stored: (() => {
          try { return localStorage.getItem('stickerface.export.levels'); } catch { return 'THREW'; }
        })(),
      };
      window.__sfLastCanvas = null;
      window.__sfSave(stash);
      return true;
    };
    window.__sfReadTouch = () => {
      const stash = window.__sfStash();
      const s = (k) => stash[k] || {};
      const controls = stash.controls || {};
      const canv = (k) => s(k).canvas || {};
      const bytes = (k) => (s(k).blob ? s(k).blob.size : null);
      const nat = stash.natural || {};
      let stored = null;
      try { stored = JSON.parse(s('jpegWeb').stored || 'null'); } catch { stored = null; }
      // The status must name the dimensions that were really written — read off the canvas, not off
      // the app's own claim.
      const dims = `${canv('webpWeb').w}x${canv('webpWeb').h}`;
      return JSON.stringify({
        steps: [['controls', controls], ['webpFull', s('webpFull')], ['webpWeb', s('webpWeb')],
          ['webpLosslessWeb', s('webpLosslessWeb')], ['pngWeb', s('pngWeb')], ['jpegWeb', s('jpegWeb')]],
        errors: [],
        sizeControlsExist: controls.sizeSelect === true,
        fullSizeIsTheDefault: canv('webpFull').w === nat.w && canv('webpFull').h === nat.h,
        // The stop condition: the size must change the PIXELS and the BYTES, not just the label.
        sizeReachesTheEncoder: canv('webpWeb').w === 1280
          && canv('webpWeb').h < canv('webpWeb').w
          && typeof bytes('webpWeb') === 'number' && typeof bytes('webpFull') === 'number'
          && bytes('webpWeb') < bytes('webpFull'),
        dimensionsAreReported: !!s('webpWeb').status && s('webpWeb').status.includes(dims),
        losslessIsOfferedForWebpOnly: controls.webpLosslessOption === true && controls.jpegLosslessOption === false,
        // Within WebP at one size: lossless is the larger file (the tier is a quality choice, not a
        // size saving), and it is still smaller than PNG of the same pixels (which is why it exists).
        // Both are GUARDED on the encoder having really been handed 1.0 — otherwise a run where the
        // tier does not exist yet passes them vacuously, comparing two lossy encodes.
        losslessIsLargerThanLossy: canv('webpLosslessWeb').q === 1
          && typeof bytes('webpLosslessWeb') === 'number'
          && typeof bytes('webpWeb') === 'number' && bytes('webpLosslessWeb') > bytes('webpWeb'),
        losslessBeatsPng: canv('webpLosslessWeb').q === 1
          && typeof bytes('webpLosslessWeb') === 'number'
          && typeof bytes('pngWeb') === 'number' && bytes('webpLosslessWeb') < bytes('pngWeb'),
        sizeIsRemembered: !!stored && stored.size === 'web',
        existingButtonsStillExport: (s('pngWeb').blob || {}).type === 'image/png'
          && (s('jpegWeb').blob || {}).type === 'image/jpeg',
      });
    };
    return [1, 1];
  };

  try {
    // The capture: the encoder's real inputs (canvas size, mime, quality) and its real output.
    const realToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (cb, mime, q) {
      const w = this.width;
      const h = this.height;
      return realToBlob.call(this, (b) => {
        window.__sfLastCanvas = { w, h, mime, q: typeof q === 'number' ? q : null, blob: b || null };
        cb(b);
      }, mime, q);
    };

    const $ = (id) => document.getElementById(id);
    const webpSel = $('export-level-webp');
    const jpegSel = $('export-level-jpeg');
    const hasLossless = (sel) => !!sel && [...sel.options].some((o) => o.value === 'lossless');
    const controls = {
      sizeSelect: !!$('export-size'),
      webpLosslessOption: hasLossless(webpSel),
      jpegLosslessOption: hasLossless(jpegSel),
      noteMentionsLossless: /lossless/i.test(($('export-level-note') || {}).textContent || ''),
    };
    log('controls', controls);
    r.sizeControlsExist = controls.sizeSelect === true;

    // A gradient with noise, big enough for every size in the table to reduce it.
    const W = 2600;
    const H = 1800;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    const im = g.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const n = (Math.random() - 0.5) * 48;
        im.data[i] = Math.max(0, Math.min(255, (x / W) * 255 + n));
        im.data[i + 1] = Math.max(0, Math.min(255, (y / H) * 255 + n));
        im.data[i + 2] = Math.max(0, Math.min(255, 128 + n));
        im.data[i + 3] = 255;
      }
    }
    g.putImageData(im, 0, 0);
    const fileBlob = await new Promise((res) => realToBlob.call(c, res, 'image/jpeg', 0.95));
    const dt = new DataTransfer();
    dt.items.add(new File([fileBlob], 'noise-big.jpg', { type: 'image/jpeg' }));
    const input = $('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 120 && $('canvas-wrap').hidden; i++) await sleep(100);
    log('photoLoaded', { visible: !$('canvas-wrap').hidden, W, H });

    // Aim at a button's centre, read from the page at dispatch time; an absent button answers with
    // the stage centre so a RED criterion stays readable rather than aborting the run.
    window.__sfAtButton = (id) => {
      const b = $(id);
      if (!b || b.hidden) {
        const can = $('stage-canvas').getBoundingClientRect();
        return [can.left + can.width / 2, can.top + can.height / 2];
      }
      const q = b.getBoundingClientRect();
      return [q.left + q.width / 2, q.top + q.height / 2];
    };
    // Forget the previous capture FIRST, then aim — so the snapshot that follows can wait for THIS
    // click's blob without accepting the last one.
    window.__sfAtExport = (id) => {
      window.__sfLastCanvas = null;
      return window.__sfAtButton(id);
    };

    const stash = { controls, natural: { w: W, h: H } };
    installHooks();
    window.__sfSave(stash);

    window.__sfNextInput = [
      // Defaults: full resolution, level untouched.
      { t: 'click', fns: ['window.__sfAtExport("btn-export-webp")'], ms: 400 },
      { t: 'read', name: 'webpFull' },
      // The size control, with the level at its top lossy step.
      { t: 'move', fns: ['window.__sfSetLevel("webp", "maximum")'] },
      { t: 'move', fns: ['window.__sfSetSize("web")'] },
      { t: 'click', fns: ['window.__sfAtExport("btn-export-webp")'], ms: 400 },
      { t: 'read', name: 'webpWeb' },
      // The lossless tier, same size: bigger than 'maximum', smaller than PNG.
      { t: 'move', fns: ['window.__sfSetLevel("webp", "lossless")'] },
      { t: 'click', fns: ['window.__sfAtExport("btn-export-webp")'], ms: 400 },
      { t: 'read', name: 'webpLosslessWeb' },
      { t: 'click', fns: ['window.__sfAtExport("btn-export-png")'], ms: 400 },
      { t: 'read', name: 'pngWeb' },
      { t: 'click', fns: ['window.__sfAtExport("btn-export-jpeg")'], ms: 400 },
      { t: 'read', name: 'jpegWeb' },
      { t: 'move', fns: [`(${String(installHooks)})()`] },
    ];
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
