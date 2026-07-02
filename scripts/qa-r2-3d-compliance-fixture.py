"""QA helper for R2.3d compliance table fixture rendering.

Creates a temporary fixture report JSON with representative non-empty compliance data,
renders PPTX/PDF locally, exports key PNG pages, and runs inspect checks.
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
OUT_DIR = DATA / "qa-r2-3d-compliance-fixture"


def _inject_fixture(report: dict) -> dict:
    report = json.loads(json.dumps(report))

    comp = report.setdefault("complianceSummary", {})
    comp["totalHits"] = 12
    comp["pendingHits"] = 5
    comp["confirmedHits"] = 4
    comp["falsePositives"] = 3
    comp["providerStatuses"] = [
        {
            "name": "DOW_JONES",
            "label": "Dow Jones Risk & Compliance Extended Provider",
            "status": "ENABLED",
            "enabled": True,
            "configured": True,
            "kind": "REAL",
            "supportsRealCalls": True,
        },
        {
            "name": "LEXISNEXIS",
            "label": "LexisNexis Compliance Corporate Watch",
            "status": "ENABLED",
            "enabled": True,
            "configured": True,
            "kind": "REAL",
            "supportsRealCalls": True,
        },
        {
            "name": "WORLD_CHECK",
            "label": "World-Check Enhanced Screening",
            "status": "ENABLED",
            "enabled": True,
            "configured": True,
            "kind": "REAL",
            "supportsRealCalls": True,
        },
        {
            "name": "MANUAL_IMPORT",
            "label": "Manual Import / Analyst Consolidated Feed",
            "status": "ENABLED",
            "enabled": True,
            "configured": True,
            "kind": "MANUAL",
            "supportsRealCalls": False,
        },
    ]
    comp["topHits"] = [
        {
            "provider": "DOW_JONES",
            "matchedName": "Tomilin Anatoly Romanovich — international sanctions watchlist long legal alias sample",
            "riskTypes": "SANCTIONS, PEP_RCA",
            "matchScore": 88,
            "confidence": "HIGH",
            "reviewStatus": "MATCH_CONFIRMED",
            "source": "https://data.example.org/records/very/long/path/that/should/not/be/raw/in/slide",
        },
        {
            "provider": "LEXISNEXIS",
            "matchedName": "A. R. Tomilin / Anatolii Romanovich Tomilin / transliteration stress-test variant",
            "riskTypes": "ADVERSE_MEDIA",
            "matchScore": 67,
            "confidence": "MEDIUM",
            "reviewStatus": "PENDING",
            "source": "LexisNexis API v3 / deep-source long descriptor",
        },
        {
            "provider": "WORLD_CHECK",
            "matchedName": "Tomilin family office affiliate with extended source title and long contextual suffix",
            "riskTypes": "LEGAL",
            "matchScore": 42,
            "confidence": "LOW",
            "reviewStatus": "FALSE_POSITIVE",
            "source": "www.long-source-domain-for-compliance-checks.example.com/some/path?q=1",
        },
        {
            "provider": "DOW_JONES",
            "matchedName": "Global watchlist mention with very long narrative description for table density stress",
            "riskTypes": "WATCHLIST",
            "matchScore": 79,
            "confidence": "MEDIUM",
            "reviewStatus": "NEEDS_REVIEW",
            "source": "",
        },
        {
            "provider": "LEXISNEXIS",
            "matchedName": "Business relationship overlap referencing offshore entity and board-level proxy chain",
            "riskTypes": "BUSINESS",
            "matchScore": 56,
            "confidence": "MEDIUM",
            "reviewStatus": "MATCH_CONFIRMED",
            "source": "https://corporate.registry.example/business/links/very/long/source",
        },
        {
            "provider": "MANUAL_IMPORT",
            "matchedName": "Composite compliance dossier row to validate continuation note and row clipping safeguards",
            "riskTypes": "COMPLIANCE",
            "matchScore": 51,
            "confidence": "LOW",
            "reviewStatus": "PENDING",
            "source": "Manual analyst workbook import",
        },
    ]

    # Backing rows for risk-type breakdown fallback in mapper.
    comp_rows = [
        ["DOW_JONES", "REAL_API", "Tomilin Anatoly Romanovich", "SANCTIONS, PEP_RCA", "88", "MATCH_CONFIRMED"],
        ["LEXISNEXIS", "REAL_API", "A. R. Tomilin", "ADVERSE_MEDIA", "67", "PENDING"],
        ["WORLD_CHECK", "MANUAL_IMPORT", "Tomilin affiliate", "LEGAL", "42", "DISMISSED"],
        ["MANUAL_IMPORT", "MANUAL_IMPORT", "Romanovich profile", "SANCTIONS", "73", "PENDING"],
        ["MANUAL_IMPORT", "MANUAL_IMPORT", "Tomilin trust", "PEP_RCA", "81", "MATCH_CONFIRMED"],
        ["WORLD_CHECK", "REAL_API", "Watchlist profile", "WATCHLIST", "65", "NEEDS_REVIEW"],
        ["LEXISNEXIS", "REAL_API", "Business links profile", "BUSINESS", "58", "MATCH_CONFIRMED"],
        ["DOW_JONES", "REAL_API", "Compliance dossier", "COMPLIANCE", "52", "PENDING"],
    ]
    comp_page = None
    for p in report.get("dynamicPages", []) or []:
        if p.get("kind") == "COMPLIANCE_DATABASES":
            comp_page = p
            break
    if comp_page is not None:
        table = comp_page.setdefault("table", {})
        table["rows"] = comp_rows
    else:
        report.setdefault("dynamicPages", []).append(
            {
                "kind": "COMPLIANCE_DATABASES",
                "title": "Fixture compliance rows",
                "table": {
                    "columns": ["provider", "source", "matchedName", "riskTypes", "score", "reviewStatus"],
                    "rows": comp_rows,
                },
            }
        )

    # Add selected risk findings for slide 36 table.
    sel = report.setdefault("selectedEvidence", {})
    rf = sel.setdefault("riskFindings", {})
    rf["selectedSubjectMatchedOnly"] = [
        {
            "title": "Potential sanctions exposure linked to cross-border intermediary network and unresolved ownership chain",
            "theme": "sanctions",
            "severity": "HIGH",
            "reviewStatus": "MATCH_CONFIRMED",
            "source": "Dow Jones consolidated feed",
            "evidenceCount": 3,
            "subjectMatched": True,
        },
        {
            "title": "Adverse media references require analyst verification before concluding material relevance",
            "theme": "adverse_media",
            "severity": "MEDIUM",
            "reviewStatus": "PENDING",
            "source": "https://news-source.example.com/long/url/for/normalization",
            "evidenceCount": 2,
            "subjectMatched": True,
        },
        {
            "title": "Legal registry mention with partial name overlap and uncertain date alignment",
            "theme": "legal",
            "severity": "LOW",
            "reviewStatus": "EXCLUDED",
            "source": "",
            "evidenceCount": 1,
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
            "from convert_pdf import convert_to_pdf; convert_to_pdf('/data/qa-r2-3d-compliance-fixture/report-v17-ru-internal-draft.pptx','/data/qa-r2-3d-compliance-fixture/report-v17-ru-internal-draft.pdf',timeout=600)",
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
    for page in (32, 33, 34, 36):
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
