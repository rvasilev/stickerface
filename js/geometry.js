// Pure geometry: no DOM, no canvas, no globals, no imports. Sticker coordinates
// are NORMALIZED (0..1 of the image); pixel maths happens only at the
// render/export edge via px()/norm(). Canvas space: +x right, +y down, rotation
// in radians, clockwise-positive (matching ctx.rotate). View pan/zoom is in CSS
// px — ui.js owns that conversion, this module only clamps the values.

/** @typedef {object} Sticker
 * @property {string} id
 * @property {'emoji'|'blur'|'mosaic'} kind
 * @property {string} [src]
 * @property {number} cx centre x, normalized to image width
 * @property {number} cy centre y, normalized to image height
 * @property {number} w width, normalized to image width
 * @property {number} h height, normalized to image height
 * @property {number} rot radians, clockwise about (cx, cy)
 * @property {number} z paint order (higher = on top)
 * @property {number} [radius] blur/mosaic corner rounding, 0..0.5 of min(w,h)
 * @property {number} [strength] blur sigma px @1x | mosaic block px @1x
 */

/** @typedef {{x:number, y:number}} Pt */

/** @param {unknown} v @param {number} fallback */
function finite(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** @param {number} v normalized, may lie outside 0..1 (not clamped)
 *  @param {number} span px (image width or height) @returns {number} px */
export function px(v, span) {
  const s = finite(span, 0);
  if (s <= 0) return 0;
  return finite(v, 0) * s;
}

/** Inverse of px(); round-trips within 1e-9. @param {number} v px
 *  @param {number} span px @returns {number} normalized */
export function norm(v, span) {
  const s = finite(span, 0);
  if (s <= 0) return 0;
  return finite(v, 0) / s;
}

/** Axis-aligned, un-rotated rect in px, centred on (cx, cy).
 *  @param {Sticker} sticker @param {number} imgW @param {number} imgH
 *  @returns {{x:number, y:number, w:number, h:number}} top-left + size */
export function stickerRect(sticker, imgW, imgH) {
  const w = px(finite(sticker.w), imgW);
  const h = px(finite(sticker.h), imgH);
  const cxp = px(finite(sticker.cx), imgW);
  const cyp = px(finite(sticker.cy), imgH);
  return { x: cxp - w / 2, y: cyp - h / 2, w, h };
}

/** The 8 handle positions (px) for a rect, rotated about its centre by `rot`
 *  with the canvas matrix, so they line up exactly with a translate/rotate paint.
 *  @param {{x:number, y:number, w:number, h:number}} rect un-rotated, px
 *  @param {number} rot radians, clockwise
 *  @returns {{nw:Pt, n:Pt, ne:Pt, e:Pt, se:Pt, s:Pt, sw:Pt, w:Pt}} */
export function handlePositions(rect, rot) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const hw = rect.w / 2;
  const hh = rect.h / 2;
  const c = Math.cos(finite(rot));
  const s = Math.sin(finite(rot));
  /** Rotate a centre-relative offset into canvas space. */
  const at = (dx, dy) => ({ x: cx + dx * c - dy * s, y: cy + dx * s + dy * c });
  return {
    nw: at(-hw, -hh),
    n: at(0, -hh),
    ne: at(hw, -hh),
    e: at(hw, 0),
    se: at(hw, hh),
    s: at(0, hh),
    sw: at(-hw, hh),
    w: at(-hw, 0),
  };
}

/** Topmost sticker whose rotated rect contains `point` (px), else null.
 *  Counter-rotates the point into the sticker's own axis-aligned frame rather
 *  than testing a rotated polygon; iterates z descending, so the sticker that
 *  would paint last wins an overlap.
 *  @param {Pt} point px, image/natural space @param {Sticker[]} stickers
 *  @param {number} imgW px @param {number} imgH px
 *  @returns {string|null} sticker id */
export function hitTest(point, stickers, imgW, imgH) {
  if (!Array.isArray(stickers) || stickers.length === 0) return null;
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  // z descending; array order breaks ties (later entries count as on top).
  const ordered = stickers
    .map((sticker, index) => ({ sticker, index }))
    .sort((a, b) => {
      const dz = finite(b.sticker.z) - finite(a.sticker.z);
      return dz !== 0 ? dz : b.index - a.index;
    });
  for (const { sticker } of ordered) {
    if (inStickerBox(point, sticker, imgW, imgH)) return sticker.id;
  }
  return null;
}

/** Smallest a two-finger pinch may shrink a sticker's shorter side to, in
 *  natural px. Without it a hard pinch-in drives k toward 0 and the sticker
 *  vanishes (or, past the origin, inverts) with no way back but undo. */
export const MIN_STICKER_PX = 16;

/** Clamp a two-finger pinch's scale factor so the sticker's SHORTER side stays
 *  within [minPx, 4 x the image's shorter side]. Returns k unchanged when it is
 *  already legal or when the start size is degenerate.
 *
 *  Pure and separate because it is the only thing standing between "pinch in"
 *  and "the sticker vanished" — and because a real browser pinch cannot always
 *  drive k to the floor, so the bound is proved by unit cover instead.
 *
 *  @param {number} k requested scale factor
 *  @param {number} shortPx the sticker's shorter side at gesture start, image px
 *  @param {number} imgShort the image's shorter side, px
 *  @param {number} [minPx] smallest legal shorter side, image px
 *  @returns {number} k, always finite and > 0 */
export function clampStickerScale(k, shortPx, imgShort, minPx = MIN_STICKER_PX) {
  const kk = finite(k, 1);
  const s = finite(shortPx, 0);
  const img = finite(imgShort, 0);
  if (!(s > 0) || !(img > 0)) return kk > 0 ? kk : 1;
  const minK = finite(minPx, MIN_STICKER_PX) / s;
  const maxK = (4 * img) / s;
  let out = kk;
  if (out < minK) out = minK;
  else if (out > maxK) out = maxK;
  return out > 0 ? out : minK;
}

/** Is `point` (image px) inside this sticker's ROTATED box? The one definition
 *  of "on the sticker": the hit test and the two-finger gesture's mode decision
 *  both need it, and a second copy of the counter-rotation would drift.
 *
 *  Empty for a degenerate size, so a zero-area sticker is never "hit" and never
 *  becomes a gesture target.
 *
 *  @param {Pt} point image px
 *  @param {Sticker} sticker
 *  @param {number} imgW px @param {number} imgH px
 *  @returns {boolean} */
export function inStickerBox(point, sticker, imgW, imgH) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  const wPx = px(finite(sticker.w), imgW);
  const hPx = px(finite(sticker.h), imgH);
  if (wPx <= 0 || hPx <= 0) return false;
  const rot = finite(sticker.rot);
  const dx = point.x - px(finite(sticker.cx), imgW);
  const dy = point.y - px(finite(sticker.cy), imgH);
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  // Counter-rotate into the local frame (rotate by -rot).
  const lx = dx * c + dy * s;
  const ly = -dx * s + dy * c;
  return Math.abs(lx) <= wPx / 2 + 1e-9 && Math.abs(ly) <= hPx / 2 + 1e-9;
}

/** Resize by dragging a handle to `pointerPx`: the opposite edge/corner stays
 *  pinned in the local frame. keepAspect preserves the current w/h PIXEL ratio,
 *  re-anchored to the pinned edge so neither axis snaps. Minimum 2 px, so a
 *  handle cannot collapse or invert a sticker. Pure — the input is not mutated.
 *  @param {Sticker} sticker
 *  @param {string} handle 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'
 *  @param {Pt} pointerPx pointer position in image px
 *  @param {{imgW:number, imgH:number, keepAspect?:boolean}} opts
 *  @returns {{cx:number, cy:number, w:number, h:number}} normalized */
export function resizeRect(sticker, handle, pointerPx, opts) {
  const W = opts?.imgW;
  const H = opts?.imgH;
  const keep = Boolean(opts?.keepAspect);
  if (!W || !H || !Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) {
    throw new TypeError('resizeRect: options { imgW, imgH, keepAspect } are required');
  }
  const key = String(handle).toLowerCase();
  if (!['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].includes(key)) {
    throw new TypeError(`resizeRect: unknown handle "${handle}"`);
  }

  const cxp = px(finite(sticker.cx), W);
  const cyp = px(finite(sticker.cy), H);
  const wPx = px(finite(sticker.w), W);
  const hPx = px(finite(sticker.h), H);
  const rot = finite(sticker.rot);
  const c = Math.cos(rot);
  const s = Math.sin(rot);

  // Pointer into the local (un-rotated) frame, relative to the centre.
  const pdx = finite(pointerPx?.x) - cxp;
  const pdy = finite(pointerPx?.y) - cyp;
  const lx = pdx * c + pdy * s;
  const ly = -pdx * s + pdy * c;

  const MIN = 2; // px; prevents collapse/inversion past the pinned edge
  let x0 = -wPx / 2;
  let x1 = wPx / 2;
  let y0 = -hPx / 2;
  let y1 = hPx / 2;

  const west = key.includes('w');
  const east = key.includes('e');
  const north = key.includes('n');
  const south = key.includes('s');

  if (west) x0 = Math.min(lx, x1 - MIN);
  if (east) x1 = Math.max(lx, x0 + MIN);
  if (north) y0 = Math.min(ly, y1 - MIN);
  if (south) y1 = Math.max(ly, y0 + MIN);

  let newW = x1 - x0;
  let newH = y1 - y0;

  if (keep && wPx > 0 && hPx > 0) {
    const ratio = wPx / hPx; // pixel ratio, not normalized w/h
    // Drive the size from whichever axis moved proportionally most so both
    // pointer axes contribute, then re-anchor to the pinned edges below.
    const growW = newW / wPx;
    const growH = newH / hPx;
    if (west || east) {
      if (north || south) {
        if (growW >= growH) {
          newH = newW / ratio;
        } else {
          newW = newH * ratio;
        }
      } else {
        // Edge handle: derive the untouched axis, keep centre on that axis.
        newH = newW / ratio;
        y0 = -newH / 2;
        y1 = newH / 2;
      }
    } else if (north || south) {
      newW = newH * ratio;
      x0 = -newW / 2;
      x1 = newW / 2;
    }
    if (newW < MIN) newW = MIN;
    if (newH < MIN) newH = MIN;
    // Re-anchor: pinned edges hold their local coordinates.
    if (west && !east) x0 = x1 - newW;
    if (east && !west) x1 = x0 + newW;
    if (north && !south) y0 = y1 - newH;
    if (south && !north) y1 = y0 + newH;
    newW = x1 - x0;
    newH = y1 - y0;
  }

  const localCx = (x0 + x1) / 2;
  const localCy = (y0 + y1) / 2;
  // Local centre back to image px (rotate by +rot, add the centre).
  const outCxPx = cxp + localCx * c - localCy * s;
  const outCyPx = cyp + localCx * s + localCy * c;

  return {
    cx: norm(outCxPx, W),
    cy: norm(outCyPx, H),
    w: norm(newW, W),
    h: norm(newH, H),
  };
}

/** Minimum pinch-zoom: 1 means fit-to-viewport, the layout the user first sees. */
export const VIEW_MIN_SCALE = 1;
/** Maximum pinch-zoom of the photo (view only; sticker geometry is unaffected). */
export const VIEW_MAX_SCALE = 8;

/** Clamp to 1…8. Non-finite or non-positive falls back to 1, never 0 — a 0 scale
 *  would invert the projection and make the image vanish from the canvas.
 *  @param {number} scale @returns {number} clamped */
export function clampViewScale(scale) {
  return Math.min(VIEW_MAX_SCALE, Math.max(VIEW_MIN_SCALE, finite(scale, VIEW_MIN_SCALE)));
}

/** Clamp a pan offset so at least 25% of the SCALED image stays visible on each
 *  axis. At scale 1 that is 75% of the CSS box (panning at fit); above 1 the
 *  allowance grows with the zoom, which is what focal pinch-zoom needs.
 *  @param {{dx:number, dy:number, scale?:number}} view pan offset in CSS px
 *  @param {number} cssW @param {number} cssH image CSS size at scale 1
 *  @returns {{dx:number, dy:number, scale:number}} clamped view */
export function clampViewPan(view, cssW, cssH) {
  const scale = clampViewScale(view?.scale);
  const w = finite(cssW);
  const h = finite(cssH);
  const maxX = w > 0 ? (w * scale) * 0.75 : 0;
  const maxY = h > 0 ? (h * scale) * 0.75 : 0;
  return {
    dx: Math.max(-maxX, Math.min(maxX, finite(view?.dx))),
    dy: Math.max(-maxY, Math.min(maxY, finite(view?.dy))),
    scale,
  };
}

/** Wheel delta -> zoom multiplier, normalised across `deltaMode`.
 *
 *  deltaMode is 0 for pixels (Chrome), 1 for LINES (Firefox) and 2 for pages. An
 *  un-normalised line-mode delta is ~40x too large, which reads as a broken zoom
 *  rather than a fast one. Exponential, not linear: N steps in and N steps out
 *  return to the same scale, so scrolling back the same distance lands on fit
 *  again instead of drifting away from it.
 *
 *  This lives here, not in the UI, for the same reason as every other projection:
 *  node can unit-test it, and CDP's `mouseWheel` cannot carry a `deltaMode` at
 *  all, so this is the only place the line/page branches can be covered.
 *
 *  @param {number} deltaY wheel delta; negative (scroll up/away) zooms IN
 *  @param {number} [deltaMode=0] 0 = pixels, 1 = lines, 2 = pages
 *  @param {number} [step] zoom per normalised pixel
 *  @returns {number} multiplier, always finite and > 0 */
export function wheelZoomFactor(deltaY, deltaMode = 0, step = 0.0015) {
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? 100 : 1;
  const px = finite(deltaY, 0) * unit;
  const k = Math.exp(-px * step);
  return Number.isFinite(k) && k > 0 ? k : 1;
}

/** Focal (pinch) zoom, derived ONLY from the gesture's start values so a pinch
 *  cannot drift: the image point under the start centroid stays under the
 *  current one. A moving centroid pans, a changing distance zooms.
 *    scale = clamp(startScale * currentDist / startDist, 1, 8)
 *    dx    = focalNow.x - (focalStart.x - startDx) * (scale / startScale)
 *  (same for dy). Distances unchanged reduces to a plain pan. clampViewPan can
 *  truncate an offset past the scaled allowance, so a focal point near the edge
 *  at high zoom slips by the excess — paint, the selection frame and hit-testing
 *  all read the same `view`, so they agree regardless.
 *  @param {{dx:number, dy:number, scale?:number}} startView view at gesture start
 *  @param {Pt} focalStart centroid at start, canvas-CSS px (relative origin)
 *  @param {Pt} focalNow centroid now, canvas-CSS px (relative origin)
 *  @param {number} startDist two-finger distance at start (CSS px)
 *  @param {number} currentDist two-finger distance now (CSS px)
 *  @param {number} cssW image CSS width px (at scale 1)
 *  @param {number} cssH image CSS height px (at scale 1)
 *  @returns {{dx:number, dy:number, scale:number}} clamped view */
export function focalZoomView(startView, focalStart, focalNow, startDist, currentDist, cssW, cssH) {
  const startScale = clampViewScale(startView?.scale);
  const sd = finite(startDist);
  const cd = finite(currentDist);
  const scale = sd > 0 && cd > 0 ? clampViewScale(startScale * (cd / sd)) : startScale;
  const k = scale / startScale;
  const startDx = finite(startView?.dx);
  const startDy = finite(startView?.dy);
  const fsx = finite(focalStart?.x);
  const fsy = finite(focalStart?.y);
  const fnx = finite(focalNow?.x);
  const fny = finite(focalNow?.y);
  return clampViewPan(
    { dx: fnx - (fsx - startDx) * k, dy: fny - (fsy - startDy) * k, scale },
    cssW,
    cssH,
  );
}

/** Shortest signed rotation from one angle to another, radians in (-PI, PI].
 *  A rotate drag accumulates these per pointer move: accumulating the deltas of
 *  successive positions keeps a sweep across ±PI continuous and lets a sweep past
 *  half a turn follow the hand, whereas subtracting the grab angle from the
 *  current one would read any long sweep as its short way round.
 *
 *  Modulo, not a while-loop: a loop bounded by the delta itself spins about
 *  delta/2π times, which for a large finite input is a hang rather than a return.
 *  @param {number} from @param {number} to @returns {number} radians in (-PI, PI] */
export function angleDelta(from, to) {
  const d = finite(to, 0) - finite(from, 0);
  let out = d % (2 * Math.PI);
  if (out <= -Math.PI) out += 2 * Math.PI;
  else if (out > Math.PI) out -= 2 * Math.PI;
  return out;
}

/** Round an angle to the nearest `step` — the 15° rotate snap. ONE definition of
 *  the step, shared by the absolute projection and the accumulated drag.
 *  @param {number} angle @param {number} [step] @returns {number} radians */
export function snapAngle(angle, step = Math.PI / 12) {
  return Math.round(finite(angle, 0) / step) * step;
}

/** Angle (radians, clockwise-positive) from centre to pointer; `snap` rounds it
 *  to the nearest 15°. @param {Pt} centrePx @param {Pt} pointerPx
 *  @param {boolean} [snap] @returns {number} radians in (-PI, PI] */
export function rotateTo(centrePx, pointerPx, snap = false) {
  const dx = finite(pointerPx?.x) - finite(centrePx?.x);
  const dy = finite(pointerPx?.y) - finite(centrePx?.y);
  let angle = Math.atan2(dy, dx);
  if (snap) {
    angle = snapAngle(angle);
    // Keep the result in (-PI, PI]: rounding PI exactly stays PI.
    if (angle <= -Math.PI) angle += 2 * Math.PI;
    if (angle > Math.PI) angle -= 2 * Math.PI;
  }
  return angle;
}

/** Offset a copy of the sticker by pixel deltas. Pure.
 *  @param {Sticker} sticker @param {number} dxPx @param {number} dyPx
 *  @param {number} imgW px @param {number} imgH px @returns {Sticker} */
export function nudge(sticker, dxPx, dyPx, imgW, imgH) {
  const cxp = px(finite(sticker.cx), imgW) + finite(dxPx);
  const cyp = px(finite(sticker.cy), imgH) + finite(dyPx);
  return {
    ...sticker,
    cx: norm(cxp, imgW),
    cy: norm(cyp, imgH),
  };
}

/** Whether `cur` completes a double-tap with `prev`. Desktop uses the browser
 *  dblclick; touch needs an explicit window so it cannot race the
 *  one-finger/two-finger arbitration.
 *  @param {{x:number,y:number,t:number}|null} prev previous tap (CSS px + ms)
 *  @param {{x:number,y:number,t:number}|null} cur current tap
 *  @param {{maxMs?:number, maxDistCssPx?:number}} [opts]
 *  @returns {boolean} true iff both taps are inside the window */
export function isDoubleTap(prev, cur, opts) {
  if (!prev || !cur) return false;
  const maxMs = Number.isFinite(opts?.maxMs) ? opts.maxMs : 350;
  const maxDist = Number.isFinite(opts?.maxDistCssPx) ? opts.maxDistCssPx : 25;
  if (![prev.x, prev.y, prev.t, cur.x, cur.y, cur.t].every(Number.isFinite)) return false;
  const dt = cur.t - prev.t;
  if (dt < 0 || dt > maxMs) return false;
  return Math.hypot(cur.x - prev.x, cur.y - prev.y) <= maxDist;
}
