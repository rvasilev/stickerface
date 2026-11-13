# Name brainstorm (2026-11-13)

Goal: memorable, typeable, no trademark collision, no collision with the engine
we credit (`deface`), and it should still describe the tool *after* v2 adds
auto-detection.

| Candidate | GitHub repos with the name | Verdict |
|---|---|---|
| **stickerface** | 14 | **Recommended.** Says exactly what v1 does (a sticker on a face), still true in v2, no famous project/trademark, easy to say and spell. |
| facepatch | 2 | Runner-up. "Patch" = the sticker *and* the fix. Slightly vaguer. |
| unface | 21 | Cute, negative-space naming ("unface yourself"). Weaker SEO — "unface" reads like "interface" typo. |
| faceoff | 690 | **Reject** — CBS TV show + 1997 film + a face-swap project; unrankable. |
| deface | — | **Reject** — collides with the MIT engine we credit (`ORB-HD/deface`); implies a fork or a wrapper. |
| facemoji | 59 | **Reject** — Facemoji Keyboard (Baidu) is a shipping app; trademark exposure. |
| emojiface | 55 | **Reject** — generic; no identity. |
| facehider | 1 | Bland, but the only truly clean one. SEO-descriptive, low personality. |
| de-face / deemoji / smileface / pastes | — | No. |

**Decision: `stickerface`** → repo `rvasilev/stickerface`, site
`https://rvasilev.github.io/stickerface/`.

Tagline options: "Put a sticker on it." / "Hide faces. Keep the photo."

All npm names returned 404 (unclaimed) — irrelevant for a static site, useful
only if we ever publish the sticker-geometry module.
