// Full-resolution export. Export ALWAYS composites at image.naturalWidth /
// naturalHeight — never at preview scale — then canvas.toBlob() (which also
// strips EXIF/GPS: surface that in the UI as a privacy feature).
//
// A partial asset failure must never disable the app: exportImage returns a
// `degraded` count of stickers that had no decoded bitmap; those draw as a
// shaded block (via render.js paint fallbacks) instead of blocking export.

import { paint, partitionStickers } from './render.js';

/**
 * Composite state onto a fresh natural-size canvas (no Blob; testable).
 * @param {object} state Store state {image, stickers}
 * @param {Map<string, ImageBitmap>} bitmaps
 * @param {Map<string, ImageBitmap>} [customBitmaps]
 * @param {Map<string, HTMLImageElement>} [fallback] img fallbacks by src
 */
export function compositeCanvas(state, bitmaps, customBitmaps, fallback) {
  const image = state.image;
  if (!image) throw new Error('No image loaded');
  const W = image.naturalWidth;
  const H = image.naturalHeight;
  if (!W || !H) throw new Error('Image has no natural size');

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const ordered = [...(state.stickers ?? [])].sort((a, b) => a.z - b.z);
  paint(ctx, {
    image,
    stickers: ordered,
    bitmaps,
    fallback,
    customBitmaps,
    imgW: W,
    imgH: H,
    scale: 1, // canvas px == natural px
    baseCanvas: null, // paint() builds a base at this scale
  });
  return canvas;
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
 * Export as a downloadable Blob.
 * @param {object} state
 * @param {Map<string, ImageBitmap>} bitmaps
 * @param {Map<string, ImageBitmap>} [customBitmaps]
 * @param {string} [mime] 'image/png' (default) or 'image/jpeg'
 * @param {Map<string, HTMLImageElement>} [fallback] img fallbacks by src
 * @param {number} [quality] JPEG quality (default 0.92)
 * @returns {Promise<{blob: Blob, filename: string, degraded: number}>}
 */
export async function exportImage(state, bitmaps, customBitmaps = new Map(), mime = 'image/png', fallback, quality = 0.92) {
  // Back-compat: the old signature was (state, bitmaps, custom, mime, quality);
  // tolerate a numeric 5th argument so older callers still work.
  if (typeof fallback === 'number') {
    quality = fallback;
    fallback = undefined;
  }
  const image = state.image;
  if (!image) throw new Error('No image loaded');
  const canvas = compositeCanvas(state, bitmaps, customBitmaps, fallback);
  const degraded = degradedStickerCount(state, bitmaps, customBitmaps, fallback);
  const ext = mime === 'image/jpeg' ? 'jpg' : 'png';
  const base = (image.name ?? 'photo')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w\-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'photo';
  const blob = await new Promise((resolve, reject) => {
    if (canvas.toBlob) {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), mime, quality);
    } else {
      // Fallback for environments without toBlob (legacy).
      const url = canvas.toDataURL(mime, quality);
      const bin = atob(url.split(',')[1]);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      resolve(new Blob([arr], { type: mime }));
    }
  });
  return { blob, filename: `${base}_stickerface.${ext}`, degraded };
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
