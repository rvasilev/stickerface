#!/usr/bin/env bash
# Generates the committed PNG icons from the committed SVGs.
#
# Run ONCE when the artwork changes; the output is COMMITTED. Nothing generates icons at
# deploy time and the repository stays buildless — the same arrangement as
# scripts/fetch-emoji.mjs, whose output (js/emoji.js) is also a committed artifact.
#
# Requires librsvg (rsvg-convert).
set -euo pipefail
cd "$(dirname "$0")/.."

command -v rsvg-convert >/dev/null || {
  echo "make-icons: rsvg-convert missing (Debian/Ubuntu: librsvg2-bin)" >&2
  exit 2
}

rsvg-convert -w 192 -h 192 icons/icon.svg          -o icons/icon-192.png
rsvg-convert -w 512 -h 512 icons/icon.svg          -o icons/icon-512.png
rsvg-convert -w 512 -h 512 icons/icon-maskable.svg -o icons/maskable-512.png

# From the MASKABLE source on purpose: iOS applies its own rounding to apple-touch-icon, so
# a full-bleed square avoids a double-rounded, oddly-inset home-screen icon.
rsvg-convert -w 180 -h 180 icons/icon-maskable.svg -o icons/apple-touch-icon.png

echo "icons: $(ls -1 icons/*.png | wc -l) PNG(s) written"
