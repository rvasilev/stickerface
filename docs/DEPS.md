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
| `@jsquash/*` | Apache-2.0 | PNG wasm 0.17 MB, JPEG 518 KB unpacked | Only worth it for quantified JPEG quality/subsampling or AVIF/WebP output. `canvas.toBlob` covers the default path natively and off the main thread. |
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

## Rule for adding anything

1. Does a platform API already do it? → use that.
2. Is it dev-only? → cheap yes, still justify it.
3. Runtime? → must be MIT/Apache-2.0/BSD, small, and self-hosted. Then prove the
   app still works with `npm test` **and** `npm run e2e`.
4. LGPL/GPL/non-commercial core → do not ship without an explicit decision recorded
   here, with the notices and source links that the licence requires.
