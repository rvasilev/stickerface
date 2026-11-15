// Diagnostic (NOT a gate): how long does the app take to BOOT, and does a file-input dispatch land
// before or after the handlers exist?
//
// Why it exists: the harness reloads, waits a fixed 2.5 s, then evaluates a probe. That is generous
// for a probe served from this repo over loopback, where the module graph is local — and it is a
// guess against a REMOTE origin, where index.html and four ES modules come over the network and each
// import is a round trip. On a cold Pages fetch the app can still be unconstructed when the probe
// dispatches `change` on #file-input, and a listener that does not exist yet swallows the event with
// no error at all: every DOM-only criterion passes, every handler-dependent one fails, and the
// console stays clean. That is a harness-timing failure wearing an app-failure costume.
//
// The boot proof is the PICKER: its 76 buttons are created by the app's constructor, so a non-empty
// #emoji-picker means the module executed and the handlers are attached.
(async () => {
  const r = { steps: [], errors: [] };
  const log = (k, v) => r.steps.push([k, v]);
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const $ = (id) => document.getElementById(id);

  r.pickerPopulatedBeforeDispatch = false;
  r.bootMsUnder3000 = false;
  r.photoLoadsAfterBoot = false;

  const t0 = performance.now();
  log('atProbeStart', {
    readyState: document.readyState,
    pickerButtons: ($('emoji-picker') || { children: [] }).children.length,
    exportPngDisabled: $('btn-export-png') ? $('btn-export-png').disabled : 'MISSING',
    hasSw: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
  });

  // 1. Wait for boot, up to 20 s, recording how long it took.
  let bootMs = null;
  for (let i = 0; i < 200; i++) {
    if ($('emoji-picker') && $('emoji-picker').children.length > 0) { bootMs = Math.round(performance.now() - t0); break; }
    await sleep(100);
  }
  log('boot', { bootMs, pickerButtons: ($('emoji-picker') || { children: [] }).children.length });
  r.pickerPopulatedBeforeDispatch = bootMs !== null;
  r.bootMsUnder3000 = bootMs !== null && bootMs < 3000;

  // 2. NOW dispatch the photo, exactly as the gates do, and see whether it loads.
  let loaded = false;
  try {
    const W = 900, H = 600;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
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
    dt.items.add(new File([blob], 'boot-noise.jpg', { type: 'image/jpeg' }));
    const input = $('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 150 && $('canvas-wrap').hidden; i++) await sleep(100);
    loaded = !$('canvas-wrap').hidden;
    log('afterDispatch', { loaded, waitedMs: Math.round(performance.now() - t0) });
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  r.photoLoadsAfterBoot = loaded;
  return JSON.stringify(r);
})()
