"""Local CLI wrapper for ORION Golden renderer."""

from __future__ import annotations

import json
import sys
from pathlib import Path

# Allow `python scripts/render-orion-golden-artifacts.py` from repo root / app image.
_ROOT = Path(__file__).resolve().parents[1]
_RENDERER = _ROOT / "renderer"
if str(_RENDERER) not in sys.path:
    sys.path.insert(0, str(_RENDERER))

from orion_golden_renderer import render_orion_golden


def main() -> None:
    payload_path = Path(sys.argv[1])
    pptx_out = Path(sys.argv[2])
    pdf_out = Path(sys.argv[3])
    pages_dir = Path(sys.argv[4])
    data = json.loads(payload_path.read_text(encoding="utf-8"))
    out = render_orion_golden(data)
    pptx_out.parent.mkdir(parents=True, exist_ok=True)
    pdf_out.parent.mkdir(parents=True, exist_ok=True)
    pages_dir.mkdir(parents=True, exist_ok=True)
    import base64

    pptx_out.write_bytes(base64.b64decode(out["pptxBase64"]))
    if out.get("pdfBase64"):
        pdf_out.write_bytes(base64.b64decode(out["pdfBase64"]))
    for page in out.get("pages") or []:
        (pages_dir / f"page-{page['pageNumber']:02d}.png").write_bytes(
            base64.b64decode(page["contentBase64"])
        )
    meta = {
        "slideCount": out["slideCount"],
        "pages": len(out.get("pages") or []),
        "pdfExportMode": out.get("pdfExportMode"),
        "warnings": out.get("warnings") or [],
        "via": "local-python",
    }
    (pages_dir.parent / "golden-render-meta.json").write_text(json.dumps(meta), encoding="utf-8")
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
