# AGENTS.md — working rules for this repo

You are working on **StickerFace**: an offline, no-account web tool that hides
faces in a photo with an emoji sticker. Static site, no build step, served from
the repo root by GitHub Pages. The blur patch, mosaic patch, About panel and
"use my own image" sticker are **disabled in v1** — hidden in the DOM, with their
code paths retained; do not re-expose them and do not treat them as absent.

Read in this order before changing anything:

1. `PLAN.md` — the spec: architecture, data model, milestones, acceptance criteria.
2. `docs/ARCHITECTURE.md` — module map, invariants, the render/export pipeline.
3. `docs/VERIFICATION.md` — how to prove your change works. **Non-optional.**
4. `docs/DEPS.md` — dependency policy and why the obvious libraries were rejected.

## The six invariants

Break one of these and the change is wrong, whatever the tests say.

1. **No bundler, no build step, no framework.** Vanilla ES modules served as-is.
   If you feel the urge to add Vite, stop and say why in the PR instead.
2. **No runtime network calls.** No CDN fonts, no CDN libraries, no remote models.
   Everything is served from this repo. A CDN request breaks the product's only
   real promise ("nothing leaves your machine").
3. **No runtime dependencies.** `devDependencies` only (vitest today). Any runtime
   package must be recorded in `docs/DEPS.md` with its licence and be self-hosted;
   the only documented candidate is `stackblur-canvas` (MIT) for the Safari < 18
   blur fallback, and it is **not adopted** — the box-blur scratch pass covers that
   case today.
4. **`js/geometry.js` is pure** — no DOM, no canvas, no globals, no imports. All
   geometric maths lives there so it can be unit-tested in node.
5. **State is NORMALIZED (0..1).** Never persist pixel coordinates. Pixel maths
   happens only at the render/export edge (`px()`, `norm()`), and export always
   composites at `image.naturalWidth/naturalHeight`, never at preview scale.
6. **One projection for the overlay.** Everything drawn over the canvas (selection
   frame, 8 handles, rotate handle, hit-testing) is projected as
   `cssPoint = canvasRect.origin + backingPoint * previewScale` — a single scale,
   the canvas's own rect. Using backing pixels as CSS pixels, borrowing the stage's
   offset, or applying the scale twice is the bug behind the user-reported
   "frame not around the emoji". The preview canvas's CSS box must also keep the
   backing store's aspect ratio, or the user positions stickers against a stretched
   photo.

## Commands

```bash
# devDependencies — REQUIRED form on this box. It exports NODE_ENV=production,
# which makes a bare `npm install` silently skip ALL devDependencies.
NODE_ENV=development npm install --include=dev

npm test                      # vitest unit tests (geometry + store + render fallback)
npm run e2e                   # real-browser acceptance probe — see docs/VERIFICATION.md
npm run e2e:mobile            # touch gate (one finger = stickers, two = pan the photo)
npm run serve                 # python3 -m http.server 8000 (file:// will NOT work: ES modules)

# Any probe, through the same harness. E2E_MOBILE=1 adds phone emulation.
E2E_PROBE=tests/e2e/selection-probe.js npm run e2e
E2E_MOBILE=1 E2E_PROBE=tests/e2e/handles-probe.js npm run e2e
```

## Definition of done

A change is done when ALL of these hold:

1. `npm test` passes (real output, pasted in the summary).
2. `npm run e2e` prints `26/26 passed` and `E2E_EXIT=0` (the count grows as
   criteria are added — quote the number you actually saw, never a remembered one).
3. Any gate your change touches is green too, run through the same harness:
   `E2E_PROBE=tests/e2e/selection-probe.js npm run e2e` (8/8),
   `E2E_PROBE=tests/e2e/delete-probe.js npm run e2e` (8/8),
   `E2E_MOBILE=1 E2E_PROBE=tests/e2e/handles-probe.js npm run e2e` (5/5),
   `npm run e2e:mobile` (the touch gate). `docs/VERIFICATION.md` lists every probe
   with its current state — **a probe that is red for a known reason stays red and
   is not in CI**; say which gates you did not run.
4. The E2E "console / uncaught exceptions" section prints `(none)`.
5. The spec still describes the code: if behaviour changed, `PLAN.md`,
   `docs/ARCHITECTURE.md`, `docs/VERIFICATION.md` and `README.md` "Features" were
   updated in the same commit. A stale rule is an instruction the next agent obeys.
6. No new runtime dependency, no network request after first load.

Unit tests alone are **not** enough. The first build of this repo passed 48/48
unit tests while the product's only job was dead (see "Pitfalls" below).

## Conventions

- Plain JS with JSDoc types. No TypeScript build step.
- 2-space indent, single quotes, semicolons. Functions over classes, except
  `Store` and `CanvasApp`.
- Comments explain **why**, not what. Good comment: why the blur source rect is
  inset by 2× sigma. Bad comment: "// loop over stickers".
- Commit messages: imperative, one line, prefixed `feat:` / `fix:` / `test:` /
  `docs:` / `chore:`. Commit in small logical steps; never commit `node_modules`.
- Never commit downloaded model weights, or a Twemoji set larger than the curated
  manifest in `js/emoji.js`. To extend the set, edit `scripts/fetch-emoji.mjs`
  and re-run it (it rewrites `js/emoji.js` — that file is GENERATED, don't
  hand-edit it).
- Accessibility is part of the spec, not a nicety: every control is a real
  `<button>`/`<input>` with an accessible name, and focus rings stay visible.

## Anti-slop requirements (this repo)

Measured against the code on 2026-11-14, not a matter of taste. Each rule names the
failure it prevents.

1. **One conversion per space change.** `_cssToCanvasPx` is the only CSS→canvas
   conversion; `_canvasPoint` is the only CSS→natural. Never hand-copy the maths at a
   call site. `_removeTopmostAt` and `tryRemoveAt` in `js/ui.js` both do, one of them
   with a comment admitting it ("same conversion as `_canvasPoint`"). Two copies of one
   projection is how the selection frame ended up ~45px off the sticker it wrapped.
2. **One path per rule.** "Remove the topmost sticker at a screen point" exists twice
   (`_removeTopmostAt` and the nested `tryRemoveAt`). Merge them; keep the behaviour both
   share today.
3. **No harness talk in app code.** Nothing in `js/` may mention the probe, a gate, a
   criterion, a fixture or a test coordinate. Current offenders to delete on sight:
   `ui.js` "the probe does exactly that", "BUT the gate's two-finger pan happens
   BETWEEN", "For the gate they coincide at (124,594)", "probe sends real CDP clickCount
   1 then 2", `pointer-tracker.js` "measurable from the gate". Exactly **one** allowlisted
   exception: `canvas.dataset.pointers`, a deliberate measurement contract — say that in
   its comment and nowhere else.
4. **No refactor history, no narrated reasoning.** Delete "The old `_canvasPoint` (now on
   the prototype above)", "NOTE: movedDist>8-on-sticker is a drag END", "matters for M6
   later", "historically need capture".
5. **No dead code, no dead exports.** `_previewScale()` has no caller; `render.js`'s
   `cancelDraw` has none anywhere; `bitmapFromImage`, `loadImgWithSize` and `export.js`'s
   `compositeCanvas` are used only inside their own file and should be locals. Grep for
   callers — including tests and config — before keeping anything.
6. **Split by job, not by line count.** `_bindPointer()` (196 lines) is pointer
   arbitration + desktop dblclick + a window-level release net + handle-drag wiring;
   `_maybePlaceOnTap()` (75) is double-tap policy + hit-test + placement + tool dispatch.
7. **Comment budget: keep it under ~1 line in 4.** Measured 2026-11-14: overall 0.30,
   `ui.js` 0.26 — but `geometry.js` 0.76 and `pointer-tracker.js` 0.80, i.e. those two
   files are mostly prose about themselves. Trim them; do not extend them.
8. **Never hand-edit `js/emoji.js`** — generated by `scripts/fetch-emoji.mjs`.
9. **Disabled is not absent.** The blur/mosaic/About/custom-image paths stay, hidden and
   guarded. Never delete them silently, never re-expose them.
10. **Account for growth.** A change that leaves a file longer must carry new behaviour;
   if it does not, justify the lines in one sentence. A cleanup commit names the
   duplicates and dead symbols it removed.

## Pitfalls (each one already cost real debugging time here)

- **Twemoji SVGs have no intrinsic size** — only a `viewBox`. `createImageBitmap`
  on the raw Blob throws `InvalidStateError: The source image could not be
  decoded`. Decode through an `<img>` (+ offscreen canvas) instead. **Never patch
  the vendored SVGs** — `assets/emoji/ATTRIBUTION.md` claims they are unmodified
  upstream copies, and that claim has to stay true.
- **Never gate the primary action on "every asset loaded".** Gating export on
  `ready = all 76 bitmaps decoded` meant one undecodable file disabled the whole
  product — exactly the competitor failure mode we exist to avoid. Gate on "the
  user's input is valid"; degrade cosmetically and report it in the UI.
- **Beware duplicate initialisation.** A second `CanvasApp` construction doubled
  every listener and doubled the picker (152 buttons for 76 emoji) while looking
  correct, because each instance re-rendered the layer list from its own store.
  Assert element counts, not just behaviour.
- **`NODE_ENV=production` is exported on this box** → `npm install` silently skips
  all devDependencies and `npm test` then fails with a missing binary.
- **`file://` will not load ES modules.** Always serve over HTTP.
- **Top-level `await` is illegal in a classic script** — in a `Runtime.evaluate`
  expression wrap it: `(async () => await eval(...))()`.
- **Chromium refuses loopback page URLs in the Hermes CDP tool.** Drive headless
  Chrome through `tests/e2e/run.py` instead (it starts with the URL on the
  command line; `Page.navigate` is blocked by the same guard).
- **GitHub Pages serves from a CDN with a ~10-minute TTL.** A file pushed seconds
  ago is not what a live probe executes — cache-bust (`?cb=<ts>`) anything you
  fetch from the page, or you will verify the previous revision.

## Attribution (non-negotiable)

- **Twemoji graphics: CC-BY 4.0.** Keep `assets/emoji/ATTRIBUTION.md`, the credit
  line in `README.md`, **and the visible page footer** intact. The code is MIT; the
  artwork is not.
  The credit used to live only in the About panel; that panel is hidden in v1, so
  the credit moved to `footer.footer` in `index.html`. Do not delete it and do not
  re-expose it only inside the hidden panel — a credit nobody can reach is a
  licence breach, not a UI preference.
- Detection/design lessons come from `ORB-HD/deface` (MIT) and
  `kmcheung12/faceblind`. Credit them by name and link.
- Never present borrowed work as original. If you port code, name the source in
  the file header.
