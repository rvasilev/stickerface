// Diagnostic (NOT a gate): why does the FIRST pinch gesture of the session change
// nothing, while the second one zooms? Requires E2E_MOBILE=1.
//
// Dumps the app's own zoom bookkeeping around a single gesture: the view before,
// during (after the first move and after the last), and after the gesture, plus the
// `_pan` record the router built at the second finger's pointerdown.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);
  const canvas = document.getElementById('stage-canvas');
  const app = () => window.__stickerface;

  const snap = () => {
    const a = app();
    const rect = canvas.getBoundingClientRect();
    const p = document.createElement('canvas');
    p.width = canvas.width; p.height = canvas.height;
    const c = p.getContext('2d');
    c.drawImage(canvas, 0, 0);
    const d = c.getImageData(0, 0, p.width, p.height).data;
    let n = 0, minX = 1e9, maxX = -1;
    for (let y = 0; y < p.height; y++) {
      for (let x = 0; x < p.width; x++) {
        const i = (y * p.width + x) * 4;
        if (d[i] >= 235 && d[i] <= 255 && d[i + 1] >= 184 && d[i + 1] <= 224 && d[i + 2] >= 57 && d[i + 2] <= 97) {
          n++; if (x < minX) minX = x; if (x > maxX) maxX = x;
        }
      }
    }
    const sx = rect.width / canvas.width;
    return {
      view: a?.view ? { dx: Math.round(a.view.dx * 100) / 100, dy: Math.round(a.view.dy * 100) / 100, scale: Math.round(a.view.scale * 1000) / 1000 } : null,
      pan: a?._pan ? {
        startDist: Math.round(a._pan.startDist * 100) / 100,
        focalStart: a._pan.focalStart ? [Math.round(a._pan.focalStart.x), Math.round(a._pan.focalStart.y)] : null,
        startView: a._pan.startView,
        keys: Object.keys(a._pan),
      } : null,
      pointers: a?._pointers?.size ?? null,
      pts: a?._pointers ? a._pointers.values().map((p) => [Math.round(p.x), Math.round(p.y)]) : null,
      datasetPointers: canvas.dataset.pointers,
      yellowW: maxX >= 0 ? Math.round((maxX - minX + 1) * sx) : 0,
      canvasCss: [Math.round(rect.width), Math.round(rect.height)],
      canvasBacking: [canvas.width, canvas.height],
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
    const rect = canvas.getBoundingClientRect();
    const at = (fx, fy) => ({ clientX: rect.left + rect.width * fx, clientY: rect.top + rect.height * fy });
    const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse', ...at(0.45, 0.4) };
    canvas.dispatchEvent(new PointerEvent('pointerdown', o));
    canvas.dispatchEvent(new PointerEvent('pointerup', o));
    await sleep(250);

    const CENTRE = [rect.left + rect.width / 2, rect.top + rect.height / 2];
    const seg = (dist) => [
      [CENTRE[0] + dist / 2, CENTRE[1]],
      [CENTRE[0] - dist / 2, CENTRE[1]],
    ];
    const lerp = (from, to, n) => {
      const out = [];
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        out.push({ t: 'touchMove', pts: [0, 1].map((j) => [
          from[j][0] + (to[j][0] - from[j][0]) * t, from[j][1] + (to[j][1] - from[j][1]) * t]), ms: 45 });
      }
      return out;
    };
    const A = seg(30), B = seg(90), C = seg(300);
    const GESTURE_1 = [
      { t: 'touchStart', pts: A, ms: 90 },
      { t: 'touchMove', pts: [[A[0][0] + 8, A[0][1]], [A[1][0] - 8, A[1][1]]], ms: 60 },
      { t: 'read', name: 'g1_firstMove' },
      ...lerp(seg(46), B, 6),
      { t: 'read', name: 'g1_lastMove' },
      { t: 'touchEnd', pts: [], ms: 320 },
      { t: 'read', name: 'g1_end' },
      // second gesture, same shape, from where the first left the fingers
      { t: 'touchStart', pts: B, ms: 90 },
      ...lerp(B, C, 8),
      { t: 'read', name: 'g2_lastMove' },
      { t: 'touchEnd', pts: [], ms: 320 },
      { t: 'read', name: 'g2_end' },
    ];

    window.__sfSnaps = {};
    window.__sfSnap = (name) => { window.__sfSnaps[name] = snap(); return true; };
    window.__sfNextInput = [{ t: 'read', name: 'before' }, ...GESTURE_1];
    window.__sfReadTouch = () => {
      // The driver counts and prints ONLY booleans, so the diagnosis is encoded as
      // threshold tests whose names state what they prove. (A diag probe cannot
      // print a number directly.)
      const s = window.__sfSnaps;
      const before = s.before, first = s.g1_firstMove, last = s.g1_lastMove;
      const end1 = s.g1_end, end2 = s.g2_end, g2 = s.g2_lastMove;
      const sd = first?.pan?.startDist;
      const out = {
        panRecordExistsAtFirstMove: !!first?.pan,
        panStartDistIsAbout30: typeof sd === 'number' && Math.abs(sd - 30) < 6,
        panStartDistInvalid: !(typeof sd === 'number' && sd > 0),
        twoPointersTrackedDuringGesture: (first?.pointers ?? 0) >= 2,
        viewScaleStartsAt1: before?.view?.scale === 1,
        gesture1ChangedScale: !!before && !!end1 && Math.abs(end1.view.scale - before.view.scale) > 0.01,
        gesture1ChangedYellowW: !!before && !!end1 && end1.yellowW !== before.yellowW,
        gesture2ChangedScale: !!end1 && !!end2 && Math.abs(end2.view.scale - end1.view.scale) > 0.01,
        gesture2ScaleAtLeast3: !!end2 && end2.view.scale >= 2.9,
        scaleGrewByEndOfSecondMoveInGesture1: !!last && !!before && Math.abs(last.view.scale - before.view.scale) > 0.01,
        pointersReturnToZero: !!end2 && end2.pointers === 0,
        g2StartScale: !!g2 && Math.abs(g2.view.scale - 1) < 0.01,
        // The decisive pair: are the TRACKED finger coordinates updating at all?
        g1TrackedPointsMoved: !!first?.pts && !!last?.pts &&
          JSON.stringify(first.pts) !== JSON.stringify(last.pts),
        g1TrackedDistanceGrew: !!first?.pts && !!last?.pts && first.pts.length >= 2 && last.pts.length >= 2 &&
          Math.hypot(last.pts[0][0] - last.pts[1][0], last.pts[0][1] - last.pts[1][1]) >
          Math.hypot(first.pts[0][0] - first.pts[1][0], first.pts[0][1] - first.pts[1][1]) + 5,
        g2TrackedDistanceGrew: !!s.g2_lastMove?.pts && !!end1?.pts && s.g2_lastMove.pts.length >= 2 && end1.pts.length >= 2 &&
          Math.hypot(s.g2_lastMove.pts[0][0] - s.g2_lastMove.pts[1][0], s.g2_lastMove.pts[0][1] - s.g2_lastMove.pts[1][1]) >
          Math.hypot(end1.pts[0][0] - end1.pts[1][0], end1.pts[0][1] - end1.pts[1][1]) + 5,
        g1PointerCountAtLastMove: (last?.pointers ?? -1) >= 2,
        // Leak hypothesis: if a stale contact is still tracked, the distance is
        // computed from the WRONG PAIR and never changes (which is what we see).
        exactlyTwoPointersDuringG1: first?.pointers === 2 && last?.pointers === 2,
        g1PannedAtAll: !!before && !!last && (Math.abs(last.view.dx - before.view.dx) > 2 ||
          Math.abs(last.view.dy - before.view.dy) > 2),
      };
      return JSON.stringify(out);
    };

    log('armed', true);
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
