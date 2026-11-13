// Full-resolution export. Export composites at image.naturalWidth /
// naturalHeight whenever the browser can allocate that canvas — never at
// preview scale — then canvas.toBlob() (which also strips EXIF/GPS: surface
// that in the UI as a privacy feature).
//
// A partial asset failure must never disable the app: exportImage returns a
// `degraded` count of stickers that had no decoded bitmap; those draw as a
// shaded block (via render.js paint fallbacks) instead of blocking export.
//
// Browsers cap canvas area (Safari 4096x4096 through iOS 17, 8192x8192 in
// iOS 18; Chrome far higher). Above the cap a natural-size canvas allocates
// nothing and toBlob resolves null, so exportSize() scales the composite
// down to the cap (normalized state is scale-free, so the result is still
// correct, only lower resolution) and said so in the returned size fields.

import { paint, partitionStickers } from './render.js';

/** Default canvas-area cap for browsers without a tighter platform limit. */
export const DEFAULT_MAX_CANVAS_PIXELS = 268435456;
/** Safari / iOS through 17: 4096x4096. */
export const SAFARI_LEGACY_MAX_CANVAS_PIXELS = 16777216;
/** Safari / iOS 18+: 8192x8192 (WebKit bug 271002). */
export const SAFARI_MODERN_MAX_CANVAS_PIXELS = 67108864;

/** Same area limits in square pixels (the argument area tests pass as `cap`). */
export const MAX_CANVAS_PIXELS = DEFAULT_MAX_CANVAS_PIXELS;

/** True when a UA string identifies Safari on iOS or macOS. @param {string} ua */
function isSafariUA(ua) {
  return typeof ua === 'string' && ua.includes('Safari') && !ua.includes('Chrome') && !ua.includes('Chromium');
}

/** True when a UA string identifies iOS. @param {string} ua */
function isIOSUA(ua) {
  return typeof ua === 'string' && /iPhone|iPad|iPod/.test(ua);
}

/** iOS major version (e.g. 17) from the UA, or null when absent. @param {string} ua */
function iosMajorVersion(ua) {
  const m = typeof ua === 'string' && ua.match(/OS (\d+)(?:[._]| )(\d+)/);
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Largest canvas area, in pixels, the current browser can allocate.
 * Pure (no DOM): pass the browser's UA from the DOM wrapper below; the
 * 268,435,456 default is the value pdf.js uses for "everything else", which
 * keeps the normal case at full resolution while Safari gets its real caps.
 * @param {string} [ua]
 * @returns {number} maximum canvas area in px
 */
export function maxCanvasPixels(ua) {
  if (!isSafariUA(ua)) return DEFAULT_MAX_CANVAS_PIXELS;
  if (isIOSUA(ua)) {
    const v = iosMajorVersion(ua);
    return v != null && v >= 18 ? SAFARI_MODERN_MAX_CANVAS_PIXELS : SAFARI_LEGACY_MAX_CANVAS_PIXELS;
  }
  // Safari on macOS (and an unknown Safari form factor): use the tight cap.
  return SAFARI_LEGACY_MAX_CANVAS_PIXELS;
}

/**
 * The size export.js actually composites at: the requested size, scaled down
 * only when its area exceeds `cap` (never upscaled, aspect preserved by one
 * linear factor). Pure so the boundary lives in unit tests.
 * @param {number} W requested width px
 * @param {number} H requested height px
 * @param {number} [cap] maximum canvas area in px (default: the default cap)
 * @returns {{w:number, h:number, scale:number, capped:boolean}} capped size,
 *   canvas px per natural px, and whether the size was reduced
 */
export function exportSize(W, H, cap = DEFAULT_MAX_CANVAS_PIXELS) {
  const w = Number.isFinite(W) ? W : 0;
  const h = Number.isFinite(H) ? H : 0;
  const limit = Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_MAX_CANVAS_PIXELS;
  const area = w * h;
  if (area <= limit || area <= 0) return { w: Math.round(w), h: Math.round(h), scale: 1, capped: false };
  const scale = Math.sqrt(limit / area);
  const cw = Math.max(1, Math.floor(w * scale));
  const ch = Math.max(1, Math.floor(h * scale));
  return { w: cw, h: ch, scale: cw / w, capped: true };
}

/** The cap for the browser running this page. The only DOM touch in this module. */
function currentMaxCanvasPixels() {
  try {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    return maxCanvasPixels(ua);
  } catch {
    return DEFAULT_MAX_CANVAS_PIXELS;
  }
}

/**
 * Composite state onto a fresh canvas (no Blob; testable). At natural size
 * when the browser can allocate it; otherwise at the largest capped size
 * that fits (compositeSize reports the size actually used).
 * @param {object} state Store state {image, stickers}
 * @param {Map<string, ImageBitmap>} bitmaps
 * @param {Map<string, ImageBitmap>} [customBitmaps]
 * @param {Map<string, HTMLImageElement>} [fallback] img fallbacks by src
 * @param {object} [opts] {cap} — override the canvas-area cap (tests / odd engines)
 * @returns {{canvas: HTMLCanvasElement, compositeSize: object}} paint store, never blank
 */
function compositeCanvas(state, bitmaps, customBitmaps, fallback, opts) {
  const image = state.image;
  if (!image) throw new Error('No image loaded');
  const W = image.naturalWidth;
  const H = image.naturalHeight;
  if (!W || !H) throw new Error('Image has no natural size');

  const size = exportSize(W, H, opts?.cap ?? currentMaxCanvasPixels());
  const canvas = document.createElement('canvas');
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(`Cannot get a 2d context for a ${size.w}x${size.h} export canvas`);
  const ordered = [...(state.stickers ?? [])].sort((a, b) => a.z - b.z);
  const compositeSize = {
    w: size.w,
    h: size.h,
    requestedW: W,
    requestedH: H,
    capped: size.capped,
    scale: size.scale,
    maxPixels: opts?.cap ?? currentMaxCanvasPixels(),
  };
  paint(ctx, {
    image,
    stickers: ordered,
    bitmaps,
    fallback,
    customBitmaps,
    imgW: W,
    imgH: H,
    scale: size.scale, // canvas px per natural px; 1 whenever the photo fits
    baseCanvas: null, // paint() builds a base at this scale
  });
  return { canvas, compositeSize };
}

/**
 * Why an export was reduced: a loud, exact sentence for the UI status text.
 * @param {object} compositeSize from compositeCanvas
 * @returns {string} empty when the export is at full resolution
 */
export function cappedExportNote(compositeSize) {
  if (!compositeSize?.capped) return '';
  return `This photo is ${compositeSize.requestedW}x${compositeSize.requestedH}, which exceeds the browser's maximum canvas size of ${compositeSize.maxPixels.toLocaleString('en-US')} pixels, so the export was saved at ${compositeSize.w}x${compositeSize.h} instead of full resolution (one ${compositeSize.maxPixels.toLocaleString('en-US')}-pixel canvas, stickers at the same positions).`;
}

/**
 * Count stickers that will draw degraded (no decoded bitmap, with or
 * without a fallback <img>). Purely informative — never blocks export.
 * @param {object} state Store state {stickers}
 * @param {Map<string, ImageBitmap>} bitmaps emoji bitmaps by src
 * @param {Map<string, ImageBitmap>} [customBitmaps] user-image bitmaps by src
 * @param {Map<string, HTMLImageElement>} [fallback] img fallbacks by src
 * @returns {number} count of degraded stickers
 */
export function degradedStickerCount(state, bitmaps, customBitmaps, fallback) {
  const stickers = state?.stickers ?? [];
  const { withFallback, withPlaceholder } = partitionStickers(stickers, bitmaps, fallback, customBitmaps);
  return withFallback.length + withPlaceholder.length;
}

/**
 * Export as a downloadable Blob. Composites at full (natural) resolution,
 * or at the largest size the browser canvas allows (see cap note below).
 * @param {object} state
 * @param {Map<string, ImageBitmap>} bitmaps
 * @param {Map<string, ImageBitmap>} [customBitmaps]
 * @param {string} [mime] 'image/png' (default) or 'image/jpeg'
 * @param {Map<string, HTMLImageElement>} [fallback] img fallbacks by src
 * @param {number|object} [quality] JPEG quality (default 0.92) or {quality, cap}
 * @returns {Promise<{blob: Blob, filename: string, degraded: number, compositeSize: object}>}
 */
export async function exportImage(state, bitmaps, customBitmaps = new Map(), mime = 'image/png', fallback, quality = 0.92) {
  // Back-compat: the old signature was (state, bitmaps, custom, mime, quality);
  // tolerate a numeric 5th argument so older callers still work.
  if (typeof fallback === 'number') {
    quality = fallback;
    fallback = undefined;
  }
  let cap;
  if (quality != null && typeof quality === 'object') {
    cap = quality.cap;
    quality = quality.quality;
  }
  const image = state.image;
  if (!image) throw new Error('No image loaded');
  const { canvas, compositeSize } = compositeCanvas(state, bitmaps, customBitmaps, fallback, cap != null ? { cap } : undefined);
  const degraded = degradedStickerCount(state, bitmaps, customBitmaps, fallback);
  const ext = mime === 'image/jpeg' ? 'jpg' : 'png';
  const base = (image.name ?? 'photo')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w\-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'photo';
  const blob = await new Promise((resolve, reject) => {
    if (canvas.toBlob) {
      canvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error(`toBlob returned null when encoding a ${compositeSize.w}x${compositeSize.h} export canvas of ${compositeSize.requestedW}x${compositeSize.requestedH} pixels (browser canvas limit ${compositeSize.maxPixels.toLocaleString('en-US')} px)`));
      }, mime, quality);
    } else {
      // Fallback for environments without toBlob (legacy).
      const url = canvas.toDataURL(mime, quality);
      const bin = atob(url.split(',')[1]);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      resolve(new Blob([arr], { type: mime }));
    }
  });
  return { blob, filename: `${base}_stickerface.${ext}`, degraded, compositeSize };
}

/** Trigger a browser download for a Blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
