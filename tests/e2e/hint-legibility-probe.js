// Gate: the stage hint must stay legible over the photo it sits on.
//
// Reported bug: "Text with instructions written on bottom of canvas is
// completely invisible when image loaded." A portrait photo fills the stage
// height, so the hint lands ON the image — and the stage paints no background of
// its own. Measured before the fix: --text-dim over a light photo = 2.6:1.
//
// The worst case is a LIGHT photo, so this probe loads one and measures the
// contrast that is actually painted: computed text colour against the hint's own
// backdrop composited over the photo pixel underneath it.
(async () => {
  const r = { steps: [], errors: [] };
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const log = (k, v) => r.steps.push([k, v]);

  const parse = (css) => {
    const m = css.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((s) => parseFloat(s.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const chan = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const over = (fg, bg) => ({
    r: fg.a * fg.r + (1 - fg.a) * bg.r,
    g: fg.a * fg.g + (1 - fg.a) * bg.g,
    b: fg.a * fg.b + (1 - fg.a) * bg.b,
    a: 1,
  });

  try {
    // A near-white photo: the backdrop that made the hint vanish.
    const c = document.createElement('canvas');
    c.width = 800; c.height = 1200;
    const cx = c.getContext('2d');
    const g = cx.createLinearGradient(0, 0, 0, 1200);
    g.addColorStop(0, '#dfe6ee'); g.addColorStop(0.7, '#f2f5f8'); g.addColorStop(1, '#ffffff');
    cx.fillStyle = g; cx.fillRect(0, 0, 800, 1200);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));

    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'bright.jpg', { type: 'image/jpeg' }));
    const input = document.getElementById('file-input');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 80 && document.getElementById('canvas-wrap').hidden; i++) await sleep(100);
    await sleep(400);

    const hint = document.getElementById('stage-hint');
    const canvas = document.getElementById('stage-canvas');
    const hb = hint.getBoundingClientRect();
    const cb = canvas.getBoundingClientRect();
    log('hintRect', [Math.round(hb.left), Math.round(hb.top), Math.round(hb.width), Math.round(hb.height)]);
    log('canvasRect', [Math.round(cb.left), Math.round(cb.top), Math.round(cb.width), Math.round(cb.height)]);

    // --- 1. shown at all -----------------------------------------------------
    r.hintShownAfterLoad = !hint.hidden && getComputedStyle(hint).visibility === 'visible';

    // --- 2. the hint overlaps the photo (the condition being tested) ----------
    const overlaps = !(hb.right < cb.left || hb.left > cb.right || hb.bottom < cb.top || hb.top > cb.bottom);
    log('hintOverlapsCanvas', overlaps);
    r.testIsWorstCase = overlaps;   // if it does not overlap, this probe proves nothing

    // --- 3. the hint paints its own backdrop ---------------------------------
    const cs = getComputedStyle(hint);
    const chip = parse(cs.backgroundColor);
    log('hintColor', cs.color);
    log('hintBackground', cs.backgroundColor);
    r.hintPaintsOwnBackdrop = !!chip && chip.a > 0;

    // --- 4. contrast of what is actually painted ------------------------------
    // Sample the photo pixel under the hint's centre, in backing-store space.
    const scale = canvas.width / cb.width;
    const bx = Math.round((hb.left + hb.width / 2 - cb.left) * scale);
    const by = Math.round((hb.top + hb.height / 2 - cb.top) * scale);
    const px = canvas.getContext('2d').getImageData(
      Math.max(0, Math.min(canvas.width - 1, bx)),
      Math.max(0, Math.min(canvas.height - 1, by)), 1, 1).data;
    const photo = { r: px[0], g: px[1], b: px[2], a: 1 };
    const photoLum = 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2];
    log('photoPixelUnderHint', [px[0], px[1], px[2]]);
    // Guard: this criterion only means something on a light backdrop.
    log('photoIsLight', photoLum > 180);

    const text = parse(cs.color);
    const effectiveBg = over(chip, photo);
    const contrast = ratio(text, effectiveBg);
    log('contrastRatio', contrast.toFixed(2));
    r.hintContrastAtLeast4_5 = contrast >= 4.5;

    // --- 5. the hint must not swallow the click ------------------------------
    // It floats over the photo: if it is a hit target, the bottom-left of the
    // image silently stops accepting a sticker drop.
    const at = document.elementFromPoint(hb.left + hb.width / 2, hb.top + hb.height / 2);
    log('elementAtHintCentre', at ? (at.id || at.tagName) : null);
    r.hintIsNotAClickTarget = !!at && at.id !== 'stage-hint';
  } catch (e) {
    r.errors.push(String((e && e.stack) || e));
  }
  return JSON.stringify(r);
})()
