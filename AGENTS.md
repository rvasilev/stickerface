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
   frame, the resize/rotate handles, the move mark, hit-testing) is projected as
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
2. `npm run e2e` prints `27/27 passed` and `E2E_EXIT=0` (the count grows as
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

## Branches

Three, all on origin, all forked from `main`:

- **`main`** — the baseline origin, and the only branch that ships: GitHub Pages builds from it
  (`source: main`, `/`) and CI runs every gate on pushes to it. Nothing unfinished lands here.
- **`devel`** — unfinished v1 work. Expected to be red sometimes; that is what it is for.
- **`next`** — v2, based on `main`.

CI's push trigger is `[main]` on purpose (see the note at the top of `ci.yml`): a CI that fails
for known reasons trains people to ignore it. So `devel` and `next` are gated when they reach a
pull request — or on demand with `gh workflow run ci.yml --ref <branch>`.

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

Each rule names the failure it prevents. The inventories were cleared on 2026-11-14
(`fix: one removal path, no dead code…`) — they stay in the rule as the concrete shape
to look for, not as a to-do list. Re-measure before trusting a number here.

1. **One conversion per space change.** `_cssToCanvasPx` is the only CSS→canvas
   conversion and `_canvasPoint` the only CSS→natural. Hand-copying that maths at a call
   site is how the selection frame once ended up ~45px off the sticker it wrapped.
2. **One path per rule.** "Remove the topmost sticker at a screen point" is
   `_removeTopmostAt` alone — the desktop dblclick and the touch double-tap both call it.
   When a second copy appears, merge it and keep the behaviour both share.
3. **No harness talk in app code.** Nothing in `js/` may mention the probe, a gate, a
   criterion, a fixture or a test coordinate: the app must read as a product, not as a
   fixture for its own tests. Exactly **one** allowlisted exception —
   `canvas.dataset.pointers`, a deliberate measurement contract, named as such in the
   comment on `_registerPointer` and nowhere else.
4. **No refactor history, no narrated reasoning.** A comment says what the code does and
   why it must — never what it used to do, what it was called before, or which milestone
   will want it later.
5. **No dead code, no dead exports.** A symbol used only inside its own file is a local;
   one with no caller anywhere is deleted. Grep for callers — **including tests and
   config** — before keeping anything. Two symbols are reachable only from tests and are
   kept deliberately, so removing either is a judgement call to state in the commit, not a
   silent sweep: `handlePositions` (`geometry.js`) and `Store.resize`. `Store.rotate` is NOT
   one of them — `js/ui.js` calls it for the rotate handle.
6. **Split by job, not by line count.** Pointer wiring is one method per job —
   `_bindPointer` composes `_bindDesktopDblclick`, `_bindCanvasPointer`, `_bindWindowMove`,
   `_bindHandles`, `_bindReleaseNet` — and `_maybePlaceOnTap` delegates the drop to
   `_placeStickerAt`, the removal to `_removeTopmostAt`. **Registration order is NOT part of
   the contract**, though this rule claimed it was until 2026-11-14: what keeps a handle's
   pointer is dynamic state — `_activeHandlePointerId`, set in `_startHandleDrag` — plus the
   release net registering in the capture phase. A mutation that swapped the two
   registrations left every pointer gate green.
7. **Comment budget: keep it under ~1 line in 4.** Re-measure rather than trusting the
   figures here: `python3 ~/.hermes/skills/software-development/ponytail-audit/scripts/slop_inventory.py
   --root . --top 8` prints comment ÷ code per file. Measured 2026-11-14 with that command:
   overall 0.27, and the prose-heavy end is `export.js` 0.66, `geometry.js` 0.65, `render.js`
   0.49 — trim those when you touch them, and do not extend any file past the budget.
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
- **A control's hit area can be bigger than the thing it annotates.** A 12 CSS px
  handle with a 32 px target covers the whole interior of any sticker ≤ 32 px, so the
  press meant to move it lands on the handle. `FRAME_MIN_CHROME_PX` (36) is where the
  chrome now stands down, derived from the target size — never from the handle count.
- **Never remove the element under a live pointer.** Hiding a captured element
  mid-gesture re-targets or aborts it: the chrome flip is deferred while any drag is
  open, applied on the frame after release.
- **A signpost must not be a target.** The move mark is `pointer-events: none` and a
  gate asserts `elementFromPoint` at its centre returns the canvas — decoration that
  swallows the press it points at is worse than decoration that is absent.
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
