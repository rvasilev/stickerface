// Gate — a two-finger pinch whose fingers land ON the handles still scales the
// sticker. Requires E2E_MOBILE=1.
//
// WHY THIS PROBE EXISTS, and why nothing else covers it: a touch pointer is
// implicitly captured by the element under its press, so when both fingers land on
// the frame's handles their `pointermove` events are delivered to the HANDLE, not the
// canvas. The window-level driver (`_bindWindowMove`, the pump at js/ui.js:1345) is
// what keeps the transform alive in that case, and `sticker-transform-probe` does NOT
// exercise it: that probe aims both fingers at the frame's INTERIOR, where
// `.select-box` is `pointer-events: none` and only `.handle` is clickable, so the
// touches land on the canvas and are pumped by the canvas branch instead.
//
// Prove it by mutation: delete `if (this._xform) this._applyStickerTransform();` from
// the window listener and re-run. Without the pump the gesture still ENTERS transform
// mode (`dataset.pointers=2`, `dataset.transforming=1`) and the sticker NEVER moves —
// silently, with no console error, and with every other named gate green.
//
// Oracles, all from canvas pixels: the sticker's Twemoji yellow bbox (its size) and
// `dataset` (which mode the canvas thinks it is in). Handles are hidden in Move mode,
// so the probe selects Resize first — setup, not a criterion — and proves each press
// really lands on a handle with `document.elementFromPoint`.
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
    let n = 0, minX = 1e9, minY = 1e9, maxX = -1, maxY = -1;
    for (let y = 0; y < probe.height; y++) {
      for (let x = 0; x < probe.width; x++) {
        const i = (y * probe.width + x) * 4;
        const R = d[i], G = d[i + 1], B = d[i + 2];
        if (R >= 235 && R <= 255 && G >= 184 && G <= 224 && B >= 57 && B <= 97) {
          n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    const csx = rect.width / canvas.width, csy = rect.height / canvas.height;
    return {
      yellowPixels: n,
      yellowW: maxX >= 0 ? (maxX - minX + 1) * csx : 0,
      yellowH: maxY >= 0 ? (maxY - minY + 1) * csy : 0,
      mode: [canvas.dataset.pointers, canvas.dataset.transforming || ''],
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
    await sleep(400);

    // Place a sticker with a synthetic tap on empty canvas.
    const rect = canvas.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse',
      clientX: rect.left + rect.width * 0.5, clientY: rect.top + rect.height * 0.5 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', o));
    canvas.dispatchEvent(new PointerEvent('pointerup', o));
    await sleep(250);

    // Handles are hidden in Move mode; this probe needs them VISIBLE and
    // hit-testable, so switch to Resize (setup, not a criterion).
    document.getElementById('mode-resize').click();
    await sleep(200);

    const handles = [...document.querySelectorAll('#select-box .handle')];
    r.handleCount = handles.length === 9;
    const visible = handles.filter((h) => !h.hidden && h.getBoundingClientRect().width > 0).length;
    r.handlesVisible = visible === 9;

    // Proof that the press really lands on a handle (not the canvas).
    window.__sfH = (name) => {
      const el = [...document.querySelectorAll('#select-box .handle')].find((h) => h.dataset.handle === name);
      const b = el.getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2];
    };
    window.__sfHitName = (name) => {
      const p = window.__sfH(name);
      const el = document.elementFromPoint(p[0], p[1]);
      return el ? (el.closest('.handle') ? 'handle:' + el.closest('.handle').dataset.handle : (el.id || el.className)) : null;
    };
    const nPt = window.__sfH('n'), sPt = window.__sfH('s');
    r.topHitIsHandle = String(window.__sfHitName('n')).startsWith('handle');
    r.botHitIsHandle = String(window.__sfHitName('s')).startsWith('handle');
    log('aim', { nPt, sPt, nHit: window.__sfHitName('n'), sHit: window.__sfHitName('s') });

    const grow = (dy) => ({
      t: 'touchMove',
      fns: [
        `(()=>{const p=window.__sfH('n');return [p[0],p[1]-${dy}];})()`,
        `(()=>{const p=window.__sfH('s');return [p[0],p[1]+${dy}];})()`,
      ],
      ms: 45,
    });
    window.__sfSnaps = {};
    window.__sfSnap = (name) => { window.__sfSnaps[name] = measure(); return true; };
    window.__sfNextInput = [
      { t: 'read', name: 'before' },
      { t: 'touchStart', fns: [`window.__sfH('n')`, `window.__sfH('s')`], ms: 90 },
      grow(20), grow(45), grow(75), grow(105),
      { t: 'read', name: 'during' },
      grow(140), grow(180),
      { t: 'touchEnd', pts: [], ms: 260 },
      { t: 'read', name: 'after' },
    ];

    window.__sfReadTouch = () => {
      const s = window.__sfSnaps;
      const b = s.before, d = s.during, a = s.after;
      const out = { steps: [] };
      const ratio = (x, y) => (x && y && x.yellowW > 0) ? y.yellowW / x.yellowW : null;
      const g = ratio(b, a);
      out.pinchOnHandlesScalesSticker = !!g && g > 1.4;
      out.pinchOnHandlesEntersTransform = !!(d && d.mode && d.mode[1] === '1');
      out.steps.push(['before', b]);
      out.steps.push(['during', d]);
      out.steps.push(['after', a]);
      out.steps.push(['ratioBeforeAfter', g]);
      return JSON.stringify(out);
    };
    log('armed', true);
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
