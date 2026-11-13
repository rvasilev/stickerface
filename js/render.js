// Render core: draws the base image and every sticker in z order onto a
// canvas. The only place where normalized state becomes pixels.
//
// Scale semantics: the caller owns the output canvas and paints in the
// canvas's OWN pixel space. `scale` is the factor from image-natural pixels
// to canvas pixels (preview: canvasW / naturalW; export: 1). Sticker pixel
// size = normalized * natural * scale. Everything here is in canvas px.
//
// rAF coalescing: requestDraw() schedules at most one frame; a burst of
// pointermove events repaints once. Call cancelDraw() if the stage unmounts.

import { stickerRect, px } from './geometry.js';
import { EMOJI } from './emoji.js';

let rafId = 0;
let scheduled = null;

/** Schedule a paint on the next frame; bursts coalesce into one paint. */
export function requestDraw(drawFn) {
  scheduled = drawFn;
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    const fn = scheduled;
    scheduled = null;
    if (typeof fn === 'function') fn();
  });
}

export function cancelDraw() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  scheduled = null;
}

/**
 * Raster fallback: draw an image that already exposes width/height onto a
 * square canvas and take the bitmap from the canvas. Chromium refuses to
 * decode a viewBox-only SVG straight from a Blob (no intrinsic size ->
 * InvalidStateError), but an <img> element given an explicit width/height
 * rasterizes fine, so this path succeeds where createImageBitmap(blob)
 * cannot. Returns null instead of throwing when the image never decodes.
 *
 * @param {HTMLImageElement} img decoded image (width/height established)
 * @param {number} size raster edge px
 * @returns {Promise<ImageBitmap|null>}
 */
export async function bitmapFromImage(img, size) {
  if (!img || !(img.naturalWidth > 0) || !(img.naturalHeight > 0)) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, size, size);
    return await createImageBitmap(canvas);
  } catch {
    return null;
  }
}

/**
 * Load a URL into a decoded <img> with an explicit display size. Nail the
 * size down BEFORE decode() so a viewBox-only SVG gets intrinsic dimensions
 * from the element attributes rather than from its (absent) root attributes.
 *
 * @param {string} src URL to load
 * @param {number} [size] explicit width/height px (default 512)
 * @returns {Promise<HTMLImageElement>} decoded image
 */
export async function loadImgWithSize(src, size = 512) {
  const img = new Image();
  img.width = size;
  img.height = size;
  img.src = src;
  await img.decode();
  return img;
}

/**
 * Pre-decode every emoji SVG once into an ImageBitmap. Drawing an <img> per
 * frame re-rasterizes the SVG on every paint, so the decode cost is paid
 * once at startup. The Twemoji SVGs carry only a viewBox and no width/
 * height, so they have no intrinsic size and Chromium refuses to decode
 * them straight from a Blob; each file is therefore loaded through an <img>
 * with an explicit size, rasterized onto an offscreen canvas, and the
 * bitmap taken from that canvas. A file that still fails is kept as its
 * <img> element (a draw source) so export never blocks on it.
 *
 * @param {object} [opts]
 * @param {number} [opts.size] raster size for the bitmaps (default 512)
 * @param {number} [opts.concurrency] decode parallelism (default 8)
 */
export async function decodeEmojiBitmaps({ size = 512, concurrency = 8 } = {}) {
  const map = new Map();
  const fallback = new Map();
  const queue = [...EMOJI];
  const jobs = [];
  const width = Math.max(64, Math.round(size));
  async function worker() {
    while (queue.length) {
      const entry = queue.shift();
      try {
        const url = entry.path;
        let img = null;
        try {
          img = await loadImgWithSize(url, width);
        } catch {
          img = null;
          const res = await fetch(url);
          if (!res.ok) continue;
          const blob = await res.blob();
          const bmp = await createImageBitmap(blob, { resizeWidth: width, resizeHeight: width, resizeQuality: 'high' });
          map.set(entry.path, bmp);
          continue;
        }
        if (img && img.complete && (img.naturalWidth > 0 || img.width > 0)) {
          if (typeof img.decode === 'function') {
            try { await img.decode(); } catch { /* already decoded */ }
          }
          const bmp = await bitmapFromImage(img, width);
          if (bmp) map.set(entry.path, bmp);
          if (!bmp) fallback.set(entry.path, img);
        } else {
          fallback.set(entry.path, img);
        }
      } catch {
        // A missing/corrupt SVG is skipped; export never blocks on it.
        // Fall back to an undecoded placeholder so paint still covers the face.
        try {
          const img = new Image();
          img.width = width;
          img.height = width;
          img.src = entry.path;
          fallback.set(entry.path, img);
        } catch {
          // Nothing draw-able; paint() will use a solid placeholder.
        }
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, EMOJI.length));
  for (let i = 0; i < n; i++) jobs.push(worker());
  await Promise.all(jobs);
  const ready = map.size === EMOJI.length;
  return { bitmaps: map, fallback, ready, loaded: map.size, total: EMOJI.length };
}

/**
 * Decode a user-supplied file/object URL into a bitmap at a good raster size.
 * Uses the same <img> path as the emoji catalogue for the same reason.
 * @param {string|Blob} src object URL or Blob
 * @param {number} [size] target raster edge
 */
export async function decodeCustomBitmap(src, size = 512) {
  const url = typeof src === 'string' ? src : URL.createObjectURL(src);
  const ownUrl = typeof src !== 'string';
  try {
    const img = await loadImgWithSize(url, size);
    const bmp = await bitmapFromImage(img, size);
    if (!bmp) throw new Error('decode failed');
    return bmp;
  } finally {
    if (ownUrl) URL.revokeObjectURL(url);
  }
}

/**
 * Solid placeholder draw: a sticker with no bitmap and no fallback image is
 * still painted (solid square) so a missing asset degrades to a cosmetic
 * block instead of silently leaving the face uncovered.
 * Pure partition + draw decision — no throw on any sticker shape.
 *
 * @param {object[]} stickers normalized stickers
 * @param {Map<string, ImageBitmap>} [bitmaps] emoji bitmaps by src
 * @param {Map<string, HTMLImageElement>} [fallback] img fallbacks by src
 * @param {Map<string, ImageBitmap>} [customBitmaps] user-image bitmaps by src
 * @returns {{withBitmap: object[], withFallback: object[], withPlaceholder: object[]}}
 */
export function partitionStickers(stickers, bitmaps, fallback, customBitmaps) {
  const withBitmap = [];
  const withFallback = [];
  const withPlaceholder = [];
  for (const sticker of stickers ?? []) {
    if (sticker.kind === 'blur' || sticker.kind === 'mosaic') {
      withBitmap.push(sticker);
      continue;
    }
    const bmp = bitmaps?.get(sticker.src) ?? customBitmaps?.get(sticker.src);
    if (bmp) {
      withBitmap.push(sticker);
    } else if (fallback?.get(sticker.src)) {
      withFallback.push(sticker);
    } else {
      withPlaceholder.push(sticker);
    }
  }
  return { withBitmap, withFallback, withPlaceholder };
}



/** Rounded-rect path helper. radiusPx is already in canvas px, clamped here. */
function roundedRectPath(ctx, x, y, w, h, radiusPx) {
  const rr = Math.max(0, Math.min(radiusPx ?? 0, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/**
 * Draw one emoji/custom sticker under translate/rotate. The draw source may
 * be an ImageBitmap, an HTMLImageElement (fallback) or a solid placeholder —
 * a missing asset is a cosmetic block, never a skipped sticker — so this
 * never throws and always paints (false only for a degenerate 0-size rect).
 */
function drawEmoji(ctx, sticker, bitmap, imgW, imgH, scale, customBitmaps, fallbackImg) {
  const bmp = bitmap ?? (sticker.kind === 'emoji' ? null : customBitmaps?.get(sticker.src));
  const img = !bmp && sticker.kind === 'emoji' ? fallbackImg ?? null : null;
  const src = bmp ?? img;
  const rect = stickerRect(sticker, imgW, imgH);
  const wPx = rect.w * scale;
  const hPx = rect.h * scale;
  if (wPx <= 0 || hPx <= 0) return false;
  ctx.save();
  ctx.translate((rect.x + rect.w / 2) * scale, (rect.y + rect.h / 2) * scale);
  ctx.rotate(sticker.rot ?? 0);
  if (!src) {
    // Placeholder: solid square covering the face instead of nothing.
    ctx.fillStyle = '#f5c542';
    ctx.fillRect(-wPx / 2, -hPx / 2, wPx, hPx);
    ctx.restore();
    return true;
  }
  // Fill the sticker box: the box IS the drawn size (selection wraps it),
  // so letterboxing would inset the art inside the frame. Stretching a
  // square emoji bitmap into a square-in-px box is a no-op; a custom image
  // is intentionally fit-to-box the same way.
  ctx.drawImage(src, -wPx / 2, -hPx / 2, wPx, hPx);
  ctx.restore();
  return true;
}

/**
 * Blur patch: clip to a rounded rect, then draw the base through ctx.filter.
 * Why the inset: canvas blur bleeds past its source rect, so the source is
 * expanded by 2x sigma on every side — the visible (clipped) area then sees
 * a fully blurred interior instead of a hard edge. Falls back to a manual
 * box-blur scratch pass where ctx.filter is unsupported.
 *
 * Implementation: everything happens under translate/rotate so the clip, the
 * inset source draw, and the rotation share one frame. The blur is applied
 * to the SOURCE pixels drawn into that frame (ctx.filter filters the draw
 * itself), which keeps rotated and un-rotated patches identical in structure.
 *
 * `baseCanvas` must hold the full image at this scale in its own (unpanned)
 * space. The panned destination grid is handled by the caller's translate()
 * wrapping this draw.
 */
function drawBlur(ctx, sticker, baseCanvas, imgW, imgH, scale) {
  const rect = stickerRect(sticker, imgW, imgH);
  const sx = rect.x * scale;
  const sy = rect.y * scale;
  const sw = rect.w * scale;
  const sh = rect.h * scale;
  if (sw <= 0 || sh <= 0) return;
  const sigma = Math.max(0.5, (sticker.strength ?? 18) * scale);
  const cr = Math.min(Math.min(0.5, sticker.radius ?? 0.5) * Math.min(sw, sh), sw / 2, sh / 2);
  const inset = 2 * sigma;
  const dx = sx - inset;
  const dy = sy - inset;
  const dw = sw + 2 * inset;
  const dh = sh + 2 * inset;

  ctx.save();
  if (sticker.rot) {
    ctx.translate(sx + sw / 2, sy + sh / 2);
    ctx.rotate(sticker.rot);
    ctx.translate(-(sx + sw / 2), -(sy + sh / 2));
  }
  roundedRectPath(ctx, sx, sy, sw, sh, cr);
  ctx.clip();

  if (typeof ctx.filter === 'string') {
    const prev = ctx.filter;
    ctx.filter = `blur(${sigma.toFixed(2)}px)`;
    ctx.drawImage(baseCanvas, rect.x, rect.y, rect.w, rect.h, dx, dy, dw, dh);
    ctx.filter = prev;
  } else {
    ctx.restore();
    const blurred = boxBlurScratch(baseCanvas, rect.x, rect.y, rect.w, rect.h, dx, dy, dw, dh);
    if (blurred) {
      ctx.save();
      if (sticker.rot) {
        ctx.translate(sx + sw / 2, sy + sh / 2);
        ctx.rotate(sticker.rot);
        ctx.translate(-(sx + sw / 2), -(sy + sh / 2));
      }
      roundedRectPath(ctx, sx, sy, sw, sh, cr);
      ctx.clip();
      ctx.drawImage(blurred, dx, dy, dw, dh);
      ctx.restore();
    }
    return;
  }
  ctx.restore();
}

/**
 * Mosaic patch: read the region with getImageData, average per block, write
 * back with smoothing off. Rotation for mosaic is approximated: the averaged
 * region is drawn rotated (block grid rotates too), which reads fine for a
 * privacy patch. getImageData needs the region in canvas px from the base.
 */
function drawMosaic(ctx, sticker, baseCanvas, imgW, imgH, scale, scratchCanvas, scratchCtx) {
  const rect = stickerRect(sticker, imgW, imgH);
  const sx = Math.max(0, Math.floor(rect.x * scale));
  const sy = Math.max(0, Math.floor(rect.y * scale));
  const sw = Math.min(baseCanvas.width - sx, Math.ceil(rect.w * scale));
  const sh = Math.min(baseCanvas.height - sy, Math.ceil(rect.h * scale));
  if (sw <= 0 || sh <= 0) return;
  const block = Math.max(2, Math.round((sticker.strength ?? 16) * scale));
  if (sw < block || sh < block) {
    // Degenerate: fall back to a flat patch of the region's average colour.
    try {
      const data = scratchCtx.getImageData(0, 0, 1, 1);
    } catch {
      /* ignore */
    }
  }

  let src;
  try {
    scratchCanvas.width = sw;
    scratchCanvas.height = sh;
    scratchCtx.drawImage(baseCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
    src = scratchCtx.getImageData(0, 0, sw, sh);
  } catch {
    return; // tainted canvas — skip the mosaic rather than crash the paint
  }

  const out = scratchCtx.createImageData(sw, sh);
  const { data } = src;
  const od = out.data;
  for (let by = 0; by < sh; by += block) {
    for (let bx = 0; bx < sw; bx += block) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      const bw = Math.min(block, sw - bx);
      const bh = Math.min(block, sh - by);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const i = ((by + y) * sw + (bx + x)) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          a += data[i + 3];
          n++;
        }
      }
      r = Math.round(r / n);
      g = Math.round(g / n);
      b = Math.round(b / n);
      a = Math.round(a / n);
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const i = ((by + y) * sw + (bx + x)) * 4;
          od[i] = r;
          od[i + 1] = g;
          od[i + 2] = b;
          od[i + 3] = a;
        }
      }
    }
  }
  scratchCtx.putImageData(out, 0, 0);

  ctx.save();
  const radiusPx = Math.min(0.5, sticker.radius ?? 0.5) * Math.min(rect.w, rect.h) * scale;
  roundedRectPath(ctx, sx, sy, sw, sh, radiusPx);
  ctx.clip();
  if (sticker.rot) {
    ctx.translate(sx + sw / 2, sy + sh / 2);
    ctx.rotate(sticker.rot);
    ctx.translate(-(sx + sw / 2), -(sy + sh / 2));
    // Draw the averaged pixels rotated about the patch centre.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scratchCanvas, sx, sy, sw, sh);
  } else {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scratchCanvas, sx, sy, sw, sh);
  }
  ctx.restore();
}

/**
 * Manual box-blur fallback: draws the region into a scratch canvas, then
 * scales down and back up (boxBlur approximates a Gaussian well enough for a
 * privacy patch). Returns a canvas covering the same region as (dx..dx+dw),
 * which drawBlur draws at that exact rect (un-rotated or rotated, as needed).
 */
function boxBlurScratch(baseCanvas, rx, ry, rw, rh, dx, dy, dw, dh) {
  try {
    const w = Math.max(1, Math.round(dw));
    const h = Math.max(1, Math.round(dh));
    const scratch = document.createElement('canvas');
    scratch.width = w;
    scratch.height = h;
    const sctx = scratch.getContext('2d');
    sctx.drawImage(baseCanvas, rx, ry, rw, rh, 0, 0, w, h);
    const factor = Math.max(2, Math.round(Math.max(w, h) / Math.min(rw, rh) * 8) || 8);
    const tinyW = Math.max(1, Math.round(w / factor));
    const tinyH = Math.max(1, Math.round(h / factor));
    const tiny = document.createElement('canvas');
    tiny.width = tinyW;
    tiny.height = tinyH;
    const tctx = tiny.getContext('2d');
    tctx.drawImage(scratch, 0, 0, tinyW, tinyH);
    sctx.clearRect(0, 0, w, h);
    sctx.imageSmoothingEnabled = true;
    sctx.drawImage(tiny, 0, 0, tinyW, tinyH, 0, 0, w, h);
    return scratch;
  } catch {
    return null;
  }
}

/**
 * Paint one frame: base image, then stickers in ascending z.
 * view: pan offset in CANVAS px (cssPoint = origin + backing*previewScale + view).
 * The preview passes view.dx/dy converted from CSS px; export always passes 0,0
 * (export composites at natural size, never panned).
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} opts
 * @param {HTMLImageElement} opts.image base image (naturalWidth/Height)
 * @param {object[]} opts.stickers normalized stickers (already z-sorted)
 * @param {Map<string, ImageBitmap>} opts.bitmaps emoji bitmaps by src
 * @param {Map<string, HTMLImageElement>} [opts.fallback] img fallbacks by src
 *   (stickers with no bitmap draw from here, else a solid placeholder)
 * @param {Map<string, ImageBitmap>} [opts.customBitmaps] user-image bitmaps by src
 * @param {number} opts.imgW natural image width
 * @param {number} opts.imgH natural image height
 * @param {number} opts.scale canvas px per natural px
 * @param {{dx?:number, dy?:number}} [opts.view] pan offset in canvas px (default 0,0)
 * @param {HTMLCanvasElement} [opts.baseCanvas] pre-staged base at canvas size
 * @param {object} [opts.selection] {id} — draws the selection chrome in ui.js,
 *   never here (keep render dumb).
 */
export function paint(ctx, { image, stickers, bitmaps, fallback, customBitmaps, imgW, imgH, scale, baseCanvas, view }) {
  const viewDx = Number.isFinite(view?.dx) ? view.dx : 0;
  const viewDy = Number.isFinite(view?.dy) ? view.dy : 0;
  ctx.save();
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();

  if (!image || !imgW || !imgH) return;
  const dw = px(1, imgW) * scale;
  const dh = px(1, imgH) * scale;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(image, viewDx, viewDy, dw, dh);
  ctx.restore();

  // Base canvas for blur/mosaic source sampling (in canvas px, PANNED frame).
  // The base must be sampled through the same view offset as the destination
  // canvas, so draw it offset. Height/width cover the canvas plus the pan
  // extent so patches near an edge still sample valid base pixels.
  let base = baseCanvas;
  if (!base) {
    // Base is dw×dh (image-sized), drawn offset by viewDx/viewDy. Sample with
    // the offset baked in below via getImageData coords — but blur/mosaic
    // draw from `base` with 9-arg drawImage reading rect.x/rect.y (canvas px
    // in unpanned space). To keep those helpers unchanged we keep `base` in
    // its own unpanned full-image space and let the panned draw offset only
    // the base image + stickers (stickers sample base by source rect, so blur /
    // mosaic source sampling must NOT be shifted — only the destination is).
    base = document.createElement('canvas');
    base.width = Math.round(dw);
    base.height = Math.round(dh);
    const bctx = base.getContext('2d');
    bctx.drawImage(image, 0, 0, base.width, base.height);
  }

  const scratchCanvas = document.createElement('canvas');
  const scratchCtx = scratchCanvas.getContext('2d', { willReadFrequently: true });

  for (const sticker of stickers ?? []) {
    ctx.save();
    ctx.translate(viewDx, viewDy);
    if (sticker.kind === 'emoji') {
      drawEmoji(ctx, sticker, bitmaps?.get(sticker.src), imgW, imgH, scale, customBitmaps, fallback?.get(sticker.src));
    } else if (sticker.kind === 'custom') {
      drawEmoji(ctx, sticker, null, imgW, imgH, scale, customBitmaps, fallback?.get(sticker.src));
    } else if (sticker.kind === 'blur') {
      drawBlur(ctx, sticker, base, imgW, imgH, scale);
    } else if (sticker.kind === 'mosaic') {
      drawMosaic(ctx, sticker, base, imgW, imgH, scale, scratchCanvas, scratchCtx);
    }
    ctx.restore();
  }
}
