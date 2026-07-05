"""Generate R9.6a ORION report quality fix summary PDF."""

from __future__ import annotations

from pathlib import Path

import fitz

OUTPUT = Path(__file__).resolve().parents[1] / "storage" / "digital-profile" / "R9-6a-orion-report-quality-summary.pdf"

LINES: list[tuple[str, str]] = [
    ("R9.6a — ORION v2 Report Quality Fix", "title"),
    ("Ветка: feature/report-quality-r9-6a-orion-gpt-report-quality-r96a", "meta"),
    ("HEAD: 1de6ef9 (без коммита) · 05.07.2026", "meta"),
    ("", "gap"),
    ("ПРОБЛЕМА", "h2"),
    ("После включения live GPT-5.5 клиентский ORION v2 ухудшился:", "body"),
    ('• Placeholder "row" в таблицах', "bullet"),
    ('• Пустые таблицы "Поле / Значение"', "bullet"),
    ('• Generic "Этап анализа" на всех слайдах', "bullet"),
    ("• ORION_STATIC в клиентском контенте", "bullet"),
    ("• LexisNexis visual pages → пустые metric cards", "bullet"),
    ("• GPT вызовы успешны — проблема в контрактах данных и renderer", "bullet"),
    ("", "gap"),
    ("ROOT CAUSE ПО СЛОЯМ", "h2"),
    ('1. "row" — fallback renderer (report_template_v3.py)', "bullet"),
    ("2. ORION_STATIC — real-case-data-adapter.ts", "bullet"),
    ("3. Потеря GPT-контента — clientNarrative не попадал в slides", "bullet"),
    ("4. Тонкий evidence-pack — пустые micro-stages", "bullet"),
    ("5. Lexis visualRef есть, renderer игнорировал visuals[]", "bullet"),
    ('6. "Этап анализа" — deterministic-microstage-analysis.ts', "bullet"),
    ("", "gap"),
    ("ИСПРАВЛЕНИЯ", "h2"),
    ("• client-slide-contract.ts — sanitize tables/metrics/narratives", "bullet"),
    ("• slide-manifest-builder.ts — clientNarrative → slides", "bullet"),
    ("• embed-visual-assets.ts — Lexis PNG base64 в manifest", "bullet"),
    ('• Renderer: Lexis visual slides, убран fallback "row"', "bullet"),
    ("• GPT prompt + post-sanitize", "bullet"),
    ("• ORION_STATIC → COMMERCIAL_CONTEXT", "bullet"),
    ("• consistency-checker quality gates", "bullet"),
    ("", "gap"),
    ("QA (локально)", "h2"),
    ("typecheck ........................ PASS", "mono"),
    ("build ............................ PASS", "mono"),
    ("qa:r9-6a-orion-report-quality .... PASS", "mono"),
    ("smoke:orion-report-quality-r96a . PASS", "mono"),
    ("smoke:orion-gpt55-required-r95c . PASS", "mono"),
    ("smoke:orion-ui-integration-r95 .. PASS", "mono"),
    ("smoke:lexisnexis-hybrid-import .. PASS", "mono"),
    ("Pipeline: 69 client pages, consistency PASS", "body"),
    ("", "gap"),
    ("ВЕРДИКТ", "h2"),
    ("Локальные QA gates: PASS", "pass"),
    ("Production: BLOCKED до deploy app+renderer и rerun с Lexis/GPT", "warn"),
    ("", "gap"),
    ("СЛЕДУЮЩИЕ ШАГИ", "h2"),
    ("1. Deploy app + renderer на Railway", "bullet"),
    ("2. Перезапустить ORION v2 на кейсе с Lexis DOCX", "bullet"),
    ("3. Проверить PDF: narrative + Lexis page images", "bullet"),
    ("4. Commit & push когда готово", "bullet"),
]

STYLES = {
    "title": "font-size:22px;font-weight:bold;color:#1f3a5f;margin:0 0 8px;",
    "meta": "font-size:11px;color:#666;margin:0 0 4px;",
    "h2": "font-size:15px;font-weight:bold;color:#1f3a5f;margin:16px 0 6px;",
    "body": "font-size:12px;color:#222;margin:4px 0;",
    "bullet": "font-size:11px;color:#333;margin:2px 0 2px 8px;line-height:1.4;",
    "mono": "font-size:11px;font-family:monospace;color:#333;margin:2px 0;",
    "pass": "font-size:12px;color:#1a7f37;font-weight:bold;margin:4px 0;",
    "warn": "font-size:12px;color:#b45309;font-weight:bold;margin:4px 0;",
    "gap": "",
}


def main() -> None:
    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    rect = fitz.Rect(50, 45, 545, 800)
    parts: list[str] = ["<div style='font-family:sans-serif;'>"]
    for text, kind in LINES:
        if kind == "gap":
            parts.append("<div style='height:6px'></div>")
            continue
        style = STYLES.get(kind, STYLES["body"])
        escaped = (
            text.replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
        )
        parts.append(f"<p style='{style}'>{escaped}</p>")
    parts.append("</div>")
    html = "".join(parts)
    page.insert_htmlbox(rect, html)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(OUTPUT))
    doc.close()
    print(str(OUTPUT))
    print(f"bytes={OUTPUT.stat().st_size}")


if __name__ == "__main__":
    main()
