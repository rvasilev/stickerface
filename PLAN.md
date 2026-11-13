# StickerFace — implementation plan

Open-source, offline, no-account alternative to Ashampoo Face Blur.
Hide faces in photos with an emoji sticker, a blur patch or a mosaic patch.

- **v1 (this milestone): manual placement, images only.**
- **v2: face detection (MediaPipe BlazeFace) + auto-place.**
- **No video.** Out of scope permanently (decided 2026-11-13).

Repo: `rvasilev/stickerface` · Site: `https://rvasilev.github.io/stickerface/` · License: MIT

## Why this shape

The detector already exists open source (`ORB-HD/deface`, MIT, 1.6k★) and the
paid tool's #1 complaint is that it *refuses to open photos where it finds no
face*. So v1 is deliberately detector-free: it always works, on any photo, with
no model download and no network. Detection is an accelerator added in v2, never
a prerequisite.

## Architecture

Static site, **no bundler, no build step, no backend, no network at runtime**.

```
stickerface/
  index.html          # single page
  css/style.css
  js/
    app.js            # bootstrap: wires UI + canvas + store
    store.js          # state + command-pattern undo/redo
    geometry.js       # PURE. normalized<->pixel, hit-test, handles, rotate
    render.js         # draws base image + each sticker (emoji/custom/blur/mosaic)
    export.js         # full-resolution composite -> Blob (PNG/JPG)
    emoji.js          # bundled sticker catalogue (manifest, GENERATED)
    ui.js             # DOM wiring: toolbar, layer list, picker, selection chrome
  assets/emoji/       # curated Twemoji SVGs (CC-BY 4.0) + ATTRIBUTION.md
  scripts/fetch-emoji.mjs   # deterministic fetch of the curated set (dev only)
  scripts/make-fixture.py   # writes the E2E fixture photo
  scripts/e2e.sh            # self-contained acceptance gate (server + Chrome + probe)
  tests/geometry.test.js    # vitest, node env, zero DOM
  tests/store.test.js       # undo/redo, clamping
  tests/render-fallback.test.js  # SVG raster fallback regression
  tests/e2e/run.py          # CDP driver; tests/e2e/probe.js = the user journey
  tests/e2e/selection-probe.js  # selection-frame alignment (independent pixel oracle)
  tests/e2e/layout-probe.js     # preview aspect / viewport fit numbers
  docs/               # ARCHITECTURE, VERIFICATION, DEPS, AGENT-WORKFLOW
  README.md  LICENSE  PLAN.md  AGENTS.md  .nojekyll
```

**Why no bundler:** GitHub Pages serves the repo root directly; ES modules work
natively; the whole point is a tool you can `git clone` and open. A build step is
friction for zero benefit at this size.

### Data model — normalized coordinates (the one invariant that matters)

```js
// All sticker geometry is stored NORMALIZED to the image (0..1) so preview and
// a 40MP export are the same math with a different scale factor.
sticker = {
  id: "s1",
  kind: "emoji" | "custom" | "blur" | "mosaic",   // "custom" = user-supplied image
  src: "assets/emoji/1f600.svg" | "<objectURL>",  // emoji + custom kinds
  cx: 0.42, cy: 0.55,      // centre, normalized to image width/height
  w: 0.12,                 // width normalized to image WIDTH
  h: 0.08,                 // height normalized to image HEIGHT (independent axes)
  rot: 0,                  // radians, clockwise, about (cx,cy)
  z: 3,                    // paint order
  radius: 0.5,             // blur/mosaic: corner rounding, 0..0.5 of min(w,h)
  strength: 12             // blur sigma px @1x  |  mosaic block px @1x
}
```

Rules:
- Preview canvas may be downscaled (cap the long edge at 1600 px for speed);
  **export always composites at `image.naturalWidth/Height`**.
- Never store pixel coordinates in state. Convert at the render edge only.
- **A square sticker must be square in PIXELS.** `w` and `h` normalize per-axis,
  so `w === h` is only square on a square photo: on 1200×800 the default
  `w: 0.18, h: 0.18` is a 216×144 px box. Emoji/custom stickers are therefore
  created with `h = w * imgW / imgH` and drawn filling that box; the art's
  intrinsic ratio is preserved by making the box match it, never by letterboxing
  inside a box of the wrong shape.
- **The overlay must be projected with the preview scale and the canvas's own
  origin.** The selection frame, handles and hit-testing all live in CSS pixels
  over a canvas drawn at `previewScale = cssWidth / naturalWidth`; using backing
  pixels as CSS pixels (or applying the scale twice) is a bug, and the frame must
  wrap the *drawn* sticker within a few pixels — see `docs/VERIFICATION.md`,
  `tests/e2e/selection-probe.js`.

### Rendering

One **visible** `HTMLCanvasElement` (`#stage-canvas`) plus offscreen scratch
canvases for the base image and the blur/mosaic work; redrawn per interaction via
`requestAnimationFrame` (coalesce multiple events per frame). The preview canvas
is displayed with a CSS box whose aspect ratio equals the backing store's — a
mismatched box stretches the photo the user is placing stickers against (this was
a real defect; it is gated by `previewAspectPreserved`).

Per sticker, in `z` order:
- **emoji / custom** — `ctx.translate/rotate` then `drawImage` of a pre-decoded
  `ImageBitmap`; an `<img>` per frame would re-rasterise on every paint. Decoding
  goes through an `<img>` (sized, then drawn to an offscreen canvas) because
  Twemoji SVGs carry only a `viewBox` and no intrinsic size — passing the raw Blob
  to `createImageBitmap` throws `InvalidStateError`. The Blob path remains only as
  a fallback. A sticker whose bitmap is missing draws a placeholder rather than
  nothing.
- **blur** — clip to the rounded rect, then `ctx.filter = 'blur(Npx)'` and
  `drawImage(base, …)`; a box-blur scratch pass covers engines without
  `ctx.filter` (Safari < 18). Note: canvas blur bleeds at the edges — clip first,
  blur second, and inset the source rect by 2× sigma.
- **mosaic** — read the region's pixels, average per `strength`-sized block,
  write back; `imageSmoothingEnabled = false` when scaling up blocks.

### Overlay (selection chrome)

The 8 resize handles and the rotate handle are **DOM elements**, positioned over
the canvas in CSS pixels and rotated by a CSS transform about the sticker centre —
never painted into the canvas, so they cannot appear in an export. The projection
is `cssPoint = canvasRect.origin + backingPoint * previewScale` using **one**
scale factor and the canvas's own bounding rect (do not mix in the stage's
offset, and never apply the scale twice). The frame must wrap the sticker that is
actually drawn: the gate re-measures the emoji's pixels in the preview canvas and
compares (`frameMatchesStickerOnScreen`).

### Touch / mobile gesture model (decided 2026-11-13)

A phone screen is too small to both scroll the photo and manipulate stickers, so
the gesture split is explicit and testable:

| Gesture on the canvas | Meaning |
|---|---|
| **1 finger** | sticker operations: tap on empty canvas to place, drag a sticker to move, drag a handle to resize/rotate |
| **2 fingers, centroid inside the selected sticker's frame** | transform **that sticker**: pinch = scale, twist = rotate, centroid drag = move (Instagram-like) — see below |
| **2 fingers, centroid outside the frame** | scroll/pan the **image**; never adds, moves, resizes or selects a sticker |
| any finger outside the canvas | normal page scrolling (the panels, not the photo) |

The mode is decided **once, at gesture start, by the centroid of the first two
pointers** (`centroid ∈ selected sticker's rotated box` → sticker transform, else
pan), and is not re-evaluated mid-gesture. A second pointer that lands on a
*non-selected* sticker neither transforms it nor pans: it selects that sticker
(single tap) and the gesture stays inert, so a stray second finger cannot deform
something the user did not aim at. Pinch-zoom of the **image** stays backlog;
sticker pinch-scale/rotate is M6.

Rules:

- **Gesture arbitration, not last-pointer-wins.** Track active pointers on the
  canvas. Exactly one pointer → sticker mode. **A second pointer landing cancels
  any in-flight sticker gesture and returns that sticker to its geometry at
  gesture start**, then the two pointers pan the image. A gesture that *begins*
  with two fingers never enters sticker mode.
- **Pan is view state, not document state**: `view = { dx, dy }` in CSS pixels,
  applied only inside the shared projection
  (`cssPoint = canvasRect.origin + backingPoint * previewScale + view`). A pan must
  not touch sticker geometry, the selection, or the undo stack. Keep a `scale` hook
  in the same object so pinch-zoom (backlog) cannot be bolted on elsewhere.
- **Clamp the pan** so the image can never be pushed entirely out of the viewport
  (keep at least a quarter of it visible).
- **Place-on-tap must survive the gesture split**: placement happens on
  `pointerup` when the gesture stayed within ~8 CSS px of its start and was not
  cancelled by a second finger — otherwise a pan attempt drops stickers.
- `touch-action: none` stays on the canvas and its overlay only, so the page still
  scrolls everywhere else.
- The handles are touch targets too: each needs a hit area ≥ 32 CSS px and must not
  throw when driven by a touch (`resizeRect: unknown handle "undefined"` was an
  uncaught exception under touch emulation).
- Pinch-zoom of the image is **backlog**; pan alone satisfies the scroll request.

### Two-finger sticker transform (Instagram-like, M6)

Requested 2026-11-13: *"when 2 fingers are used inside the sticker sizing frame,
sticker may be zoomed and rotated (Instagram like)"*.

Applies to the **selected** sticker, whatever its kind (emoji, custom, blur,
mosaic), while both pointers' centroid sits inside its frame:

- **Scale** = `|p1 - p2| / |startP1 - startP2|` applied to the sticker's *start*
  size (never accumulated per event — accumulating drifts). Uniform in **pixels**,
  so both `w` and `h` multiply by the same `k`: a square sticker stays square.
- **Rotate** = `angle(p1 - p2) - angle(startP1 - startP2)` added to the sticker's
  *start* rotation, about the sticker centre (not the gesture centroid — otherwise
  the sticker walks away as you twist it). Snap to multiples of 15° within **4°**
  (hysteresis: keep the snapped value until the finger angle leaves the ±4° band).
- **Translate** = centroid delta, so a two-finger drag also repositions.
- **Clamp**: `k` limited so the shorter side never goes below **16 natural px** and
  never exceeds **4× the image's shorter side**; `k > 0` always (no inversion, no
  vanishing sticker). `strength`/`radius` of blur/mosaic patches are **not** scaled
  — the patch grows, the blur amount stays predictable.
- **One undo entry for the whole gesture** (like a drag): press → release is one
  command, so `Ctrl+Z` restores size, angle and position together.
- The DOM overlay must track live during the gesture (same projection as
  everything else, no second code path).

Gate: `tests/e2e/sticker-transform-probe.js` — two real CDP touch points that
start inside the placed sticker's frame (aimed at the frame's own screen box, which
is itself gated by `selection-probe`), measured from canvas pixels:
`pinchScalesSticker`, `pinchScalesUniformly`, `twistRotatesSticker`,
`twoFingerOnStickerDoesNotPanImage`, `pinchIsOneUndoStep`,
`twoFingerOutsideFrameStillPans`, `pinchClampsSize`. Rotation is read from the
sticker's yellow pixels via second-moment orientation (the pixel bbox cannot see a
90°-symmetric square's twist).

Gate: `scripts/e2e-mobile.sh` — emulated 390×844 touch device, real CDP touch
events, verified from canvas pixels (`tests/e2e/mobile-probe.js`): tap places, one
finger moves the sticker without moving the image, two fingers pan the image
without moving/resizing/adding a sticker, and a second finger cancels a drag.

### Remove a sticker (double-click / double-tap)

Requested 2026-11-13. Rule:

- **Desktop:** a real browser double-click (`dblclick`, i.e. two clicks within the
  platform threshold) on a sticker removes it. A single click only selects.
- **Touch:** a double-tap — two taps within **350 ms**, less than **25 CSS px**
  apart, with no second finger involved — removes the sticker under the point.
  The double-tap must be decided by the same gesture router as the one-finger/two-
  finger split, not by a separate listener that can race it.
- Removal is **one undoable command** (a single `Ctrl+Z` brings it back), it hits
  only the **topmost** sticker under the point (hit-test in reverse z), and it
  clears the selection (frame and handles hidden) if the removed sticker was
  selected. The layer list loses exactly that row.
- **Double-clicking empty canvas must leave no sticker behind.** Placement is on
  `pointerup` (see the touch model), so the first click may place one and the
  second is a double-click on it — the net effect must be zero stickers *and* an
  undo stack that is not corrupted (undoing twice returns to the same state).
  A double-click on empty canvas with no pending placement does nothing.
- Do not implement this with a CSS `ondblclick` attribute or a bare synthetic
  `dblclick` test: the handler must respond to the browser's own click sequence.

Gate: `tests/e2e/delete-probe.js` — real CDP mouse input (`clickCount` 1 then 2)
plus a real `Ctrl+Z`, measured from canvas pixels:
`singleClickKeepsSticker`, `doubleClickDeletesSticker`,
`doubleClickDeletesOnlyTheClickedSticker`, `deleteClearsSelection`,
`undoRestoresDeletedSticker`, `doubleClickDeletesSecondSticker`,
`doubleClickOnEmptyLeavesNoSticker`, `twoStickersPlaced`.

### Export

`export.js`: fresh canvas at natural size → draw base → draw each sticker with
the pixel scale factor → `canvas.toBlob(mime, quality)` → download as
`<basename>_stickerface.<ext>`.

- PNG default (lossless, alpha); JPEG at `quality 0.92` as an option.
- Canvas re-encode **drops EXIF/GPS automatically** — surface this in the UI as a
  privacy feature ("metadata removed on export").
- **Export gates on "an image is loaded" — never on the whole asset catalogue.**
  The original spec said "gate on a `ready` flag" for all emoji bitmaps; one
  undecodable file then disabled export entirely, which is the same failure class
  as the competitor refusing to open a photo. A missing bitmap degrades to a
  placeholder and is reported in `#export-status`. (No font dependency: the
  stickers are SVG/bitmap assets, not glyphs — the `document.fonts.ready` clause in
  the first draft was wrong and is removed.)

### Interaction (v1)

| Action | Binding |
|---|---|
| Add sticker | click on canvas with a tool active (emoji / blur / mosaic) |
| Select | click a sticker |
| Move | drag body; arrows nudge 1 **preview** px (Shift = 10 preview px), converted to natural px |
| Resize | 8 handles; corners keep ratio, `Shift` frees it |
| Rotate | handle above top-centre; snap to 15° with `Shift` |
| Delete | `Delete`/`Backspace`, the layer-list ✕, **or double-click / double-tap the sticker** |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Shift+Z`, toolbar buttons |
| Bring forward / back | `[` / `]` |

Open interaction issues (spec debt, not yet fixed):

- **Nudge granularity degrades on large photos.** "1 preview px" is ~1.3 natural
  px at preview scale 0.77, but on a 40 MP image one preview px is tens of natural
  px, so arrow-key placement gets coarse exactly where precision matters. Decide:
  nudge in natural px (with Shift as the coarse step) or allow sub-preview-pixel
  steps. Nothing gates this today.
- **Zoom (`+` / `-` / `0`) is NOT implemented.** It appeared in the first draft of
  this table and was never built; removed from the table as backlog. Add it with a
  gate if it is wanted, because zoom re-opens the overlay projection
  (`cssPoint = origin + backingPoint * previewScale` is the only place it may live).

Undo = command pattern in `store.js`: each mutation pushes `{undo(), redo()}`;
cap the stack at 100; coalesce a drag into ONE entry (push on pointerup, not per
pointermove).

### Batch — "same layout next photo"

After exporting, keep the sticker geometry and offer **"apply to next photo"**:
the new image loads with the same normalized layout, adjusted for aspect-ratio
drift (only if the images differ by >5% in aspect, warn). This is the single
highest-value manual-mode feature: a family photo set is 10 near-identical shots.

## v2 — detection (not in this milestone)

- MediaPipe Tasks Vision `FaceDetector` (`blaze_face_short_range.tflite`,
  Apache-2.0, ~230 KB), **self-hosted** from `assets/models/` — no CDN, or the
  "nothing leaves your machine" claim is false.
- Auto-place on every detection; `expand` slider (default +20%) to cover chin/ears.
- Detections stay *adoptable* (click a box → becomes an editable sticker) and
  *ignorable* (drop an ignore region for a false positive) — the manual
  affordances are never removed.
- Detection is opt-in and lazy: the model is fetched only when the user clicks
  "Detect faces".

## Milestones

| # | Deliverable | Gate | State |
|---|---|---|---|
| **M0** | repo, README, LICENSE, index.html canvas, image upload, draggable emoji sticker | upload → drag → export PNG | **done** |
| **M1** | handles + rotate, undo, layer list, blur + mosaic kinds, full-res export, keyboard | `npm test` + browser probe green | **done** (after the decode fix) |
| **M2** | emoji picker (curated Twemoji set), custom image sticker, "same layout next photo" | probe + manual batch of 3 photos | **done**; batch flow needs a manual pass |
| **M3** | browser acceptance gate (upload → place → export, pixels asserted), CI on push | `npm run e2e` = 15/15 + `selection-probe` 6/6, exit 0 | **done**, except CI |
| M4 (v2) | detection, auto-place, adopt/ignore | detection never required for export | not started |
| **M5** | touch model: 1 finger = sticker ops, 2 fingers = pan the image; second finger cancels a drag | `scripts/e2e-mobile.sh` = 9/9, desktop probes still green | **done** (2026-11-13; the probe's 10th criterion, double-tap delete, belongs to the next item) |
| **M6** | two-finger sticker transform inside the frame: pinch scale, twist rotate, centroid move (Instagram-like) | `tests/e2e/sticker-transform-probe.js` = 8/8, M5 gate still green | **spec'd, not started** |

M3 shipped as a hand-rolled CDP harness rather than Playwright: no Playwright is
installed on the build box and the Hermes CDP tool refuses loopback URLs, so
`tests/e2e/run.py` drives headless Chrome over the DevTools WebSocket directly.
It is a real browser, a real file upload and real pixel assertions — see
`docs/VERIFICATION.md`. Adding Playwright later is fine; do not delete the probe.

## Status log

- **2026-11-13** — v1 built (delegated to a coding agent). Unit gate green at 48/48.
- **2026-11-13** — browser verification found two real defects the unit tests could
  not see: (a) all 76 Twemoji SVGs failed to decode (`createImageBitmap` on a
  `viewBox`-only SVG throws `InvalidStateError`), which left **export permanently
  disabled**; (b) `CanvasApp` was constructed twice — 152 picker buttons for 76
  emoji and doubled listeners, masked by each instance re-rendering the layer list
  from its own store. Both fixed (decode through `<img>` + offscreen canvas, export
  gated on "image loaded" with a degraded-asset fallback, single init), regression
  test added.
- **2026-11-13** — a screenshot of the running app (not a test) found defect (c):
  the preview canvas CSS box was 875×778 for a 1200×800 backing store, stretching
  the photo ~33%, with the stage 1594 px tall in a 913 px viewport. Fixed
  (distortion 1.0005, portrait included); gated by `previewAspectPreserved` +
  `canvasFitsViewport`. Main probe 15/15.
- **2026-11-13** — user-reported defect (d): the selection frame did not wrap the
  emoji — measured +45 px right, +39 px down, 106×34 px oversized. The emoji itself
  is drawn exactly where clicked (centre error 0.00). Two causes: the overlay was
  projected in backing pixels instead of CSS pixels (scale not applied / wrong
  origin), and the default sticker box is non-square in pixels while square art is
  drawn inside it. Fix in progress under `stickerface-frame`; gated by
  `tests/e2e/selection-probe.js` (frame vs the emoji's own pixels, before and after
  a real handle drag). Lesson: the first version of that probe "passed" resize
  because synthetic pointer events cannot drive handles — handle drags must use
  real CDP input.
- **2026-11-13** — user-reported defect (e): on a phone there was no way to scroll the
  photo without moving a sticker. The gesture model is now implemented (M5): one
  finger works the stickers, two fingers pan the image, a second finger cancels an
  in-flight drag, and placement moved to `pointerup` (8 px threshold) so a pan
  attempt cannot drop a sticker. Gate `scripts/e2e-mobile.sh` **9/9** (was 7/9: two
  fingers moved the *sticker* +59.8 px instead of panning by 0.0). Root cause of the
  handle exception in the same pass: `setPointerCapture` on touch pointers
  re-targeted the second finger's moves away from the handle, leaving
  `ev.target.dataset.handle` undefined.
- Recurring lesson, recorded in `AGENTS.md` and `docs/AGENT-WORKFLOW.md`: a green
  unit suite is not the app working.

## Acceptance criteria for M1 (what "done" means)

Kept as written (they are the original contract); the ones the harness actually
enforces today are noted, and the rest are manual.

1. A static server serves the page with zero console errors and **no network
   requests after the initial asset load**. *(enforced: the probe fails on any
   console error or uncaught exception; `no-network` is manual.)*
2. Upload a 40 MP JPEG → preview stays interactive; export returns a PNG with the
   same dimensions as the source and no EXIF. *(dimensions + no-EXIF enforced at
   1200×800; the 40 MP case is manual.)*
3. Place emoji + blur + mosaic stickers; each survives export at full resolution in
   the same relative position. *(enforced: `stickerAreaChanged` +
   `untouchedAreaIntact`; per-kind positioning is spot-checked, not exhaustive.)*
4. Undo/redo restores state across ≥20 operations, including one whole drag.
   *(enforced in `tests/store.test.js`; one-drag-one-entry is unit-tested, a real
   drag's undo is manual.)*
5. `npm test` passes: geometry round-trips at 640×480, 1920×1080, 8000×5000;
   hit-test selects the topmost sticker and respects rotation; handle maths stable
   at 0/90/180/270°. *(enforced; 58 tests as of 2026-11-13.)*
6. Keyboard-only workflow: place a sticker, nudge, rotate, delete, undo.
   *(partially enforced: nudge + undo are in the probe; delete/rotate are manual.)*
7. Works in Chromium and Firefox; Safari best-effort. *(Chromium enforced by the
   harness. **Firefox has never been run** — the harness is Chrome-only, so this
   criterion is unverified, not satisfied.)*

Additional criteria added after real defects (all enforced):
preview aspect ratio preserved, preview fits the viewport, the selection frame
wraps the drawn sticker, the frame follows a real handle drag, no duplicate
initialisation.

## Testing

- **Unit (vitest, node env, no DOM)** — `geometry.js`, `store.js`, and the SVG
  raster fallback. Everything geometric must be testable without a browser; that is
  why it is a separate pure module.
- **Acceptance (real headless Chrome over CDP, M3)** — `scripts/e2e.sh` runs
  `tests/e2e/probe.js` (15 criteria: upload → place → nudge → undo → export, with
  pixel assertions) and `tests/e2e/selection-probe.js` (6 criteria: frame vs the
  emoji's own pixels, before and after a real handle drag). Handle drags must use
  CDP `Input.dispatchMouseEvent` — synthetic pointer events cannot drive them.
- **Diagnostic probes** — `layout-probe.js` (preview box vs backing aspect, stage
  vs viewport, picker thumbnails) reports numbers for triage; it is not a gate.
- **Manual checklist** — 40 MP photo; EXIF-rotated JPEG; non-Latin filename;
  400 % display scaling; Firefox and Safari (unverified today). Video is out of
  scope, so an HEVC `.mov` is expected to fail as a photo input.

## Risks

- **If manual placement is slow, the manual-first plan fails.** Mitigation:
  click-to-drop, arrow nudge, and "same layout next photo" are M0/M1/M2, not later.
- Canvas emoji rendering is OS-dependent → always bundled SVG assets, never a
  `font-family: emoji` hit.
- Twemoji graphics are **CC-BY 4.0** → `assets/emoji/ATTRIBUTION.md` + a credit
  line in the README and the About panel. (OpenMoji, CC BY-SA 4.0, is the
  share-alike alternative — rejected to keep the project MIT-only.)
- GPL contamination: do **not** add `@ffmpeg/core` (published build is
  `--enable-gpl`, libx264/x265 → GPL-2.0-or-later). Not needed: no video.
- Large images on mobile Safari → cap the preview, composite at full res only on
  export.
