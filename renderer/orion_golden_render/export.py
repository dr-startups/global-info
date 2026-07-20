"""PDF fallback and PNG page export."""

from __future__ import annotations

import base64
import io
import json
import os
from pathlib import Path
from typing import Any

import fitz
from pptx.dml.color import RGBColor

from .common import (
    BODY_COLOR,
    FONT,
    FS_BODY,
    FS_CAPTION,
    FS_SECTION,
    MUTED_COLOR,
    NAVY,
    SLIDE_H,
    SLIDE_W,
    TITLE_COLOR,
    WHITE,
    _asset_map,
    _font_path,
    _resolve_image_bytes,
    _safe,
    assert_render_font_family,
)

def _pdf_cyrillic_fontfile() -> str | None:
    """Prefer a system font that can render Russian in fitz insert_textbox."""
    candidates = [
        Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "arial.ttf",
        Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts" / "arialuni.ttf",
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        Path("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"),
    ]
    for p in candidates:
        try:
            if p.is_file():
                return str(p)
        except OSError:
            continue
    return None


def _write_pdf_fallback(
    slides: list[dict[str, Any]],
    pdf_path: Path,
    subject: str,
    assets: dict[str, dict[str, Any]] | None = None,
) -> None:
    """Text+image PDF when LibreOffice is unavailable. Must embed SERP/Lexis imageData."""
    doc = fitz.open()
    asset_map = assets or {}
    # Match PPTX master 16:10 (do not invent an extra cover page — slides already include cover).
    all_slides = list(slides)
    total = len(all_slides)
    # 16:10 page geometry (px @ 100dpi of 12.8"×8.0")
    page_w, page_h = 1280, 800
    margin_x, title_bottom, content_bottom, footer_y = 48, 72, 740, 770
    visual_templates = {
        "orion_golden_serp_screenshot",
        "orion_golden_lexis_visual_page",
        "orion_golden_image_grid",
        "orion_golden_video_cards",
        "orion_golden_knowledge_panel",
        "orion_golden_surface_panel",
        "orion_golden_lexis_visual_page",
        "orion_golden_compliance_visual_page",
    }
    fontfile = _pdf_cyrillic_fontfile()
    cyr_font = "ArialCyr"

    def esc(t: str) -> str:
        return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    def textbox(page: fitz.Page, rect: fitz.Rect, text: str, *, fontsize: float, color: tuple[float, float, float]) -> None:
        if fontfile:
            try:
                page.insert_font(fontname=cyr_font, fontfile=fontfile)
                page.insert_textbox(rect, text, fontsize=fontsize, fontname=cyr_font, color=color)
                return
            except Exception:  # noqa: BLE001
                pass
        page.insert_textbox(rect, text, fontsize=fontsize, fontname="helv", color=color)

    for idx, slide in enumerate(all_slides, start=1):
        page = doc.new_page(width=page_w, height=page_h)
        title = _safe(slide.get("title") or "ORION")
        template = str(slide.get("template") or "")
        refs = slide.get("assetRefs") or []
        primary = None
        for ref in refs:
            cand = asset_map.get(str(ref))
            if cand and _resolve_image_bytes(cand):
                primary = cand
                break
        if primary is None and refs:
            primary = asset_map.get(str(refs[0]))
        img_bytes: bytes | None = None
        if template in visual_templates and primary:
            img_bytes = _resolve_image_bytes(primary)

        if img_bytes and len(img_bytes) > 500:
            # Title strip + embedded visual (same data PPTX path uses).
            textbox(
                page,
                fitz.Rect(margin_x, 28, page_w - margin_x, title_bottom),
                title,
                fontsize=18,
                color=(0.04, 0.10, 0.20),
            )
            analysis = slide.get("visualAnalysis") if isinstance(slide.get("visualAnalysis"), dict) else {}
            has_side = bool(analysis) or bool(slide.get("clientTakeaway"))
            img_right = int(page_w * 0.62) if has_side else (page_w - margin_x)
            try:
                page.insert_image(
                    fitz.Rect(margin_x, 80, img_right, content_bottom),
                    stream=img_bytes,
                    keep_proportion=True,
                )
            except Exception:  # noqa: BLE001
                textbox(
                    page,
                    fitz.Rect(margin_x, 100, img_right, 200),
                    "Визуальный материал недоступен для данного раздела.",
                    fontsize=12,
                    color=(0.2, 0.25, 0.33),
                )
            if has_side:
                side_bits = [
                    _safe(analysis.get("headlineConclusion") or slide.get("clientTakeaway") or ""),
                    _safe(analysis.get("whatIsVisible") or ""),
                    _safe(analysis.get("whyItMatters") or ""),
                    _safe((analysis.get("limitations") or [None])[0] or ""),
                    _safe(analysis.get("provenanceLabel") or ""),
                ]
                side_text = "\n\n".join([b for b in side_bits if b])
                textbox(
                    page,
                    fitz.Rect(img_right + 16, 80, page_w - margin_x, content_bottom),
                    side_text[:1200],
                    fontsize=10,
                    color=(0.2, 0.25, 0.33),
                )
            textbox(
                page,
                fitz.Rect(page_w - 180, footer_y, page_w - margin_x, footer_y + 20),
                f"{idx}/{total}",
                fontsize=10,
                color=(0.58, 0.64, 0.72),
            )
            continue

        body = esc(_safe(slide.get("body") or slide.get("narrative") or ""))
        bullets = slide.get("bullets") or []
        bullet_html = "".join(f"<li>{esc(_safe(b))}</li>" for b in bullets[:8])
        html = (
            "<div style='font-family:Arial,sans-serif;color:#0b1a33;padding:8px;'>"
            f"<h1 style='font-size:22px;margin:0;'>{esc(title)}</h1>"
            f"<p style='margin-top:12px;font-size:12px;color:#334155;'>{body}</p>"
            f"<ul style='margin-top:12px;font-size:11px;color:#334155;'>{bullet_html}</ul>"
            f"<p style='position:absolute;bottom:16px;right:24px;color:#94a3b8;font-size:10px;'>{idx}/{total}</p>"
            "</div>"
        )
        page.insert_htmlbox(fitz.Rect(margin_x, 40, page_w - margin_x, content_bottom), html)
    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(pdf_path))
    doc.close()


def _export_png_pages(pdf_path: Path) -> list[dict[str, Any]]:
    doc = fitz.open(str(pdf_path))
    pages: list[dict[str, Any]] = []
    try:
        for i in range(len(doc)):
            pix = doc[i].get_pixmap(matrix=fitz.Matrix(2, 2))
            pages.append(
                {
                    "pageNumber": i + 1,
                    "width": pix.width,
                    "height": pix.height,
                    "contentBase64": base64.b64encode(pix.tobytes("png")).decode("ascii"),
                }
            )
    finally:
        doc.close()
    return pages


