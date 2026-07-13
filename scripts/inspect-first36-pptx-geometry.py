#!/usr/bin/env python3
"""First36 PPTX geometry inspector → JSON {overlaps, overflow} with page+detail."""

from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path

FOOTER_SAFE_BOTTOM = 6315360


def slide_xml(z: zipfile.ZipFile, n: int) -> str:
    name = f"ppt/slides/slide{n}.xml"
    if name not in z.namelist():
        return ""
    return z.read(name).decode("utf-8", errors="ignore")


def boxes(xml: str) -> list[tuple[int, int, int, int]]:
    out: list[tuple[int, int, int, int]] = []
    for m in re.finditer(
        r'<a:off x="(\d+)" y="(\d+)"[^/]*/>[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"',
        xml,
    ):
        x, y, cx, cy = (int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)))
        out.append((x, y, cx, cy))
    return out


def inspect(pptx: Path) -> dict:
    overlaps: list[dict] = []
    overflow: list[dict] = []
    with zipfile.ZipFile(pptx) as z:
        for page in range(1, 37):
            xml = slide_xml(z, page)
            if not xml:
                overflow.append({"page": page, "detail": "missing slide xml"})
                continue
            bx = boxes(xml)
            for i, (x, y, cx, cy) in enumerate(bx):
                bottom = y + cy
                if bottom > FOOTER_SAFE_BOTTOM:
                    overflow.append(
                        {
                            "page": page,
                            "detail": f"shape bottom {bottom} exceeds footer safe {FOOTER_SAFE_BOTTOM}",
                        }
                    )
            for i in range(len(bx)):
                for j in range(i + 1, len(bx)):
                    ax, ay, acx, acy = bx[i]
                    bx_, by, bcx, bcy = bx[j]
                    horiz = ax < bx_ + bcx and bx_ < ax + acx
                    vert = ay < by + bcy and by < ay + acy
                    if horiz and vert:
                        overlaps.append(
                            {"page": page, "detail": f"overlapping shapes i={i} j={j}"}
                        )
    return {"overlaps": overlaps, "overflow": overflow}


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: inspect-first36-pptx-geometry.py <pptx>"}))
        return 2
    pptx = Path(sys.argv[1])
    if not pptx.exists():
        print(json.dumps({"error": f"missing {pptx}"}))
        return 2
    try:
        print(json.dumps(inspect(pptx), ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
