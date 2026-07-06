#!/usr/bin/env python3
"""Local fallback: render ClientStoryboard via orion_visual_composer.py."""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "renderer"))

from orion_visual_composer import render_client_storyboard  # noqa: E402


def main() -> int:
    if len(sys.argv) < 5:
        print("usage: render-orion-storyboard-artifacts.py <payload.json> <pptxOut> <pdfOut> <pagesDir>", file=sys.stderr)
        return 1
    payload_path, pptx_out, pdf_out, pages_dir = sys.argv[1:5]
    payload = json.loads(Path(payload_path).read_text(encoding="utf-8"))
    result = render_client_storyboard(payload)
    pptx_path = Path(pptx_out)
    pdf_path = Path(pdf_out)
    pages_path = Path(pages_dir)
    pptx_path.parent.mkdir(parents=True, exist_ok=True)
    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    pages_path.mkdir(parents=True, exist_ok=True)
    pptx_path.write_bytes(base64.b64decode(result["pptxBase64"]))
    pdf_path.write_bytes(base64.b64decode(result["pdfBase64"]))
    for page in result.get("pages") or []:
        num = int(page["pageNumber"])
        out = pages_path / f"page-{num:02d}.png"
        out.write_bytes(base64.b64decode(page["contentBase64"]))
    meta_path = pptx_path.parent / "storyboard-render-meta.json"
    meta_path.write_text(
        json.dumps({"pdfExportMode": result.get("pdfExportMode"), "slideCount": result.get("slideCount")}, indent=2),
        encoding="utf-8",
    )
    print(json.dumps({"slideCount": result.get("slideCount"), "pdfExportMode": result.get("pdfExportMode")}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
