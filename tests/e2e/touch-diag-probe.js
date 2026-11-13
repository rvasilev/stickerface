(async () => {
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const blob = await (await fetch('tests/e2e/fixture.jpg?cb=' + Date.now(), { cache: 'no-store' })).blob();
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'fixture.jpg', { type: 'image/jpeg' }));
  const input = document.getElementById('file-input');
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  for (let i = 0; i < 100 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);
  const canvas = document.getElementById('stage-canvas');
  const rect = canvas.getBoundingClientRect();
  const cx = rect.left + rect.width * 0.45, cy = rect.top + rect.height * 0.40;
  window.__log = [];
  for (const t of ['pointerdown','pointermove','pointerup','pointercancel','touchstart','touchmove','touchend']) {
    canvas.addEventListener(t, (e) => {
      window.__log.push([t, e.pointerId ?? null, e.isPrimary, e.clientX, e.clientY, e.pointerType, e.button ?? null]);
    }, true);
    document.addEventListener(t, (e) => {
      window.__log.push(['DOC-'+t, e.pointerId ?? null, e.isPrimary, e.clientX, e.clientY]);
    }, true);
  }
  window.__dump = () => JSON.stringify(window.__log);
  window.__viewNow = () => JSON.stringify({ view: window.__stickerface?.view, pointers: window.__stickerface?._pointers?.size, pan: window.__stickerface?._pan, drag: window.__stickerface?.drag });
  window.__sfNextInput = [
    { t: 'touchStart', pts: [[cx, cy]], ms: 90 },
    { t: 'touchEnd', pts: [], ms: 250 },
    { t: 'touchStart', pts: [[cx, cy]], ms: 90 },
    { t: 'touchMove', pts: [[cx+25, cy+15]], ms: 40 },
    { t: 'touchMove', pts: [[cx+50, cy+30]], ms: 40 },
    { t: 'touchEnd', pts: [], ms: 250 },
    { t: 'touchStart', pts: [[cx, cy], [cx+60, cy+40]], ms: 90 },
    { t: 'touchMove', pts: [[cx+30, cy+20], [cx+90, cy+60]], ms: 40 },
    { t: 'touchMove', pts: [[cx+60, cy+40], [cx+120, cy+80]], ms: 40 },
    { t: 'touchEnd', pts: [], ms: 250 },
  ];
  window.__sfReadTouch = () => {
    return JSON.stringify({ steps: [], ok: true });
  };
  return JSON.stringify({ armed: true, rect: [rect.left, rect.top, rect.width, rect.height], cx, cy });
})()
