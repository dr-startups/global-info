"""ORION Golden Report renderer — R10 deterministic PPTX/PDF from ReportSpec + deck manifest."""

from __future__ import annotations

import base64
import io
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

import fitz
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Pt

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None  # type: ignore

FONT = "Arial"
FS_TITLE = 26
FS_SECTION = 22
FS_SUBTITLE = 13
FS_BODY = 12
FS_CAPTION = 9

MARGIN_X = 420000
CONTENT_W = 8300000
SLIDE_H = 6858000
FOOTER_Y = 6420000
CONTENT_BOTTOM = 6200000

NAVY = RGBColor(0x0B, 0x1A, 0x33)
TITLE_COLOR = RGBColor(0xF8, 0xFA, 0xFC)
BODY_COLOR = RGBColor(0x33, 0x41, 0x55)
MUTED_COLOR = RGBColor(0x64, 0x74, 0x8B)
ACCENT = RGBColor(0x3B, 0x82, 0xF6)
CARD_BG = RGBColor(0xF8, 0xFA, 0xFC)
CARD_BORDER = RGBColor(0xE2, 0xE8, 0xF0)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)

FORBIDDEN = re.compile(
    r"(storage/|C:\\\\|openai[_-]?api[_-]?key|cmr[a-z0-9]{10,}|adverse_media|requires_review)",
    re.I,
)


def _safe(text: object) -> str:
    val = re.sub(r"\s+", " ", str(text or "")).strip()
    val = FORBIDDEN.sub("", val)
    # Humanize residual enum-like tokens that may appear in summaries
    val = re.sub(r"\bWRONG[_\s-]?SUBJECT\b", "другой субъект", val, flags=re.I)
    val = re.sub(r"\bPENDING\b", "требует проверки", val, flags=re.I)
    val = re.sub(r"\bGPT\b", "модельный анализ", val)
    return val.strip()


def _clip_words(text: str, max_chars: int) -> str:
    """Clip on sentence/word boundary without forcing an ellipsis mid-thought."""
    val = _safe(text)
    if len(val) <= max_chars:
        return val
    slice_ = val[:max_chars]
    punct = max(slice_.rfind(". "), slice_.rfind("! "), slice_.rfind("? "))
    if punct > max_chars * 0.55:
        return slice_[: punct + 1].rstrip()
    sp = max(slice_.rfind(" "), slice_.rfind("\u00a0"))
    if sp > max_chars * 0.45:
        return slice_[:sp].rstrip()
    soft = re.sub(r"[^\s]{1,12}$", "", slice_).rstrip()
    if len(soft) > max_chars * 0.4:
        return soft
    return slice_.rstrip()


class _Ctx:
    def __init__(self, prs: Presentation, page: int, total: int):
        self.prs = prs
        self.page = page
        self.total = total
        layout = prs.slide_layouts[6] if len(prs.slide_layouts) > 6 else prs.slide_layouts[0]
        self.slide = prs.slides.add_slide(layout)

    def footer(self) -> None:
        box = self.slide.shapes.add_textbox(Emu(MARGIN_X), Emu(FOOTER_Y), Emu(CONTENT_W), Emu(250000))
        tf = box.text_frame
        p = tf.paragraphs[0]
        p.alignment = PP_ALIGN.RIGHT
        r = p.add_run()
        r.text = f"{self.page} / {self.total}"
        r.font.name = FONT
        r.font.size = Pt(FS_CAPTION)
        r.font.color.rgb = MUTED_COLOR

    def dark_bg(self) -> None:
        fill = self.slide.background.fill
        fill.solid()
        fill.fore_color.rgb = NAVY

    def light_bg(self) -> None:
        fill = self.slide.background.fill
        fill.solid()
        fill.fore_color.rgb = WHITE

    def title(self, text: str, y: int = 280000, color: RGBColor = TITLE_COLOR, size: int = FS_TITLE) -> int:
        box = self.slide.shapes.add_textbox(Emu(MARGIN_X), Emu(y), Emu(CONTENT_W), Emu(900000))
        tf = box.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        r = p.add_run()
        r.text = _safe(text)
        r.font.name = FONT
        r.font.bold = True
        r.font.size = Pt(size)
        r.font.color.rgb = color
        return y + 950000

    def body(self, text: str, y: int, max_h: int = 900000, color: RGBColor = BODY_COLOR) -> int:
        # Cap height so body never collides with footer
        avail = max(200000, min(max_h, CONTENT_BOTTOM - y))
        box = self.slide.shapes.add_textbox(Emu(MARGIN_X), Emu(y), Emu(CONTENT_W), Emu(avail))
        tf = box.text_frame
        tf.word_wrap = True
        # Split long narrative into short paragraphs for readability
        chunks = [c.strip() for c in re.split(r"\n+", _safe(text)) if c.strip()]
        if not chunks:
            chunks = [""]
        first = True
        used_chars = 0
        for chunk in chunks[:6]:
            p = tf.paragraphs[0] if first else tf.add_paragraph()
            first = False
            p.space_after = Pt(8)
            r = p.add_run()
            clipped = _clip_words(chunk, 900)
            r.text = clipped
            used_chars += len(clipped)
            r.font.name = FONT
            r.font.size = Pt(FS_BODY)
            r.font.color.rgb = color
        # Estimate consumed height (~18pt line) instead of returning full avail
        est_lines = max(2, min(14, used_chars // 90 + len(chunks)))
        used_h = min(avail, est_lines * 230000 + 120000)
        return y + used_h

    def bullets(self, items: list[str], y: int, color: RGBColor = BODY_COLOR, max_items: int = 8, max_chars: int = 280) -> int:
        avail = max(400000, CONTENT_BOTTOM - y)
        box = self.slide.shapes.add_textbox(Emu(MARGIN_X), Emu(y), Emu(CONTENT_W), Emu(avail))
        tf = box.text_frame
        tf.word_wrap = True
        first = True
        for bullet in items[:max_items]:
            p = tf.paragraphs[0] if first else tf.add_paragraph()
            first = False
            # R10.9a — explicit spacing prevents overlapping bullet lines
            p.space_before = Pt(4)
            p.space_after = Pt(10)
            p.line_spacing = 1.15
            r = p.add_run()
            clipped = _clip_words(bullet, max_chars)
            r.text = f"• {clipped}"
            r.font.name = FONT
            r.font.size = Pt(FS_BODY)
            r.font.color.rgb = color
        return y + avail

    def card(self, y: int, h: int = 4200000) -> None:
        avail = max(300000, min(h, CONTENT_BOTTOM - y))
        shape = self.slide.shapes.add_shape(1, Emu(MARGIN_X), Emu(y), Emu(CONTENT_W), Emu(avail))
        shape.fill.solid()
        shape.fill.fore_color.rgb = CARD_BG
        shape.line.color.rgb = CARD_BORDER


def _asset_map(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(a.get("assetRef")): a for a in payload.get("assets") or []}


def _resolve_image_bytes(asset: dict[str, Any] | None) -> bytes | None:
    """Load PNG/JPEG bytes from inline imageData or DATA_ROOT storageKey."""
    if not asset:
        return None
    img_data = asset.get("imageData")
    if img_data:
        try:
            raw = base64.b64decode(str(img_data))
            if len(raw) > 500:
                return raw
        except Exception:  # noqa: BLE001
            pass
    storage_key = str(asset.get("storageKey") or "").strip().lstrip("/")
    if storage_key:
        data_root = Path(os.environ.get("DATA_ROOT", "/data"))
        # storage keys are relative to digital-profile root; DATA_ROOT usually mounts that root.
        candidates = [
            data_root / storage_key,
            data_root / "digital-profile" / storage_key,
            Path(storage_key),
        ]
        for path in candidates:
            try:
                if path.is_file() and path.stat().st_size > 500:
                    return path.read_bytes()
            except OSError:
                continue
    return None


def _embed_image(ctx: _Ctx, asset: dict[str, Any] | None, y: int, h: int = 4800000) -> None:
    if not asset:
        ctx.body("Визуальный материал недоступен для данного раздела.", y)
        return
    raw = _resolve_image_bytes(asset)
    if raw:
        # BytesIO — do not rely on temp files that may be unlinked before PPTX save.
        stream = io.BytesIO(raw)
        ctx.slide.shapes.add_picture(stream, Emu(MARGIN_X), Emu(y), width=Emu(CONTENT_W), height=Emu(h))
        return
    title = _safe(asset.get("title") or "Источник")
    domain = _safe(asset.get("caption") or asset.get("storageKey") or "")
    ctx.card(y, h)
    ctx.body(f"{title}\n{domain}\nИзображение недоступно — показаны источник и описание.", y + 120000, max_h=h - 200000)


def _render_slide(ctx: _Ctx, slide: dict[str, Any], assets: dict[str, dict[str, Any]]) -> None:
    template = str(slide.get("template") or "")
    title = _safe(slide.get("title") or "ORION")
    narrative = _safe(slide.get("narrative") or "")
    bullets = [_safe(b) for b in slide.get("bullets") or [] if _safe(b)]
    refs = slide.get("assetRefs") or []
    primary = assets.get(str(refs[0])) if refs else None

    if template == "orion_golden_cover":
        ctx.dark_bg()
        y = ctx.title("ORION Digital Profile", 1800000, WHITE, 34)
        ctx.body(narrative or title, y, max_h=700000, color=RGBColor(0xBF, 0xDB, 0xFE))
        ctx.body("Клиентский аудит · предварительная оценка", y + 900000, max_h=400000, color=MUTED_COLOR)
        return

    if template == "orion_golden_toc":
        ctx.dark_bg()
        y = ctx.title("Содержание отчёта", 400000, WHITE, FS_SECTION)
        ctx.bullets(
            bullets or ["Резюме", "Россия", "ОАЭ", "Compliance", "LexisNexis", "Рекомендации"],
            y,
            color=WHITE,
            max_items=14,
        )
        return

    if template == "orion_golden_executive_card":
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY, FS_SECTION)
        # Narrative-only slide (part 1) vs themes slide: give narrative more vertical room.
        narr = narrative.strip()
        if narr and not bullets:
            card_h = min(5200000, max(1600000, CONTENT_BOTTOM - y - 200000))
            ctx.card(y, h=card_h)
            # Do not hard-clip the full résumé; body splits paragraphs itself.
            ctx.body(narr, y + 100000, max_h=card_h - 160000)
            return
        if narr:
            narr_show = _clip_words(narr, 2200)
            card_h = min(2800000, max(800000, len(narr_show) * 1600 + 200000))
            max_card = max(800000, CONTENT_BOTTOM - y - (1100000 if bullets else 200000))
            card_h = min(card_h, max_card)
            ctx.card(y, h=card_h)
            y = ctx.body(narr_show, y + 100000, max_h=card_h - 160000)
            y = y + 140000
        if bullets:
            ctx.bullets(bullets, y, max_items=7, max_chars=280)
        return

    if template == "orion_golden_risk_matrix":
        ctx.light_bg()
        y = ctx.title(title or "Матрица рисков", 280000, NAVY, FS_SECTION)
        ctx.body(
            "Уровни риска показаны в клиентских формулировках. Материалы «Требует проверки» не являются подтверждённым риском.",
            y,
            max_h=520000,
            color=MUTED_COLOR,
        )
        y = y + 560000
        ctx.card(y, h=CONTENT_BOTTOM - y - 80000)
        ctx.bullets(bullets or ["Существенных подтверждённых тем риска не выявлено."], y + 100000, max_items=8)
        return

    if template == "orion_golden_region_divider":
        ctx.dark_bg()
        ctx.title(title, 2800000, WHITE, 34)
        return

    if template == "orion_golden_serp_screenshot":
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY)
        # Leave room for API caption under the visual.
        img_h = 4600000 if bullets else 5000000
        _embed_image(ctx, primary, y + 60000, h=img_h)
        if bullets:
            ctx.body(bullets[0], CONTENT_BOTTOM - 420000, max_h=380000, color=MUTED_COLOR)
        return

    if template == "orion_golden_image_grid":
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY)
        cols = 3
        cell_w = 2600000
        cell_h = 1500000
        gap = 120000
        for idx, ref in enumerate(refs[:6]):
            row = idx // cols
            col = idx % cols
            cx = MARGIN_X + col * (cell_w + gap)
            cy = y + row * (cell_h + gap)
            asset = assets.get(str(ref))
            if asset and asset.get("imageData"):
                stream = io.BytesIO(base64.b64decode(str(asset.get("imageData"))))
                ctx.slide.shapes.add_picture(stream, Emu(cx), Emu(cy), width=Emu(cell_w), height=Emu(cell_h))
            else:
                shape = ctx.slide.shapes.add_shape(1, Emu(cx), Emu(cy), Emu(cell_w), Emu(cell_h))
                shape.fill.solid()
                shape.fill.fore_color.rgb = CARD_BG
                shape.line.color.rgb = CARD_BORDER
                tf = shape.text_frame
                tf.word_wrap = True
                p = tf.paragraphs[0]
                r = p.add_run()
                r.text = _safe((asset or {}).get("title") or "Недоступно")
                r.font.size = Pt(FS_CAPTION)
        return

    if template == "orion_golden_video_cards":
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY)
        ctx.bullets(bullets or [_safe((primary or {}).get("title"))], y)
        return

    if template == "orion_golden_lexis_visual_page":
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY)
        _embed_image(ctx, primary, y + 60000, h=5000000)
        return

    if template == "orion_golden_search_table":
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY, FS_SECTION)
        if narrative:
            y = ctx.body(_clip_words(narrative, 320), y, max_h=520000, color=MUTED_COLOR)
            y = y + 60000
        # Dense SERP / suggestion / heat-grid rows
        avail = max(400000, CONTENT_BOTTOM - y)
        box = ctx.slide.shapes.add_textbox(Emu(MARGIN_X), Emu(y), Emu(CONTENT_W), Emu(avail))
        tf = box.text_frame
        tf.word_wrap = True
        first = True
        for bullet in bullets[:18]:
            p = tf.paragraphs[0] if first else tf.add_paragraph()
            first = False
            p.space_before = Pt(2)
            p.space_after = Pt(5)
            p.line_spacing = 1.05
            r = p.add_run()
            clipped = _clip_words(bullet, 160)
            r.text = f"• {clipped}"
            r.font.name = FONT
            r.font.size = Pt(11)
            # Highlight adverse heat-grid rows
            if clipped.startswith("[Н]"):
                r.font.color.rgb = RGBColor(0xB9, 0x1C, 0x1C)
            else:
                r.font.color.rgb = BODY_COLOR
        return

    if template == "orion_golden_no_data_compact":
        ctx.light_bg()
        y = ctx.title(title, 320000, NAVY)
        ctx.body(narrative or "Для данного раздела недостаточно подтверждённых данных.", y)
        return

    if template == "orion_golden_audit_dashboard":
        # ORION regional résumé: themes left-ish via bullets top, KPI counters below.
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY, FS_SECTION)
        if narrative:
            y = ctx.body(_clip_words(narrative, 520), y, max_h=1000000)
            y = y + 80000
        if bullets:
            ctx.bullets(bullets, y, max_items=14, max_chars=220)
        return

    # default section summary / appendix
    ctx.light_bg()
    y = ctx.title(title, 280000, NAVY, FS_SECTION)
    # Prefer bullets for dense content; keep narrative short to avoid overlap
    short_narrative = _clip_words(narrative, 480) if narrative else ""
    if short_narrative and not bullets:
        ctx.body(short_narrative, y, max_h=CONTENT_BOTTOM - y - 100000)
        return
    if short_narrative:
        y = ctx.body(short_narrative, y, max_h=900000)
        y = y + 80000
    if bullets:
        ctx.bullets(bullets, y, max_items=8)


def _write_pdf_fallback(
    slides: list[dict[str, Any]],
    pdf_path: Path,
    subject: str,
    assets: dict[str, dict[str, Any]] | None = None,
) -> None:
    """Text+image PDF when LibreOffice is unavailable. Must embed SERP/Lexis imageData."""
    doc = fitz.open()
    asset_map = assets or {}
    all_slides = [{"title": "ORION Digital Profile", "body": subject}] + slides
    total = len(all_slides)
    visual_templates = {"orion_golden_serp_screenshot", "orion_golden_lexis_visual_page"}

    def esc(t: str) -> str:
        return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    for idx, slide in enumerate(all_slides, start=1):
        page = doc.new_page(width=1280, height=720)
        title = _safe(slide.get("title") or "ORION")
        template = str(slide.get("template") or "")
        refs = slide.get("assetRefs") or []
        primary = asset_map.get(str(refs[0])) if refs else None
        img_bytes: bytes | None = None
        if template in visual_templates and primary:
            img_bytes = _resolve_image_bytes(primary)

        if img_bytes and len(img_bytes) > 500:
            # Title strip + embedded visual (same data PPTX path uses).
            page.insert_textbox(
                fitz.Rect(48, 28, 1232, 72),
                title,
                fontsize=18,
                fontname="helv",
                color=(0.04, 0.10, 0.20),
            )
            try:
                page.insert_image(fitz.Rect(48, 80, 1232, 680), stream=img_bytes, keep_proportion=True)
            except Exception:  # noqa: BLE001
                page.insert_textbox(
                    fitz.Rect(48, 100, 1232, 200),
                    "Визуальный материал недоступен для данного раздела.",
                    fontsize=12,
                    fontname="helv",
                    color=(0.2, 0.25, 0.33),
                )
            page.insert_textbox(
                fitz.Rect(1100, 690, 1260, 710),
                f"{idx}/{total}",
                fontsize=10,
                fontname="helv",
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
        page.insert_htmlbox(fitz.Rect(48, 40, 1232, 680), html)
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


def render_orion_golden(payload: dict[str, Any]) -> dict[str, Any]:
    deck = payload.get("deckManifest") or {}
    report_spec = payload.get("reportSpec") or {}
    slides = list(deck.get("finalSlides") or [])
    if not slides:
        raise ValueError("deckManifest.finalSlides is empty")

    assets = _asset_map(payload)
    # Diagnostics for blank SERP slides (lengths only — never log base64).
    asset_diag = []
    for ref, asset in list(assets.items())[:20]:
        raw = _resolve_image_bytes(asset)
        asset_diag.append(
            {
                "assetRef": ref,
                "kind": asset.get("kind"),
                "hasImageData": bool(asset.get("imageData")),
                "imageDataChars": len(str(asset.get("imageData") or "")),
                "hasStorageKey": bool(asset.get("storageKey")),
                "resolvedBytes": len(raw) if raw else 0,
            }
        )
    print(
        "[orion-golden-render] assets",
        json.dumps(
            {
                "assetCount": len(assets),
                "serpSlides": sum(
                    1 for s in slides if str(s.get("template") or "") == "orion_golden_serp_screenshot"
                ),
                "sample": asset_diag[:8],
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    subject = (report_spec.get("subject") or {}).get("displayName") or "Цифровой профиль"
    total = len(slides)
    prs = Presentation()
    prs.slide_width = Emu(9144000)
    prs.slide_height = Emu(SLIDE_H)

    for idx, slide in enumerate(slides, start=1):
        ctx = _Ctx(prs, idx, total)
        _render_slide(ctx, slide, assets)
        ctx.footer()

    warnings: list[str] = []
    with tempfile.TemporaryDirectory(prefix="orion-golden-") as tmp:
        tmp_path = Path(tmp)
        pptx_path = tmp_path / "report.pptx"
        prs.save(str(pptx_path))
        pdf_path = tmp_path / "report.pdf"
        pdf_ok = False
        pdf_mode = "fitz-fallback"
        try:
            from convert_pdf import convert_to_pdf

            convert_to_pdf(str(pptx_path), str(pdf_path))
            pdf_ok = pdf_path.exists() and pdf_path.stat().st_size > 0
            if pdf_ok:
                pdf_mode = "libreoffice"
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"libreoffice-failed:{exc}")

        if not pdf_ok:
            _write_pdf_fallback(slides, pdf_path, str(subject), assets)
            pdf_mode = "fitz-fallback"

        print(f"[orion-golden-render] pdfExportMode={pdf_mode} warnings={warnings}", flush=True)
        pages = _export_png_pages(pdf_path)
        return {
            "slideCount": len(prs.slides),
            "pptxBase64": base64.b64encode(pptx_path.read_bytes()).decode("ascii"),
            "pdfBase64": base64.b64encode(pdf_path.read_bytes()).decode("ascii") if pdf_path.exists() else "",
            "pages": pages,
            "pdfExportMode": pdf_mode,
            "warnings": warnings,
        }


if __name__ == "__main__":
    import sys

    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out = render_orion_golden(data)
    Path(sys.argv[2]).write_bytes(base64.b64decode(out["pptxBase64"]))
    if out.get("pdfBase64"):
        Path(sys.argv[3]).write_bytes(base64.b64decode(out["pdfBase64"]))
    pages_dir = Path(sys.argv[4])
    pages_dir.mkdir(parents=True, exist_ok=True)
    for page in out.get("pages") or []:
        Path(pages_dir / f"page-{page['pageNumber']:02d}.png").write_bytes(
            base64.b64decode(page["contentBase64"])
        )
    meta = {"slideCount": out["slideCount"], "pages": len(out.get("pages") or []), "pdfExportMode": out.get("pdfExportMode")}
    Path(pages_dir.parent / "golden-render-meta.json").write_text(json.dumps(meta), encoding="utf-8")
    print(json.dumps(meta))
