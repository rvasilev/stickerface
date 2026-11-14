// Selection-handle probe: the visible markers must be SMALL while the hit area
// stays finger-sized, and shrinking them must not break frame alignment.
// Requires E2E_MOBILE=1 (touch) so the hit area is tested with real touches.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);
  const canvas = document.getElementById('stage-canvas');

  const yellowBox = () => {
    const rect = canvas.getBoundingClientRect();
    const p = document.createElement('canvas');
    p.width = canvas.width; p.height = canvas.height;
    const c = p.getContext('2d');
    c.drawImage(canvas, 0, 0);
    const d = c.getImageData(0, 0, p.width, p.height).data;
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1, n = 0;
    for (let y = 0; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        const i = (y * p.width + x) * 4;
        if (d[i] >= 235 && d[i] <= 255 && d[i + 1] >= 184 && d[i + 1] <= 224 && d[i + 2] >= 57 && d[i + 2] <= 97) {
          n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    const sx = rect.width / canvas.width, sy = rect.height / canvas.height;
    const box = document.getElementById('select-box').getBoundingClientRect();
    return { yellowW: maxX >= 0 ? (maxX - minX + 1) * sx : 0, yellowPixels: n, frameW: box.width, frameH: box.height };
  };

  try {
    const blob = await (await fetch('tests/e2e/fixture.jpg?cb=' + Date.now(), { cache: 'no-store' })).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'fixture.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 100 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);

    const rect = canvas.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse',
      clientX: rect.left + rect.width * 0.45, clientY: rect.top + rect.height * 0.4 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', o));
    canvas.dispatchEvent(new PointerEvent('pointerup', o));
    await sleep(250);

    // The resize and rotate handles are the selected sticker's chrome, with no mode
    // to switch into — they are out whenever the frame is big enough to carry a
    // finger-sized target (three-handle-probe.js gates that).
    const handles = [...document.querySelectorAll('#select-box .handle')];
    const sizes = handles.map((el) => {
      const b = el.getBoundingClientRect();
      return { handle: el.dataset.handle, w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10, cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
    });
    r.handleCount = handles.length === 2;   // 1 resize + 1 rotate
    r.handlesSmall = sizes.every((s) => s.w <= 15 && s.h <= 15 && s.w >= 8 && s.h >= 8);
    log('handleSizes', sizes);
    const rot = sizes.find((s) => s.handle === 'rotate');
    const se = sizes.find((s) => s.handle === 'se');
    r.rotateHandleSmallToo = !!rot && rot.w <= 16 && rot.h <= 16;

    const before = yellowBox();
    log('before', before);
    r.frameAlignmentKept = before.yellowW > 0 && Math.abs(before.frameW / before.yellowW - 1) < 0.25;

    // A finger landing 13px outside the marker's centre must still start the
    // resize: the marker is small but the target is not.
    const OFF = 13;
    const start = [se.cx + OFF, se.cy + OFF];
    const steps = [
      { t: 'touchStart', pts: [start], ms: 90 },
      { t: 'touchMove', pts: [[start[0] + 12, start[1] + 12]], ms: 60 },
      { t: 'touchMove', pts: [[start[0] + 30, start[1] + 30]], ms: 60 },
      { t: 'touchMove', pts: [[start[0] + 45, start[1] + 45]], ms: 60 },
      { t: 'touchEnd', pts: [], ms: 320 },
    ];
    window.__sfSnaps = {};
    window.__sfSnap = (name) => { window.__sfSnaps[name] = yellowBox(); return true; };
    window.__sfNextInput = [{ t: 'read', name: 't0' }, ...steps, { t: 'read', name: 'afterOffCentreDrag' }];
    window.__sfReadTouch = () => {
      const s = window.__sfSnaps;
      const b = s.t0, a = s.afterOffCentreDrag;
      const out = { steps: [] };
      const grow = (b && a && b.yellowW > 0) ? a.yellowW / b.yellowW : null;
      out.offCentreTouchResizes = !!grow && grow > 1.12;
      out.steps.push(['grow', grow]);
      out.steps.push(['afterOffCentreDrag', a]);
      return JSON.stringify(out);
    };
    log('armed', true);
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
