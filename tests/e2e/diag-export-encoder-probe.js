// Diagnostic (NOT a gate): what can THIS browser's canvas encoder actually produce, and what does
// the quality argument cost or save per format?
//
// The point is to measure the premise the export-settings plan rests on, rather than reason about
// it: (1) whether `toBlob('image/webp')` returns WebP or silently falls back to PNG, (2) whether
// PNG's quality argument moves a single byte, (3) what a step of quality actually buys in bytes.
// Safari has no canvas WebP encoder at all (spec: unsupported type -> PNG, silently), so any WebP
// export MUST decide from `blob.type`, never from the mime it asked for. This probe shows the
// shape of the answer on the browser the gates run in; it cannot show Safari's, which is why the
// decision has to live in a pure unit-tested function.
(async () => {
  const r = { steps: [], errors: [] };
  const log = (k, v) => r.steps.push([k, v]);

  // A deterministic 3000x2000 (6 MP) "photo": smooth gradient plus noise, which is what makes a
  // lossy encoder's quality argument mean anything (a flat canvas compresses the same at any q).
  const W = 3000, H = 2000;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const n = (Math.random() - 0.5) * 40;
      img.data[i] = Math.max(0, Math.min(255, (x / W) * 255 + n));
      img.data[i + 1] = Math.max(0, Math.min(255, (y / H) * 255 + n));
      img.data[i + 2] = Math.max(0, Math.min(255, 128 + n));
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  const encode = (mime, q) => new Promise((resolve) => {
    c.toBlob((b) => resolve(b ? { type: b.type, bytes: b.size } : null), mime, q);
  });

  const rows = [];
  for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
    for (const q of [0.5, 0.8, 0.92, 1.0]) {
      const out = await encode(mime, q);
      rows.push({
        asked: mime,
        q,
        got: out ? out.type : null,
        fellBack: out ? out.type !== mime : null,
        kb: out && typeof out.bytes === 'number' ? Math.round(out.bytes / 1024) : null,
        bytes: out ? out.bytes : null,
      });
    }
  }
  log('canvas', { W, H });
  for (const row of rows) log('encode', row);

  const byMime = {};
  for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
    const forMime = rows.filter((x) => x.asked === mime);
    const sizes = forMime.map((x) => x.kb);
    byMime[mime] = {
      encodesAsAsked: forMime.every((x) => x.got === mime),
      distinctSizesAcrossQuality: new Set(sizes).size,
      sizes: sizes,
    };
  }
  log('summary', byMime);

  r.pngIgnoresQuality = byMime['image/png'].distinctSizesAcrossQuality === 1;
  r.webpEncodesAsWebp = byMime['image/webp'].encodesAsAsked;
  r.jpegEncodesAsJpeg = byMime['image/jpeg'].encodesAsAsked;
  return JSON.stringify(r);
})()
