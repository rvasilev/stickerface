// Gate — the export FORMATS and the compression levels, through the real UI path.
//
// What this covers that the unit tests cannot: the WIRING. The pure layer (resolveExportFormat, the
// level table, the settings store) is unit-tested, including the Safari fallback that no browser
// here can reproduce. What only a browser can show is that a level chosen in the panel reaches the
// encoder and changes the BYTES — because a status line that names a level while the encoder is
// still handed 0.92 would read as working and be a lie. The plan's stop condition turns on exactly
// that criterion (`levelReachesTheEncoder`).
//
// How the bytes are read: `downloadBlob` is the app's only path to a file, and it goes through
// `URL.createObjectURL(blob)`. Wrapping that one call captures the real Blob the app produced —
// type and size — without touching the app, and the original is still called so the download
// behaves exactly as before.
//
// The photo is synthesised IN-PAGE as noise (the trick offline-probe.js uses) rather than taken
// from tests/e2e/fixture.jpg: the fixture is a flat synthetic image, and flat images encode to
// nearly the same size at every quality, which would make a byte comparison meaningless. Noise is
// what makes a quality argument visible in bytes.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);

  r.webpButtonExists = false;
  r.levelControlsExist = false;
  r.pngHasNoLevelControlButSaysWhy = false;
  r.webpExportEncodesWebp = false;
  r.levelReachesTheEncoder = false;
  r.levelIsRemembered = false;
  r.pngAndJpegStillExport = false;

  // One definition, used here and handed to the step list as source so the same hooks exist in the
  // document the steps end in.
  const installHooks = () => {
    const $ = (id) => document.getElementById(id);
    window.__sfStash = () => JSON.parse(sessionStorage.getItem('sf-export-probe') || '{}');
    window.__sfSave = (s) => sessionStorage.setItem('sf-export-probe', JSON.stringify(s));
    // A `<select>` cannot be driven by a synthetic click over CDP (the dropdown is browser chrome,
    // not DOM), so the accepted way is value + change — the same event a real pick fires.
    window.__sfSetLevel = (format, level) => {
      const sel = $('export-level-' + format);
      if (sel) {
        sel.value = level;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return [1, 1];
    };
    window.__sfSnap = async (name) => {
      // The export is ASYNC and its length depends on the format (a 900x600 PNG of noise takes
      // longer than 400ms), so a fixed sleep after the click races the encode and can read the
      // previous export's blob — or none. `downloadBlob` calls createObjectURL when the encode
      // finishes, so wait for THAT. The blob is cleared by the CLICK step (`__sfAtExport`), never
      // here: clearing here would throw away a blob that already arrived during the click's delay.
      for (let i = 0; i < 400 && !window.__sfLastBlob; i++) await new Promise((r) => setTimeout(r, 50));
      const stash = window.__sfStash();
      const blob = window.__sfLastBlob;
      const status = $('export-status');
      stash[name] = {
        blobType: blob ? blob.type : null,
        blobSize: blob ? blob.size : null,
        status: status ? (status.textContent || '').trim() : null,
        stored: (() => {
          try { return localStorage.getItem('stickerface.export.levels'); } catch { return 'THREW'; }
        })(),
        webpDisabled: $('btn-export-webp') ? $('btn-export-webp').disabled : 'MISSING',
      };
      window.__sfLastBlob = null;
      window.__sfSave(stash);
      return true;
    };
    window.__sfReadTouch = () => {
      const stash = window.__sfStash();
      const s = (k) => stash[k] || {};
      const controls = stash.controls || {};
      // The last snapshot's stored value: it is written by the level picks, so it is the claim
      // "the choice was persisted", not "something was persisted at some point".
      let stored = null;
      try { stored = JSON.parse(s('pngExport').stored || 'null'); } catch { stored = null; }
      return JSON.stringify({
        steps: [['controls', controls], ['webpDefault', s('webpDefault')], ['webpSmaller', s('webpSmaller')],
          ['webpMaximum', s('webpMaximum')], ['jpegSmaller', s('jpegSmaller')], ['jpegMaximum', s('jpegMaximum')],
          ['png', s('pngExport')]],
        errors: [],
        webpButtonExists: controls.webp === true,
        levelControlsExist: controls.jpegSelect === true && controls.webpSelect === true,
        pngHasNoLevelControlButSaysWhy: controls.pngSelect === false && controls.noteSaysLossless === true,
        // The browser we run in CAN encode WebP, so "it produced WebP" is the expected answer here;
        // the fallback side of this decision is unit-tested (resolveExportFormat).
        webpExportEncodesWebp: s('webpDefault').blobType === 'image/webp'
          && /\.webp\b/.test(s('webpDefault').status || ''),
        // The criterion the stop condition hangs on: the level must change the BYTES, not just the
        // label. Strictly fewer bytes at the smaller level, in both lossy formats.
        levelReachesTheEncoder: typeof s('webpSmaller').blobSize === 'number'
          && typeof s('webpMaximum').blobSize === 'number'
          && s('webpSmaller').blobSize < s('webpMaximum').blobSize
          && typeof s('jpegSmaller').blobSize === 'number'
          && typeof s('jpegMaximum').blobSize === 'number'
          && s('jpegSmaller').blobSize < s('jpegMaximum').blobSize,
        levelIsRemembered: !!stored && stored.webp === 'maximum' && stored.jpeg === 'maximum',
        pngAndJpegStillExport: s('pngExport').blobType === 'image/png'
          && s('jpegMaximum').blobType === 'image/jpeg',
      });
    };
    return [1, 1];
  };

  try {
    // Capture what the app hands the browser to download, without changing what it does.
    const realCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      window.__sfLastBlob = blob;
      return realCreateObjectURL(blob);
    };

    const $ = (id) => document.getElementById(id);
    const controls = {
      webp: !!$('btn-export-webp'),
      jpegSelect: !!$('export-level-jpeg'),
      webpSelect: !!$('export-level-webp'),
      pngSelect: !!$('export-level-png'),
      noteSaysLossless: /lossless/i.test(($('export-level-note') || {}).textContent || ''),
    };
    log('controls', controls);
    r.webpButtonExists = controls.webp === true;
    r.levelControlsExist = controls.jpegSelect && controls.webpSelect;
    r.pngHasNoLevelControlButSaysWhy = controls.pngSelect === false && controls.noteSaysLossless;

    // A gradient with noise on it: flat images encode to nearly the same size at every quality
    // (which would make the byte comparison vacuous), while PURE random noise is the encoders'
    // worst case and makes the PNG export take many seconds for no benefit — the PNG criterion
    // only checks its TYPE.
    const W = 900;
    const H = 600;
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
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.95));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'noise.jpg', { type: 'image/jpeg' }));
    const input = $('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 80 && $('canvas-wrap').hidden; i++) await sleep(100);
    log('photoLoaded', { visible: !$('canvas-wrap').hidden });

    window.__sfAtButton = (id) => {
      const b = $(id);
      if (!b || b.hidden) {
        const can = $('stage-canvas').getBoundingClientRect();
        return [can.left + can.width / 2, can.top + can.height / 2];   // absent: keep RED readable
      }
      const q = b.getBoundingClientRect();
      return [q.left + q.width / 2, q.top + q.height / 2];
    };
    // For an export click: forget the previous capture FIRST, then aim — so the snapshot that
    // follows can wait for this click's blob without accepting the last one.
    window.__sfAtExport = (id) => {
      window.__sfLastBlob = null;
      return window.__sfAtButton(id);
    };

    const stash = { controls };
    installHooks();          // defines __sfSave/__sfStash, and the criteria for this document
    window.__sfSave(stash);

    window.__sfNextInput = [
      { t: 'click', fns: ['window.__sfAtExport("btn-export-webp")'], ms: 400 },
      { t: 'read', name: 'webpDefault' },
      { t: 'move', fns: ['window.__sfSetLevel("webp", "smaller")'] },
      { t: 'click', fns: ['window.__sfAtExport("btn-export-webp")'], ms: 400 },
      { t: 'read', name: 'webpSmaller' },
      { t: 'move', fns: ['window.__sfSetLevel("webp", "maximum")'] },
      { t: 'click', fns: ['window.__sfAtExport("btn-export-webp")'], ms: 400 },
      { t: 'read', name: 'webpMaximum' },
      { t: 'move', fns: ['window.__sfSetLevel("jpeg", "smaller")'] },
      { t: 'click', fns: ['window.__sfAtExport("btn-export-jpeg")'], ms: 400 },
      { t: 'read', name: 'jpegSmaller' },
      { t: 'move', fns: ['window.__sfSetLevel("jpeg", "maximum")'] },
      { t: 'click', fns: ['window.__sfAtExport("btn-export-jpeg")'], ms: 400 },
      { t: 'read', name: 'jpegMaximum' },
      { t: 'click', fns: ['window.__sfAtExport("btn-export-png")'], ms: 400 },
      { t: 'read', name: 'pngExport' },
      { t: 'move', fns: [`(${String(installHooks)})()`] },
    ];
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
