// Full-resolution export. Export ALWAYS composites at image.naturalWidth /
// naturalHeight — never at preview scale — then canvas.toBlob() (which also
// strips EXIF/GPS: surface that in the UI as a privacy feature).

import { paint } from './render.js';

/**
 * Composite state onto a fresh natural-size canvas (no Blob; testable).
 * @param {object} state Store state {image, stickers}
 * @param {Map<string, ImageBitmap>} bitmaps
 * @param {Map<string, ImageBitmap>} [customBitmaps]
 */
export function compositeCanvas(state, bitmaps, customBitmaps) {
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
    customBitmaps,
    imgW: W,
    imgH: H,
    scale: 1, // canvas px == natural px
    baseCanvas: null, // paint() builds a base at this scale
  });
  return canvas;
}

/**
 * Export as a downloadable Blob.
 * @param {object} state
 * @param {Map<string, ImageBitmap>} bitmaps
 * @param {Map<string, ImageBitmap>} [customBitmaps]
 * @param {string} [mime] 'image/png' (default) or 'image/jpeg'
 * @param {number} [quality] JPEG quality (default 0.92)
 * @returns {Promise<{blob: Blob, filename: string}>}
 */
export async function exportImage(state, bitmaps, customBitmaps = new Map(), mime = 'image/png', quality = 0.92) {
  const image = state.image;
  if (!image) throw new Error('No image loaded');
  const canvas = compositeCanvas(state, bitmaps, customBitmaps);
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
  return { blob, filename: `${base}_stickerface.${ext}` };
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
