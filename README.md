# StickerFace

Put a sticker on it. Hide faces in a photo with an emoji, a blur patch or a
mosaic patch — **entirely in your browser**. No upload, no account, no install,
no telemetry. Works on Linux, macOS, Windows and phones.

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

- Three sticker kinds: **emoji** (curated Twemoji set, plus "use my own
  image" custom stickers), **blur** patches (adjustable strength and corner
  radius) and **mosaic** (pixelate) patches
- Click to drop, drag to move, 8 resize handles (corners keep aspect,
  `Shift` frees it) and a rotate handle (`Shift` snaps to 15°)
- Full-resolution export: PNG (default) or JPEG (quality 0.92), always
  composited at the source's natural size — **EXIF and GPS are dropped on
  export**
- "Apply layout to next photo": keeps the normalized sticker layout for the
  next image, warns if the aspect ratio differs by more than 5%
- Undo/redo (command pattern, one entry per drag), layer list with
  forward/back ordering, keyboard nudging (1 px / 10 px with `Shift`),
  `Delete` to remove, `[` / `]` to reorder
- Drag-and-drop a photo onto the stage; preview is capped at a 1600 px
  long edge so even a 40 MP photo stays interactive
- Zero network activity after the page loads; zero console errors on a
  plain static-server load

Roadmap: automatic face detection (v2) via a self-hosted MediaPipe BlazeFace
model. Video is explicitly out of scope.

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
