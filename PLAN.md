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
    render.js         # draws base image + each sticker (emoji/blur/mosaic)
    export.js         # full-resolution composite -> Blob (PNG/JPG)
    emoji.js          # bundled sticker catalogue (manifest, not inline data)
    ui.js             # DOM wiring: toolbar, layer list, file input, picker
  assets/emoji/       # curated Twemoji SVGs (CC-BY 4.0) + ATTRIBUTION.md
  scripts/fetch-emoji.mjs  # deterministic fetch of the curated set (dev only)
  tests/geometry.test.js   # vitest, node env, zero DOM
  README.md  LICENSE  PLAN.md  AGENTS.md
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
  kind: "emoji" | "blur" | "mosaic",
  src: "assets/emoji/1f600.svg" | "user:<objectURL>",  // emoji kind only
  cx: 0.42, cy: 0.55,      // centre, normalized to image width/height
  w: 0.12,                 // width normalized to image WIDTH
  h: 0.12,                 // height normalized to image HEIGHT (independent -> non-square ok)
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
- Emoji aspect: preserve the SVG's intrinsic ratio by default; dragging a corner
  with `Shift` unlocks non-uniform scaling.

### Rendering

Single offscreen `HTMLCanvasElement`, redrawn per interaction via
`requestAnimationFrame` (coalesce multiple events per frame).

Per sticker, in `z` order:
- **emoji** — `ctx.translate/rotate` then `drawImage(svgBitmap)`; SVGs are
  pre-decoded once into `ImageBitmap`s at load (an `<img>` per frame is a
  re-rasterisation on every paint).
- **blur** — clip to the rounded rect, then `ctx.filter = 'blur(Npx)'` and
  `drawImage(base, …)`; fall back to a manual box-blur pass on a scratch canvas
  if `ctx.filter` is unsupported. Note: canvas blur bleeds at the edges — clip
  first, blur second, and inset the source rect by 2× sigma.
- **mosaic** — read the region's pixels, average per `strength`-sized block,
  write back; `imageSmoothingEnabled = false` when scaling up blocks.

### Export

`export.js`: fresh canvas at natural size → draw base → draw each sticker with
the pixel scale factor → `canvas.toBlob(mime, quality)` → download as
`<basename>_stickerface.<ext>`.

- PNG default (lossless, alpha); JPEG at `quality 0.92` as an option.
- Canvas re-encode **drops EXIF/GPS automatically** — surface this in the UI as a
  privacy feature ("metadata removed on export").
- Ordering: export must run after `document.fonts.ready` and all emoji bitmaps
  are loaded; gate the button on a `ready` flag rather than throwing.

### Interaction (v1)

| Action | Binding |
|---|---|
| Add sticker | click on canvas with a tool active (emoji / blur / mosaic) |
| Select | click a sticker |
| Move | drag body; arrows nudge 1 px @preview scale (Shift = 10) |
| Resize | 8 handles; corners keep ratio, `Shift` frees it |
| Rotate | handle above top-centre; snap to 15° with `Shift` |
| Delete | `Delete`/`Backspace` or layer-list ✕ |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Shift+Z`, toolbar buttons |
| Bring forward / back | `[` / `]` |
| Zoom preview | `+` / `-` / `0` (fit) |

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

| # | Deliverable | Gate |
|---|---|---|
| **M0** | repo, README, LICENSE, index.html canvas, image upload, ONE draggable emoji sticker | manual: upload → drag → export PNG matches |
| **M1** | handles + rotate, undo, layer list, blur + mosaic kinds, full-res export, keyboard | `npm test` green; manual export at 3 image sizes |
| **M2** | emoji picker (curated Twemoji set), custom image sticker, "same layout next photo" | manual batch of 3 photos |
| **M3** | Playwright smoke test (upload → place → download), geometry unit tests expanded | CI green on push |
| M4 (v2) | detection, auto-place, adopt/ignore | detection never required for export |

## Acceptance criteria for M1 (what "done" means)

1. `python3 -m http.server 8000` (or any static server) → page loads with zero
   console errors and zero network requests after first load.
2. Upload a 40 MP JPEG → preview stays interactive; export returns a PNG with the
   same dimensions as the source and no EXIF.
3. Place emoji + blur + mosaic stickers; each survives export at full resolution
   in the same relative position (verify by pixel-diff of the exported file).
4. Undo/redo restores state across ≥20 operations, including one whole drag.
5. `npm test` (vitest) passes: geometry round-trips at 640×480, 1920×1080,
   8000×5000; hit-test selects the topmost sticker at an overlap; rotate handle
   maths is stable at 0/90/180/270°.
6. Keyboard-only workflow: place a sticker, nudge, rotate, delete, undo.
7. Works in Chromium and Firefox; Safari best-effort.

## Testing

- **Unit (vitest, node env, no DOM)** — `geometry.js` only. Everything geometric
  must be testable without a browser; that's why it's a separate pure module.
- **E2E (Playwright, M3)** — real upload → drag → export → assert the downloaded
  file's dimensions and that pixels outside the sticker bbox are unchanged.
- **Manual checklist** — HEVC `.mov` frame (should still load as an image via
  `<img>`? no — document that video is out of scope), EXIF-rotated JPEG, 40 MP
  photo, non-Latin filename, 400%-zoom display scaling.

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
