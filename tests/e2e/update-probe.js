// Gate — the update TRANSITION, end to end: a waiting worker, the bar that offers it, the click
// that takes it over, and the bar's absence afterwards.
//
// The other offline criteria stop at "a first install offers no bar". The transition between
// install and takeover was documented as an unasserted gap
// (browser-acceptance-gates/references/caching-and-offline-gates.md: "the update transition …
// needs a second, different worker served mid-run, which a one-origin-state harness does not
// have") — and a real user walked straight into it: the bar appeared, the click did nothing, and
// the bar stayed. The defect was one line: `controller.postMessage({type:'SKIP_WAITING'})`
// targets the ACTIVE worker, where skipWaiting() is a no-op, so the WAITING worker never
// activated, no `controllerchange` fired, and nothing reloaded.
//
// The transition is forced with no harness change: the SAME script under a URL this run has never
// used is a different worker for the same registration, so it installs and WAITS behind the
// controlling one.
//
// Three measured constraints shape the run, and each one cost a false reading before it was
// understood:
//   1. A probe cannot intercept the app's reload — `location.reload` is an unforgeable own
//      property (no `Location.prototype.reload`, and `defineProperty(location, 'reload', …)`
//      throws `Cannot redefine property: reload`). The click's aftermath therefore only exists in
//      the NEXT document, so what the reader must know is stashed in `sessionStorage`.
//   2. A document that has no controller cannot produce a waiting worker — a new worker activates
//      immediately instead of waiting. So the probe waits for the app's own registration to take
//      control, and only forces a fresh install if the profile left the page uncontrolled.
//   3. Unregistering to get a "clean" start breaks the app: the click handler holds the
//      registration object the app obtained at load, and a stale one reads `waiting === null`, so
//      the handler reloads with the OLD worker still in charge (measured: `navType: 'reload'`,
//      controller unchanged). Never unregister here.
//
// So the run is three documents: A builds the waiting worker, then reloads ITSELF (the probe's own
// reload — which is also what gives B the app's genuine load-path registration); B is where the
// app offers the bar and where the real CDP mouse click lands; C is the document the app's own
// reload produces, and where the final reader runs. The harness evaluates `window.__sfReadTouch()`
// after the steps, so each document re-installs the reader through a no-op mouse MOVE whose `fns`
// expression is the only generic hook available.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);

  r.aWorkerIsWaiting = false;
  r.updateBarAppearsWhileAWorkerWaits = false;
  r.clickTakesOverAndReloads = false;
  r.updateBarGoneAfterTheTakeover = false;

  const scriptOf = (w) => (w ? w.scriptURL : null);

  // Used only if no navigation happens (the build whose click does nothing): armed criteria stay
  // false, which is the true reading there.
  window.__sfReadTouch = () => JSON.stringify(r);

  // Re-installed in every document by the `move` steps below: captures the current state into
  // sessionStorage, and computes the final criteria from whatever document it is called in.
  const HOOKS = [
    '(() => {',
    '  const scriptOf = (w) => (w ? w.scriptURL : null);',
    '  window.__sfSnap = async (name) => {',
    '    const bar = document.getElementById("update-bar");',
    '    const btn = document.getElementById("update-reload");',
    '    const shown = !!bar && !bar.hidden && getComputedStyle(bar).display !== "none";',
    '    const box = btn ? btn.getBoundingClientRect() : null;',
    '    const hit = box ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null;',
    '    const reg = await navigator.serviceWorker.getRegistration();',
    '    const stash = JSON.parse(sessionStorage.getItem("sf-update-probe") || "{}");',
    '    stash[name] = {',
    '      navType: (performance.getEntriesByType("navigation")[0] || {}).type,',
    '      barVisible: shown,',
    '      hitAtButtonCentre: hit ? (hit.id || hit.className || hit.tagName) : null,',
    '      controller: scriptOf(navigator.serviceWorker.controller),',
    '      waiting: scriptOf(reg && reg.waiting),',
    '    };',
    '    sessionStorage.setItem("sf-update-probe", JSON.stringify(stash));',
    '    return true;',
    '  };',
    '  window.__sfReadTouch = async () => {',
    '    const reg = await navigator.serviceWorker.getRegistration();',
    '    const stash = JSON.parse(sessionStorage.getItem("sf-update-probe") || "{}");',
    '    const after = stash.afterClick || {};',
    '    const before = stash.beforeClick || {};',
    '    return JSON.stringify({',
    '      steps: [["docB", before], ["docC", after], ["docCregWaiting", scriptOf(reg && reg.waiting)]],',
    '      errors: [],',
    // Measured at click time, in document B: the app only offers the bar when one is waiting.
    '      aWorkerIsWaiting: !!before.waiting,',
    '      updateBarAppearsWhileAWorkerWaits: !!before.barVisible,',
    // A reload that nothing else could have caused, and a controller that is NOT the one the page
    // had before the click — compared to document B rather than to a URL recorded earlier, because
    // the app\'s own load-path registration legitimately supersedes document A\'s waiting worker.
    '      clickTakesOverAndReloads: after.navType === "reload" && !!before.controller &&',
    '        after.controller !== before.controller,',
    '      updateBarGoneAfterTheTakeover: !after.barVisible,',
    '    });',
    '  };',
    '  return [1, 1];',   // a harmless spot for the no-op mouse move carrying this expression
    '})()',
  ].join('\n');

  try {
    // ---- document A: a controlled page, then a worker that waits behind it ----------------
    for (let i = 0; i < 60 && !navigator.serviceWorker.controller; i++) await sleep(100);
    if (!navigator.serviceWorker.controller) {
      // A profile that left the page uncontrolled: a fresh install's `activate()` →
      // `clients.claim()` is what grants control without a reload. Safe here — document B
      // re-registers and gets its own valid registration object.
      await navigator.serviceWorker.register('./sw.js', { scope: './' });
      for (let i = 0; i < 60 && !navigator.serviceWorker.controller; i++) await sleep(100);
    }
    const regA = await navigator.serviceWorker.getRegistration();
    log('docA', { controller: scriptOf(navigator.serviceWorker.controller) });

    if (!regA.waiting) await navigator.serviceWorker.register('./sw.js?update=' + Date.now(), { scope: './' });
    for (let i = 0; i < 60 && !regA.waiting; i++) await sleep(100);
    log('docAWaiting', { waiting: scriptOf(regA.waiting) });

    // The probe's own reload: document B is then a genuine load, where the app registers and
    // offers the bar by itself. Stash nothing yet — B fills the stash.
    sessionStorage.removeItem('sf-update-probe');
    window.__sfNextInput = [
      { t: 'move', fns: ["(() => { location.reload(); return [1, 1]; })()"] },
      { t: 'settle', ms: 2500 },                                  // document B arrives
      { t: 'move', fns: [HOOKS] },                                // hooks for B
      { t: 'settle', ms: 2000 },                                  // the app registers + offers
      { t: 'read', name: 'beforeClick' },                          // stash: bar, waiting, hit target
      { t: 'click', fns: ["(() => { const b = document.getElementById('update-reload').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; })()"], ms: 60 },
      { t: 'settle', ms: 2500 },                                  // the app's own reload -> document C
      { t: 'move', fns: [HOOKS] },                                // reader for C
      { t: 'read', name: 'afterClick' },                           // stash: what C actually is
    ];

    // The waiting worker's URL, for the reader in C to compare against.
    window.__sfStashWaiting = scriptOf(regA.waiting);
    sessionStorage.setItem('sf-update-probe', JSON.stringify({ waiting: window.__sfStashWaiting }));
    log('stashed', { waiting: window.__sfStashWaiting });
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
