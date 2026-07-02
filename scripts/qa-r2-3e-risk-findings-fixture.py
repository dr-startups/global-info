"""QA helper for R2.3e risk findings table fixture rendering.

Creates a temporary fixture report JSON with representative non-empty risk findings,
renders PPTX/PDF, exports key PNG pages, and runs inspect checks.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import fitz

sys.path.insert(0, "renderer")
from render_pptx import build_pptx  # noqa: E402


DATA = Path("storage/digital-profile")
SRC_DIR = DATA / "qa-r2-3d-compliance"
OUT_DIR = DATA / "qa-r2-3e-risk-findings-fixture"


def _inject_fixture(report: dict) -> dict:
    report = json.loads(json.dumps(report))
    selected = report.setdefault("selectedEvidence", {})
    risk = selected.setdefault("riskFindings", {})
    risk["selectedSubjectMatchedOnly"] = [
        {
            "title": "Open-source allegations with complex ownership references requiring legal context review",
            "theme": "reputation",
            "severity": "HIGH",
            "reviewStatus": "MATCH_CONFIRMED",
            "source": "https://investigations.example.com/very/long/path?query=123",
            "evidenceCount": 4,
            "subjectMatched": True,
        },
        {
            "title": "International litigation mention with partial name overlap and unresolved timeline",
            "theme": "litigation",
            "severity": "MEDIUM",
            "reviewStatus": "PENDING",
            "source": "",
            "evidenceCount": 2,
            "subjectMatched": True,
        },
        {
            "title": "Regional media narrative indicates reputational escalation risk in partner due-diligence",
            "theme": "adverse_publicity",
            "severity": "LOW",
            "reviewStatus": "NEEDS_REVIEW",
            "source": "www.global-news-monitor.example/article/long-slug",
            "evidenceCount": 3,
            "subjectMatched": True,
        },
        {
            "title": "Identity-proxy chain appears in corporate filing and needs manual source validation",
            "theme": "ownership",
            "severity": "CRITICAL",
            "reviewStatus": "FALSE_POSITIVE",
            "source": "manual_import",
            "evidenceCount": 1,
            "subjectMatched": True,
        },
        {
            "title": "Foreign language mention linked to operational control questions across jurisdictions",
            "theme": "control",
            "severity": "MEDIUM",
            "reviewStatus": "DISMISSED",
            "source": "GOOGLE_SEARCH_PROVIDER",
            "evidenceCount": 2,
            "subjectMatched": True,
        },
        {
            "title": "Regulatory publication summary with narrow context and low confidence attribution",
            "theme": "regulatory",
            "severity": "LOW",
            "reviewStatus": "PENDING",
            "source": "https://registry.example.org/records/alpha-beta",
            "evidenceCount": 1,
            "subjectMatched": True,
        },
        {
            "title": "Board-linked mention requires analyst follow-up before escalation decision",
            "theme": "governance",
            "severity": "HIGH",
            "reviewStatus": "NEEDS_REVIEW",
            "source": "providerAdapter:legacy/sourceMode:auto",
            "evidenceCount": 2,
            "subjectMatched": True,
        },
    ]
    return report


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "pages-pdf").mkdir(parents=True, exist_ok=True)

    src_json = SRC_DIR / "report-json-ru.json"
    if not src_json.exists():
        print(f"[FAIL] missing source json: {src_json}")
        return 1

    report = json.loads(src_json.read_text(encoding="utf-8"))
    fixture = _inject_fixture(report)

    json_path = OUT_DIR / "report-json-ru.json"
    pptx_path = OUT_DIR / "report-v17-ru-internal-draft.pptx"
    pdf_path = OUT_DIR / "report-v17-ru-internal-draft.pdf"
    json_path.write_text(json.dumps(fixture, ensure_ascii=False, indent=2), encoding="utf-8")

    warnings, slide_count = build_pptx(
        fixture,
        str(pptx_path),
        str(DATA),
        template_version="report-template-v3",
        audience="internal",
        watermark_mode="draft",
    )
    print(f"[INFO] fixture slides={slide_count} warnings={len(warnings)}")

    conv = subprocess.run(
        [
            "docker",
            "exec",
            "global-info-renderer",
            "python",
            "-c",
            "from convert_pdf import convert_to_pdf; convert_to_pdf('/data/qa-r2-3e-risk-findings-fixture/report-v17-ru-internal-draft.pptx','/data/qa-r2-3e-risk-findings-fixture/report-v17-ru-internal-draft.pdf',timeout=600)",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if conv.returncode != 0:
        print(conv.stdout)
        print(conv.stderr)
        print("[FAIL] fixture PDF conversion failed")
        return conv.returncode

    doc = fitz.open(str(pdf_path))
    for page in (17, 29):
        out = OUT_DIR / "pages-pdf" / f"page-{page:02d}.png"
        doc[page - 1].get_pixmap(matrix=fitz.Matrix(2, 2)).save(str(out))
        print(f"[INFO] png {out}")

    inspect = subprocess.run(
        [sys.executable, "scripts/inspect-0541-pptx.py", str(pptx_path), str(json_path)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if inspect.stdout:
        print(inspect.stdout, end="")
    if inspect.stderr:
        print(inspect.stderr, file=sys.stderr, end="")
    return inspect.returncode


if __name__ == "__main__":
    raise SystemExit(main())
