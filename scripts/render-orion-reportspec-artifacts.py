from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RENDERER = ROOT / "renderer"
if str(RENDERER) not in sys.path:
    sys.path.insert(0, str(RENDERER))

from orion_report_spec_render import render_report_spec  # noqa: E402


def main() -> None:
    if len(sys.argv) < 5:
        print("usage: render-orion-reportspec-artifacts.py <reportSpec.json> <pptxOut> <pdfOut> <pagesDir>")
        sys.exit(2)
    spec_path = Path(sys.argv[1])
    pptx_out = Path(sys.argv[2])
    pdf_out = Path(sys.argv[3])
    pages_dir = Path(sys.argv[4])
    report_spec = json.loads(spec_path.read_text(encoding="utf-8"))
    result = render_report_spec(report_spec)
    pptx_out.parent.mkdir(parents=True, exist_ok=True)
    pdf_out.parent.mkdir(parents=True, exist_ok=True)
    pages_dir.mkdir(parents=True, exist_ok=True)
    import base64

    pptx_out.write_bytes(base64.b64decode(result["pptxBase64"]))
    if result.get("pdfBase64"):
        pdf_out.write_bytes(base64.b64decode(result["pdfBase64"]))
    for page in result.get("pages") or []:
        (pages_dir / f"page-{page['pageNumber']:02d}.png").write_bytes(
            base64.b64decode(page["contentBase64"])
        )
    print(json.dumps({"slideCount": result["slideCount"], "pages": len(result.get("pages") or [])}))


if __name__ == "__main__":
    main()
