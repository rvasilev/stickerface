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
python3 -m http.server 8000      # file:// does NOT work (ES modules)
# → http://localhost:8000
```

## Features

v1 manual placement (images only — video is not supported):

- **Emoji stickers** from a curated Twemoji set; click the canvas to drop one
- **Selected-sticker pad** in the panel — nudge arrows with a 1 px / 10 px step and
  size −/+ — so a sticker resized too small to grab can still be moved and resized
- Click to drop, drag to move, 8 resize handles (corners keep aspect,
  `Shift` frees it) and a rotate handle (`Shift` snaps to 15°)
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
