// First-run coach mark probe. The gesture model is unusual (one finger works the
// stickers, two fingers move/zoom the photo) and nobody discovers it without being
// told; below ~32 CSS px the handles used to block a move drag too, and Move/Resize
// is a mode the user has to notice. So the first photo load explains it, once.
//
// Requirements this pins, each of which has a way to be wrong:
//   * it appears on the FIRST photo, and never before one is loaded
//   * the wording matches the device (a mouse user must not be told about fingers)
//   * its card does NOT swallow canvas presses — an overlay that does is the
//     "I can't click there" bug this repo already fixed once for the stage hint
//   * its button IS pressable and does not leak the press through to the canvas
//   * either dismissing path hides it and persists, so it is first-run only
//   * a later photo does not bring it back
//
// Criteria are declared false up front and overwritten by whichever phase measures
// them, so a phase that never runs leaves them FAILING instead of absent.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);

  const rect = (el) => {
    const b = el.getBoundingClientRect();
    return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height,
             cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
  };

  r.coachHiddenBeforePhoto = false;
  r.coachAppearsOnFirstPhoto = false;
  r.coachTextMatchesPointerType = false;
  r.coachCardIsNotAHitTarget = false;
  r.coachDoesNotSwallowCanvasPresses = false;
  r.coachButtonIsReachableAndSized = false;
  r.canvasInteractionDismissesIt = false;
  r.coachStaysAwayAfterSeen = false;
  r.dismissButtonHidesAndPersists = false;

  try {
    const coach = document.getElementById('coach');
    const dismiss = document.getElementById('coach-dismiss');
    const canvas = document.getElementById('stage-canvas');
    const wrap = document.getElementById('canvas-wrap');
    const app = window.__stickerface;
    const KEY = 'stickerface.coach.seen';
    const shown = (el) => !!el && getComputedStyle(el).display !== 'none';
    const flag = () => { try { return localStorage.getItem(KEY); } catch { return 'THREW'; } };

    // Nothing loaded yet: there is nothing to explain.
    const hiddenBefore = !!coach && !shown(coach);
    r.coachHiddenBeforePhoto = hiddenBefore;
    log('beforeLoad', { coach: !!coach, dismiss: !!dismiss, shownBefore: shown(coach), flag: flag() });

    const loadFixture = async () => {
      const blob = await (await fetch('tests/e2e/fixture.jpg?cb=' + Date.now(), { cache: 'no-store' })).blob();
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'fixture.jpg', { type: 'image/jpeg' }));
      const input = document.getElementById('file-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      for (let i = 0; i < 100 && wrap.hidden; i++) await sleep(100);
      await sleep(250);
    };
    await loadFixture();

    const text = () => (coach ? (coach.textContent || '').replace(/\s+/g, ' ').trim() : '');
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const cardRect = coach ? rect(coach.querySelector('.coach-card') || coach) : null;

    r.coachAppearsOnFirstPhoto = shown(coach) && text().length > 20 && !!dismiss;
    // The wording follows the INPUT DEVICE: a mouse user must not be told about
    // fingers (and a touch user must not be told to "click"). Guarded on the text
    // existing — `/finger/.test('')` is false, so an absent coach would "match" a
    // mouse pointer and this criterion would vouch for nothing.
    r.coachTextMatchesPointerType = shown(coach) && text().length > 10
      && /finger/i.test(text()) === coarse;
    log('firstLoad', { shown: shown(coach), coarse, text: text().slice(0, 220), card: cardRect });

    if (!shown(coach) || !dismiss) {
      log('bail', ['coach not shown on the first photo, or no dismiss button in the DOM']);
      return JSON.stringify(r);
    }

    // The overlay must not intercept: the card's own centre passes through to the
    // canvas. (Whether the press actually LANDED is the behavioural half, measured
    // in the input phase — a hit test alone can be right while the handler is not.)
    const br = rect(dismiss);
    const cardHit = cardRect ? document.elementFromPoint(cardRect.cx, cardRect.cy) : null;
    const btnHit = document.elementFromPoint(br.cx, br.cy);
    const inViewport = br.l >= 0 && br.t >= 0 && br.r <= window.innerWidth && br.b <= window.innerHeight;
    r.coachCardIsNotAHitTarget = !!cardHit && cardHit !== coach && !coach.contains(cardHit);
    r.coachButtonIsReachableAndSized = inViewport && br.w >= 32 && br.h >= 32
      && !!btnHit && (btnHit === dismiss || dismiss.contains(btnHit));
    log('hitTest', {
      cardCentreHits: cardHit ? (cardHit.id || cardHit.className || cardHit.tagName) : null,
      buttonCentreHits: btnHit ? (btnHit.id || btnHit.className || btnHit.tagName) : null,
      buttonBox: br, inViewport,
    });

    // ---- phase 2: real input --------------------------------------------------
    window.__sfBtn = () => { const b = rect(document.getElementById('coach-dismiss')); return [b.cx, b.cy]; };
    window.__sfCard = () => { const el = document.getElementById('coach'); const b = rect(el.querySelector('.coach-card') || el); return [b.cx, b.cy]; };

    const snaps = {};
    window.__sfSnaps = snaps;
    window.__sfSnap = async (name) => {
      // In-page side effects for the state boundaries (a second photo, a cleared
      // flag): building the alternative image in a canvas and handing it to the app
      // as a real File drives the same load path a user does.
      if (name === 'clearFlagAndReload' || name === 'reloadPhoto') {
        if (name === 'clearFlagAndReload') { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }
        const c = document.createElement('canvas');
        c.width = 640; c.height = 480;
        const x = c.getContext('2d');
        x.fillStyle = '#123456'; x.fillRect(0, 0, 640, 480);
        const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
        const dt = new DataTransfer();
        dt.items.add(new File([blob], 'second.png', { type: 'image/png' }));
        const input = document.getElementById('file-input');
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        for (let i = 0; i < 100 && wrap.hidden; i++) await sleep(100);
        await sleep(250);
        snaps[name] = { shown: shown(coach), flag: flag(), stickers: app.store.state.stickers.length, clear: name === 'clearFlagAndReload' };
        return true;
      }
      snaps[name] = {
        shown: shown(coach), flag: flag(),
        stickers: app.store.state.stickers.length,
        card: coach ? rect(coach.querySelector('.coach-card') || coach) : null,
      };
      return true;
    };

    window.__sfNextInput = [
      { t: 'read', name: 't0' },
      // Through the CARD: the press must reach the canvas and place a sticker, and
      // the coach must get out of the way once the user has started.
      { t: 'drag', fns: ['window.__sfCard()', 'window.__sfCard()'], steps: 3, ms: 320 },
      { t: 'read', name: 'afterCardPress' },
      // A later photo with the flag set must not bring it back.
      { t: 'read', name: 'reloadPhoto' },
      // And with the flag cleared it must come back, so the BUTTON path can be
      // measured: a real click on it hides the coach, persists, and does NOT leak
      // through to the canvas (no sticker placed by that press).
      { t: 'read', name: 'clearFlagAndReload' },
      { t: 'click', fns: ['window.__sfBtn()'], ms: 300 },
      { t: 'read', name: 'afterButton' },
    ];

    window.__sfReadTouch = () => {
      const s = window.__sfSnaps || {};
      const out = { steps: [] };
      const need = ['t0', 'afterCardPress', 'reloadPhoto', 'clearFlagAndReload', 'afterButton'];
      const missing = need.filter((k) => !s[k]);
      if (missing.length) { out.steps.push(['missingSnaps', missing]); return JSON.stringify(out); }

      // The pass-through, behaviourally: a real press at the CARD's own centre
      // reached the canvas and placed a sticker. Guarded on the sticker count —
      // "nothing broke" is not the claim.
      const placed = s.afterCardPress.stickers === s.t0.stickers + 1;
      out.coachDoesNotSwallowCanvasPresses = placed && s.afterCardPress.shown === false;
      out.canvasInteractionDismissesIt = s.t0.shown === true
        && s.afterCardPress.shown === false && s.afterCardPress.flag === '1';
      out.coachStaysAwayAfterSeen = s.reloadPhoto.shown === false && s.reloadPhoto.flag === '1';
      // With the flag cleared and a fresh photo, the coach is back — so the button
      // click below is a real dismissal, not a no-op on a hidden element.
      const cameBack = s.clearFlagAndReload.shown === true;
      out.dismissButtonHidesAndPersists = cameBack && s.afterButton.shown === false
        && s.afterButton.flag === '1'
        && s.afterButton.stickers === s.clearFlagAndReload.stickers;

      out.steps.push(['passThrough', { placed, t0: s.t0.stickers, after: s.afterCardPress.stickers }]);
      out.steps.push(['interaction', { shownBefore: s.t0.shown, shownAfter: s.afterCardPress.shown, flag: s.afterCardPress.flag }]);
      out.steps.push(['persistence', { reload: [s.reloadPhoto.shown, s.reloadPhoto.flag], cameBack, afterButton: [s.afterButton.shown, s.afterButton.flag], stickers: [s.clearFlagAndReload.stickers, s.afterButton.stickers] }]);
      return JSON.stringify(out);
    };

    log('armed', { buttonBox: br, card: cardRect });
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()