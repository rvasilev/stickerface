// Probe: is the preview canvas laid out without distortion, and are all picker
// thumbnails actually loaded?
(async () => {
  const out = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // load the fixture first — geometry only matters with a photo in the canvas
  const blob = await (await fetch('tests/e2e/fixture.jpg?cb=' + Date.now(), { cache: 'no-store' })).blob();
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'fixture.jpg', { type: 'image/jpeg' }));
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  for (let i = 0; i < 80 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);
  const canvas = document.getElementById('stage-canvas');
  const wrap = document.getElementById('canvas-wrap');
  const stage = document.querySelector('main.stage');
  // drop one sticker so the selection chrome exists
  const rr = canvas.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse',
              clientX: rr.left + rr.width * 0.5, clientY: rr.top + rr.height * 0.5 };
  canvas.dispatchEvent(new PointerEvent('pointerdown', o));
  canvas.dispatchEvent(new PointerEvent('pointerup', o));
  await sleep(200);
  const cs = getComputedStyle(canvas);
  out.canvasBacking = [canvas.width, canvas.height];
  out.imageAspect = +(canvas.width / canvas.height).toFixed(4);
  const r = canvas.getBoundingClientRect();
  out.canvasCssBox = [Math.round(r.width), Math.round(r.height)];
  out.cssAspect = +(r.width / r.height).toFixed(4);
  out.aspectDistortion = +((r.width / r.height) / (canvas.width / canvas.height)).toFixed(4);
  out.cssSize = cs.width + ' x ' + cs.height;
  out.objectFit = cs.objectFit;
  out.wrapBox = [Math.round(wrap.getBoundingClientRect().width), Math.round(wrap.getBoundingClientRect().height)];
  out.stageBox = [Math.round(stage.getBoundingClientRect().width), Math.round(stage.getBoundingClientRect().height)];
  out.viewport = [window.innerWidth, window.innerHeight];
  const imgs = [...document.querySelectorAll('#emoji-picker img')];
  out.pickerThumbs = imgs.length;
  out.pickerThumbsNotLoaded = imgs.filter((i) => !i.complete || i.naturalWidth === 0).length;
  const st = document.querySelector('.select-box');
  if (st && !st.hidden) {
    const sr = st.getBoundingClientRect();
    out.selectBox = { left: Math.round(sr.left), top: Math.round(sr.top), w: Math.round(sr.width), h: Math.round(sr.height) };
    out.selectBoxInsideCanvas = sr.left >= r.left - 1 && sr.right <= r.right + 1 && sr.top >= r.top - 1 && sr.bottom <= r.bottom + 1;
  }
  // --- portrait round-trip: a tall image must also get a correct box ------
  // Generated in-page (no network, no fixture regeneration): a deterministic
  // 800x1200 JPEG uploaded through the same file input. The acceptance gate
  // uses the landscape fixture; portrait is where a naive width-only fit
  // gives a box taller than the window.
  out.portrait = await (async () => {
    const w = 800, h = 1200;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.fillStyle = 'rgb(20,60,120)'; cx.fillRect(0, 0, w, h);
    cx.fillStyle = 'rgb(230,180,120)'; cx.fillRect(300, 400, 200, 200);
    const pb = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.95));
    const dt2 = new DataTransfer();
    dt2.items.add(new File([pb], 'portrait.jpg', { type: 'image/jpeg' }));
    const inp2 = document.getElementById('file-input');
    inp2.files = dt2.files;
    inp2.dispatchEvent(new Event('change', { bubbles: true }));
    // Poll until backing store matches the portrait image (it was 1200x800).
    for (let i = 0; i < 80; i++) {
      if (canvas.width === 800 && canvas.height === 1200) break;
      await sleep(100);
    }
    await sleep(250); // let _applyFitCanvas settle after the resize
    const r2 = canvas.getBoundingClientRect();
    return {
      canvasBacking: [canvas.width, canvas.height],
      cssBox: [Math.round(r2.width), Math.round(r2.height)],
      cssAspect: +(r2.width / r2.height).toFixed(4),
      aspectDistortion: +((r2.width / r2.height) / (canvas.width / canvas.height)).toFixed(4),
    };
  })();
  return JSON.stringify(out, null, 1);
})()
