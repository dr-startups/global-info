"""Offline extract of report №72 PDF text and page inventory cues."""
from __future__ import annotations

import json
import re
from pathlib import Path

import fitz

PDF = Path(__file__).resolve().parent / "artifacts" / "orion-classic-audit-v72.pdf"
OUT_DIR = Path(__file__).resolve().parent / "artifacts"


def main() -> None:
    doc = fitz.open(PDF)
    page0 = doc[0]
    meta = {
        "page_count": doc.page_count,
        "page_width_pt": float(page0.rect.width),
        "page_height_pt": float(page0.rect.height),
    }
    pages = []
    for i, page in enumerate(doc, start=1):
        text = page.get_text("text")
        pages.append({"page": i, "text": text})

    (OUT_DIR / "pdf-text-extract.json").write_text(
        json.dumps({"meta": meta, "pages": pages}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    cont_re = re.compile(r"\((\d+)\s*/\s*(\d+)\)")
    n_str_re = re.compile(r"\((\d+)\s*стр\.?\)", re.I)
    inventory = []
    for p in pages:
        lines = [ln.strip() for ln in p["text"].splitlines() if ln.strip()]
        conts = [{"index": int(a), "of": int(b)} for a, b in cont_re.findall(p["text"])]
        toc_suffixes = n_str_re.findall(p["text"])
        inventory.append(
            {
                "page": p["page"],
                "headLines": lines[:6],
                "continuationMarkers": conts,
                "tocPageSuffixes": toc_suffixes,
                "charCount": len(p["text"]),
            }
        )

    (OUT_DIR / "pdf-page-inventory-cues.json").write_text(
        json.dumps({"meta": meta, "inventory": inventory}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    full = "\n".join(p["text"] for p in pages)
    provider_terms = [
        "Yandex",
        "Яндекс",
        "Google",
        "Serper",
        "Arsenkin",
        "Wikipedia",
        "Википедия",
        "LexisNexis",
        "Lexis",
        "Dow Jones",
        "World-Check",
        "World Check",
    ]
    provider_counts = {t: len(re.findall(re.escape(t), full, flags=re.I)) for t in provider_terms}

    # Capture percent and "N of M" / metric-like lines
    percent_hits = sorted(set(re.findall(r"\b\d{1,3}\s*%", full)))
    metric_lines = []
    for p in pages:
        for ln in p["text"].splitlines():
            s = ln.strip()
            if not s:
                continue
            if re.search(r"\d+\s*%", s) or re.search(r"\b\d+\s*/\s*\d+\b", s):
                metric_lines.append({"page": p["page"], "line": s})
            elif re.search(
                r"(результат|подсказ|изображен|запрос|adverse|негатив|wiki|викип|KPI|показател|выдач)",
                s,
                re.I,
            ) and re.search(r"\d+", s):
                metric_lines.append({"page": p["page"], "line": s})

    signals = {
        "providerMentionCounts": provider_counts,
        "uniquePercentTokens": percent_hits,
        "metricLines": metric_lines[:400],
    }
    (OUT_DIR / "pdf-kpi-provider-signals.json").write_text(
        json.dumps(signals, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(json.dumps({"meta": meta, "providerMentionCounts": provider_counts}, ensure_ascii=False, indent=2))
    for row in inventory:
        head = " | ".join(row["headLines"][:3])[:160]
        print(f"P{row['page']:02d} cont={row['continuationMarkers']} :: {head}")


if __name__ == "__main__":
    main()
