// Diagnostic (NOT a gate): which lever actually moves an export's byte count?
//
// The M14 settings gave a level per lossy format, and measured that PNG ignores the quality
// argument entirely. The open question this probe answers is the NEXT one: of the levers a
// settings surface could offer — format, lossy level, and RESOLUTION — which one buys the most
// bytes, and does a lossless export have a smaller native option than PNG.
//
// Matrix: a deterministic photo-like canvas (gradient + bounded noise; flat content encodes to
// the same size at every quality, and pure noise is the encoders' worst case) encoded at three
// resolutions. Everything is `canvas.toBlob` with this browser's own encoders — no dependency,
// so the numbers are what an offline app can actually produce today.
(async () => {
  const r = { steps: [], errors: [] };
  const log = (k, v) => r.steps.push([k, v]);

  // Source: 4032x3024 (12.2 MP) — the shape of a phone photo, which is what the export path sees.
  const SRC_W = 4032, SRC_H = 3024;
  const src = document.createElement('canvas');
  src.width = SRC_W; src.height = SRC_H;
  const sg = src.getContext('2d');
  const img = sg.createImageData(SRC_W, SRC_H);
  for (let y = 0; y < SRC_H; y++) {
    for (let x = 0; x < SRC_W; x++) {
      const i = (y * SRC_W + x) * 4;
      const n = (Math.random() - 0.5) * 40;
      img.data[i] = Math.max(0, Math.min(255, (x / SRC_W) * 220 + 20 + n));
      img.data[i + 1] = Math.max(0, Math.min(255, (y / SRC_H) * 200 + 30 + n));
      img.data[i + 2] = Math.max(0, Math.min(255, 128 + n));
      img.data[i + 3] = 255;
    }
  }
  sg.putImageData(img, 0, 0);

  /** src scaled so its longer side is `side`, aspect preserved (the exportSize() rule). */
  const scaled = (side) => {
    const s = Math.min(1, side / Math.max(SRC_W, SRC_H));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.floor(SRC_W * s));
    c.height = Math.max(1, Math.floor(SRC_H * s));
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, c.width, c.height);
    return c;
  };

  const encode = (canvas, mime, q) => new Promise((resolve) => {
    const t0 = performance.now();
    canvas.toBlob((b) => resolve(b
      ? { type: b.type, bytes: b.size, ms: Math.round(performance.now() - t0) }
      : null), mime, q);
  });

  // The cells that decide the question. `lossless` is WebP at q=1.0 — the value the shipped
  // level table deliberately excludes, because for a LOSSY tier it is a cliff; as its own tier
  // it is Chrome's lossless encoder.
  const CELLS = [
    { side: 4032, mime: 'image/png', q: undefined, label: 'png/lossless' },
    { side: 4032, mime: 'image/webp', q: 1.0, label: 'webp/lossless' },
    { side: 4032, mime: 'image/jpeg', q: 0.92, label: 'jpeg/better' },
    { side: 4032, mime: 'image/jpeg', q: 0.5, label: 'jpeg/smaller' },
    { side: 4032, mime: 'image/webp', q: 0.75, label: 'webp/balanced' },
    { side: 2048, mime: 'image/png', q: undefined, label: 'png/lossless' },
    { side: 2048, mime: 'image/webp', q: 1.0, label: 'webp/lossless' },
    { side: 2048, mime: 'image/jpeg', q: 0.92, label: 'jpeg/better' },
    { side: 2048, mime: 'image/jpeg', q: 0.5, label: 'jpeg/smaller' },
    { side: 2048, mime: 'image/webp', q: 0.75, label: 'webp/balanced' },
    { side: 1280, mime: 'image/jpeg', q: 0.92, label: 'jpeg/better' },
    { side: 1280, mime: 'image/jpeg', q: 0.5, label: 'jpeg/smaller' },
    { side: 1280, mime: 'image/webp', q: 0.75, label: 'webp/balanced' },
  ];

  const canvases = new Map();
  const rows = [];
  for (const cell of CELLS) {
    if (!canvases.has(cell.side)) canvases.set(cell.side, cell.side >= Math.max(SRC_W, SRC_H) ? src : scaled(cell.side));
    const c = canvases.get(cell.side);
    const out = await encode(c, cell.mime, cell.q);
    rows.push({
      side: cell.side,
      px: c.width * c.height,
      label: cell.label,
      q: cell.q ?? null,
      got: out ? out.type : null,
      fellBack: out ? out.type !== cell.mime : null,
      kb: out ? Math.round(out.bytes / 1024) : null,
      ms: out ? out.ms : null,
    });
  }
  log('source', { W: SRC_W, H: SRC_H, px: SRC_W * SRC_H });
  for (const row of rows) log('encode', row);

  // The two comparisons the plan turns on, computed here so the answer is not read off a table
  // by eye: (a) lossless WebP vs PNG at the same resolution, (b) each resolution step.
  const at = (side, label) => rows.find((x) => x.side === side && x.label === label);
  const pct = (a, b) => (a && b && a.kb ? Math.round((1 - b.kb / a.kb) * 1000) / 10 : null);
  log('losslessGain_pct', {
    full: pct(at(4032, 'png/lossless'), at(4032, 'webp/lossless')),
    half: pct(at(2048, 'png/lossless'), at(2048, 'webp/lossless')),
  });
  log('downscaleGain_pct', {
    jpeg_4032_to_2048: pct(at(4032, 'jpeg/better'), at(2048, 'jpeg/better')),
    jpeg_4032_to_1280: pct(at(4032, 'jpeg/better'), at(1280, 'jpeg/better')),
    webp_4032_to_2048: pct(at(4032, 'webp/balanced'), at(2048, 'webp/balanced')),
  });
  log('levelGain_pct', {
    jpeg_better_to_smaller: pct(at(4032, 'jpeg/better'), at(4032, 'jpeg/smaller')),
  });

  r.measuredEveryCell = rows.every((x) => typeof x.kb === 'number' && x.kb > 0 && !x.fellBack);
  r.losslessWebpSmallerThanPng = (at(4032, 'webp/lossless')?.kb ?? Infinity) < (at(4032, 'png/lossless')?.kb ?? 0);
  return JSON.stringify(r);
})()
