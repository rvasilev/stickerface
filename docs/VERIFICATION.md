# Verification — how to prove a change works

**A green unit suite proves nothing about the app.** The first build of this repo
passed 48/48 unit tests while export was permanently disabled. Every change has to
clear a browser gate as well as the unit gate.

```bash
npm test                 # 1. unit gate — pure logic, node, no DOM
npm run e2e              # 2. acceptance gate — a real browser, the real page
npm run e2e:mobile       # 3. touch gate — emulated phone, real touch events
```

## 1. Unit gate (`npm test`)

vitest, node environment. Only pure modules:

| File | What it proves |
|---|---|
| `tests/geometry.test.js` | norm↔px round-trips at 640×480 / 1920×1080 / 8000×5000, hit-test picks the topmost sticker and respects rotation, each handle pins the opposite corner, keepAspect holds the pixel ratio, `rotateTo` snapping, nudge |
| `tests/store.test.js` | add/move/resize/rotate/remove, clamping, one undo entry per drag, 20-operation undo/redo chain restores every intermediate snapshot |
| `tests/render-fallback.test.js` | the SVG raster fallback path (regression for the `viewBox`-only decode failure) |

If you add geometry, add it to `js/geometry.js` and test it there — not in the UI.

## 2. Browser gates

`tests/e2e/run.py` drives a **real headless Chrome** over the DevTools WebSocket and
evaluates a probe (a JS file) inside the page. Each probe returns one **top-level
boolean per criterion**; the runner prints `PASS`/`FAIL` per criterion and returns
non-zero if any failed — or if the probe emitted **no** criteria at all (a crashed
probe must never read as success).

| Probe | Criteria | State |
|---|---|---|
| `probe.js` — the user journey (upload → stickers → nudge → undo → export, pixels asserted) | 27 | green |
| `photo-boundary-probe.js` — a new photo starts clean, the carry-over is explicit and one undo step | 9 | green |
| `selection-probe.js` — the frame wraps the drawn sticker, before and after a real handle drag | 8 | green |
| `delete-probe.js` — double-click removes the topmost sticker, one undo step, empty-canvas no-op | 8 | green |
| `handles-probe.js` — markers are small, the hit area stays finger-sized, alignment kept | 5 | green (touch) |
| `mobile-probe.js` — one finger = sticker ops, two fingers = pan, second finger cancels a drag, double-tap deletes | 12 | green |
| `tap-after-pan-probe.js` — tap-to-place still works after a pan / cancelled drag, and the contact count returns to zero | 8 | green |
| `sticker-transform-probe.js` — pinch scale + twist rotate inside the frame (M6) | 8 | **3 green** — not implemented |
| `zoom-probe.js` — focal image pinch-zoom, clamped, view-only (M7) | 9 | green |
| `hint-legibility-probe.js` — the stage hint stays legible over the photo it overlaps (own backdrop, ≥4.5:1 with a *light* photo behind it) and is not a click target | 5 | green |

`layout-probe.js`, `touch-diag-probe.js`, `diag-doubletap-probe.js`,
`diag-mobile-metrics-probe.js`, `diag-zoom-internals-probe.js` and
`diag-layer-perf-probe.js` are **diagnostics**, not gates: they print app
internals (view, tap bookkeeping, sticker positions, `createElement` calls per
drag gesture) and device metrics (picker
target size, canvas backing vs CSS box vs DPR, decoded-emoji count, page height)
for triage. `layout-probe` in particular reports the preview box vs the backing
store's aspect ratio, stage vs viewport, thumbnails.

```bash
E2E_MOBILE=1 E2E_PROBE=tests/e2e/diag-mobile-metrics-probe.js npm run e2e   # device numbers
```

### Running any probe through the one harness

```bash
npm run e2e                                                  # the user journey
E2E_PROBE=tests/e2e/delete-probe.js npm run e2e              # any probe
E2E_MOBILE=1 E2E_PROBE=tests/e2e/handles-probe.js npm run e2e # with the phone emulation
npm run e2e -- https://rvasilev.github.io/stickerface/        # against the deployed site
```

`scripts/e2e.sh` serves the repo, starts Chrome, runs the probe and tears both down;
`HTTP_PORT`/`CDP_PORT` override the ports and `CHROME_BIN` the browser. There is no
ad-hoc runner — a gate you can only start by hand stops being run.

### Real input, not synthetic events

The app is canvas + pointer driven, and **synthetic events lie**: a
`dispatchEvent(new PointerEvent('pointerdown'))` creates no active pointer, so
`setPointerCapture` throws and the handler bails *silently* — a probe driving
handles that way reported PASS while nothing moved. Probes therefore return an input
**plan** and the driver executes it over CDP:

| Step | CDP call | Used for |
|---|---|---|
| `{t:'touchStart'/'touchMove'/'touchEnd', pts:[[x,y],…]}` | `Input.dispatchTouchEvent` | pinch, pan, tap, drag (touch ids are monotonic, like a real browser) |
| `{t:'click', pts:[[x,y]], count:2}` | `Input.dispatchMouseEvent` | single/double click (`clickCount` 1 then 2) |
| `{t:'key', key:'z', modifiers:2}` | `Input.dispatchKeyEvent` | Ctrl+Z, Ctrl+Shift+Z |
| `{t:'read', name:'x'}` | evaluates `window.__sfSnap('x')` | measure **between** gestures |
| `{t:'tapPagePoint', fn:'window.__sfFreeSpot()'}` | asks the page for a point, then touches it | aiming at a spot that depends on the current pan |
| `{t:'settle', ms:…}` | sleeps | let a gesture finish |

The probe installs `window.__sfSnap(name)` (writes into `window.__sfSnaps`) and
returns its verdict from `window.__sfReadTouch()`; an optional `window.__sfFinishZoom()`
runs before the reader when a result (e.g. an export) needs to be collected first.
**Measure the rendered pixels**, not the app's own geometry: a known colour block in
the fixture tracks the image, the Twemoji yellow tracks the sticker.

Touch requires mobile emulation **before the reload** (`E2E_MOBILE=1` →
`Emulation.setDeviceMetricsOverride` 390×844 dsf 2 + `setTouchEmulationEnabled`),
otherwise the run measures a desktop layout.

### Adding a criterion

Add a top-level `r.yourCriterionName = <boolean>` and a `log(...)` line carrying the
evidence. Two rules: a criterion that cannot fail is not a test, and a criterion that
passes when nothing happened is worse — guard it (`if the zoom did not happen, FAIL`)
rather than letting "no change" read as success.

### Two probe-authoring traps that produced false failures here

- **Taps closer together than the double-tap window ARE a double-tap.** Two taps
  350 ms apart on the same spot delete the sticker — correct behaviour that made a
  probe sequence of "place, tap, tap" read as "nothing happened" (place, delete,
  place). Space standalone taps beyond the window (`{t:'settle', ms:400}` in the
  probe) and keep a genuine pair tight.
- **After a pan, a hardcoded tap coordinate is no longer empty.** The image moves,
  so a sticker can drift under a canvas fraction that used to be free; the tap then
  correctly *selects* instead of placing, and the criterion fails while the app is
  right. Compute the tap point in the page at dispatch time (`tapPagePoint` step +
  an "emptiest on-screen spot" search) and assert the clearance you got — a sticker
  is 216 natural px wide, so require >150 px of clearance or the criterion is
  measuring the wrong thing.
- **A screen-space oracle that ignores the view pan measures the pan.** "The sticker
  must not move when a second finger cancels the drag" cannot be measured as a raw
  screen displacement: two fingers pan the photo, the sticker rides the photo, so the
  sticker legitimately moves by the pan. Subtract the image's own shift
  (`interruptStickerShiftRelImage`); it was 0.33px against a 40px pan. Guard the
  criterion on the pan actually happening, or "nothing moved" passes as a cancel.
- **Do not assert an exact arithmetic product against a clamped value.** The low-zoom
  clamp was checked as `minR <= 1.6`, which is exactly what `scale 8 x (6/30)` produces:
  the bound sat ON the correct answer and failed on 0.2% raster noise. State the
  property instead (came back toward fit, never below fit) — a broken clamp or a dead
  pinch-in still fails it.

## Traps

- **The URL goes on Chrome's command line.** `Page.navigate` (and the Hermes CDP tool)
  refuses loopback/private page URLs, so the driver reloads whatever the browser was
  started on. Start Chrome with the target URL.
- **Pages CDN caching (~10 min TTL).** A probe or module pushed seconds ago is not
  what the live run executes. The probe and fixture fetches append `?cb=<Date.now()>`
  with `cache: 'no-store'` — do not remove them.
- **The probe path must be RELATIVE.** The app is at the origin root locally but under
  `/stickerface/` on Pages; a root-absolute `/tests/e2e/probe.js` resolves to the
  origin root, returns a 404 **HTML** page, and the eval dies with
  `SyntaxError: Unexpected token '<'`.
- **`.nojekyll` must exist at the repo root** (and be empty). Without it Pages runs
  Jekyll: `.md` files become `.html` (a documented `docs/x.md` 404s) and
  underscore-prefixed paths are dropped.
- **Needs Python `websockets`** (present on this box). No Playwright/Puppeteer is
  installed and this harness deliberately does not add one.
- **A leaked harness server holds the port the next run needs.** `$!` from
  `( cd … && python3 -m http.server … ) &` is the *subshell*, not the listener, so
  killing it can leave the server running — 109 orphans had piled up on the dev
  box before anyone noticed, on ports no one was watching. `scripts/e2e.sh` reaps
  by PORT (`HTTP_PORT` and `CDP_PORT`) on entry *and* on exit, plus any
  `python3 -m http.server` whose cwd is this repo or an `/tmp/sf-*` copy; a server
  you started by hand for another project is never touched. **Do not hand-roll a
  runner with its own port** — that is how the orphans got there.
- **Verify against an isolated copy when something else is writing to the tree.**
  A delegated agent editing `js/ui.js` makes local runs lie — the failures belong to
  its unfinished work. Build a clean tree at HEAD and run the gates there:

  ```bash
  rm -rf /tmp/sf-head && mkdir -p /tmp/sf-head
  git archive HEAD | tar -x -C /tmp/sf-head
  # copy in the files under test, then run the gates from /tmp/sf-head
  ```

  That is how a change gets attributed to the right side of the blame.

## Manual checklist (things the probes cannot see)

- `ctx.filter` blur on Safari < 18 (the harness runs Chromium; the fallback path is
  not covered — see `docs/DEPS.md`).
- A 40 MP photo: preview stays interactive, export returns full-resolution output.
- An EXIF-rotated JPEG and a non-Latin filename.
- Keyboard-only run: drop a sticker, nudge, rotate, delete, undo.
- Browser display scaling at 400 %.
- Firefox — **never run**; the harness is Chrome-only, so this is unverified, not
  satisfied.

## Reporting rules

- Paste real output: `N/M passed` and `E2E_EXIT=0`, or the failing lines.
- Never claim a probe passed that you did not run. If Chrome will not start, say so.
- If a criterion is red, ship nothing and name it.
- Say which gates were **not** run (and why) rather than implying full coverage.
