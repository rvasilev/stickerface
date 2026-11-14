// Gate — a pinch that crosses FRAME_MIN_CHROME_PX must not have the chrome yanked out
// from under it, and it must still be able to finish.
//
// The hazard, stated plainly: a touch pointer is implicitly captured by the element
// under its press, and `_syncChrome` toggles `hidden` on those very elements while the
// frame's size changes. If Chromium cancelled the captured touch when its element is
// hidden, the pinch would freeze exactly at the threshold — silently, with no console
// error, and every other gate still green (they all pinch OUTWARD, so none of them
// reaches the threshold at all).
//
// So this probe pinches INWARD with both contacts on the handles, and reads BETWEEN
// moves — the steps phase delivers `read` steps between touch events, which is the only
// way to observe a gesture mid-flight here. Measured 2026-11-14, on the build that hid
// the chrome mid-gesture: the pinch did NOT freeze (29.9 px -> 6.7 px after the
// crossing, contacts intact), but the handles and the move mark did disappear under the
// fingers using them. `chromeStaysUpWhileAGestureIsLive` is the criterion that fails
// there and passes once the flip waits for the gesture to end. Requires E2E_MOBILE=1.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);
  const canvas = document.getElementById('stage-canvas');

  r.shrinkSurvivesTheCrossing = false;
  r.pointersSurviveTheCrossing = false;
  r.chromeStaysUpWhileAGestureIsLive = false;

  try {
    const blob = await (await fetch('tests/e2e/fixture.jpg?cb=' + Date.now(), { cache: 'no-store' })).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'fixture.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 100 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);
    await sleep(400);

    const rect = canvas.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, pointerType: 'mouse',
                clientX: rect.left + rect.width * 0.5, clientY: rect.top + rect.height * 0.5 };
    canvas.dispatchEvent(new PointerEvent('pointerdown', o));
    canvas.dispatchEvent(new PointerEvent('pointerup', o));
    await sleep(250);

    window.__sfH = (name) => {
      const el = [...document.querySelectorAll('#select-box .handle')].find((h) => h.dataset.handle === name);
      const b = el.getBoundingClientRect();
      return [b.left + b.width / 2, b.top + b.height / 2];
    };

    const snap = () => {
      const box = document.getElementById('select-box').getBoundingClientRect();
      const hs = [...document.querySelectorAll('#select-box .handle')];
      const mark = document.querySelector('.move-mark');
      return {
        frameW: Math.round(box.width * 10) / 10,
        pointers: canvas.dataset.pointers,
        transforming: canvas.dataset.transforming || '',
        handlesShown: hs.every((h) => !h.hidden && getComputedStyle(h).display !== 'none'),
        markShown: !!mark && getComputedStyle(mark).display !== 'none',
      };
    };

    // The contacts are captured ONCE, from the page, before any gesture: the chrome this
    // probe is testing is exactly what a live resolver reads, so when `_syncChrome` hides
    // a handle mid-pinch a live `getBoundingClientRect` returns 0×0 and the contacts
    // teleport to the viewport origin — measured, the sticker then collapses to its size
    // floor in one step. A probe whose aim depends on the thing under test cannot measure
    // that thing changing. Fixed absolute points + a fraction of the INITIAL separation
    // are immune to it.
    window.__sfStart = { rotate: window.__sfH('rotate'), se: window.__sfH('se') };
    window.__sfPt = (which, s) => {
      const { rotate, se } = window.__sfStart;
      const dx = se[0] - rotate[0], dy = se[1] - rotate[1];
      const n = Math.hypot(dx, dy) || 1;
      const a = which === 'rotate' ? rotate : se;
      const sign = which === 'rotate' ? 1 : -1;   // both walk inward along that line
      return [a[0] + sign * dx / n * (s * n), a[1] + sign * dy / n * (s * n)];
    };

    // s is the fraction of the initial separation each contact gives up, so the
    // separation becomes n(1 - 2s) and the centroid never moves.
    const squash = (s) => ({
      t: 'touchMove',
      fns: [`window.__sfPt('rotate', ${s})`, `window.__sfPt('se', ${s})`],
      ms: 70,
    });

    window.__sfSnaps = {};
    window.__sfSnap = (name) => { window.__sfSnaps[name] = snap(); return true; };
    window.__sfNextInput = [
      { t: 'read', name: 'start' },
      { t: 'touchStart', fns: [`window.__sfPt('rotate', 0)`, `window.__sfPt('se', 0)`], ms: 100 },
      squash(0.1), { t: 'read', name: 's1' },
      squash(0.2), { t: 'read', name: 's2' },
      squash(0.3), { t: 'read', name: 's3' },
      squash(0.4), { t: 'read', name: 's4' },
      { t: 'touchEnd', pts: [], ms: 320 },
      { t: 'read', name: 'end' },
    ];

    window.__sfReadTouch = () => {
      const s = window.__sfSnaps || {};
      const out = { steps: [] };
      const keys = ['start', 's1', 's2', 's3', 's4', 'end'].filter((k) => s[k]);
      for (const k of keys) out.steps.push([k, s[k]]);
      const live = keys.filter((k) => k !== 'start' && k !== 'end');   // gesture in flight
      const end = s.end;
      if (live.length < 4 || !end) { out.steps.push(['missingSnaps', keys]); return JSON.stringify(out); }

      const sizes = live.map((k) => s[k].frameW);
      const monotone = sizes.every((v, i) => i === 0 || v <= sizes[i - 1]);
      const crossed = live.filter((k) => s[k].frameW < 36);
      // Guarded on the crossing having happened, and on the aim having worked: a
      // sequence that stalls or reverses says nothing about surviving the crossing.
      out.shrinkSurvivesTheCrossing = crossed.length > 0 && monotone
        && sizes[sizes.length - 1] < s[crossed[0]].frameW;

      out.pointersSurviveTheCrossing = live.every((k) => s[k].pointers === '2')
        && live.some((k) => s[k].transforming === '1');

      // The rule: the chrome is NOT redecorated under a live contact — and, so the
      // criterion cannot pass by never hiding at all, it IS out once the contacts lift.
      out.chromeStaysUpWhileAGestureIsLive = live.every((k) => s[k].handlesShown && s[k].markShown)
        && !end.handlesShown && !end.markShown;

      out.steps.push(['sizes', sizes]);
      out.steps.push(['crossedAt', crossed.length ? s[crossed[0]].frameW : null]);
      out.steps.push(['end', end]);
      return JSON.stringify(out);
    };
    log('armed', true);
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
