"""ORION Client Storyboard Visual Composer — R9.9 deterministic slide renderer."""

from __future__ import annotations

import base64
import io
import re
import tempfile
from pathlib import Path
from typing import Any

import fitz
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Pt

FONT = "Arial"
FS_TITLE = 26
FS_SUBTITLE = 14
FS_BODY = 12
FS_CAPTION = 10
FS_TAKEAWAY = 13
FS_METRIC_VALUE = 20
FS_METRIC_LABEL = 11

MARGIN_X = 450000
CONTENT_W = 8200000
SLIDE_H = 6858000
FOOTER_Y = 6400000

TITLE_COLOR = RGBColor(0x1F, 0x3A, 0x5F)
BODY_COLOR = RGBColor(0x33, 0x41, 0x55)
MUTED_COLOR = RGBColor(0x64, 0x74, 0x8B)
ACCENT = RGBColor(0x1D, 0x4E, 0xD8)
CARD_BG = RGBColor(0xF8, 0xFA, 0xFC)
CARD_BORDER = RGBColor(0xE2, 0xE8, 0xF0)
WARN_BG = RGBColor(0xFF, 0xFB, 0xEB)

FORBIDDEN = re.compile(
    r"\b(PRESENT|UNKNOWN|adverse_media|pep|mock|fallback|provider|runtime|debug)\b",
    re.I,
)


def _safe(text: object) -> str:
    val = re.sub(r"\s+", " ", str(text or "")).strip()
    val = FORBIDDEN.sub("", val)
    val = re.sub(r"(storage/|C:\\\\|/mnt/|openai[_-]?api[_-]?key)", "", val, flags=re.I)
    val = re.sub(r"\+\s*\d+\s*more items.*", "", val, flags=re.I)
    return val.strip()


class _Ctx:
    def __init__(self, prs: Presentation, page: int, total: int):
        self.prs = prs
        self.page = page
        self.total = total
        layout = prs.slide_layouts[6] if len(prs.slide_layouts) > 6 else prs.slide_layouts[0]
        self.slide = prs.slides.add_slide(layout)

    def footer(self) -> None:
        box = self.slide.shapes.add_textbox(Emu(MARGIN_X), Emu(FOOTER_Y), Emu(CONTENT_W), Emu(250000))
        p = box.text_frame.paragraphs[0]
        p.alignment = PP_ALIGN.RIGHT
        r = p.add_run()
        r.text = f"{self.page} / {self.total}"
        r.font.name = FONT
        r.font.size = Pt(FS_CAPTION)
        r.font.color.rgb = MUTED_COLOR

    def title_block(self, title: str, subtitle: str = "") -> int:
        y = 260000
        box = self.slide.shapes.add_textbox(Emu(MARGIN_X), Emu(y), Emu(CONTENT_W), Emu(900000))
        tf = box.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        r = p.add_run()
        r.text = _safe(title)
        r.font.name = FONT
        r.font.bold = True
        r.font.size = Pt(FS_TITLE)
        r.font.color.rgb = TITLE_COLOR
        if subtitle:
            p2 = tf.add_paragraph()
            r2 = p2.add_run()
            r2.text = _safe(subtitle)
            r2.font.name = FONT
            r2.font.size = Pt(FS_SUBTITLE)
            r2.font.color.rgb = MUTED_COLOR
        return y + 950000

    def takeaway(self, text: str, y: int) -> int:
        shape = self.slide.shapes.add_shape(1, Emu(MARGIN_X), Emu(y), Emu(CONTENT_W), Emu(650000))
        shape.fill.solid()
        shape.fill.fore_color.rgb = CARD_BG
        shape.line.color.rgb = ACCENT
        tf = shape.text_frame
        tf.margin_left = Emu(100000)
        tf.margin_top = Emu(80000)
        tf.word_wrap = True
        p = tf.paragraphs[0]
        r = p.add_run()
        r.text = _safe(text)[:320]
        r.font.name = FONT
        r.font.size = Pt(FS_TAKEAWAY)
        r.font.color.rgb = BODY_COLOR
        return y + 720000

    def bullets(self, items: list[str], y: int, max_items: int = 5) -> int:
        cleaned = [_safe(x) for x in items if _safe(x)][:max_items]
        if not cleaned:
            return y
        box = self.slide.shapes.add_textbox(Emu(MARGIN_X), Emu(y), Emu(CONTENT_W), Emu(2400000))
        tf = box.text_frame
        tf.word_wrap = True
        first = True
        for bullet in cleaned:
            p = tf.paragraphs[0] if first else tf.add_paragraph()
            first = False
            r = p.add_run()
            r.text = f"• {bullet[:200]}"
            r.font.name = FONT
            r.font.size = Pt(FS_BODY)
            r.font.color.rgb = BODY_COLOR
        return y + min(2400000, 450000 * len(cleaned) + 200000)

    def metrics(self, metrics: list[dict[str, Any]], y: int) -> int:
        if not metrics:
            return y
        card_w = 1900000
        gap = 180000
        for idx, metric in enumerate(metrics[:4]):
            cx = MARGIN_X + idx * (card_w + gap)
            shape = self.slide.shapes.add_shape(1, Emu(cx), Emu(y), Emu(card_w), Emu(680000))
            shape.fill.solid()
            shape.fill.fore_color.rgb = CARD_BG
            shape.line.color.rgb = CARD_BORDER
            tf = shape.text_frame
            tf.margin_left = Emu(80000)
            tf.margin_top = Emu(60000)
            p = tf.paragraphs[0]
            r = p.add_run()
            r.text = _safe(metric.get("label"))
            r.font.name = FONT
            r.font.size = Pt(FS_METRIC_LABEL)
            r.font.color.rgb = MUTED_COLOR
            p2 = tf.add_paragraph()
            r2 = p2.add_run()
            r2.text = _safe(metric.get("value"))
            r2.font.name = FONT
            r2.font.bold = True
            r2.font.size = Pt(FS_METRIC_VALUE)
            r2.font.color.rgb = TITLE_COLOR
        return y + 780000

    def unavailable_card(self, message: str, y: int) -> int:
        shape = self.slide.shapes.add_shape(1, Emu(MARGIN_X), Emu(y), Emu(CONTENT_W), Emu(900000))
        shape.fill.solid()
        shape.fill.fore_color.rgb = WARN_BG
        shape.line.color.rgb = CARD_BORDER
        tf = shape.text_frame
        tf.margin_left = Emu(120000)
        tf.margin_top = Emu(100000)
        p = tf.paragraphs[0]
        r = p.add_run()
        r.text = _safe(message)
        r.font.name = FONT
        r.font.size = Pt(FS_BODY)
        r.font.color.rgb = BODY_COLOR
        return y + 950000


def _assets_map(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {str(a.get("assetRef")): a for a in payload.get("assets") or []}


def render_cover(ctx: _Ctx, slide: dict[str, Any]) -> None:
    y = ctx.title_block(slide.get("title") or "ORION Digital Profile", slide.get("subtitle") or "")
    ctx.takeaway(slide.get("clientTakeaway") or "", y + 400000)


def render_global_toc(ctx: _Ctx, slide: dict[str, Any], all_slides: list[dict[str, Any]]) -> None:
    y = ctx.title_block(slide.get("title") or "Содержание", "")
    items = []
    for s in all_slides:
        t = _safe(s.get("title"))
        if t and s.get("slideType") not in ("cover", "global_toc"):
            items.append(t)
    ctx.bullets(items[:8], y, max_items=8)


def render_executive_summary(ctx: _Ctx, slide: dict[str, Any]) -> None:
    y = ctx.title_block(slide.get("title") or "Executive Summary", slide.get("subtitle") or "")
    y = ctx.takeaway(slide.get("clientTakeaway") or "", y)
    y = ctx.metrics(slide.get("metrics") or [], y + 80000)
    findings = slide.get("findings") or []
    bullets = [_safe(f.get("summary")) for f in findings if isinstance(f, dict)]
    actions = slide.get("recommendedActions") or []
    bullets.extend([_safe(a.get("label")) for a in actions if isinstance(a, dict)])
    ctx.bullets(bullets, y + 80000, max_items=5)


def render_region_summary(ctx: _Ctx, slide: dict[str, Any]) -> None:
    y = ctx.title_block(slide.get("title") or "Сводка региона", slide.get("subtitle") or "")
    y = ctx.takeaway(slide.get("clientTakeaway") or "", y)
    findings = slide.get("findings") or []
    ctx.bullets([_safe(f.get("summary")) for f in findings if isinstance(f, dict)], y + 80000, max_items=5)


def render_search_overview(ctx: _Ctx, slide: dict[str, Any]) -> None:
    y = ctx.title_block(slide.get("title") or "Поисковая выдача", slide.get("subtitle") or "")
    y = ctx.takeaway(slide.get("clientTakeaway") or "", y)
    y = ctx.metrics(slide.get("metrics") or [], y + 80000)
    evidence = slide.get("evidenceRefs") or []
    ctx.bullets(
        [_safe(f"{e.get('label')}: {e.get('summary')}") for e in evidence if isinstance(e, dict)],
        y + 80000,
        max_items=5,
    )


def render_serp_screenshot(ctx: _Ctx, slide: dict[str, Any], assets: dict[str, dict[str, Any]]) -> None:
    y = ctx.title_block(slide.get("title") or "Снимок выдачи", slide.get("subtitle") or "")
    if slide.get("clientTakeaway"):
        y = ctx.takeaway(slide.get("clientTakeaway"), y)
    refs = slide.get("assetRefs") or []
    asset_ref = refs[0].get("assetRef") if refs and isinstance(refs[0], dict) else None
    if not asset_ref and refs:
        asset_ref = str(refs[0])
    asset = assets.get(str(asset_ref)) if asset_ref else None
    img_data = (asset or {}).get("imageData")
    img_y = y + 60000
    if img_data:
        raw = base64.b64decode(str(img_data))
        tmp = Path(tempfile.gettempdir()) / f"orion-storyboard-{asset_ref}.png"
        tmp.write_bytes(raw)
        ctx.slide.shapes.add_picture(str(tmp), Emu(MARGIN_X), Emu(img_y), width=Emu(CONTENT_W), height=Emu(4800000))
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
    else:
        ctx.unavailable_card("Данные снимка поисковой выдачи не обнаружены.", img_y)


def render_search_results_table(ctx: _Ctx, slide: dict[str, Any]) -> None:
    y = ctx.title_block(slide.get("title") or "Результаты поиска", "")
    evidence = slide.get("evidenceRefs") or []
    rows = []
    for e in evidence[:6]:
        if not isinstance(e, dict):
            continue
        rows.append(f"{_safe(e.get('label'))} — {_safe(e.get('statusLabel'))}")
    ctx.bullets(rows, y, max_items=6)


def render_adverse_media_summary(ctx: _Ctx, slide: dict[str, Any]) -> None:
    y = ctx.title_block(slide.get("title") or "Негативные публикации", "")
    y = ctx.takeaway(slide.get("clientTakeaway") or "", y)
    findings = slide.get("findings") or []
    ctx.bullets([_safe(f.get("summary")) for f in findings if isinstance(f, dict)], y + 80000, max_items=4)


def render_image_grid(ctx: _Ctx, slide: dict[str, Any], assets: dict[str, dict[str, Any]]) -> None:
    y = ctx.title_block(slide.get("title") or "Изображения", "")
    y = ctx.takeaway(slide.get("clientTakeaway") or "", y)
    refs = slide.get("assetRefs") or []
    placed = 0
    for idx, ref in enumerate(refs[:4]):
        asset_ref = ref.get("assetRef") if isinstance(ref, dict) else str(ref)
        asset = assets.get(str(asset_ref))
        if not asset or not asset.get("imageData"):
            continue
        col = idx % 2
        row = idx // 2
        cx = MARGIN_X + col * (CONTENT_W // 2 + 80000)
        cy = y + row * 2400000
        raw = base64.b64decode(str(asset.get("imageData")))
        tmp = Path(tempfile.gettempdir()) / f"orion-grid-{asset_ref}.png"
        tmp.write_bytes(raw)
        ctx.slide.shapes.add_picture(str(tmp), Emu(cx), Emu(cy), width=Emu(CONTENT_W // 2 - 100000), height=Emu(2200000))
        placed += 1
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
    if placed == 0:
        ctx.unavailable_card("Изображения по данному региону не обнаружены.", y + 80000)


def render_video_cards(ctx: _Ctx, slide: dict[str, Any], assets: dict[str, dict[str, Any]]) -> None:
    y = ctx.title_block(slide.get("title") or "Видеоматериалы", "")
    refs = slide.get("assetRefs") or []
    asset_ref = None
    if refs:
        asset_ref = refs[0].get("assetRef") if isinstance(refs[0], dict) else str(refs[0])
    asset = assets.get(str(asset_ref)) if asset_ref else None
    if asset and asset.get("imageData"):
        raw = base64.b64decode(str(asset.get("imageData")))
        tmp = Path(tempfile.gettempdir()) / f"orion-video-{asset_ref}.png"
        tmp.write_bytes(raw)
        ctx.slide.shapes.add_picture(str(tmp), Emu(MARGIN_X), Emu(y + 80000), width=Emu(CONTENT_W), height=Emu(4200000))
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
    else:
        ctx.unavailable_card("Видеоматериалы не обнаружены или недоступны для предпросмотра.", y + 80000)


def render_knowledge_panel(ctx: _Ctx, slide: dict[str, Any], assets: dict[str, dict[str, Any]]) -> None:
    y = ctx.title_block(slide.get("title") or "Справочная карточка", "")
    refs = slide.get("assetRefs") or []
    asset_ref = refs[0].get("assetRef") if refs and isinstance(refs[0], dict) else None
    asset = assets.get(str(asset_ref)) if asset_ref else None
    if asset and asset.get("imageData"):
        raw = base64.b64decode(str(asset.get("imageData")))
        tmp = Path(tempfile.gettempdir()) / f"orion-kp-{asset_ref}.png"
        tmp.write_bytes(raw)
        ctx.slide.shapes.add_picture(str(tmp), Emu(MARGIN_X), Emu(y + 80000), width=Emu(CONTENT_W // 2), height=Emu(3800000))
    else:
        ctx.takeaway(slide.get("clientTakeaway") or "Справочные данные ограничены.", y)


def render_recommended_actions(ctx: _Ctx, slide: dict[str, Any]) -> None:
    y = ctx.title_block(slide.get("title") or "Рекомендуемые действия", "")
    actions = slide.get("recommendedActions") or []
    ctx.bullets([_safe(a.get("label")) for a in actions if isinstance(a, dict)], y, max_items=5)


def render_no_data_compact(ctx: _Ctx, slide: dict[str, Any]) -> None:
    y = ctx.title_block(slide.get("title") or "Недостаточно данных", "")
    ctx.unavailable_card(slide.get("clientTakeaway") or "Данные не обнаружены / не применимо", y)


def render_generic(ctx: _Ctx, slide: dict[str, Any]) -> None:
    y = ctx.title_block(slide.get("title") or "Раздел", slide.get("subtitle") or "")
    ctx.takeaway(slide.get("clientTakeaway") or "", y)


def render_client_storyboard(payload: dict[str, Any]) -> dict[str, Any]:
    storyboard = payload.get("storyboard") or payload
    slides = list(storyboard.get("slides") or [])
    assets = _assets_map(payload)
    prs = Presentation()
    prs.slide_width = Emu(9144000)
    prs.slide_height = Emu(SLIDE_H)
    total = max(len(slides), 1)

    for idx, slide in enumerate(slides, start=1):
        stype = str(slide.get("slideType") or "region_summary")
        ctx = _Ctx(prs, idx, total)
        if stype == "cover":
            render_cover(ctx, slide)
        elif stype == "global_toc":
            render_global_toc(ctx, slide, slides)
        elif stype == "executive_summary":
            render_executive_summary(ctx, slide)
        elif stype == "region_summary":
            render_region_summary(ctx, slide)
        elif stype == "search_overview":
            render_search_overview(ctx, slide)
        elif stype == "serp_screenshot":
            render_serp_screenshot(ctx, slide, assets)
        elif stype == "search_results_table":
            render_search_results_table(ctx, slide)
        elif stype == "adverse_media_summary":
            render_adverse_media_summary(ctx, slide)
        elif stype == "image_grid":
            render_image_grid(ctx, slide, assets)
        elif stype == "video_cards":
            render_video_cards(ctx, slide, assets)
        elif stype == "knowledge_panel":
            render_knowledge_panel(ctx, slide, assets)
        elif stype == "lexisnexis_summary":
            render_generic(ctx, slide)
        elif stype == "lexisnexis_visual_page":
            render_serp_screenshot(ctx, slide, assets)
        elif stype == "recommended_actions":
            render_recommended_actions(ctx, slide)
        elif stype == "no_data_compact":
            render_no_data_compact(ctx, slide)
        else:
            render_generic(ctx, slide)
        ctx.footer()

    with tempfile.TemporaryDirectory() as tmp:
        pptx_path = Path(tmp) / "storyboard.pptx"
        pdf_path = Path(tmp) / "storyboard.pdf"
        prs.save(str(pptx_path))
        pdf_mode = "libreoffice"
        try:
            from convert_pdf import convert_to_pdf

            convert_to_pdf(str(pptx_path), str(pdf_path))
        except Exception:
            pdf_mode = "fitz-fallback"
            doc = fitz.open()
            for slide in slides:
                page = doc.new_page(width=595, height=842)
                page.insert_text((50, 60), _safe(slide.get("title")), fontsize=14)
                page.insert_text((50, 90), _safe(slide.get("clientTakeaway"))[:500], fontsize=10)
            doc.save(str(pdf_path))
            doc.close()

        pptx_b64 = base64.b64encode(pptx_path.read_bytes()).decode("ascii")
        pdf_b64 = base64.b64encode(pdf_path.read_bytes()).decode("ascii")
        pages = []
        doc = fitz.open(str(pdf_path))
        for i in range(len(doc)):
            pix = doc[i].get_pixmap(matrix=fitz.Matrix(2, 2))
            pages.append({"pageNumber": i + 1, "contentBase64": base64.b64encode(pix.tobytes("png")).decode("ascii")})
        doc.close()

    return {
        "slideCount": len(slides),
        "pptxBase64": pptx_b64,
        "pdfBase64": pdf_b64,
        "pages": pages,
        "pdfExportMode": pdf_mode,
        "warnings": [],
    }
