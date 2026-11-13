# AGENTS.md — working rules for this repo

Read `PLAN.md` first. It is the spec; this file is only how to work here.

## Stack rules

- **No bundler, no build step.** Vanilla ES modules, served as-is from the repo
  root by GitHub Pages. If you feel the urge to add Vite, stop and say why.
- **No runtime network calls.** Everything (emoji SVGs, fonts, code) is served
  from this repo. A request to a CDN breaks the product's only real promise.
- **No dependencies at runtime.** `devDependencies` (vitest, playwright) only.
- `js/geometry.js` is **pure** — no DOM, no canvas, no globals. It is the only
  module unit-tested in node, so anything geometric must live there.
- State stores **normalized** coordinates (0..1). Never persist pixel values.
- All exports composite at `image.naturalWidth/Height`, never at preview scale.

## Commands

```bash
NODE_ENV=development npm install --include=dev   # REQUIRED — this box exports NODE_ENV=production,
                                                 # which makes npm silently skip ALL devDependencies
npx vitest run          # unit tests
python3 -m http.server 8000   # manual check — file:// will NOT work (ES modules)
```

## Conventions

- Plain JS with JSDoc types. No TypeScript build step.
- 2-space indent, single quotes, semicolons. Functions over classes except for
  `Store`.
- Commit messages: imperative, one line, prefixed `feat:` / `fix:` / `test:` /
  `docs:` / `chore:`.
- Never commit downloaded model weights or the full Twemoji set — only the
  curated manifest in `js/emoji.js` and the SVGs it names.
- Keep `PLAN.md` acceptance criteria honest: if something is not done, say so in
  the summary rather than marking it done.

## Attribution (non-negotiable)

- Twemoji graphics: CC-BY 4.0 — keep `assets/emoji/ATTRIBUTION.md` and the credit
  line in `README.md` intact.
- The face-detection engine we take ideas from is `ORB-HD/deface` (MIT).
- Never present borrowed work as original.
