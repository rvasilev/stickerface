// DIAGNOSTIC (not a gate): does the PAINT follow array order after a reorder?
// The gate's dragReordersPixels reads grey (49,55,61) where it expects black
// after the drag. Two candidates, and they need different fixes:
//   a) store.moveTo leaves z out of step with array order -> paint disagrees
//      with the DOM (the failure mode the plan warns about), or
//   b) the gesture does something extra (moves the sticker, resizes the canvas,
//      leaves a drag overlay) that the pixel oracle is reading.
// Calling moveTo directly, with no gesture at all, separates them.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);
  r.paintFollowsArrayOrder = false;
  r.paintFollowsArrayOrderOnDirectMove = false;

  const BLACK = 'assets/emoji/2b1b.svg';
  const WHITE = 'assets/emoji/2b1c.svg';

  try {
    const app = window.__stickerface;
    const canvas = document.getElementById('stage-canvas');
    const ctx = canvas.getContext('2d');
    const blob = await (await fetch('tests/e2e/fixture.jpg?cb=' + Date.now(), { cache: 'no-store' })).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'fixture.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 100 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);
    await sleep(300);

    const imgW = app.image.naturalWidth, imgH = app.image.naturalHeight;
    const w = 0.2, h = (w * imgW) / imgH, CX = 0.4, CY = 0.45;
    const black = app.store.add({ kind: 'emoji', src: BLACK, cx: CX, cy: CY, w, h });
    const white = app.store.add({ kind: 'emoji', src: WHITE, cx: CX, cy: CY, w, h });
    app._draw();
    await sleep(500);

    const px = (fx, fy) => {
      const d = ctx.getImageData(Math.round(fx * canvas.width), Math.round(fy * canvas.height), 1, 1).data;
      return `${d[0]},${d[1]},${d[2]}`;
    };
    const describe = () => app.store.state.stickers.map((s) => ({
      src: (s.src || '').split('/').pop(), z: s.z,
      cx: +s.cx.toFixed(3), cy: +s.cy.toFixed(3), w: +s.w.toFixed(3), radius: s.radius,
    }));
    const snapshot = (tag) => {
      log(tag, {
        arrayOrder: describe().map((s) => s.src),
        z: describe().map((s) => s.z),
        stickers: describe(),
        canvas: [canvas.width, canvas.height, canvas.clientWidth, canvas.clientHeight],
        centre: px(CX, CY),
        centreUp: px(CX, CY - 0.02),
        centreDown: px(CX, CY + 0.02),
      });
    };

    snapshot('beforeAnyMove');
    r.paintFollowsArrayOrder = px(CX, CY) === '255,255,255';

    // (a) DIRECT moveTo, no gesture: white (array idx 1) -> idx 0, so BLACK is painted last
    app.store.moveTo(white.id, 0);
    app._draw();
    await sleep(400);
    snapshot('afterDirectMoveTo');
    r.paintFollowsArrayOrderOnDirectMove = px(CX, CY) === '0,0,0';

    // and back, to be sure it is not a one-way accident
    app.store.moveTo(white.id, 1);
    app._draw();
    await sleep(400);
    snapshot('afterMoveBack');

    log('verdict', {
      directMoveToGivesBlack: r.paintFollowsArrayOrderOnDirectMove,
      means: r.paintFollowsArrayOrderOnDirectMove
        ? 'moveTo + paint agree -> the DRAG gesture is what the gate is reading, not a paint bug'
        : 'moveTo leaves paint out of step with array order -> the store/render path is the bug',
    });
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
