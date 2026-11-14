# Architecture

Static site. No bundler, no build step, no backend, no network after first load.
GitHub Pages serves the repo root; `index.html` loads one ES module and everything
else is imported from there.

```
index.html              markup only: toolbar, stage, canvas, right panel, About
css/style.css           all styling; no external fonts
js/ui.js                entry (index.html loads this): CanvasApp — DOM wiring,
                         pointer state machine, selection chrome (8 resize
                         handles + rotate handle, reachable only in Resize mode),
                         the selected-sticker pad with its Move/Resize row and the
                         hint text that follows the mode, the layers section
                         (`<details>`/`<summary>`) and the row drag grip.
                         `editMode` is view state beside `view`/`_pan`: it is never
                         in the store, so switching it cannot touch geometry, the
                         selection or the undo stack
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

`swapEmoji(id, src)` is the single artwork-swap path, and it exists because
`move(id, { src })` does **not** work: `_applyGeom` writes only the geometry keys
and `_geomChanged` returns false for a src-only patch, so `move` would emit a
`change`, report success and change nothing — silently. It refuses a non-emoji
kind (a blur has no artwork), a missing/empty src and the emoji already in place,
leaving no undo entry behind. Geometry and `z` are untouched by design: every
Twemoji is square, so a sticker's box stays valid across a swap.

It emits **`swap`**, not `change`. `change` is the geometry fast path, where
`onStateChange` calls `_updateLayerTitles()` — which refreshes the `title` TOOLTIP
only. A layer row's VISIBLE text is the emoji's name, so a swap emitting `change`
would leave the row naming the old emoji while the canvas showed the new one.
`swap` is outside the `change`/`history` pair, so it takes the `_syncLayerList()`
branch. (Note the gate: `emoji-swap-probe.js` drives `swapEmoji` directly for
this, because a picker click also emits a `setTool` event that rebuilds the list
regardless — masking the difference.)

`lastPickedSrc` has two meanings and both must keep working: it is "armed for the
next drop" (a canvas click places it), and `_syncPickerSelection` prefers the
SELECTED sticker's emoji over it, so the highlight points at what an edit would
change rather than at an unrelated emoji. A refused swap — a blur selected, or the
same emoji — still updates `lastPickedSrc`.

## Two-finger sticker transform: one decision, start-relative maths

The gesture split is `centroid ∈ selected sticker's rotated box → transform it,
else pan the photo`, and the mode is decided ONCE, when the second pointer lands
(`_tryEnterStickerTransform`, called from BOTH the canvas and the handle
two-pointer branches — a handle press stops propagation, so the canvas branch
never sees it). It is never re-evaluated mid-gesture: a transform cannot become a
pan or vice versa, which is what makes the gesture predictable.

Every frame is derived from the gesture's START snapshot plus the current
pointers — a ratio of ratios, never an accumulation:

- scale = |p1−p2| / |start p1−p2|, applied to the START size, so both axes get
  the same k and a square stays square. `clampStickerScale` floors the shorter
  side at 16 image px (and caps it at 4× the image's shorter side) so k stays
  positive: a hard pinch-in cannot vanish or invert the sticker.
- rotation = the shortest signed angle delta added to the START rotation, about
  the sticker's own centre. Projecting the pointer's absolute angle would snap the
  sticker on the first move; rotating about the gesture centroid would make it
  walk away as you twist.
- translate = the centroid delta, converted from client px into natural px, so a
  two-finger drag repositions without changing size.

`inStickerBox` is the single definition of "on this sticker" (shared with
`hitTest`); `_endStickerTransform` commits through the same `beginDrag`/`commitDrag`
pair a one-finger drag uses, so press→release is ONE undo entry.

**The trap that cost the most:** a touch pointer is implicitly captured by
whatever received its `pointerdown`. When a pinch's fingers land on the frame's
handles, every move is delivered to the HANDLE — so `_applyStickerTransform` has
to be driven from the window-level listener as well, or the transform is entered
and then receives no updates while `dataset.transforming` cheerfully reads `1`.

## View state: three input adapters, one function

`this.view` (`{dx, dy, scale}`, CSS px, per-photo, reset by `fitCanvas()`) is the
only zoom/pan state, and it is deliberately NOT in the store — the store is the
document, the view is how you are looking at it.

All three inputs go through `focalZoomView`, whose contract says *"distances
unchanged reduces to a plain pan"*:

- **Two-finger pinch/pan** — the original caller, anchors on the gesture centroid.
- **Mouse wheel** — `focalZoomView(view, cursor, cursor, 1, k, w, h)`: anchor and
  cursor are the same point, so it is a pure focal zoom. Ctrl/Cmd needs no branch —
  a trackpad pinch arrives as ctrl+wheel, so that case is free.
- **Middle-button drag** — the same `_applyPanMove` the touch gesture uses, with one
  pointer so the focal distance never changes; the result is a translation through
  the same clamp.

Writing separate mouse maths is how the mouse view would silently disagree with the
touch one, and the frame projection reads the same `view`, so the frame would be the
first visible casualty. `wheelZoomFactor(deltaY, deltaMode)` lives in `geometry.js`
because every projection does (node can unit-test it) and because CDP cannot carry a
`deltaMode` — the line/page normalisation is only coverable in vitest.

Two deliberate gaps, recorded in `docs/VERIFICATION.md`: no keyboard zoom (Ctrl +/-
belongs to the browser) and no pan affordance on a middle-button-less trackpad.

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
