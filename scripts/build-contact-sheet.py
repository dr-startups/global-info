"""Compose a contact sheet PNG from rendered page PNGs (offline, PIL)."""

from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image


def main() -> None:
    pages_dir = Path(sys.argv[1])
    out_path = Path(sys.argv[2])
    pages = sorted(pages_dir.glob("page-*.png"))
    if not pages:
        print("no pages; contact sheet skipped")
        return
    cols = 6
    rows = math.ceil(len(pages) / cols)
    thumb_w, thumb_h = 320, 200
    sheet = Image.new("RGB", (cols * thumb_w, rows * thumb_h), "white")
    for i, page in enumerate(pages):
        img = Image.open(page).convert("RGB")
        img.thumbnail((thumb_w - 8, thumb_h - 8))
        x = (i % cols) * thumb_w + 4
        y = (i // cols) * thumb_h + 4
        sheet.paste(img, (x, y))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_path)
    print(f"contact sheet: {out_path} ({len(pages)} pages, {cols}x{rows})")


if __name__ == "__main__":
    main()
