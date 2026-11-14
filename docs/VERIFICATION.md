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
| `probe.js` — the user journey (upload → stickers → nudge → undo → export, pixels asserted) | 27 | green — `reorderReachesLayerList` was updated when the Layers list went TOPMOST-FIRST: it used to raise the second-to-bottom row and expect the last two rows to swap, which is the bottom-first convention the list no longer uses. The INTENT (a store reorder reaches the list) is unchanged; a second half was added that calls `moveTo` with no selection change, because the original click half bubbles to the row and fires `select`, which rebuilds the list anyway — see the note in the trap list |
| `layers-probe.js` — the Layers list as a sticker selector: rows read topmost-first, the section collapses, a row drags to restack | 8 | green — desktop 7/8, with only `dragWorksWithTouch` red because that criterion needs real touch input (CI runs this probe under `E2E_MOBILE=1` for the full 8/8) |
| `photo-boundary-probe.js` — a new photo starts clean, the carry-over is explicit and one undo step | 9 | green |
| `selection-probe.js` — the frame wraps the drawn sticker, before and after a real handle drag | 8 | green |
| `delete-probe.js` — double-click removes the topmost sticker, one undo step, empty-canvas no-op | 8 | green |
| `handles-probe.js` — markers are small, the hit area stays finger-sized, alignment kept | 5 | green (touch) |
| `mobile-probe.js` — one finger = sticker ops, two fingers = pan, second finger cancels a drag, double-tap deletes | 12 | green |
| `tap-after-pan-probe.js` — tap-to-place still works after a pan / cancelled drag, and the contact count returns to zero | 8 | green |
| `sticker-transform-probe.js` — two fingers whose centroid is inside the selected sticker's frame pinch-scale it (uniformly), twist-rotate it, and drag it — all in ONE undo step — while the photo does not pan; two fingers outside the frame still pan | 9 | green (2026-11-14) |
| `zoom-probe.js` — focal image pinch-zoom, clamped, view-only (M7) | 9 | green |
| `hint-legibility-probe.js` — the stage hint stays legible over the photo it overlaps (own backdrop, ≥4.5:1 with a *light* photo behind it) and is not a click target | 5 | green |
| `pad-probe.js` — the selected-sticker pad: nudges by the step, a held button is ONE undo entry, size −/+ keeps the pixel aspect, and a sticker shrunk to 22 CSS px is still movable | 7 | green (2026-11-14) |
| `rotate-grab-probe.js` — the rotate handle rotates BY the drag: a 2 px move off the grab is ~0°, a quarter turn is 90°, a sweep across ±PI stays that sweep (not a full turn), Shift snaps to 15°, and one drag is ONE undo step | 7 | green (2026-11-14) |
| `emoji-swap-probe.js` — the picker EDITS the selected sticker: the artwork and the painted pixel change in place, geometry and z do not, it is one undo step, the layer row's visible name follows, the highlight follows the selection, and with nothing selected the click only arms the drop | 7 | green (2026-11-14) |
| `desktop-zoom-probe.js` — the mouse wheel zooms the photo about the cursor (plain and Ctrl/Cmd, with the BROWSER not zooming), the frame and the canvas both follow, the page does not scroll, export is untouched, and a middle-button drag pans 1:1 and clamps rather than running away | 10 | green (2026-11-14) |
| `polish-probe.js` — the panel is not a wall: `hidden` actually hides, sections collapse by real click, the emoji grid is capped, every control is ≥32px, every control type has a `:focus-visible` rule, one heading treatment, one number format, the nudge cluster reads ← ↑ ↓ → | 9 desktop / 4 phone | green (2026-11-14) — the only probe with a **mode-aware criteria set**: a desktop claim like "the panel fits without scrolling" is simply false on a phone, where the panel is meant to scroll, so each run reports only what holds for its viewport (CI runs both) |

`layout-probe.js`, `touch-diag-probe.js`, `diag-doubletap-probe.js`,
`diag-mobile-metrics-probe.js`, `diag-zoom-internals-probe.js` and
`diag-layer-perf-probe.js` are **diagnostics**, not gates: they print app
internals (view, tap bookkeeping, sticker positions, `createElement` calls per
drag gesture) and device metrics (picker
target size, canvas backing vs CSS box vs DPR, decoded-emoji count, page height)
for triage. `layout-probe` in particular reports the preview box vs the backing
store's aspect ratio, stage vs viewport, thumbnails.

`diag-layers-paint-probe.js` asks whether the CANVAS follows the array order after a
reorder, with no gesture involved at all: it adds the black and white squares,
calls `store.moveTo` directly, and reports the pixel at their shared centre before
and after. It is the isolation step that separated "the store left paint out of
step" from "the gesture did something extra" — the answer was neither (the gate's
own colour threshold was wrong; see the trap list).

`diag-small-sticker-probe.js` sweeps the selected box down through a series of
on-screen sizes and reports, at each one, what a press at the sticker's centre
would hit. Measured 2026-11-14: **free at 36 CSS px, blocked at 30** — at and below
~32 px the 8 handles' hit areas (12 px marker + a 10 px `::before` inset) cover the
entire interior, so the centre press lands on `handle:w` and the sticker cannot be
moved. The transition brackets the predicted threshold (the edge handle's 32 px box
reaches the centre when the box is ≤ 32 px). This is the measurement behind the
selected-sticker pad (M8); `pad-probe.js` is the gate that now covers it.

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
- **A gate's pixel predicate must bracket the colour the asset actually draws.**
  `layers-probe.js` originally classed the centre pixel as `black` only if every
  channel was `< 60`. Twemoji's black large square (2b1b) is `#31373D` — (49, 55,
  61) — so a correctly restacked canvas read `other(49,55,61)` and both the drag
  criteria failed while the app was right (the row order changed and the undo delta
  was 1). The probe now **measures** each square's rendered colour first — each with
  its sticker alone on the canvas — and compares against those references, with a
  guard that the two are distinguishable, so there is no threshold left to
  re-derive and no drift if Twemoji ships another shade. Correcting an oracle is not
  weakening a gate; keep every guard and re-run it. (`diag-layers-paint-probe.js`
  is the isolation tool for this class: it calls `moveTo` with no gesture at all and
  reports whether the canvas pixel follows the array order.)
- **A negative criterion needs a positive precondition, or it passes for an
  unimplemented feature.** `middleDragDoesNotSelect`, `middleDragCleansUp` and
  `wheelDoesNotScrollPage` all passed against a build with NO wheel listener and NO
  middle-button handling: nothing happened, so "it did not select", "it cleaned up"
  and "the page did not scroll" were all trivially true. Each now requires the
  gesture to have actually happened.
- **A gate's aim goes stale when an EARLIER gesture moves the target.** Two
  hands, two directions. (a) The probe's own steps: `sticker-transform-probe.js`
  computes its pinch points once, at arm time, and its two-finger drag moved the
  sticker first — so the clamp step then panned the photo instead (`to` unchanged
  at 70.2px, mode `["0","",""]`), and the criterion passed while testing nothing.
  Fixed by resolving the points from the page at dispatch time (`fns` on the
  touch steps; the frame's centre is stable through a pinch, since scaling happens
  about it). (b) The hit test: `mobile-probe.js` pressed where the sticker had
  been, not where it was, so no drag was ever live.
- **Assert the mechanism, not only its consequence, when the consequence depends on
  the environment.** `wheelDoesNotScrollPage` could not be broken by deleting
  `preventDefault()` — the page is scrollable, but a dispatched wheel over the
  canvas did not move it here, so `scrollY` stayed 0 either way. The criterion now
  also requires `defaultPrevented` on the events (observed by a listener registered
  after the app's), and that IS falsifiable: deleting `preventDefault` turns exactly
  that criterion red (9/10). `scrollY` remains the user-visible requirement.
- **A gate's anchor feature can leave the canvas.** The wheel criteria anchor on the
  fixture's red block. Zoom about the canvas centre instead of the cursor and the
  block goes off-screen, the anchor reads `null`, and the reader throws — which the
  harness reports as every criterion failing, a much louder signal than the one
  thing that broke. The deltas are computed null-safely now, so a lost anchor fails
  only the criteria that needed it.
- **An unrelated event in the same handler can mask the one you are testing.**
  `layerRowLabelFollowsSwap` passed with the store's `swap` event mutated to
  `change` — the exact trap it exists to catch. Cause: the picker's click handler
  also calls `setTool`, which emits an event outside the `change`/`history` pair,
  so `_syncLayerList()` ran anyway and the row's name refreshed. The criterion now
  ALSO drives `store.swapEmoji` directly, with no picker click behind it, where the
  event type is the only thing that can refresh the label: with `change` the direct
  half goes red (6/7) and every other criterion stays green. Same pattern as the
  layers reorder criterion, and the lesson generalises — **if a criterion cannot be
  made to fail by breaking the thing it names, it is not testing that thing.**
- **A guard on the selector, not an `!important`.** The panel's phantom UI was
  `display` set by an author class rule beating the UA's `[hidden] { display: none }`
  — `.toolbar button, .file-btn`, `.panel section`, and (found only by the gate, after
  two were already fixed) a second `.file-btn { display: inline-block }` further down
  the file. Each now carries `:not([hidden])`. The gate is what found the third one:
  the criterion counts every `[hidden]` element that still renders, so "I fixed the
  rules I knew about" is not a passing state.
- **A gate's own helper must preserve the gesture's invariants.** Moving the
  layers drag's endpoints from precomputed boxes to live resolvers (necessary: the
  panel now scrolls, so a stale point misses) broke the mouse reorder outright —
  I returned the *row's* centre X for the drop point where the original used the
  *grip's* X. The grip owns `pointermove` and there is no pointer capture, so the
  interpolated path drifting sideways off a 24 px wide grip stopped delivering
  moves: rows unchanged, no undo entry, and the touch path (which holds x fixed)
  still worked. It looked exactly like an app regression and was not — reverting
  the app files to HEAD reproduced it identically. **Before blaming the app,
  revert the app files and re-run.** Kept as permanent evidence: the resolver now
  records what `elementFromPoint` returns at each endpoint, so "the drag did
  nothing" is attributable in one run instead of five.
- **A closed `<details>` does not zero its child's rect.** Chromium hides the content
  with `::details-content { content-visibility: hidden }`, so `#layer-list` kept a
  142px bounding rect and read as "visible" while the section was collapsed. Measure
  the `<details>` element's own height (159 → 17) or its `open` property; both child
  rects and `innerText` are useless signals. `checkVisibility()` does not cover it
  either — the hiding element is a pseudo-element, not a DOM ancestor.
- **Count a document once.** The unit-format criterion first concatenated `innerText`
  with the tag-stripped markup and so counted every string twice (4/4 instead of 2/2)
  — a comparison that still "worked", which is exactly how such a bug survives. Use
  one source; the stripped markup is the better one because it includes switched-off
  sections.
- **A gate's preconditions are part of the gate.** `polish-probe.js` asserts a
  different set per viewport and reports only that set, because a criterion that can
  never pass in the other viewport is worse than no criterion — it trains people to
  ignore a red run. Two of the plan's claims did not survive contact: the phone stage
  already measured 50% of the viewport (so the planned change was dropped, with the
  measurement kept as the regression guard), and the heading treatment was already
  uniform.
- **A criterion can pass through an event it never meant to test.** In
  `reorderReachesLayerList`, clicking a row's ⤴ button also bubbles to the row and
  fires `select`, and `select` rebuilds the layer list on its own — so changing the
  store's `reorder` event to `change` (which suppresses the rebuild) left the click
  half GREEN. Measured, not assumed. The criterion now also calls `moveTo` directly,
  with no selection change, so only the `reorder` event can make it pass; with the
  event type flipped it goes red (`26/27`, and the moved label appears twice in the
  list log).

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

- **A second finger landing on a live touch gesture.** CDP cannot deliver it
  through this harness: a `touchStart` that carries the already-active point is
  dropped wholesale (measured twice, `dataset.pointers` stayed at 1), so the app
  never sees two pointers and no implementation could cancel anything. The
  `secondFingerCancelsDrag` assertion was therefore REMOVED from
  `mobile-probe.js` — and note that it had been passing vacuously: with arm-time
  coordinates the press missed the sticker entirely, so no drag was ever live,
  two empty-canvas fingers merely panned, and the sticker rode the image with
  `rel` ≈ 0. Its gesture steps remain (pointer bookkeeping), and the mode
  decision it was reaching for is covered from the other side by
  `sticker-transform-probe.js`. Restoring it needs a harness that can add a
  finger mid-gesture (`tests/e2e/run.py`'s `touchAdd` is the beginnings of one,
  but Chromium still drops the event).
- **A two-finger gesture whose fingers land on the frame's HANDLES.** Delivered
  by implicit pointer capture to the handle, not the canvas, so the transform is
  entered and then receives no updates unless the window listener drives it too
  (it does, and the M6 probe's clamp step exercises exactly this). No separate
  criterion asserts the handle path specifically.

- **No keyboard zoom.** Ctrl/Cmd `+` / `-` is the browser's own page zoom, which is
  an accessibility feature — stealing it would be a worse bug than having no
  keyboard zoom. Recorded as a gap, not an oversight.
- **No pan affordance without a middle button.** A trackpad has none. Space-drag (the
  Figma convention) is the right follow-up; it needs a key-state machine and
  `preventDefault` on space, so it is deliberately out of scope. Mouse-wheel zoom and
  ctrl+wheel (trackpad pinch) do work on a trackpad.
- **`deltaMode` on Firefox is unit-tested only.** CDP's `mouseWheel` cannot carry a
  `deltaMode`, so the line/page normalisation is covered by `tests/geometry.test.js`
  and never in the browser. If that test is removed, the feature ships visibly
  broken on one engine with no gate catching it.

- **Handle drags that leave the handle.** No gate drags a handle far enough off the
  handle to re-target `pointermove`, so both hazards documented in `_startHandleDrag` are
  unverified. Mutation-tested 2026-11-14: keying the handle off `ev.target` instead of the
  drag (the throw-`unknown handle "undefined"` bug) **survives** a full 5/5
  `handles-probe` run, and so does deleting the `_activeHandlePointerId` guard that stops
  the release net stealing a handle's pointer.
- **The 2 → 1 finger transition.** Removing the `_pan = null` reset applied when one finger
  of a pinch lifts **survives** `mobile-probe` (12/12) and `zoom-probe` (9/9): neither
  gate pinches and then lifts a finger while checking that the remaining finger does not
  jump. The same harness shows both gates *do* catch a corrupted fit-pan (7/12 vs 12/12),
  so this is a coverage hole, not a dead gate.
- `ctx.filter` blur on Safari < 18 (the harness runs Chromium; the fallback path is
  not covered — see `docs/DEPS.md`).
- **The Layers grip is pointer-only by design.** It is decorative (`aria-hidden`),
  not a button: a button that does nothing on click is worse for assistive tech
  than no control, and the accessible reorder path — the ⤴/⤵ buttons and `[`
  / `]` — already exists. The keyboard reorder is gated
  (`keyboardReorderStillWorks`), the pointer drag is gated for mouse and touch; the
  grip's *visual* affordance (the `⠿` glyph, the insertion line) is manual.
- **Row buttons are 32px.** They were 24px, below the 32px touch minimum WCAG
  targets; the row gained a fourth control (the grip) in the same commit, so the
  row height follows the buttons rather than the reverse.
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
