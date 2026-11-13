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

- Click to drop an emoji sticker, drag / resize / rotate it
- Blur and mosaic (pixelate) patches with adjustable strength
- Full-resolution export (PNG or JPEG) — **EXIF and GPS are dropped on export**
- Batch workflow: "apply this layout to the next photo"
- Undo/redo, keyboard nudging, layer ordering
- Zero network activity after the page loads

Roadmap: automatic face detection (v2) via a self-hosted MediaPipe BlazeFace
model. Video is explicitly out of scope.

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
