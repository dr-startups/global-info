"""QA v19 — slide 14 ORION video evidence: render locally and export proof.

Renders the Tomilin report JSON through the local renderer container
(http://localhost:8080/render), saves artifacts into
storage/digital-profile/qa-v19-orion-slide14/, exports slide 13/14 PNGs,
and runs inspect-o541-pptx.py.

Run: python scripts/qa-v19-orion-slide14-local.py [source-report-json]
"""
from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

DATA = Path("storage/digital-profile")
OUT = DATA / "qa-v19-orion-slide14"
SRC_JSON = Path(
    sys.argv[1] if len(sys.argv) > 1 else str(DATA / "qa-v17-card-layout-integrity/report-json-ru.json")
)
RENDER_URL = "http://localhost:8080/render"


def attach_thumbnails(obj) -> None:
    """Wire thumbnail bytes the way report-renderer-service.ts does for real renders."""
    if isinstance(obj, dict):
        key = obj.get("thumbnailStorageKey")
        if key and not obj.get("thumbnailBytesBase64"):
            p = DATA / key.replace("/", os.sep)
            if p.is_file():
                b64 = base64.b64encode(p.read_bytes()).decode("ascii")
                obj["thumbnailBytesBase64"] = b64
                obj["thumbnailBase64"] = b64
                obj["hasThumbnail"] = True
        for v in obj.values():
            attach_thumbnails(v)
    elif isinstance(obj, list):
        for v in obj:
            attach_thumbnails(v)


def main() -> int:
    report = json.loads(SRC_JSON.read_text(encoding="utf-8"))
    attach_thumbnails(report)
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "pages-pdf").mkdir(exist_ok=True)
    json_path = OUT / "report-json-ru.json"
    json_path.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")

    payload = json.dumps(
        {
            "reportJson": report,
            "pptxKey": "qa/render.pptx",
            "pdfKey": "qa/render.pdf",
            "templateVersion": "report-template-v3",
            "audience": "internal",
            "watermarkMode": "draft",
            "reportLanguage": "ru",
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        RENDER_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=600) as resp:
        data = json.loads(resp.read().decode())
    print("slides=", data.get("slideCount"))

    pptx_path = OUT / "report-v17-ru-internal-draft.pptx"
    pdf_path = OUT / "report-v17-ru-internal-draft.pdf"
    pptx_path.write_bytes(base64.b64decode(data["pptx"]["contentBase64"]))
    pdf_path.write_bytes(base64.b64decode(data["pdf"]["contentBase64"]))
    print("pptx", pptx_path.stat().st_size, "pdf", pdf_path.stat().st_size)

    import fitz

    doc = fitz.open(str(pdf_path))
    for page_no in (13, 14):
        out_png = OUT / "pages-pdf" / f"page-{page_no:02d}.png"
        doc[page_no - 1].get_pixmap(matrix=fitz.Matrix(2, 2)).save(str(out_png))
        print("png", out_png)

    ins = subprocess.run(
        [sys.executable, "scripts/inspect-o541-pptx.py", str(pptx_path), str(json_path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    print(ins.stdout)
    if ins.stderr:
        print(ins.stderr, file=sys.stderr)

    (OUT / "artifact-inspection.json").write_text(
        json.dumps(
            {
                "slideCount": data.get("slideCount"),
                "inspectExitCode": ins.returncode,
                "layoutVersion": "v19-orion-slide14",
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return ins.returncode


if __name__ == "__main__":
    sys.exit(main())
