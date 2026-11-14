# StickerFace

[![CI](https://github.com/rvasilev/stickerface/actions/workflows/ci.yml/badge.svg)](https://github.com/rvasilev/stickerface/actions/workflows/ci.yml)

Put a sticker on it. Hide faces in a photo with an emoji sticker — **entirely in
your browser**. No upload, no account, no install, no telemetry. Works on Linux,
macOS, Windows and phones.

An open-source replacement for tools like Ashampoo Face Blur, built on the
manual-first principle: the app never refuses to open your photo just because a
face detector failed.

## Use it

Open <https://rvasilev.github.io/stickerface/> — or run it locally:

```bash
git clone https://github.com/rvasilev/stickerface
cd stickerface
python3 -m http.server 8000      # file:// does NOT work: no ES modules, and no manifest/installability
# → http://localhost:8000
```

## Install it

StickerFace is installable — no store, no account, no download:

- **Android, or desktop Chrome/Edge:** the install icon in the address bar, or the browser
  menu → *Install*.
- **iPhone / iPad / macOS Safari:** Share → *Add to Home Screen* (on iOS/iPadOS 26 and later
  it opens as a web app straight away, with no further setup), or *Add to Dock* on the Mac.
- **Firefox:** the menu's *Install* adds it as a shortcut.

It then opens like any other app: its own icon, no browser chrome. And it keeps working with
no signal at all — the whole app (shell, every emoji, every icon) is cached on first visit, so
a plane, a train, or a dead wifi connection changes nothing. The icon is `icons/icon.svg`, and
the PNGs the install surfaces use are committed — regenerated only when the artwork changes
(`scripts/make-icons.sh`).

## Features

v1 manual placement (images only — video is not supported):

- **Emoji stickers** from a curated Twemoji set; click the canvas to drop one —
  and with a sticker **selected**, clicking a different emoji **replaces that
  sticker's artwork in place** (same position, size, rotation and depth), one undo
  step. With nothing selected the click only arms the next drop, as before
- **Selected-sticker pad** in the panel — nudge arrows with a 1 px / 10 px step and
  size −/+ — so a sticker resized too small to grab can still be moved and resized
- **One resize handle, one rotate handle, and the body moves it.** With a sticker
  selected, its corner handle resizes it (corners keep aspect, `Shift` frees it) and
  the dot above its top edge rotates it (`Shift` snaps to 15°) — always, with no mode
  to switch into, and a small four-way **move mark** at its centre as a signpost. The
  sticker's body is the move handle, so where a press lands decides what it does: a
  corner resizes, the dot rotates, anywhere inside drags. Below ~36 CSS px the two
  handles step aside, because their 32 px hit areas would otherwise cover the whole
  sticker — the body drag and the pad's arrows take over, and the handles come back
  when it grows
- **A first-run coach mark**, once per browser: the first photo explains that one
  pointer works the stickers and two move or zoom the photo, and that a sticker's
  corner resizes it while the dot above rotates it. The wording follows the device — a
  mouse user is told about dragging and scrolling, never about fingers. It goes away
  when you press its **Got it**, or the moment you start using the canvas, and it never
  comes back. Its card is `pointer-events: none` (only the button is interactive), so
  it can never be the reason a press on the photo does nothing
- Click to drop, drag the body to move, the corner to resize, the top dot to rotate
- Full-resolution export: PNG (default) or JPEG (quality 0.92), always
  composited at the source's natural size — **EXIF and GPS are dropped on
  export**
- "Apply layout to next photo": keeps the normalized sticker layout for the
  next image, warns if the aspect ratio differs by more than 5%
- Undo/redo (command pattern, one entry per drag), layer list with
  forward/back ordering, keyboard nudging (1 px / 10 px with `Shift`),
  `Delete` **or a double-click / double-tap on the sticker** to remove,
  `[` / `]` to reorder
- **Layers panel reads topmost-first, like every other editor** — the top row
  is the sticker on top — inside a collapsible section, and each row's `⠿`
  grip drags the sticker up or down the stack (the grip is decorative;
  ⤴/⤵ and `[`/`]` stay the accessible reorder path)
- **Panel sections collapse** (`<details>`, no JS): Emoji, Strength and Layers,
  with a capped, internally-scrolling emoji grid so the list and the sticker pad
  stay reachable without scrolling the panel
- Controls are touch-sized (≥32 px), every control type has a visible
  `:focus-visible` ring, and numbers use one format throughout (`1 px`, `10 px`)
- **Desktop wheel-zoom at the cursor, and middle-button pan.** The wheel zooms the
  photo about the pointer (plain, and with Ctrl/Cmd — a trackpad pinch arrives as
  ctrl+wheel, so that path is free); holding the middle button pans a zoomed photo.
  Middle-click's default actions are suppressed (`pointerdown` and `auxclick`), so
  it neither autoscrolls on Windows nor pastes the X11 selection.
  Nothing new computes a view: all three inputs (pinch, wheel, middle drag) go
  through `focalZoomView`, which is what keeps the mouse and touch views from
  drifting apart. `wheelZoomFactor` normalises `deltaMode`, so Firefox's line-mode
  wheel is not ~40× too strong. Zoom is view-only — sticker geometry and export are
  untouched, and `desktop-zoom-probe.js` asserts the exported centre is unchanged.
  **Two gaps, deliberate:** no keyboard zoom (Ctrl `+`/`-` is the browser's own page
  zoom, an accessibility feature) and nothing for a middle-button-less trackpad
  (space-drag is the right follow-up).
- **Two fingers inside the selected sticker's frame transform it; outside, they
  pan the photo.** Pinch scales it uniformly (a square stays square), twisting
  rotates it about its own centre, and dragging the pair repositions it —
  Instagram-like, decided once when the second finger lands. A hard pinch-in stops
  at a 16-pixel floor instead of collapsing the sticker, and the whole gesture is
  one undo step, so `Ctrl+Z` restores size, angle and position together.
- On a touch screen: **one finger** works the stickers (tap to place, drag to
  move, handles to resize/rotate), **two fingers** scroll the photo; a second
  finger cancels an in-flight sticker drag
- Drag-and-drop a photo onto the stage; preview is capped at a 1600 px
  long edge so even a 40 MP photo stays interactive
- Zero network activity after the page loads; zero console errors on a
  plain static-server load

Roadmap: automatic face detection (v2) via a self-hosted MediaPipe BlazeFace
model. Video is explicitly out of scope.

## Disabled in v1 (buttons hidden, code retained)

Requested 2026-11-13: *"disable blur, mosaic, about buttons"* and *"disable use my
own image as sticker functionality"*. These are **hidden, not deleted** — the code
path stays (a layout saved with a blur patch still renders and exports), and each
control comes back by removing one `hidden` attribute in `index.html`:

| Control | Element |
|---|---|
| Blur tool | `#tool-blur` |
| Mosaic tool | `#tool-mosaic` |
| Blur/mosaic settings (strength, corner radius) | `#tool-settings` |
| About button + panel | `#btn-about`, `#about-panel` |
| "Use my own image" custom sticker | `#custom-label` / `#custom-input` |

Two consequences that are contract, not polish:

- **Until 2026-11-14 these attributes did not actually hide anything.** Author
  rules that set `display` (`.toolbar button, .file-btn`, `.panel section`, and a
  second `.file-btn` further down the sheet) outrank the UA's
  `[hidden] { display: none }`, so the v1-off controls rendered anyway — the About
  panel alone was 690 px of always-present markup, and the panel overflowed its
  height by ~1030 px. Each culprit now carries `:not([hidden])`, and
  `polish-probe.js` fails if any `[hidden]` element still renders, so this cannot
  come back unnoticed.

- **Attribution must stay reachable.** The About panel was the only place the
  CC-BY 4.0 Twemoji credit appeared in the UI, so the same credit moved into a
  visible page footer — dropping it would break the licence obligation.
- **Hiding is not disabling.** A hidden `<button>` still fires its handler if
  clicked programmatically and a hidden file input still fires `change`, so
  `js/ui.js` must refuse to activate a tool or load a custom sticker whose control
  is hidden (`toolCannotBeActivatedWhileHidden`,
  `customStickerCannotBeLoadedWhileHidden`).

Emoji is the only sticker the UI offers; blur/mosaic/custom remain implemented and
unit-tested at the store/render level.

## Development

```bash
NODE_ENV=development npm install --include=dev   # required on this box
npm test          # unit gate: vitest, pure modules, no DOM
npm run e2e       # acceptance gate: real headless Chrome, 12 criteria
npm run serve     # then open http://localhost:8000
```

`js/geometry.js` is pure (no DOM, no canvas) and is the only module unit-tested in
node. `js/store.js` holds all state in normalized coordinates; pixel conversion
happens only at the render/export edge. **A green unit suite is not enough** — the
first build of this repo passed 48/48 unit tests while export was disabled in the
browser. Run `npm run e2e` too.

## Documentation

| File | For |
|---|---|
| `PLAN.md` | the spec: architecture, milestones, acceptance criteria |
| `AGENTS.md` | working rules for any AI agent — invariants, commands, pitfalls |
| `docs/ARCHITECTURE.md` | module map, data model, render/export pipeline |
| `docs/VERIFICATION.md` | the two gates, the browser probe, how to add a criterion |
| `docs/DEPS.md` | dependency policy, npm/WASM survey, licensing verdicts |
| `docs/AGENT-WORKFLOW.md` | how this repo is built with a coding agent, and what to verify |

## Privacy

Nothing leaves the tab. There is no server, no analytics, no remote font or model
fetch. The exported file is re-encoded through a canvas, which strips EXIF
metadata including GPS coordinates.

## Credits

- Emoji artwork: [Twemoji](https://github.com/jdecked/twemoji) by X Corp. and
  contributors, licensed **CC-BY 4.0** — see `assets/emoji/ATTRIBUTION.md`.
- Design lessons and the detection approach came from
  [ORB-HD/deface](https://github.com/ORB-HD/deface) (MIT) and
  [kmcheung12/faceblind](https://github.com/kmcheung12/faceblind).

## License

MIT — see `LICENSE`.
