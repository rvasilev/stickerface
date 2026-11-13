# Architecture

Static site. No bundler, no build step, no backend, no network after first load.
GitHub Pages serves the repo root; `index.html` loads one ES module and everything
else is imported from there.

```
index.html              markup only: toolbar, stage, canvas, right panel, About
css/style.css           all styling; no external fonts
js/ui.js                entry (index.html loads this): CanvasApp — DOM wiring,
                         pointer state machine, selection chrome (8 resize
                         handles + rotate handle), layer list, the
                         selected-sticker pad, the layers section
                         (`<details>`/`<summary>`) and the row drag grip
js/store.js             Store: state + command-pattern undo/redo + subscribe().
                         `moveTo(id, index)` is the one reorder path — 0 = bottom —
                         and the row buttons, `[`/`]` and the grip drag all ride it
js/geometry.js          PURE maths: px/norm, stickerRect, handlePositions,
                         hitTest, resizeRect, rotateTo, angleDelta, snapAngle,
                         nudge
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

`compositeCanvas()` builds a fresh canvas at `naturalWidth × naturalHeight` when the
browser can allocate it, and at the largest capped size that fits when it cannot
(Safari's canvas-area limit is 16.7M px before iOS 18 and 67.1M px after; everything else
is assumed to be 268M). It paints base + stickers at the composite's own scale — the
geometry is normalized, so a reduced export places stickers identically, just at lower
resolution — and reports what it did (`compositeSize`, `cappedExportNote()`) so the UI can
say it. Because the image is re-encoded through a canvas, **EXIF/GPS metadata is dropped** —
a privacy feature, stated in the UI and asserted in the E2E probe (no `APP1` segment in
the JPEG).

Export is gated on "an image is loaded", never on the whole asset catalogue being
decoded. A missing emoji bitmap degrades to a drawn `<img>` or placeholder and is
reported in `#export-status`; it must never block the export.

## Layer list

The Layers panel is a **descending** render of the store's ascending-z array:
only `_syncLayerList`'s loop direction changes, so the row the user sees at the
top is the sticker painted on top. `_updateLayerTitles` maps rows by id and is
order-agnostic. The list lives inside a `<details open>`/`<summary>` — collapse
is the platform's job, no JS — and the rows are hidden by the closed details,
never destroyed, so selection and state survive a collapse.

Every panel section (Emoji, Strength, Layers) is the same `<details>`/`<summary>`
shape: one platform pattern, no bespoke disclosure JS, no `aria-expanded` to keep
in sync. The emoji grid is the tallest thing in the panel (76 tiles), so it is
capped and scrolls in place — that, plus real `[hidden]` support, is what keeps
the list and the pad reachable without scrolling the panel. **Author rules that
set `display` beat the UA's `[hidden] { display: none }`**: the three selectors
that do so in this sheet (`:56`, `:117`, `:399` for `.file-btn`, `.toolbar button`
and `.panel section`) carry `:not([hidden])` rather than an `!important`, and any
new rule that sets `display` on a hideable element must do the same.

Each row's first child is a **grip** (`<span class="grip" aria-hidden="true">⠿</span>`):
decorative, not a button — the accessible reorder path stays the ⤴/⤵ buttons and
`[`/`]`. `touch-action: none` is on the grip only, so a grip drag cannot scroll
the panel while a tap elsewhere in the row still selects. During a drag the row
is translated and a 2px insertion line marks the slot; the slot counts how many
of the *other* rows the pointer has passed (edge-based, so a drop exactly on a
row's centre counts as passed it), and the store commits once, at drop. The
visual→array conversion (`arrayIndex = ordered.length - 1 - visualIndex`) lives
only in the drop handler — mixing visual order with z order anywhere else is how
this feature breaks.

## Undo/redo

Command pattern in `store.js`: each mutation pushes `{undo, redo}` closures onto a
stack capped at 100. A pointer drag is committed **once**, on pointerup — not per
`pointermove` — so one drag is one undo step. `Store.subscribe(fn)` drives the UI;
the store never touches the DOM.

`moveTo(id, index)` is the single reorder path: array index 0 is the bottom
(lowest z), `z` is renumbered to `i + 1` for every sticker after the splice so
array order and paint order cannot diverge, and an out-of-range or same-index call
is a no-op that pushes no undo entry. `raise`/`lower` are thin callers of it; the
layer-row ⤴/⤵ buttons, `[`/`]`, and the grip drag all go through the same call.

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
