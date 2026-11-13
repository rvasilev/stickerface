# Verification — how to prove a change works

Two gates. **Both** must pass; a green unit suite proves nothing about the app.

```bash
npm test      # 1. unit gate — pure logic, node, no DOM
npm run e2e   # 2. acceptance gate — a real browser driving the real page
```

## 1. Unit gate (`npm test`)

vitest, node environment. Covers only pure modules:

| File | What it proves |
|---|---|
| `tests/geometry.test.js` | norm↔px round-trips at 640×480 / 1920×1080 / 8000×5000, hit-test picks the topmost sticker and respects rotation, each handle pins the opposite corner, keepAspect holds the pixel ratio, `rotateTo` snapping, nudge |
| `tests/store.test.js` | add/move/resize/rotate/remove, clamping, one undo entry per drag, 20-operation undo/redo chain restores every intermediate snapshot |
| `tests/render-fallback.test.js` | the SVG raster fallback path (regression for the `viewBox`-only decode failure) |

If you add geometry, add it to `js/geometry.js` and test it there — not in the UI.

## 2. Acceptance gate (`npm run e2e`)

`tests/e2e/run.py` drives a **real headless Chrome** over the DevTools WebSocket
and evaluates `tests/e2e/probe.js` inside the page. The probe performs the actual
user journey and returns one boolean per acceptance criterion.

What it does, in order:

1. loads the page, counts picker buttons (must be exactly one per emoji — this
   catches duplicate initialisation);
2. uploads `tests/e2e/fixture.jpg` through the real `<input type=file>`;
3. asserts export is **enabled** once a photo is loaded;
4. drops an emoji sticker, a blur patch and a mosaic patch by dispatching real
   `pointerdown`/`pointerup` events at canvas coordinates;
5. nudges with a keyboard event and undoes;
6. exports PNG and captures the Blob instead of downloading it, then proves:
   blob exists, dimensions equal the source's natural size, the sticker area
   **changed**, an untouched corner is **byte-identical** (±2 per channel);
7. exports JPEG and scans the first 8 KB for an `APP1`/EXIF segment (must be absent).

### Running it by hand

```bash
python3 scripts/make-fixture.py            # writes tests/e2e/fixture.jpg (1200×800)
python3 -m http.server 8123 &              # serve the repo (must stay up)

google-chrome-stable --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/sf-chrome --no-first-run --disable-gpu \
  "http://127.0.0.1:8123/index.html" &     # URL on the command line — see note

python3 tests/e2e/run.py tests/e2e/probe.js
echo "exit=$?"
```

Notes and traps:

- **The URL goes on Chrome's command line.** `Page.navigate` (and the Hermes CDP
  tool generally) refuses loopback/private page URLs, so the driver never
  navigates — it reloads whatever the browser was started on.
- Needs Python `websockets` (stdlib-adjacent, already present on this box). No
  Playwright/Puppeteer is installed, and this harness deliberately does not add
  one.
- Exit code 0 = all criteria passed; 1 = at least one FAIL is printed under
  `=== checks ===`. The probe also prints raw evidence (`exportSize`,
  `centreExport` vs `centreSource`, blob sizes) so a failure is diagnosable
  without re-running.
- Run it against the **deployed** site too, to prove the published artifact
  works, not just your working tree:

  ```bash
  google-chrome-stable --headless=new --remote-debugging-port=9223 \
    --user-data-dir=/tmp/sf-chrome-live --no-first-run --disable-gpu \
    "https://rvasilev.github.io/stickerface/" &
  CDP_HTTP=http://127.0.0.1:9223 python3 tests/e2e/run.py tests/e2e/probe.js github.io
  ```

### Adding a criterion

Add a `r.yourCriterionName = <boolean>` line and a `log(...)` line with the
evidence. Top-level boolean keys are the checks; `steps` is the evidence trail.
Keep it honest: a criterion that cannot fail is not a test.

### Trap: GitHub Pages CDN caching

Pages serves static files through a CDN with a ~10-minute TTL, so a probe (or an
app module) pushed seconds ago is **not** what the live run executes — you will
silently verify the previous revision. Both the probe fetch and the fixture fetch
therefore append `?cb=<Date.now()>` with `cache: 'no-store'`. Do not remove that.

### Trap: the probe path must be RELATIVE

The app is served at the origin root locally (`/index.html`) but under
`/stickerface/` on GitHub Pages. A root-absolute fetch (`/tests/e2e/probe.js`)
resolves to the origin root on Pages, returns a 404 **HTML** page, and the eval
fails with `SyntaxError: Unexpected token '<'`. Always fetch the probe relative to
the document (`tests/e2e/probe.js`).

## Manual checklist (things the probe cannot see)

- `ctx.filter` blur on Safari < 18 (the harness runs Chromium; the fallback path
  is not covered — see `docs/DEPS.md` for the StackBlur option).
- A 40 MP photo: preview stays interactive, export returns full-resolution output.
- An EXIF-rotated JPEG and a non-Latin filename.
- Keyboard-only run: drop a sticker, nudge, rotate, delete, undo.
- Browser display scaling at 400%.

## Reporting rules

- Paste real output. `12/12 passed` and `E2E_EXIT=0`, or the failing lines.
- Never claim a probe passed that you did not run. If Chrome will not start, say
  that instead.
- If a criterion is red, ship nothing and say which one.
