# Architecture

Static site. No bundler, no build step, no backend, no network after first load.
GitHub Pages serves the repo root; `index.html` loads one ES module and everything
else is imported from there.

```
index.html              markup only: toolbar, stage, canvas, right panel, About
css/style.css           all styling; no external fonts
js/ui.js                entry (index.html loads this): CanvasApp — DOM wiring,
                        pointer state machine, selection chrome (8 resize
                        handles + rotate handle), layer list
js/store.js             Store: state + command-pattern undo/redo + subscribe()
js/geometry.js          PURE maths: px/norm, stickerRect, handlePositions,
                        hitTest, resizeRect, rotateTo, nudge
js/render.js            paint(), requestDraw() (rAF-coalesced), emoji bitmap
                        decoding with an SVG fallback, blur + mosaic effects
js/export.js            capped-canvas export guard (maxCanvasPixels/exportSize,
                        pure), compositeCanvas() at the largest size that fits,
                        exportImage(), download
js/emoji.js             GENERATED manifest of the bundled Twemoji set
assets/emoji/*.svg      76 Twemoji SVGs (CC-BY 4.0) + ATTRIBUTION.md
scripts/fetch-emoji.mjs regenerates the set (pinned version) and the manifest
scripts/make-fixture.py generates the E2E fixture photo
tests/*.test.js         vitest unit tests
tests/e2e/run.py        CDP driver for the browser acceptance probe
tests/e2e/probe.js      the probe itself (user journey → booleans)
```

## Data model

```js
sticker = {
  id: 's1',
  kind: 'emoji' | 'blur' | 'mosaic',
  src: 'assets/emoji/1f600.svg',  // emoji kind only
  cx: 0.42, cy: 0.55,             // centre, NORMALIZED to image width/height
  w: 0.12, h: 0.12,               // size, normalized per axis (non-square is fine)
  rot: 0,                         // radians, clockwise, about (cx, cy)
  z: 3,                           // paint order, higher = on top
  radius: 0.5,                    // blur/mosaic corner rounding, 0..0.5
  strength: 18                    // blur sigma px | mosaic block px, at full scale
}
```

**The load-bearing invariant: everything is normalized (0..1).** Pixel values are
never stored. `px(v, span)` / `norm(v, span)` convert at the render edge only, so
the preview and a 40-megapixel export are the same maths with a different scale
factor. Round-trip error is < 1e-9 (asserted in `tests/geometry.test.js`).

## Render pipeline

One visible canvas, redrawn on `requestAnimationFrame` (a burst of `pointermove`
events coalesces into a single paint). The preview canvas may be downscaled
(`PREVIEW_LONG_EDGE = 1600`); the export canvas never is.

Per sticker, in `z` order:

- **emoji** — `ctx.translate/rotate` + `drawImage` of a pre-decoded `ImageBitmap`.
  Bitmaps are decoded once at startup; an `<img>` per frame would re-rasterise the
  SVG on every paint. Decoding goes through an `<img>` + offscreen canvas because
  Twemoji SVGs carry only a `viewBox` and no intrinsic size (see AGENTS.md
  pitfalls); the raw-Blob path is kept only as a fallback.
- **blur** — clip to the rounded rect, set `ctx.filter = 'blur(N * scale)px'`, draw
  the base image. The source rect is inset by 2× sigma because canvas blur bleeds
  at the edges of the drawn region.
- **mosaic** — `getImageData` the region, average each `strength * scale` block,
  write back with `imageSmoothingEnabled = false`.

Selection chrome (handles) is **DOM**, positioned over the canvas by JS — not
painted into it, so it never appears in the export.

## Export

`compositeCanvas()` builds a fresh canvas at `naturalWidth × naturalHeight`, paints
base + stickers at `scale = 1`, then `canvas.toBlob()`. Because the image is
re-encoded through a canvas, **EXIF/GPS metadata is dropped** — a privacy feature,
stated in the UI and asserted in the E2E probe (no `APP1` segment in the JPEG).

Export is gated on "an image is loaded", never on the whole asset catalogue being
decoded. A missing emoji bitmap degrades to a drawn `<img>` or placeholder and is
reported in `#export-status`; it must never block the export.

## Undo/redo

Command pattern in `store.js`: each mutation pushes `{undo, redo}` closures onto a
stack capped at 100. A pointer drag is committed **once**, on pointerup — not per
`pointermove` — so one drag is one undo step. `Store.subscribe(fn)` drives the UI;
the store never touches the DOM.

## Why this shape

- **No bundler:** the app is ~1 500 lines; GitHub Pages serves the source directly.
  A build step would be friction for zero benefit and would make the code less
  inspectable — which matters for a privacy tool people are asked to trust.
- **No framework:** the state machine is small and explicit; a framework would add
  a dependency to a project whose selling point is that it has none.
- **Normalized geometry:** the only way preview and full-resolution export can be
  guaranteed to agree.
- **Detector-free v1:** the competitor's top complaint is refusing to open a photo
  when detection fails. Detection (v2) is an accelerator, never a prerequisite.
