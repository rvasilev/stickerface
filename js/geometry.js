// Pure geometry for StickerFace. No DOM, no canvas, no globals, no imports.
// All sticker coordinates are NORMALIZED (0..1 relative to image width/height);
// pixel math happens only at the render/export edge via px()/norm(). View pan
// (clampViewPan) is in CSS px — the projection owner (ui.js) converts between
// CSS px and canvas px; this module only clamps the offset values.
//
// Screen coordinates: canvas space, +x right, +y down. Rotation is radians,
// clockwise-positive (matching ctx.rotate): a point rotated +90° points down.

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

/**
 * Convert a normalized value to pixels: px(v, span) = v * span.
 * @param {number} v normalized value (may lie outside 0..1; no clamping)
 * @param {number} span span in pixels (image width or height)
 * @returns {number} pixels
 */
export function px(v, span) {
  const s = finite(span, 0);
  if (s <= 0) return 0;
  return finite(v, 0) * s;
}

/**
 * Convert pixels back to a normalized value: norm(v, span) = v / span.
 * Inverse of px(); round-trips within 1e-9 at any sane image size.
 * @param {number} v pixels
 * @param {number} span span in pixels
 * @returns {number} normalized value
 */
export function norm(v, span) {
  const s = finite(span, 0);
  if (s <= 0) return 0;
  return finite(v, 0) / s;
}

/**
 * Axis-aligned, un-rotated rect of a sticker in pixels.
 * Centred on (cx*imgW, cy*imgH) with size (w*imgW, h*imgH).
 * @param {Sticker} sticker
 * @param {number} imgW natural image width px
 * @param {number} imgH natural image height px
 * @returns {{x:number, y:number, w:number, h:number}} top-left + size in px
 */
export function stickerRect(sticker, imgW, imgH) {
  const w = px(finite(sticker.w), imgW);
  const h = px(finite(sticker.h), imgH);
  const cxp = px(finite(sticker.cx), imgW);
  const cyp = px(finite(sticker.cy), imgH);
  return { x: cxp - w / 2, y: cyp - h / 2, w, h };
}

/**
 * The 8 resize-handle positions (px) for a rect, rotated about the sticker
 * centre by `rot`. Local offsets are the un-rotated corners/edges, rotated
 * with the canvas matrix (x' = dx*cos - dy*sin, y' = dx*sin + dy*cos) so the
 * handles line up exactly with a translate/rotate/drawImage paint.
 * @param {{x:number, y:number, w:number, h:number}} rect un-rotated rect (px)
 * @param {number} rot radians, clockwise
 * @returns {{nw:Pt, n:Pt, ne:Pt, e:Pt, se:Pt, s:Pt, sw:Pt, w:Pt}}
 */
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

/**
 * Topmost sticker whose rotated rect contains `point` (px), else null.
 * Why the local frame: rotating the rect and doing a point-in-polygon test is
 * error-prone at the corners; instead counter-rotate the point by -rot into
 * the sticker's own axis-aligned frame and do an AABB test. Iterates z
 * descending so an overlap returns the sticker that would paint last.
 * @param {Pt} point px (image/natural space)
 * @param {Sticker[]} stickers
 * @param {number} imgW px
 * @param {number} imgH px
 * @returns {string|null} sticker id or null
 */
export function hitTest(point, stickers, imgW, imgH) {
  if (!Array.isArray(stickers) || stickers.length === 0) return null;
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const EPS = 1e-9;
  // z descending; array order breaks ties (later entries count as on top).
  const ordered = stickers
    .map((sticker, index) => ({ sticker, index }))
    .sort((a, b) => {
      const dz = finite(b.sticker.z) - finite(a.sticker.z);
      return dz !== 0 ? dz : b.index - a.index;
    });
  for (const { sticker } of ordered) {
    const wPx = px(finite(sticker.w), imgW);
    const hPx = px(finite(sticker.h), imgH);
    if (wPx <= 0 || hPx <= 0) continue;
    const cxp = px(finite(sticker.cx), imgW);
    const cyp = px(finite(sticker.cy), imgH);
    const rot = finite(sticker.rot);
    const dx = point.x - cxp;
    const dy = point.y - cyp;
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    // Counter-rotate into the local frame (rotate by -rot).
    const lx = dx * c + dy * s;
    const ly = -dx * s + dy * c;
    if (Math.abs(lx) <= wPx / 2 + EPS && Math.abs(ly) <= hPx / 2 + EPS) {
      return sticker.id;
    }
  }
  return null;
}

/**
 * Resize a sticker by dragging a handle to `pointerPx`.
 * The opposite edge/corner stays pinned (in the local frame). Returns a NEW
 * normalized {cx, cy, w, h}; the input sticker is not mutated.
 *
 * Signatures (imgW/imgH are required to normalize):
 *   resizeRect(sticker, handle, pointerPx, imgW, imgH, keepAspect)
 *   resizeRect(sticker, handle, pointerPx, { imgW, imgH, keepAspect })
 *   resizeRect(sticker, handle, pointerPx, keepAspect) — sticker carries imgW/imgH
 *
 * keepAspect preserves the current w/h PIXEL ratio: the dragged size is
 * re-derived from that ratio and re-anchored to the pinned edge, so both
 * axes stay proportional instead of one axis snapping.
 *
 * Minimum size is 2 px so a handle cannot collapse or invert a sticker.
 * @param {Sticker} sticker
 * @param {string} handle 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'
 * @param {Pt} pointerPx pointer position in image px
 * @param {number|boolean|object} [imgW]
 * @param {number} [imgH]
 * @param {boolean} [keepAspect]
 * @returns {{cx:number, cy:number, w:number, h:number}} normalized
 */
export function resizeRect(sticker, handle, pointerPx, imgW, imgH, keepAspect) {
  let W;
  let H;
  let keep = false;
  if (imgW !== null && typeof imgW === 'object') {
    W = imgW.imgW ?? imgW.width;
    H = imgW.imgH ?? imgW.height;
    keep = Boolean(imgW.keepAspect);
  } else if (typeof imgW === 'number' && typeof imgH === 'number') {
    W = imgW;
    H = imgH;
    keep = Boolean(keepAspect);
  } else if (typeof imgW === 'boolean' || imgW == null) {
    keep = Boolean(imgW);
    W = sticker.imgW ?? sticker.width;
    H = sticker.imgH ?? sticker.height;
  } else {
    throw new TypeError('resizeRect: expected (sticker, handle, pointerPx, imgW, imgH, keepAspect)');
  }
  if (!W || !H || !Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) {
    throw new TypeError('resizeRect: image dimensions (imgW, imgH) are required');
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

/**
 * Clamp a view scale to the pinch-zoom range 1…8. Non-finite / non-positive
 * values fall back to 1 (fit), never to 0 — a 0 scale would invert the
 * projection and make the image vanish from the canvas.
 * @param {number} scale
 * @returns {number} clamped scale
 */
export function clampViewScale(scale) {
  return Math.min(VIEW_MAX_SCALE, Math.max(VIEW_MIN_SCALE, finite(scale, VIEW_MIN_SCALE)));
}

/**
 * Clamp a pan offset so the image can never be pushed entirely out of view.
 * Keeps at least 25% of the (zoomed) image visible in each axis: the offset
 * (CSS px, the view's dx/dy) is limited to 75% of the SCALED image's CSS
 * size. At scale 1 this is exactly the old pan clamp (75% of the CSS box),
 * so panning at fit behaves as before; at scale > 1 the allowance grows
 * with the scaled image, which is what focal zoom needs — an edge clamp of
 * [cssW - scaledW, 0] at scale >= 1 would forbid panning at 1x entirely
 * and would snap the focal point for a pinch that starts from a pan.
 * `scale` is clamped to 1…8 (see clampViewScale) and carried through.
 * @param {{dx:number, dy:number, scale?:number}} view pan offset in CSS px
 * @param {number} cssW image CSS width px (at scale 1)
 * @param {number} cssH image CSS height px (at scale 1)
 * @returns {{dx:number, dy:number, scale:number}} clamped view
 */
export function clampViewPan(view, cssW, cssH) {
  const dx = finite(view?.dx);
  const dy = finite(view?.dy);
  const scale = clampViewScale(view?.scale);
  const w = finite(cssW);
  const h = finite(cssH);
  const maxX = w > 0 ? (w * scale) * 0.75 : 0;
  const maxY = h > 0 ? (h * scale) * 0.75 : 0;
  const rawDx = finite(view?.dx);
  const rawDy = finite(view?.dy);
  // Genuine pan offset: move toward zero when it is beyond the scaled
  // allowance; a plain focal zoom stays inside, a zoom-out overshoots.
  return {
    dx: Math.max(-maxX, Math.min(maxX, rawDx)),
    dy: Math.max(-maxY, Math.min(maxY, rawDy)),
    scale,
  };
}

/**
 * Focal (pinch) zoom: the view for the current gesture state, derived ONLY
 * from the gesture's start values — never accumulated per event, so a pinch
 * cannot drift. The image point that was under the focal (centroid) point at
 * gesture start stays under the focal point now, which is also what makes a
 * moving centroid pan the image at the same time as it zooms.
 *
 * With focal points in canvas-CSS coordinates (relative to the canvas rect
 * origin), the image point under the focal at start is
 * `(focalStart - startDx) / startScale` (in backing*preview units), and the
 * new offset follows from demanding that same point sit under `focalNow`:
 *   scale = clamp(startScale * currentDist / startDist, 1, 8)
 *   dx    = focalNow.x - (focalStart.x - startDx) * (scale / startScale)
 * (same for dy). When the distance is unchanged this reduces to a plain pan:
 * dx = startDx + (focalNow.x - focalStart.x).
 * @param {{dx:number, dy:number, scale?:number}} startView view at gesture start
 * @param {Pt} focalStart gesture centroid at start, canvas-CSS px (relative origin)
 * @param {Pt} focalNow gesture centroid now, canvas-CSS px (relative origin)
 * @param {number} startDist two-finger distance at start (CSS px)
 * @param {number} currentDist two-finger distance now (CSS px)
 * @param {number} cssW image CSS width px (at scale 1)
 * @param {number} cssH image CSS height px (at scale 1)
 * @returns {{dx:number, dy:number, scale:number}} clamped view
 */
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

/**
 * Angle (radians, clockwise-positive) from centre to pointer.
 * When `snap` is true, snaps to the nearest 15° (Math.PI/12).
 * @param {Pt} centrePx
 * @param {Pt} pointerPx
 * @param {boolean} [snap]
 * @returns {number} radians in (-PI, PI]
 */
export function rotateTo(centrePx, pointerPx, snap = false) {
  const dx = finite(pointerPx?.x) - finite(centrePx?.x);
  const dy = finite(pointerPx?.y) - finite(centrePx?.y);
  let angle = Math.atan2(dy, dx);
  if (snap) {
    const step = Math.PI / 12;
    angle = Math.round(angle / step) * step;
    // Keep the result in (-PI, PI]: rounding PI exactly stays PI.
    if (angle <= -Math.PI) angle += 2 * Math.PI;
    if (angle > Math.PI) angle -= 2 * Math.PI;
  }
  return angle;
}

/**
 * Nudge a sticker by pixel deltas, returning a NEW normalized sticker
 * (all other fields copied). Pure: the input sticker is not mutated.
 * @param {Sticker} sticker
 * @param {number} dxPx horizontal delta in image px
 * @param {number} dyPx vertical delta in image px
 * @param {number} imgW px
 * @param {number} imgH px
 * @returns {Sticker} new sticker
 */
export function nudge(sticker, dxPx, dyPx, imgW, imgH) {
  const cxp = px(finite(sticker.cx), imgW) + finite(dxPx);
  const cyp = px(finite(sticker.cy), imgH) + finite(dyPx);
  return {
    ...sticker,
    cx: norm(cxp, imgW),
    cy: norm(cyp, imgH),
  };
}

/**
 * Pure double-tap windowing: decide whether a second tap completes a
 * double-tap with a previous tap. Desktop uses the browser dblclick instead;
 * touch must be decided by the gesture router with an explicit window so it
 * cannot race the one-finger/two-finger arbitration.
 * @param {{x:number,y:number,t:number}|null} prev previous tap (CSS px + ms clock)
 * @param {{x:number,y:number,t:number}|null} cur current tap
 * @param {{maxMs?:number, maxDistCssPx?:number}} [opts]
 * @returns {boolean} true iff both taps are inside the window
 */
export function isDoubleTap(prev, cur, opts) {
  if (!prev || !cur) return false;
  const maxMs = Number.isFinite(opts?.maxMs) ? opts.maxMs : 350;
  const maxDist = Number.isFinite(opts?.maxDistCssPx) ? opts.maxDistCssPx : 25;
  if (![prev.x, prev.y, prev.t, cur.x, cur.y, cur.t].every(Number.isFinite)) return false;
  const dt = cur.t - prev.t;
  if (dt < 0 || dt > maxMs) return false;
  return Math.hypot(cur.x - prev.x, cur.y - prev.y) <= maxDist;
}
