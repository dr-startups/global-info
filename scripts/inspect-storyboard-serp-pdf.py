#!/usr/bin/env python3
"""Detect SERP pages with embedded images in storyboard PDF."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import fitz


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"hasSerpPixels": False, "serpPagesWithImages": []}))
        return 1
    pdf_path = Path(sys.argv[1])
    doc = fitz.open(str(pdf_path))
    pages_with_images: list[int] = []
    for i in range(len(doc)):
        page = doc[i]
        images = page.get_images(full=True)
        if images:
            pages_with_images.append(i + 1)
    doc.close()
    print(
        json.dumps(
            {
                "hasSerpPixels": len(pages_with_images) > 0,
                "serpPagesWithImages": pages_with_images,
                "pageCount": len(pages_with_images),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
