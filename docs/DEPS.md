# Dependency policy and the WASM question

Policy: **no runtime dependencies.** Dev-only packages are fine. Anything proposed
for runtime must beat "the platform already does it" and survive the licensing
check. This file records the survey so it does not have to be redone.

Sizes below are real downloads measured from unpkg on 2026-11-13.

## The constraint that decides most of it

**GitHub Pages cannot set response headers**, so we cannot serve
`Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`. Without COOP/COEP
there is no `SharedArrayBuffer`, so **any WASM library that needs it for threads is
out** (wasm-vips, multi-threaded ffmpeg.wasm, multi-threaded ORT). Single-threaded
WASM still works.

## Adopt

| Package | Version | License | Size | Why |
|---|---|---|---|---|
| `vitest` | ^3.2.4 | MIT | dev | unit gate (already in use) |
| `stackblur-canvas` | 3.0.0 | MIT | ~10 KB | **only if** Safari < 18 support matters: `ctx.filter` is Chrome 52+/Firefox 49+ but Safari 18+. Gate it behind `typeof ctx.filter === 'string'`, never a UA sniff, and prefer the native filter when present (StackBlur has known hard-edge artefacts under a clip). |

Everything else in the current build is platform API: `Canvas2D`,
`createImageBitmap`, `ImageBitmap`, `requestAnimationFrame`, `toBlob`,
`PointerEvent`, `DataTransfer`, `FileReader`.

## Later (v2, face detection)

| Package | License | Size | Notes |
|---|---|---|---|
| `@mediapipe/tasks-vision` | Apache-2.0 | 130 KB JS glue + ~3 MB wasm + 230 KB `blaze_face_short_range.tflite` | The right detector. **Self-host every file** (no CDN) or the "nothing leaves your machine" claim is false. Load lazily on "Detect faces". |

## Rejected, with reasons

| Candidate | License | Size | Verdict |
|---|---|---|---|
| `heic-to` / `libheif-js` | **LGPL-3.0** | 3.08 MB bundle (libheif + libde265 compiled in) | Would put LGPL code inside an otherwise clean MIT project. Permitted *if* shipped unmodified, lazily, with source + notices (Imgovo and Vitebird both publish exactly that), but it is a licensing decision, not a detail — flag it, don't sneak it in. Alternative: tell iPhone users to shoot "Most Compatible". |
| `wasm-vips` | MIT wrapper / **LGPLv3 core** (libvips, glib, libexif) | ~4.6 MB wasm | Three strikes: LGPL core, large, and requires `SharedArrayBuffer` → impossible on Pages. |
| `@ffmpeg/core` (ffmpeg.wasm) | **GPL-2.0-or-later** (published build is `--enable-gpl`, libx264/x265) | ~30 MB | Would force the whole project to GPL. No video anyway. |
| `canvaskit-wasm` | BSD-3-Clause | 6.98 MB `.wasm` | Replaces an API we already have. |
| `fabric` | MIT | 290 KB min | Genuinely tempting — ships `Blur` + `Pixelate` filters, handles, layering, JSON serialisation (free undo/redo). Rejected for v1 only because our own geometry is written, tested and dependency-free. **Named escape hatch** if the gesture code becomes a maintenance burden. |
| `moveable` | MIT | dist is a monorepo of builds; last publish 2023 | Targets DOM elements; our stickers live inside the canvas. Mismatch + stale. |
| `@jsquash/*` | Apache-2.0 | PNG wasm 0.17 MB, JPEG 518 KB unpacked | Only worth it for quantified JPEG quality/subsampling or AVIF/WebP output. `canvas.toBlob` covers the default path natively and off the main thread. **Declined a second time for PNG, now on a measurement** (2026-11-15): a PNG optimiser buys a low double-digit percent at best, because PNG's size on a photo is lossless encoding of photographic entropy rather than encoder slack — while the native lossless WebP encoder is 43.8% smaller than PNG at identical pixels for 0 bytes of wasm, and the export-size control is worth 83–95%. Named revisit trigger: someone who needs PNG *specifically* and has hit a hard external size cap. |
| `@vladmandic/face-api` | MIT | heavy (tfjs) | MediaPipe is smaller and better-suited. |
| Pyodide / OpenCV.js | MPL-2.0 / Apache-2.0 | 10 MB+ / 8–10 MB | For primitives we do not need. |

## WASM / Python / Rust / Go

**WASM only pays for two jobs here: codecs the browser lacks, and ML inference.**
Not for the compositing loop: `ctx.filter` is GPU-backed native, mosaic is a typed
array over one region (milliseconds), compositing is `drawImage`. Moving those into
WASM adds a JS↔WASM copy plus module load for negative gain.

- **Python — no, on runtime.** Pyodide is a ~10 MB CPython build and no real CV/ML
  Python package survives that trip usefully. Python stays on the dev side (asset
  scripts, fixtures, the E2E driver).
- **Go — no.** ~2 MB minimum runtime for hello-world, GC pauses, heavy JS interop.
- **Rust — only as someone else's library.** `@jsquash/png` is Rust→WASM; consume
  existing codecs, never hand-roll a blur to beat `ctx.filter`.
- **The real speed levers are platform APIs:** `OffscreenCanvas` + a worker for
  export, `createImageBitmap` (with `resizeWidth`/`resizeHeight`) for decode,
  pre-decoded `ImageBitmap`s for emoji, `requestAnimationFrame`-coalesced redraws.
  All four are already in the build.

## Round-2 module review (2026-11-14)

Re-asked, against the surface as it exists now rather than the four planned features.
Facts fetched live from the registry (not recalled); sizes are unpacked unless stated.

**Verdict: no runtime module. The one candidate is dev-only, and it is the harness.**

| component | verdict | why |
|---|---|---|
| `tests/e2e/run.py` + `scripts/e2e.sh` (523 + 171 lines, hand-rolled CDP) | **the one real candidate** — `@playwright/test`, **dev-only** | It is the only component here that a maintained library clearly does better, and the repo has already paid the cost of that twice: the pad needed a `hold` step and the zoom work needed a `wheel` step plus middle-button support, because the driver hardcoded the left button and could not send a wheel at all. WebKit also closes a gap already written down in `docs/VERIFICATION.md` (`ctx.filter` blur on Safari < 18 is untested because the harness is Chromium-only). |
| pointer/gesture router (`ui.js`) | keep | Bespoke by necessity: it publishes a documented measurement contract (`dataset.pointers`) that three gates read, and it implements the implicit-capture workaround a DOM library would not know about. A library swap invalidates those gates and re-earns a solved bug. |
| undo/redo store (`store.js`) | keep | ~40 lines of command pattern with a cap, drag coalescing and an undo-invariant test surface. A state library would replace explicit, tested code with a dependency to configure. |
| layer drag-reorder (`ui.js` + `<details>`) | keep | `sortablejs` is MIT and widely used but mutates real DOM nodes while the list is rebuilt with `replaceChildren()`, and it ships no keyboard/ARIA model — so the accessible path stays bespoke either way. See the survey's three reasons. |
| canvas view zoom/pan | keep | `@panzoom/panzoom` applies a CSS transform to an element, which is a *second* projection beside invariant 6's single one. Wrong on architecture, not quality. |
| emoji pipeline (`emoji.js`, `render.js`) | keep | A generated manifest plus `createImageBitmap` with an `<img>` fallback for viewBox-only SVGs. Nothing to adopt; the fallback exists because of a platform quirk, not a missing library. |

`@playwright/test` at a glance (live, 2026-11-14): **1.65.1**, **Apache-2.0**, **1 runtime
dependency**, ~28.5 KB unpacked for the test runner, **129.6 M weekly downloads**,
published 2026-11-13 — and it downloads **no browser** on install, so invariant 3
(no runtime dependencies) is untouched by construction. Browsers are a separate
`npx playwright install`; this box already has a cache under `~/.cache/ms-playwright`.

**Decision gate, not a change:** migrating 26 probes and the launcher is a real cost,
and the hand-rolled harness exists because of this box's constraints, not the product's.
Recorded in `PLAN.md` as Phase 6 and in the survey. Do not start it inside a feature
commit.

**Corrections to [[npm-module-survey]] (it is dated the same day but was written before
these fetches):** the Playwright cache path it cites (`/usr/local/share/playwright/…-1208`)
does not exist — the real one is `~/.cache/ms-playwright` (3.2 GB); `@panzoom/panzoom`'s
last publish is 2026-04-02, not "~3 months before 2026-11-14"; the touch gate is **11/11**,
not 12/12; and "11 probes" understates the real count (26 probe files, 21 of them gates).



## Installable and offline: still zero dependencies (M11, M12)

Nothing in M11 or M12 adds a runtime dependency. A web app manifest, its icons, and a service
worker are platform features, not packages: `dependencies` stays empty and the app stays a
static site with no build step.

Dev tooling, one-off: **`rsvg-convert`** (Debian/Ubuntu: `librsvg2-bin`) rasterises
`icons/*.svg` into the committed PNGs, via `scripts/make-icons.sh`, run by hand when the
artwork changes. It is not a build step and adds no dependency to ship — the output is
committed, exactly as `scripts/fetch-emoji.mjs` commits `js/emoji.js`. A machine without
librsvg can still build and deploy the site; it just cannot regenerate icons.

## Rule for adding anything

1. Does a platform API already do it? → use that.
2. Is it dev-only? → cheap yes, still justify it.
3. Runtime? → must be MIT/Apache-2.0/BSD, small, and self-hosted. Then prove the
   app still works with `npm test` **and** `npm run e2e`.
4. LGPL/GPL/non-commercial core → do not ship without an explicit decision recorded
   here, with the notices and source links that the licence requires.
