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
FS_BODY = 12  # min readable body ≥ 11pt
FS_CAPTION = 9

# Master slide 16:10 (12.8" × 8.0") — matches ORION reference aspect.
SLIDE_W = 11_704_320
SLIDE_H = 7_315_200
MARGIN_X = 480_000
CONTENT_W = SLIDE_W - 2 * MARGIN_X
FOOTER_Y = SLIDE_H - 440_000
CONTENT_BOTTOM = SLIDE_H - 700_000

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
        # Cap height so body never collides with footer. Consume the full budget so
        # subsequent content never overlaps underestimated text height (p3/p11 fix).
        avail = max(200000, min(max_h, CONTENT_BOTTOM - y))
        box = self.slide.shapes.add_textbox(Emu(MARGIN_X), Emu(y), Emu(CONTENT_W), Emu(avail))
        tf = box.text_frame
        tf.word_wrap = True
        chunks = [c.strip() for c in re.split(r"\n+", _safe(text)) if c.strip()]
        if not chunks:
            chunks = [""]
        first = True
        max_chars_total = max(200, int(avail / 230000) * 90)
        used = 0
        for chunk in chunks[:6]:
            if used >= max_chars_total:
                break
            p = tf.paragraphs[0] if first else tf.add_paragraph()
            first = False
            p.space_after = Pt(8)
            r = p.add_run()
            clipped = _clip_words(chunk, min(900, max_chars_total - used))
            r.text = clipped
            used += len(clipped)
            r.font.name = FONT
            r.font.size = Pt(FS_BODY)
            r.font.color.rgb = color
        return y + avail

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


def _embed_image_contain(ctx: _Ctx, asset: dict[str, Any] | None, y: int, h: int = 4800000) -> bool:
    """Place image inside (MARGIN_X, y, CONTENT_W, h) preserving aspect ratio."""
    if not asset:
        ctx.body("Визуальный материал недоступен для данного раздела.", y)
        return False
    raw = _resolve_image_bytes(asset)
    if not raw:
        title = _safe(asset.get("title") or "Источник")
        domain = _safe(asset.get("caption") or asset.get("storageKey") or "")
        ctx.card(y, h)
        ctx.body(
            f"{title}\n{domain}\nИзображение недоступно — показаны источник и описание.",
            y + 120000,
            max_h=h - 200000,
        )
        return False
    box_w, box_h = CONTENT_W, h
    iw, ih = box_w, box_h
    if Image is not None:
        try:
            with Image.open(io.BytesIO(raw)) as im:
                iw, ih = im.size
        except Exception:  # noqa: BLE001
            pass
    scale = min(box_w / max(iw, 1), box_h / max(ih, 1))
    draw_w = int(iw * scale)
    draw_h = int(ih * scale)
    left = MARGIN_X + (box_w - draw_w) // 2
    top = y + (box_h - draw_h) // 2
    stream = io.BytesIO(raw)
    ctx.slide.shapes.add_picture(stream, Emu(left), Emu(top), width=Emu(draw_w), height=Emu(draw_h))
    return True


def _embed_image(ctx: _Ctx, asset: dict[str, Any] | None, y: int, h: int = 4800000) -> None:
    _embed_image_contain(ctx, asset, y, h)


def _first_visual_asset(refs: list[Any], assets: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    for ref in refs:
        asset = assets.get(str(ref))
        if asset and _resolve_image_bytes(asset):
            return asset
    return None


def _sidebar_analysis(ctx: _Ctx, slide: dict[str, Any], x: int, y: int, w: int, h: int) -> None:
    """Render VisualSlideAnalysis in a right-hand column."""
    analysis = slide.get("visualAnalysis") or {}
    if not isinstance(analysis, dict) or not analysis:
        takeaway = _safe(slide.get("clientTakeaway") or "")
        bullets = [_safe(b) for b in slide.get("bullets") or [] if _safe(b)]
        if not takeaway and not bullets:
            return
        shape = ctx.slide.shapes.add_shape(1, Emu(x), Emu(y), Emu(w), Emu(h))
        shape.fill.solid()
        shape.fill.fore_color.rgb = CARD_BG
        shape.line.color.rgb = CARD_BORDER
        box = ctx.slide.shapes.add_textbox(Emu(x + 80000), Emu(y + 80000), Emu(w - 160000), Emu(h - 160000))
        tf = box.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        r = p.add_run()
        r.text = takeaway or (bullets[0] if bullets else "")
        r.font.name = FONT
        r.font.size = Pt(11)
        r.font.bold = True
        r.font.color.rgb = NAVY
        for bullet in bullets[:4]:
            bp = tf.add_paragraph()
            bp.space_before = Pt(6)
            br = bp.add_run()
            br.text = f"• {_clip_words(bullet, 160)}"
            br.font.name = FONT
            br.font.size = Pt(10)
            br.font.color.rgb = BODY_COLOR
        return

    shape = ctx.slide.shapes.add_shape(1, Emu(x), Emu(y), Emu(w), Emu(h))
    shape.fill.solid()
    shape.fill.fore_color.rgb = CARD_BG
    shape.line.color.rgb = CARD_BORDER
    box = ctx.slide.shapes.add_textbox(Emu(x + 80000), Emu(y + 80000), Emu(w - 160000), Emu(h - 160000))
    tf = box.text_frame
    tf.word_wrap = True

    def add_line(text: str, *, bold: bool = False, size: int = 10, color: RGBColor = BODY_COLOR, space: int = 4) -> None:
        p = tf.add_paragraph()
        p.space_before = Pt(space)
        r = p.add_run()
        r.text = _clip_words(text, 200)
        r.font.name = FONT
        r.font.size = Pt(size)
        r.font.bold = bold
        r.font.color.rgb = color

    # First paragraph
    p0 = tf.paragraphs[0]
    r0 = p0.add_run()
    r0.text = _clip_words(_safe(analysis.get("headlineConclusion") or "Вывод"), 140)
    r0.font.name = FONT
    r0.font.size = Pt(12)
    r0.font.bold = True
    r0.font.color.rgb = NAVY

    what = _safe(analysis.get("whatIsVisible") or "")
    if what:
        add_line("Что видно", bold=True, size=10, color=MUTED_COLOR, space=10)
        add_line(what, size=10, space=2)
    why = _safe(analysis.get("whyItMatters") or "")
    if why:
        add_line("Почему важно", bold=True, size=10, color=MUTED_COLOR, space=10)
        add_line(why, size=10, space=2)
    prov = _safe(analysis.get("provenanceLabel") or "")
    if prov:
        add_line(prov, size=9, color=MUTED_COLOR, space=10)
    actions = analysis.get("recommendedActions") or []
    if isinstance(actions, list) and actions:
        add_line("Действие", bold=True, size=10, color=MUTED_COLOR, space=10)
        add_line(_safe(actions[0]), size=10, space=2)


def _render_visual_with_sidebar(
    ctx: _Ctx,
    slide: dict[str, Any],
    assets: dict[str, dict[str, Any]],
    title: str,
) -> None:
    """Title + left visual (contain) + right analytical sidebar."""
    ctx.light_bg()
    y = ctx.title(title, 280000, NAVY)
    refs = slide.get("assetRefs") or []
    visual = _first_visual_asset(refs, assets)
    has_sidebar = bool(slide.get("visualAnalysis") or slide.get("clientTakeaway") or slide.get("bullets"))
    img_w = int(CONTENT_W * 0.62) if has_sidebar else CONTENT_W
    side_w = CONTENT_W - img_w - 120000
    img_h = CONTENT_BOTTOM - y - 80000
    if visual:
        # Temporarily embed into a narrower box by using contain math inline
        raw = _resolve_image_bytes(visual)
        if raw:
            iw, ih = img_w, img_h
            if Image is not None:
                try:
                    with Image.open(io.BytesIO(raw)) as im:
                        iw, ih = im.size
                except Exception:  # noqa: BLE001
                    pass
            scale = min(img_w / max(iw, 1), img_h / max(ih, 1))
            dw, dh = int(iw * scale), int(ih * scale)
            left = MARGIN_X + (img_w - dw) // 2
            top = y + 60000 + (img_h - 60000 - dh) // 2
            ctx.slide.shapes.add_picture(io.BytesIO(raw), Emu(left), Emu(top), width=Emu(dw), height=Emu(dh))
        else:
            ctx.body("Визуальный материал недоступен.", y + 80000, max_h=600000, color=MUTED_COLOR)
    else:
        reason = _safe(slide.get("blockedReason") or "Визуальный материал недоступен для данного раздела.")
        ctx.body(reason, y + 80000, max_h=800000, color=MUTED_COLOR)
    if has_sidebar and side_w > 400000:
        _sidebar_analysis(ctx, slide, MARGIN_X + img_w + 120000, y + 60000, side_w, img_h - 60000)


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
        narr = narrative.strip()
        # Fixed template budgets — never size cards from character count (p3/p11 overlap).
        if narr and not bullets:
            card_h = min(5_400_000, max(1_600_000, CONTENT_BOTTOM - y - 200000))
            ctx.card(y, h=card_h)
            ctx.body(narr, y + 100000, max_h=card_h - 160000)
            return
        if narr:
            narr_show = _clip_words(narr, 1800)
            bullet_reserve = 1_800_000 if bullets else 200000
            max_card = max(800000, CONTENT_BOTTOM - y - bullet_reserve)
            card_h = min(3_200_000, max_card)
            ctx.card(y, h=card_h)
            ctx.body(narr_show, y + 100000, max_h=card_h - 160000)
            y = y + card_h + 120000
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
        _render_visual_with_sidebar(ctx, slide, assets, title)
        return

    if template == "orion_golden_image_grid":
        if slide.get("visualAnalysis") or slide.get("clientTakeaway"):
            _render_visual_with_sidebar(ctx, slide, assets, title)
            return
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY)
        if len(refs) == 1:
            primary_grid = assets.get(str(refs[0])) if refs else None
            if primary_grid and _resolve_image_bytes(primary_grid):
                _embed_image(ctx, primary_grid, y + 60000, h=5_200_000)
                cap = _safe(primary_grid.get("caption") or "")
                if cap:
                    ctx.body(cap, CONTENT_BOTTOM - 380000, max_h=320000, color=MUTED_COLOR)
                return
        cols = 3
        cell_w = CONTENT_W // 3 - 80_000
        cell_h = 1_600_000
        gap = 120000
        for idx, ref in enumerate(refs[:6]):
            row = idx // cols
            col = idx % cols
            cx = MARGIN_X + col * (cell_w + gap)
            cy = y + row * (cell_h + gap)
            asset = assets.get(str(ref))
            raw = _resolve_image_bytes(asset) if asset else None
            if raw:
                stream = io.BytesIO(raw)
                iw, ih = cell_w, cell_h
                if Image is not None:
                    try:
                        with Image.open(io.BytesIO(raw)) as im:
                            iw, ih = im.size
                    except Exception:
                        pass
                scale = min(cell_w / max(iw, 1), cell_h / max(ih, 1))
                dw, dh = int(iw * scale), int(ih * scale)
                left = cx + (cell_w - dw) // 2
                top = cy + (cell_h - dh) // 2
                ctx.slide.shapes.add_picture(stream, Emu(left), Emu(top), width=Emu(dw), height=Emu(dh))
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
        _render_visual_with_sidebar(ctx, slide, assets, title)
        return

    if template == "orion_golden_knowledge_panel":
        _render_visual_with_sidebar(ctx, slide, assets, title)
        return

    if template == "orion_golden_lexis_visual_page":
        if slide.get("visualAnalysis") or slide.get("clientTakeaway"):
            _render_visual_with_sidebar(ctx, slide, assets, title)
            return
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY)
        _embed_image(ctx, primary, y + 60000, h=5_200_000)
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
    }

    def esc(t: str) -> str:
        return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

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
            page.insert_textbox(
                fitz.Rect(margin_x, 28, page_w - margin_x, title_bottom),
                title,
                fontsize=18,
                fontname="helv",
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
                page.insert_textbox(
                    fitz.Rect(margin_x, 100, img_right, 200),
                    "Визуальный материал недоступен для данного раздела.",
                    fontsize=12,
                    fontname="helv",
                    color=(0.2, 0.25, 0.33),
                )
            if has_side:
                side_bits = [
                    _safe(analysis.get("headlineConclusion") or slide.get("clientTakeaway") or ""),
                    _safe(analysis.get("whatIsVisible") or ""),
                    _safe(analysis.get("whyItMatters") or ""),
                    _safe(analysis.get("provenanceLabel") or ""),
                ]
                side_text = "\n\n".join([b for b in side_bits if b])
                page.insert_textbox(
                    fitz.Rect(img_right + 16, 80, page_w - margin_x, content_bottom),
                    side_text[:900],
                    fontsize=10,
                    fontname="helv",
                    color=(0.2, 0.25, 0.33),
                )
            page.insert_textbox(
                fitz.Rect(page_w - 180, footer_y, page_w - margin_x, footer_y + 20),
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
    prs.slide_width = Emu(SLIDE_W)
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
