#!/usr/bin/env python3
"""REMEDIATION §6.2 — forbidden sidebar token soft-degrades; render succeeds.

Run from repo root:
  python scripts/smoke-sidebar-soft-degrade.py
"""

from __future__ import annotations

import base64
import json
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "renderer"))

import fitz  # noqa: E402
from orion_golden_renderer import SIDEBAR_SAFE_FALLBACK, render_orion_golden  # noqa: E402

# 1×1 PNG
TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
BANNED = "provider"


def main() -> int:
    payload = {
        "reportSpec": {"subject": {"displayName": "Тестов Иван"}},
        "deckManifest": {
            "finalSlides": [
                {
                    "template": "orion_golden_serp_screenshot",
                    "title": "Россия — поисковая выдача",
                    "assetRefs": ["serp_ru"],
                    "visualAnalysis": {
                        "sidebarMode": "context",
                        "headlineConclusion": f"Данные от {BANNED} X попали в вывод.",
                        "whatIsVisible": "На экране видны строки выдачи по субъекту.",
                        "clientMeaning": "Это важно для оценки цифрового следа.",
                        "recommendedActions": ["Сверить источники вручную."],
                        "highlightExplanations": [],
                        "moreSignalsCount": 0,
                    },
                }
            ]
        },
        "assets": [
            {
                "assetRef": "serp_ru",
                "kind": "serp_snapshot",
                "imageData": TINY_PNG_B64,
            }
        ],
    }

    out = render_orion_golden(payload)
    warnings = out.get("warnings") or []
    sidebar_warns = [w for w in warnings if str(w).startswith("sidebar-qa:")]
    assert sidebar_warns, f"expected sidebar-qa warnings, got {warnings}"
    assert any(BANNED in str(w) for w in sidebar_warns), sidebar_warns

    pdf_b64 = out.get("pdfBase64") or ""
    assert pdf_b64, "expected PDF bytes"
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        tmp.write(base64.b64decode(pdf_b64))
        pdf_path = Path(tmp.name)
    try:
        doc = fitz.open(pdf_path)
        text = "\n".join(page.get_text() for page in doc)
        doc.close()
    finally:
        pdf_path.unlink(missing_ok=True)

    assert BANNED not in text.lower(), f"banned token leaked into PDF:\n{text}"
    assert SIDEBAR_SAFE_FALLBACK in text or "таблицу результатов" in text.lower(), text

    print(
        json.dumps(
            {
                "ok": True,
                "sidebarWarnings": len(sidebar_warns),
                "pdfExportMode": out.get("pdfExportMode"),
                "slideCount": out.get("slideCount"),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
