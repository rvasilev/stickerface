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
- **No contact may stay tracked after it lifts.** After every gesture ends, the live
  pointer count must be zero. The count is exposed as `canvas.dataset.pointers` so a
  leak is measurable: a stale entry makes the next one-finger tap look like the
  second finger of a pan, which silently kills tap-to-place (observed after a
  cancelled drag: tap 2 placed, tap 3 did nothing).
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
`tests/e2e/tap-after-pan-probe.js` localises pointer-bookkeeping regressions
(place → pan → cancelled drag → tap must still place, and the pointer count must
return to zero).

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

### Two-finger image pinch-zoom (M7)

Requested 2026-11-13: *"image should be able to zoom with two fingers pinch"*.
Supersedes the earlier "pinch-zoom stays backlog" note.

Two fingers whose centroid is **outside** the selected sticker's frame pan **and
zoom the photo** (the same gesture as M5's pan, now with scale):

- `view = { dx, dy, scale }` — one object, `scale: 1` = fit-to-viewport, clamped to
  **1 … 8**. Zoom about the **gesture centroid**: the image point under the centroid
  must not move (focal zoom). Compute from the gesture's start distance and start
  scale (`k = dist / startDist`, `scale = startScale * k`), never accumulate per
  event, and derive `dx/dy` so the focal point stays fixed.
- Clamp the offsets so the photo cannot be pushed out of view: when
  `scale * canvasCSSWidth >= canvasCSSWidth` clamp `dx` to
  `[canvasW - scaledW, 0]`, otherwise centre that axis (same for `y`).
- **Zoom is view-only.** It must never touch sticker geometry (normalized
  coordinates stay as they are), never enter the undo stack, and never change the
  export: the exported file is composited at natural size from normalized state, so
  the sticker's relative position in the export is identical at 1× and at 5×.
- The one projection carries the scale:
  `cssPoint = canvasRect.origin + backingPoint * previewScale * view.scale + view.dx/dy`.
  The selection frame, handles and hit-testing all use it, so the frame still wraps
  the sticker at any zoom, and a sticker drag at 4× moves it by the right amount.
- Reset to fit when a new photo loads (`fitView()`); an explicit "reset zoom" button
  is backlog. A pinch whose centroid is inside the sticker frame is M6's sticker
  transform and must not change the view.

Gate: `tests/e2e/zoom-probe.js` (390×844 touch device, real CDP touch, measured
from canvas pixels and from the exported PNG): `pinchZoomsImage`,
`pinchZoomsAboutFocalPoint`, `pinchClampsZoomRange`, `pinchClampsMinZoom`,
`selectionFrameTracksZoom`, `zoomDoesNotAddStickers`, `stickersStillDrawnAtZoom`,
`exportUnaffectedByZoom`, `pointersCleanAfterZoom`. Baseline before the work:
**3/9** — two fingers only pan (zoomRatio 1.00), and the criteria that would pass
vacuously are guarded on the zoom having actually happened.

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
| Nudge / size (selected) | the panel's **Selected sticker** pad — 4 arrows, a 1 px / 10 px step, size −/+ (inherits the nudge-granularity debt below) |
| Restack (Layers) | drag a row by its `⠿` grip to move it up/down the stack; ⤴/⤵ and `[`/`]` move one step; the section collapses via `<details>` |

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

## Disabled in v1 (2026-11-13)

Per user request, these controls are **hidden but implemented** (a layout carrying a
blur patch still renders and exports; removing one `hidden` attribute in
`index.html` restores each):

| Control | Element | Guard required in `js/ui.js` |
|---|---|---|
| Blur tool | `#tool-blur` | refuse to activate while hidden |
| Mosaic tool | `#tool-mosaic` | refuse to activate while hidden |
| Strength / corner-radius sliders | `#tool-settings` | hidden with the tools |
| About button + panel | `#btn-about`, `#about-panel` | hidden |
| "Use my own image" | `#custom-label`, `#custom-input` | refuse to load a custom file while hidden |

- The CC-BY attribution that lived only in the About panel moved to a visible page
  footer (`footer.footer`) — the licence obligation is not optional.
- The probe asserts reachability (`offsetParent === null`); once the ui.js guards
  land it also asserts that a programmatic click on a hidden tool does not switch
  the tool and a programmatic `change` on the hidden file input adds no sticker
  (`toolCannotBeActivatedWhileHidden`, `customStickerCannotBeLoadedWhileHidden`).

## Milestones

| # | Deliverable | Gate | State |
|---|---|---|---|
| **M0** | repo, README, LICENSE, index.html canvas, image upload, draggable emoji sticker | upload → drag → export PNG | **done** |
| **M1** | handles + rotate, undo, layer list, blur + mosaic kinds, full-res export, keyboard | `npm test` + browser probe green | **done** (after the decode fix) |
| **M2** | emoji picker (curated Twemoji set), custom image sticker, "same layout next photo" | probe + manual batch of 3 photos | **done**; batch flow needs a manual pass |
| **M3** | browser acceptance gate (upload → place → export, pixels asserted), CI on push | `npm run e2e` = 26/26 + the other green probes, exit 0; CI workflow on push | **done** (CI added 2026-11-13) |
| M4 (v2) | detection, auto-place, adopt/ignore | detection never required for export | not started |
| **M5** | touch model: 1 finger = sticker ops, 2 fingers = pan the image; second finger cancels a drag | `npm run e2e:mobile` = 12/12 (incl. double-tap delete + zero leaked contacts), desktop probes green | **done** (2026-11-13) |
| **M6** | two-finger sticker transform inside the frame: pinch scale, twist rotate, centroid move (Instagram-like) | `tests/e2e/sticker-transform-probe.js` = 8/8, M5 gate still green | **spec'd, not started** |
| **M7** | two-finger image pinch-zoom (focal, clamped, view-only) | `tests/e2e/zoom-probe.js` = 9/9; export identical at any zoom | **done** (2026-11-14, three delegated rounds) |
| **M8** | selected-sticker pad: nudge arrows + a 1 px/10 px step + size −/+, so a sticker too small to grab can still be moved and resized | `tests/e2e/pad-probe.js` = 7/7, every M1–M7 gate green | **done** (2026-11-14, delegated; the gate itself corrected once) |

M3 shipped as a hand-rolled CDP harness rather than Playwright: no Playwright is
installed on the build box and the Hermes CDP tool refuses loopback URLs, so
`tests/e2e/run.py` drives headless Chrome over the DevTools WebSocket directly.
It is a real browser, a real file upload and real pixel assertions — see
`docs/VERIFICATION.md`. Adding Playwright later is fine; do not delete the probe.

## Status log

- **2026-11-14** — UI/UX polish, gate-first. `polish-probe.js` was written RED
  (desktop 3/9, phone 3/4) against measured defects, then the app was fixed until
  it was green (desktop 9/9, phone 4/4) with no other gate moving. What it caught:
  six of nine `[hidden]` elements rendered because author `display` rules beat the
  UA's `[hidden]` rule; the panel overflowed by ~1030 px (v1-off About panel,
  690 px, plus a 97 px settings section); the full 76-tile emoji grid made the
  panel 850 px of wall; two pad-group controls were under 32 px; the nudge cluster
  read ↑ ← ↓ →; and `1px` in the KEYS legend fought `1 px` in the pad. Fixed with
  `:not([hidden])` on the three selectors that set `display`, `<details>` sections
  for Emoji/Strength/Layers (platform feature, zero JS), a capped in-place
  scrolling grid, `min-height: 32px` on the summaries, a labelled pad, and one
  number format. Two plan items were DROPPED because the gate measured them as
  already-correct: the heading treatment was uniform, and the phone stage already
  took 50% of the viewport (422/844), so no change was made and the measurement
  stayed as the regression guard. `docs/VERIFICATION.md` records the four new
  traps, including that a closed `<details>` does not zero its child's rect.

- **2026-11-14** — the Layers list became a real sticker selector. Rows now read
  **topmost-first** (the store still keeps ascending-z array order; only
  `_syncLayerList` walks it backwards, which is also what made the ⤴ glyph stop
  contradicting its own motion), the section collapses via `<details>`/`<summary>`
  (the platform's job, no JS, and rows are hidden rather than destroyed), and a
  row's decorative `⠿` grip drags to restack with a single commit at drop —
  `touch-action: none` is on the grip only, so the panel does not scroll during a
  grip drag while a row tap still selects. Row buttons grew 24px → 32px (the
  touch minimum; the row also gained the grip as a fourth control). One reorder
  path now: `Store.moveTo(id, index)` (0 = bottom, z renumbered 1..n after the
  splice, clamp at both ends, same-index and unknown-id are no-ops that push no
  undo entry); `raise`/`lower`, the row buttons, `[`/`]` and the drag all ride
  it. Two drag bugs were real and are gated: the slot count is edge-based, so a
  drop exactly on a row's centre counts as having passed it (the midpoint-strict
  version made a drag ending on the last row a silent no-op); and without
  `touch-action: none` on the grip the browser cancelled the touch drag mid-way
  and fired `pointercancel` instead of `pointerup`. `tests/e2e/layers-probe.js`
  (8 criteria) is committed RED and left untouched: 6/8 green, with
  `dragReordersPixels` and `dragWorksWithTouch` red on the probe's pixel
  predicate — it classifies the centre as "black" only when every channel is
  `< 60`, but Twemoji's black large square (2b1b) is `#31373D` = (49, 55, 61), so
  the pixel reads `other(49,55,61)` after a correct restack; the row order
  changed, the undo delta is 1, and the touch variant's rows changed too. The
  fix is one threshold on the probe side. `probe.js`'s `reorderReachesLayerList`
  is also red-consequence: it raises the second-to-bottom row expecting the last
  two rows to swap, which is backwards against a topmost-first list — kept as
  written, not weakened, and reported. Unit: 119/119 (was 114).

- **2026-11-14 (verification)** — the layers packet was verified externally, and
  both reds above were the GATE's fault, not the app's. The agent was right about
  the pixel predicate and correctly left the frozen probe alone; the oracle is now
  threshold-free: `layers-probe.js` measures each square's rendered colour first
  (each with its sticker alone) and compares against those references, with a
  `refsDistinct` guard. Restated, measured by me: desktop **7/8** (only
  `dragWorksWithTouch`, which needs touch input) and mobile **8/8**, console
  `(none)`; every other gate at its previous count; unit 119. Falsified:
  commenting out the `z` renumber in `moveTo` takes `layers-probe` to **4/8** with
  `dragReordersPixels` reading `before: white, after: white` — the DOM restacks
  while the canvas does not, which is what the pixel criterion exists to catch.
  `probe.js`'s `reorderReachesLayerList` was updated to the topmost-first
  convention (its intent is unchanged) and GAINED a direct-`moveTo` half, because
  the original click half was insensitive: clicking ⤴ bubbles to the row, fires
  `select`, and `select` rebuilds the list on its own — flipping the store's
  `reorder` event to `change` left it green. With the extra half it goes red
  (`26/27`). Both probes are wired into CI (the layers gate in both desktop and
  mobile steps), which the packet's DoD required and the run did not deliver.

- **2026-11-14** — the rotate handle snapped the sticker 90° counter-clockwise on
  the first move of a drag. The cause was structural, not a typo: the handle sits
  above the sticker's centre, so the pointer's ABSOLUTE angle there is −90°, and
  the move handler wrote that angle straight into `rot` — the sticker jumped TO
  the pointer instead of rotating BY it. Rotation is now a delta accumulated per
  pointer move (`angleDelta`), which also makes a sweep across ±PI continuous and
  lets a sweep past 180° follow the hand rather than collapse to its short way
  round. The same maths was duplicated in the handle's own move listener and in
  the canvas listener; both now call one `_rotateFromDrag`. The gate was written
  RED first and two criteria failed against the old code —
  `tinyMoveAfterGrabDoesNotJump` at −90.01° and `wrapAcrossPiDoesNotSpin` at
  +169.84° — so it can fail. Worth recording: the probe's FIRST version passed
  three of its criteria **vacuously**. The drags used coordinates computed before
  the gesture, and the select-box rotates with the sticker, so after the first
  rotation the pointer missed the handle entirely and those drags measured nothing
  (a `0` delta passes a bare "under 40°" check). Endpoints are now resolved from
  the page at dispatch time and every criterion is guarded against a no-op
  gesture. `scripts/e2e.sh` gained a `drag` step for this (real button-held,
  interpolated moves, Shift modifier).

- **2026-11-14** — the selected-sticker pad (M8). The trigger was measured, not
  guessed: at and below ~32 CSS px the 8 handles' hit areas (12 px marker + a 10 px
  `::before` inset) cover a sticker's whole interior, so a move drag is impossible —
  free at 36 px, blocked at 30 (`diag-small-sticker-probe.js`, landed at `a05e346`).
  The pad's arrows move by coordinates and never need the sticker's pixels, so the
  fix does not depend on its size. `tests/e2e/pad-probe.js` was committed RED, then
  implemented by a delegated agent. **The agent refused correctly**: the frozen
  gate's `shrink` snapshot wrote a flat rect while its reader addressed `.box`,
  which made `tinyStickerIsMovable` unconditionally false — a criterion that can
  never pass is as worthless as one that can never fail. Fixed in `257bdfd` with
  the guard unchanged; a reader that throws is now reported instead of dropped in
  silence. The agent's second claim (a tolerance 0.05 too tight) was wrong
  arithmetic and was not acted on — verify a refusing agent's claims, don't just
  accept them. Proven able to fail: removing the hold's `beginDrag`/`commitDrag`
  pair takes `undoGrew` from 1 to 6 and the criterion to red.

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
- **2026-11-13** — audit pass. Findings and fixes:
  - **CI did not exist** while the definition of done demanded two green gates →
    `.github/workflows/ci.yml` runs unit + the green browser gates on push/PR.
  - **No ad-hoc runner for other probes** — the interaction gates could only be
    started from a scratch script in `/tmp`, so they were not reproducible from a
    clean clone → `scripts/e2e.sh` now takes `E2E_PROBE=<path>` and `E2E_MOBILE=1`.
  - **`.nojekyll` held prose** (196 bytes) instead of being empty; the explanation
    moved into `docs/VERIFICATION.md`.
  - **`.gitignore` missed `.code-review-graph/` and `coverage/`** — a generated
    tool directory sitting untracked in the tree is one `git add -A` from being
    committed.
  - **`package.json` still advertised blur/mosaic** in its description after those
    tools were disabled; scripts/metadata/description updated (`e2e:mobile` added).
  - **Docs drift**: `docs/VERIFICATION.md` still described one gate, "drops an emoji,
    a blur patch and a mosaic patch" and `12/12 passed`; `docs/AGENT-WORKFLOW.md`
    quoted the same stale count. Both rewritten around the real gate inventory,
    the input-plan protocol, and the two verification disciplines learned here
    (isolated-tree attribution, non-vacuous criteria).
  - Verified **clean, not broken**: `run.py` already exits 1 when a probe emits no
    criteria, and `scripts/e2e.sh` already propagates the probe's exit code — both
    are the "gate passes when it verified nothing" class, and both were sound.
  - Outstanding by design: the touch gate (pointer leak + double-tap) is red and
    `tap-after-pan` with it; M6/M7 probes are red until those features exist. CI
    runs only the green set and says so.
- **2026-11-13 (later)** — the touch round landed and was verified: contact leak
  fixed (`canvas.dataset.pointers` back to 0 after every gesture), touch double-tap
  deletes as one undo step, `tap-to-place` survives a pan and a cancelled drag.
  Touch gate **12/12**, tap-after-pan **8/8**, main probe **26/26** (two new
  criteria: a hidden tool button cannot be activated, and a programmatic change on
  the hidden custom-image input loads nothing), vitest **74/74**. CI extended with
  the touch and tap-after-pan gates.
  Two of the failures that looked like app bugs were **my probes'**: taps spaced
  under 350 ms are a double-tap by design, and after a pan a hardcoded tap
  coordinate is no longer empty (a sticker drifts under it, the app correctly
  selects instead of placing). Both traps are now written into
  `docs/VERIFICATION.md`, and the harness gained a `tapPagePoint` step so a probe
  can ask the page for an empty spot at dispatch time.

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
