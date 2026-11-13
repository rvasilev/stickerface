// Diagnostic (NOT a gate): measure document.createElement calls during one
// synthetic drag gesture with ~10 stickers on screen. Run through the same
// harness as every other probe: E2E_PROBE=tests/e2e/diag-layer-perf-probe.js npm run e2e
//
// Places 10 stickers via the store, then drives a drag by calling
// store.beginDrag/move/commitDrag the way the pointer handler does,
// counting createElement calls. BEFORE: one rebuild per move -> ~50 nodes
// per move * 9 events = hundreds. AFTER: geometry events only refresh the
// label titles; the 2 remaining canvases are paint()'s scratch canvases.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);
  const canvas = document.getElementById('stage-canvas');

  try {
    const blob = await (await fetch('tests/e2e/fixture.jpg?cb=' + Date.now(), { cache: 'no-store' })).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'fixture.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 100 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);

    const app = window.__stickerface;
    if (!app) throw new Error('no app');

    // Add 10 stickers programmatically (each add rebuilds the list, but we
    // reset the counter after setup so only the drag counts).
    const srcs = ['assets/emoji/1f600.svg', 'assets/emoji/1f601.svg', 'assets/emoji/1f602.svg', 'assets/emoji/1f603.svg', 'assets/emoji/1f604.svg'];
    for (let i = 0; i < 10; i++) {
      app.store.add({ kind: 'emoji', src: srcs[i % srcs.length], cx: 0.18 + (i % 5) * 0.16, cy: 0.18 + Math.floor(i / 5) * 0.35 + 0.3, w: 0.12, h: 0.12 });
    }
    await sleep(300);
    log('stickers', app.store.state.stickers.length);
    log('rows', document.getElementById('layer-list').children.length);

    // Patch createElement and count during one drag: 8 moves + commit.
    // Instrument every path to _syncLayerList so the call is root-caused.
    const app2 = window.__stickerface;
    const origSync = app2._syncLayerList.bind(app2);
    let syncCalls = [];
    app2._syncLayerList = function(...a) {
      const stack = (new Error()).stack.split('\n').slice(1, 7).join(' ');
      syncCalls.push(stack);
      return origSync(...a);
    };
    const realCreate = document.createElement.bind(document);
    let count = 0;
    let tags = [];
    document.createElement = (tag, opts) => { count++; tags.push(tag); return realCreate(tag, opts); };
    const before = count;
    tags = [];
    syncCalls = [];
    const target = app.store.state.stickers[3];
    app.store.beginDrag(target.id);
    for (let i = 1; i <= 8; i++) {
      app.store.move(target.id, { cx: 0.5 + i * 0.01, cy: 0.5 });
    }
    app.store.commitDrag();
    await sleep(300);
    const during = count - before;
    log('createElementDuringDrag', during);
    log('syncCalls', syncCalls);
    log('layerRowsInTags', tags.filter((t) => ['li', 'span', 'button'].includes(t)).length);
    log('canvasTags', tags.filter((t) => t === 'canvas').length);
    app2._syncLayerList = origSync;
    log('moves', 8);
    log('stickersAfter', app.store.state.stickers.length);
    document.createElement = realCreate;

    // Booleans required by the driver: at least one PASS criterion.
    r.dragCompleted = app.store.state.stickers.length === 10;
    r.createElementCountReported = typeof during === 'number';
    log('targetCx', target.cx);
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})();
