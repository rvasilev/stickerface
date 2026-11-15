// Full-resolution export: composite at image.naturalWidth/naturalHeight — never at preview scale —
// then canvas.toBlob(), which also strips EXIF/GPS (surfaced in the UI as a privacy feature).
//
// Two limits can reduce what is written, and compositeSize names which one did: the browser's canvas
// area cap (Safari 4096x4096 through iOS 17, 8192x8192 in iOS 18; Chrome far higher — above it a
// natural-size canvas allocates nothing and toBlob resolves null) and the user's own export size.
// Normalized state is scale-free, so a reduced export is still correct, only lower resolution.

import { paint, partitionStickers } from './render.js';

/** Default canvas-area cap for browsers without a tighter platform limit. */
export const DEFAULT_MAX_CANVAS_PIXELS = 268435456;
/** Safari / iOS through 17: 4096x4096. */
export const SAFARI_LEGACY_MAX_CANVAS_PIXELS = 16777216;
/** Safari / iOS 18+: 8192x8192 (WebKit bug 271002). */
export const SAFARI_MODERN_MAX_CANVAS_PIXELS = 67108864;

/* ---------- format, compression level, export size, and the settings that hold them ---------- */

/**
 * The levels a lossy export offers, per format. PNG is absent on purpose: `toBlob`'s quality
 * argument applies to lossy formats only (measured byte-identical output across the whole range).
 * `better` is 0.92 — what this module hardcoded before levels existed — so a default JPEG export is
 * byte-for-byte what it always was. No LOSSY level reaches 1.0 (for WebP that is a switch to true
 * lossless, measured 2.4 MB -> 7.3 MB from 0.92); `webp.lossless` IS that switch, and it is worth a
 * named tier because lossless WebP is 43.8% smaller than PNG at identical pixels for no dependency.
 */
export const EXPORT_LEVELS = {
  jpeg: { smaller: 0.5, balanced: 0.75, better: 0.92, maximum: 0.95 },
  webp: { smaller: 0.5, balanced: 0.75, better: 0.92, maximum: 0.95, lossless: 1.0 },
};

/**
 * Long-edge targets — the setting that actually decides a file's size. Measured on a 12.2 MP photo:
 * a 2048 long edge is 83% fewer bytes than full resolution and 1280 is 95%, against 78% for the
 * entire JPEG level range. `full` is null, and null means "do not touch the pixels".
 */
export const EXPORT_SIZES = { full: null, large: 2048, web: 1280 };

/** The level used when nothing is stored, or when the stored one is unknown. */
export const DEFAULT_EXPORT_LEVEL = 'better';

/** The size used when nothing is stored, or when the stored one is unknown. */
export const DEFAULT_EXPORT_SIZE = 'full';

/** One key for both formats and the size: the three choices are read and written together. */
export const EXPORT_SETTINGS_KEY = 'stickerface.export.levels';

/**
 * The long edge for a size name, or null for full resolution — also for an unknown name, so a
 * stored size this build no longer has can never silently reduce someone's export.
 * @param {string} [name] a key of EXPORT_SIZES
 * @returns {number|null}
 */
export function longEdge(name) {
  return EXPORT_SIZES[name] ?? null;
}

/** The quality for a format+level, or undefined for a format that has no level (PNG).
 * @param {string} format 'png' | 'jpeg' | 'webp'
 * @param {string} [level] a key of EXPORT_LEVELS[format]
 * @returns {number|undefined}
 */
export function levelValue(format, level) {
  const table = EXPORT_LEVELS[format];
  if (!table) return undefined;
  return table[level] ?? table[DEFAULT_EXPORT_LEVEL];
}

/**
 * What the browser actually produced, versus what it was asked for. The mismatch is SILENT: the spec
 * requires an unencodable type to be exported as `image/png` with no error, and Safari has no canvas
 * WebP encoder at all — so the returned type is the only signal, hence the extension follows it.
 * @param {string} requested the mime that was asked for
 * @param {string} actual the returned Blob's type (may be missing)
 * @returns {{mime:string, ext:string, fellBack:boolean}}
 */
export function resolveExportFormat(requested, actual) {
  const mime = actual === 'image/jpeg' || actual === 'image/webp' ? actual : 'image/png';
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  return { mime, ext, fellBack: mime !== requested };
}

/** The download name: the base is already sanitised by exportImage, and the extension must be the
 *  PRODUCED one, never the requested one. */
export function exportFilename(base, ext) {
  return `${base}_stickerface.${ext}`;
}

/**
 * Stored choices, validated against the CURRENT tables: a name that no longer exists resolves to its
 * default rather than propagating, a blob written before `size` existed reads as full resolution, and
 * unreadable storage is a default — never an exception (the coach flag's fail-safe shape).
 * @param {{getItem:function(string):?string}} [storage]
 * @returns {{jpeg:string, webp:string, size:string}}
 */
export function readExportSettings(storage) {
  const defaults = {
    jpeg: DEFAULT_EXPORT_LEVEL, webp: DEFAULT_EXPORT_LEVEL, size: DEFAULT_EXPORT_SIZE,
  };
  let raw = null;
  try {
    raw = storage?.getItem(EXPORT_SETTINGS_KEY) ?? null;
  } catch {
    return defaults;
  }
  if (!raw) return defaults;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
  const out = { ...defaults };
  for (const format of Object.keys(EXPORT_LEVELS)) {
    const name = parsed[format];
    if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(EXPORT_LEVELS[format], name)) {
      out[format] = name;
    }
  }
  // Its own check: the loop above walks EXPORT_LEVELS, which never sees the size.
  const size = parsed.size;
  if (typeof size === 'string' && Object.prototype.hasOwnProperty.call(EXPORT_SIZES, size)) {
    out.size = size;
  }
  return out;
}

/** Persist the choices. A storage that throws (private mode, blocked site data) must not break the
 *  export path, so this never propagates.
 * @param {{setItem:function(string,string):void}} [storage]
 * @param {{jpeg:string, webp:string, size:string}} settings
 */
export function writeExportSettings(storage, settings) {
  try {
    storage?.setItem(EXPORT_SETTINGS_KEY, JSON.stringify({
      jpeg: settings?.jpeg ?? DEFAULT_EXPORT_LEVEL,
      webp: settings?.webp ?? DEFAULT_EXPORT_LEVEL,
      size: settings?.size ?? DEFAULT_EXPORT_SIZE,
    }));
  } catch {
    /* an unwritable preference is a preference at its default */
  }
}

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
 * Largest canvas area, in pixels, the current browser can allocate. Pure (the UA is an argument);
 * the 268,435,456 default is pdf.js's "everything else" value, which keeps the normal case at full
 * resolution while Safari gets its real caps.
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
 * Per-side canvas limit, in px. An area cap alone is not enough: 8192x2048 is exactly at Safari's
 * legacy area cap, so an area-only guard passes it through with a side of 8192 — twice what Safari
 * allocates, and the failure message then blames the area. Non-Safari returns Infinity: inventing a
 * cap there would refuse exports that work today.
 * @param {string} [ua]
 * @returns {number} maximum canvas side in px (Infinity when unconstrained)
 */
export function maxCanvasSide(ua) {
  if (!isSafariUA(ua)) return Infinity;
  if (isIOSUA(ua)) {
    const v = iosMajorVersion(ua);
    return Math.sqrt(v != null && v >= 18 ? SAFARI_MODERN_MAX_CANVAS_PIXELS : SAFARI_LEGACY_MAX_CANVAS_PIXELS);
  }
  return Math.sqrt(SAFARI_LEGACY_MAX_CANVAS_PIXELS);
}

/**
 * The size export.js actually composites at: the requested size, scaled down only when its area
 * exceeds `cap` or its longer side exceeds `maxSide` (never upscaled, aspect preserved by one linear
 * factor). Pure so the boundary lives in unit tests.
 * @param {number} W requested width px
 * @param {number} H requested height px
 * @param {number} [cap] maximum canvas area in px (default: the default cap)
 * @param {number} [maxSide] maximum canvas side in px (default: unconstrained)
 * @returns {{w:number, h:number, scale:number, capped:boolean}} capped size, canvas px per natural
 *   px, and whether the size was reduced
 */
export function exportSize(W, H, cap = DEFAULT_MAX_CANVAS_PIXELS, maxSide = Infinity) {
  const w = Number.isFinite(W) ? W : 0;
  const h = Number.isFinite(H) ? H : 0;
  const limit = Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_MAX_CANVAS_PIXELS;
  const area = w * h;
  if (area <= 0) return { w: Math.round(w), h: Math.round(h), scale: 1, capped: false };
  let scale = area > limit ? Math.sqrt(limit / area) : 1;
  const side = Math.max(w, h);
  if (Number.isFinite(maxSide) && maxSide > 0 && side * scale > maxSide) scale = maxSide / side;
  if (scale >= 1) return { w: Math.round(w), h: Math.round(h), scale: 1, capped: false };
  const cw = Math.max(1, Math.floor(w * scale));
  const ch = Math.max(1, Math.floor(h * scale));
  return { w: cw, h: ch, scale: cw / w, capped: true };
}

/** The UA string of the environment this runs in, or '' where there is none (a worker, an old page). */
function currentUA() {
  try {
    return typeof navigator !== 'undefined' ? navigator.userAgent : '';
  } catch {
    return '';
  }
}

/** Largest canvas area, in pixels, the browser running this page can allocate. */
function currentMaxCanvasPixels() {
  return maxCanvasPixels(currentUA());
}

/** The per-side cap for the same browser — Infinity where nothing constrains it. */
function currentMaxCanvasSide() {
  return maxCanvasSide(currentUA());
}

/**
 * Composite state onto a fresh canvas (no Blob; testable). At natural size unless a limit binds — the
 * browser's canvas cap or the user's own export size. compositeSize reports the size used AND which
 * limit reduced it, so nothing downstream can blame the wrong one.
 * @param {number} [maxLongEdge] the user's chosen long edge in px (Infinity = full resolution)
 */
function compositeCanvas(state, bitmaps, customBitmaps, fallback, maxLongEdge = Infinity) {
  const image = state.image;
  if (!image) throw new Error('No image loaded');
  const W = image.naturalWidth;
  const H = image.naturalHeight;
  if (!W || !H) throw new Error('Image has no natural size');

  const maxPixels = currentMaxCanvasPixels();
  const browserSide = currentMaxCanvasSide();
  const userEdge = Number.isFinite(maxLongEdge) && maxLongEdge > 0 ? maxLongEdge : Infinity;
  // The tighter side wins; the area cap is passed through untouched so a browser whose AREA limit
  // binds still gets its full allowance.
  const size = exportSize(W, H, maxPixels, Math.min(browserSide, userEdge));
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
    maxPixels,
    // Which limit reduced it: 'size' (the user's own setting), 'canvas' (the browser's cap), or null
    // when nothing did. The note may not blame the browser for the user's own choice.
    reducedBy: size.capped ? (userEdge < browserSide ? 'size' : 'canvas') : null,
    longEdgePx: userEdge === Infinity ? null : userEdge,
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
 * Why an export was reduced: a loud, exact sentence naming the limit that actually applied, for the
 * status text (which already reports the dimensions and bytes that were written, so this explains
 * rather than repeats them).
 * @param {object} compositeSize from compositeCanvas
 * @returns {string} empty when the export is at full resolution
 */
export function cappedExportNote(compositeSize) {
  if (!compositeSize?.capped) return '';
  const { requestedW, requestedH, maxPixels, longEdgePx } = compositeSize;
  if (compositeSize.reducedBy === 'size') {
    return `The export size is set to a ${longEdgePx} px long edge, so this ${requestedW}x${requestedH} photo was reduced (stickers keep their positions).`;
  }
  return `This photo is ${requestedW}x${requestedH}, which exceeds the browser's maximum canvas size of ${maxPixels.toLocaleString('en-US')} pixels, so the export is at the largest size that canvas can paint (stickers keep their positions).`;
}

/** How many stickers have no drawable asset (no bitmap and no fallback <img>), and so paint as a
 *  shaded block. Informative only — it never blocks an export. */
export function degradedStickerCount(state, bitmaps, customBitmaps, fallback) {
  const stickers = state?.stickers ?? [];
  const { withPlaceholder } = partitionStickers(stickers, bitmaps, fallback, customBitmaps);
  return withPlaceholder.length;
}

/**
 * Export as a downloadable Blob, at full resolution unless the user chose a size or the browser's
 * canvas cap binds (compositeSize says which).
 * @param {object} state
 * @param {Map<string, ImageBitmap>} bitmaps
 * @param {Map<string, ImageBitmap>} [customBitmaps]
 * @param {string} [mime] 'image/png' (default), 'image/jpeg' or 'image/webp' — a browser with no
 *   encoder for the requested type answers with PNG, which `format` reports
 * @param {Map<string, HTMLImageElement>} [fallback] img fallbacks by src
 * @param {number} [quality] lossy quality (ignored for PNG; see EXPORT_LEVELS)
 * @param {number} [maxLongEdge] the user's chosen long edge in px, or null/Infinity for full
 * @returns {Promise<{blob: Blob, filename: string, degraded: number, compositeSize: object,
 *   format: {mime: string, ext: string, fellBack: boolean}}>}
 */
export async function exportImage(state, bitmaps, customBitmaps = new Map(), mime = 'image/png', fallback, quality = 0.92, maxLongEdge = Infinity) {
  const image = state.image;
  if (!image) throw new Error('No image loaded');
  const { canvas, compositeSize } = compositeCanvas(state, bitmaps, customBitmaps, fallback, maxLongEdge);
  const degraded = degradedStickerCount(state, bitmaps, customBitmaps, fallback);
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
  // The name and the reported format follow what came BACK. A browser without an encoder for the
  // requested type answers with PNG and says so — in `blob.type` and nowhere else — so trusting the
  // request here is how a `.webp` file ends up holding PNG bytes.
  const format = resolveExportFormat(mime, blob.type);
  return {
    blob,
    filename: exportFilename(base, format.ext),
    degraded,
    compositeSize,
    /** What was actually encoded: {mime, ext, fellBack}. `fellBack` true means the browser could
     *  not produce the requested type and produced PNG instead. */
    format,
  };
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
