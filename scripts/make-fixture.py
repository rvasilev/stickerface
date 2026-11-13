#!/usr/bin/env python3
"""Generate the E2E fixture photo (deterministic, no network).

    python3 scripts/make-fixture.py

Writes tests/e2e/fixture.jpg — 1200x800, flat background, one skin-tone blob
where a face would be, and a red square in the corner to detect any unintended
change in a region that no sticker should touch.
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "tests" / "e2e" / "fixture.jpg"


def main() -> None:
    im = Image.new("RGB", (1200, 800), (20, 60, 120))
    d = ImageDraw.Draw(im)
    d.ellipse((500, 280, 700, 480), fill=(230, 180, 120))
    d.rectangle((0, 0, 60, 60), fill=(255, 0, 0))
    im.save(OUT, quality=95)
    print(f"wrote {OUT} {im.size}")


if __name__ == "__main__":
    main()
