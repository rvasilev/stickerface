// Full-resolution export. Export composites at image.naturalWidth /
// naturalHeight whenever the browser can allocate that canvas — never at
// preview scale — then canvas.toBlob() (which also strips EXIF/GPS: surface
// that in the UI as a privacy feature).
//
// A partial asset failure must never disable the app: exportImage returns a
// `degraded` count of stickers that had no drawable asset (no bitmap AND no
// <img> fallback) and so draw as a shaded block. A sticker drawn from the
// <img> fallback draws the real artwork, so it is not degraded.
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

/* ---------- format, compression level, export size, and the settings that hold them ---------- */

/**
 * The levels a lossy export offers, per format. PNG is absent on purpose: `toBlob`'s quality
 * argument applies to lossy formats only, so a PNG "level" would be a control wired to nothing
 * (measured: byte-identical output across the whole range).
 *
 * `better` is 0.92 — the value this module hardcoded before levels existed — so the default JPEG
 * export is byte-for-byte what it always was. No LOSSY level reaches 1.0: for WebP that is not
 * "maximum" but a switch to true lossless (measured 2.4 MB -> 7.3 MB from 0.92), and JPEG at 1.0 is
 * still lossy and still triples the file. `webp.lossless` IS that switch, offered as its own named
 * tier, because lossless WebP is 43.8% smaller than PNG at identical pixels for no dependency.
 */
export const EXPORT_LEVELS = {
  jpeg: { smaller: 0.5, balanced: 0.75, better: 0.92, maximum: 0.95 },
  webp: { smaller: 0.5, balanced: 0.75, better: 0.92, maximum: 0.95, lossless: 1.0 },
};

/**
 * Long-edge targets — the setting that actually decides a file's size. Measured on a 12.2 MP
 * photo: a 2048 long edge is 83% fewer bytes than full resolution and 1280 is 95%, against 78% for
 * the entire JPEG level range. `full` is null, and null means "do not touch the pixels": reducing
 * an export is the user's call, never a default.
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

/**
 * The quality for a format+level, or undefined for a format that has no level.
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
 * What the browser actually produced, versus what it was asked for.
 *
 * The mismatch is SILENT: the HTML spec requires a browser that cannot encode the requested type to
 * export `image/png`, with no error and no rejection — and Safari has no canvas WebP encoder at
 * all, so asking for WebP there returns valid PNG bytes. The returned type is the only signal there
 * is, which is why the extension is derived from `actual`. Pure so the Safari case is unit-testable
 * without owning a Safari.
 *
 * @param {string} requested the mime that was asked for
 * @param {string} actual the returned Blob's type (may be missing)
 * @returns {{mime:string, ext:string, fellBack:boolean}}
 */
export function resolveExportFormat(requested, actual) {
  const mime = actual === 'image/jpeg' || actual === 'image/webp' ? actual : 'image/png';
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  return { mime, ext, fellBack: mime !== requested };
}

/**
 * The download name. Dumb on purpose: the base is already sanitised by exportImage, and the only
 * thing this adds is the extension — which must be the PRODUCED one, never the requested one.
 * @param {string} base sanitised photo name
 * @param {string} ext 'png' | 'jpg' | 'webp'
 * @returns {string}
 */
export function exportFilename(base, ext) {
  return `${base}_stickerface.${ext}`;
}

/**
 * Stored choices, validated against the CURRENT tables: a name that no longer exists — or a format
 * this build does not have — resolves to its default rather than propagating a stale value, and a
 * blob written before `size` existed reads as full resolution. Unreadable storage is a default,
 * never an exception: the same fail-safe shape as the coach flag.
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
 * Per-side canvas limit, in px, for the current browser. An area cap alone is not
 * enough: a wide photo can clear the area and still exceed the SIDE, so the
 * allocation fails and the message blames the area. 8192x2048 is exactly at
 * Safari's legacy area cap, so an area-only guard passes it through with a side of
 * 8192 — twice the 4096 Safari will allocate. Non-Safari returns Infinity: Chrome
 * allocates far larger sides, and inventing a cap there would refuse exports that
 * work today.
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
 * The size export.js actually composites at: the requested size, scaled down
 * only when its area exceeds `cap` or its longer side exceeds `maxSide` (never
 * upscaled, aspect preserved by one linear factor). Pure so the boundary lives in
 * unit tests.
 * @param {number} W requested width px
 * @param {number} H requested height px
 * @param {number} [cap] maximum canvas area in px (default: the default cap)
 * @param {number} [maxSide] maximum canvas side in px (default: unconstrained)
 * @returns {{w:number, h:number, scale:number, capped:boolean}} capped size,
 *   canvas px per natural px, and whether the size was reduced
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

/** The cap for the browser running this page. The only DOM touch in this module. */
function currentMaxCanvasPixels() {
  try {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    return maxCanvasPixels(ua);
  } catch {
    return DEFAULT_MAX_CANVAS_PIXELS;
  }
}

/** The per-side cap for the browser running this page, same DOM touch as above. */
function currentMaxCanvasSide() {
  try {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    return maxCanvasSide(ua);
  } catch {
    return Infinity;
  }
}

/**
 * Composite state onto a fresh canvas (no Blob; testable). At natural size unless a limit binds:
 * the browser's canvas cap, or the user's own export size. compositeSize reports the size actually
 * used AND which limit did the reducing, so nothing downstream has to guess or blame the wrong one.
 * @param {object} state Store state {image, stickers}
 * @param {Map<string, ImageBitmap>} bitmaps
 * @param {Map<string, ImageBitmap>} [customBitmaps]
 * @param {Map<string, HTMLImageElement>} [fallback] img fallbacks by src
 * @param {number} [maxLongEdge] the user's chosen long edge in px (Infinity = full resolution)
 * @returns {{canvas: HTMLCanvasElement, compositeSize: object}} paint store, never blank
 */
function compositeCanvas(state, bitmaps, customBitmaps, fallback, maxLongEdge = Infinity) {
  const image = state.image;
  if (!image) throw new Error('No image loaded');
  const W = image.naturalWidth;
  const H = image.naturalHeight;
  if (!W || !H) throw new Error('Image has no natural size');

  const browserSide = currentMaxCanvasSide();
  const userEdge = Number.isFinite(maxLongEdge) && maxLongEdge > 0 ? maxLongEdge : Infinity;
  // The tighter side wins; the area cap is passed through untouched so a browser whose AREA limit
  // binds still gets its full allowance.
  const size = exportSize(W, H, currentMaxCanvasPixels(), Math.min(browserSide, userEdge));
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
    maxPixels: currentMaxCanvasPixels(),
    /** Which limit reduced it: 'size' (the user's own setting), 'canvas' (the browser's cap), or
     *  null when nothing did. The note may not blame the browser for the user's own choice. */
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
 * Why an export was reduced: a loud, exact sentence for the UI status text, naming the limit that
 * actually applied — the user's own size setting, or the browser's canvas cap.
 * @param {object} compositeSize from compositeCanvas
 * @returns {string} empty when the export is at full resolution
 */
export function cappedExportNote(compositeSize) {
  if (!compositeSize?.capped) return '';
  const { requestedW, requestedH, w, h, maxPixels } = compositeSize;
  if (compositeSize.reducedBy === 'size') {
    return `Saved at ${w}x${h} — the export size is set to a ${compositeSize.longEdgePx} px long edge (this photo is ${requestedW}x${requestedH}).`;
  }
  return `This photo is ${requestedW}x${requestedH}, which exceeds the browser's maximum canvas size of ${maxPixels.toLocaleString('en-US')} pixels, so the export was saved at ${w}x${h} instead of full resolution (one ${maxPixels.toLocaleString('en-US')}-pixel canvas, stickers at the same positions).`;
}

/**
 * Count stickers with no drawable asset (no bitmap and no fallback <img>),
 * which paint as a shaded block. A sticker with a fallback <img> draws the
 * real artwork and is not counted. Purely informative — never blocks export.
 * @param {object} state Store state {stickers}
 * @param {Map<string, ImageBitmap>} bitmaps emoji bitmaps by src
 * @param {Map<string, ImageBitmap>} [customBitmaps] user-image bitmaps by src
 * @param {Map<string, HTMLImageElement>} [fallback] img fallbacks by src
 * @returns {number} count of stickers exported as a shaded block
 */
export function degradedStickerCount(state, bitmaps, customBitmaps, fallback) {
  const stickers = state?.stickers ?? [];
  const { withPlaceholder } = partitionStickers(stickers, bitmaps, fallback, customBitmaps);
  return withPlaceholder.length;
}

/**
 * Export as a downloadable Blob. Composites at full (natural) resolution unless the user chose an
 * export size or the browser's canvas limit binds (compositeSize says which).
 * @param {object} state
 * @param {Map<string, ImageBitmap>} bitmaps
 * @param {Map<string, ImageBitmap>} [customBitmaps]
 * @param {string} [mime] 'image/png' (default), 'image/jpeg' or 'image/webp' — a browser with no
 *   encoder for the requested type answers with PNG, which `format` reports
 * @param {Map<string, HTMLImageElement>} [fallback] img fallbacks by src
 * @param {number} [quality] lossy quality (ignored for PNG; see EXPORT_LEVELS)
 * @param {number} [maxLongEdge] the user's chosen long edge in px, or Infinity for full resolution
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
