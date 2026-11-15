// Diagnostic (NOT a gate): does a synthetic file-input dispatch actually reach the app, and at which
// photo size does it stop loading?
//
// Two facts make this worth a probe rather than an argument:
//  - the app's load path is SILENT on refusal — `ui.js: loadImageFile` returns without a word when
//    the File's type does not start with `image/`, and `img.onerror` only revokes the object URL;
//  - the obsvered failure on a REMOTE origin is that every DOM-only criterion passes while every
//    handler-dependent one fails with no console error and no status text, which is exactly what a
//    dispatch that never reaches a listener looks like — or what a listener that refuses looks like.
//
// So this reports, for each photo size: whether a probe-installed listener SAW the change event, what
// type/size it carried, whether the app then showed its stage, and the app's own status line. A probe
// listener and the app's listener both receive the same event, so "seen" separates "the event did not
// arrive" from "the app received it and did nothing".
(async () => {
  const r = { steps: [], errors: [] };
  const log = (k, v) => r.steps.push([k, v]);
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const $ = (id) => document.getElementById(id);
  const observed = [];

  r.dispatchReachesAListener = false;
  r.everySizeLoads = false;

  try {
    log('atProbeStart', {
      readyState: document.readyState,
      pickerButtons: ($('emoji-picker') || { children: [] }).children.length,
      exportPngDisabled: $('btn-export-png') ? $('btn-export-png').disabled : 'MISSING',
      inputPresent: !!$('file-input'),
      accept: ($('file-input') || {}).accept,
      hasSw: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      origin: location.origin,
    });

    // A second listener on the same node the app listens to: if this fires, the event reached the
    // document's listeners and the app's own handler was called too.
    $('file-input').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      observed.push({ seen: true, name: f ? f.name : null, type: f ? f.type : null, size: f ? f.size : null });
    });

    const makeFile = async (W, H) => {
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
      return new File([blob], `boot-${W}.jpg`, { type: 'image/jpeg' });
    };

    // The sweep: the 900x600 the older gates use, and the 2600x1800 the size gate uses.
    for (const [W, H] of [[900, 600], [2600, 1800]]) {
      const before = observed.length;
      const t0 = performance.now();
      let built = null;
      try {
        const file = await makeFile(W, H);
        built = { name: file.name, type: file.type, size: file.size };
        const dt = new DataTransfer();
        dt.items.add(file);
        const input = $('file-input');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) {
        r.errors.push(`build/dispatch ${W}: ${String((e && e.stack) || e)}`);
      }
      let loaded = false;
      for (let i = 0; i < 120 && $('canvas-wrap').hidden; i++) await sleep(100);
      loaded = !$('canvas-wrap').hidden;
      log(`size ${W}x${H}`, {
        built,
        dispatchSeenByProbe: observed.length > before,
        observed: observed[observed.length - 1] || null,
        stageShown: loaded,
        status: ($('export-status') || {}).textContent || '',
        exportPngDisabled: $('btn-export-png') ? $('btn-export-png').disabled : 'MISSING',
        ms: Math.round(performance.now() - t0),
      });
    }

    r.dispatchReachesAListener = observed.length > 0;
    r.everySizeLoads = !$('canvas-wrap').hidden;
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
