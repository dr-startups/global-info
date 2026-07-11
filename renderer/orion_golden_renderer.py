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
ACCENT_SOFT = RGBColor(0xEF, 0xF6, 0xFF)
WARN_BG = RGBColor(0xFF, 0xF7, 0xED)
RISK_BG = RGBColor(0xFE, 0xF2, 0xF2)
GOOD_BG = RGBColor(0xEC, 0xFD, 0xF5)
TONE_RISK = RGBColor(0xB9, 0x1C, 0x1C)
TONE_WARN = RGBColor(0xC2, 0x41, 0x0C)
TONE_GOOD = RGBColor(0x04, 0x78, 0x57)

FORBIDDEN = re.compile(
    r"(storage/|C:\\\\|openai[_-]?api[_-]?key|cmr[a-z0-9]{10,}|adverse_media|requires_review)",
    re.I,
)

# EMU helpers: 914400 EMU = 1 inch; 72 pt = 1 inch
EMU_PER_PT = 12_700
EMU_PER_INCH = 914_400


def _font_path() -> str | None:
    candidates = [
        os.environ.get("ORION_RENDER_FONT"),
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for path in candidates:
        if path and Path(path).is_file():
            return path
    return None


def measure_text_height(
    text: str,
    width_emu: int,
    font_size_pt: float,
    line_spacing: float = 1.2,
    paragraph_spacing_pt: float = 6.0,
) -> int:
    """Measure wrapped text height in EMU using real font metrics when available."""
    raw = _safe(text)
    if not raw:
        return int(font_size_pt * EMU_PER_PT * line_spacing)
    # Slightly narrower than box so PPTX wrap is not underestimated.
    width_px = max(40, int(width_emu / EMU_PER_INCH * 96 * 0.90))
    paragraphs = [p.strip() for p in re.split(r"\n+", raw) if p.strip()] or [""]
    total_lines = 0
    font = None
    if Image is not None:
        try:
            from PIL import ImageFont  # type: ignore

            fp = _font_path()
            if fp:
                font = ImageFont.truetype(fp, size=max(8, int(round(font_size_pt * 96 / 72))))
        except Exception:  # noqa: BLE001
            font = None

    for para in paragraphs:
        words = para.split(" ")
        if not words:
            total_lines += 1
            continue
        line = ""
        lines = 1
        for word in words:
            trial = word if not line else f"{line} {word}"
            if font is not None:
                try:
                    bbox = font.getbbox(trial)
                    tw = bbox[2] - bbox[0]
                except Exception:  # noqa: BLE001
                    tw = int(len(trial) * font_size_pt * 0.58 * 96 / 72)
            else:
                tw = int(len(trial) * font_size_pt * 0.58 * 96 / 72)
            if tw <= width_px or not line:
                line = trial
            else:
                lines += 1
                line = word
        total_lines += max(1, lines)

    line_h = font_size_pt * EMU_PER_PT * line_spacing
    para_extra = max(0, len(paragraphs) - 1) * paragraph_spacing_pt * EMU_PER_PT
    # Safety margin: PPTX wraps more aggressively than PIL metrics.
    return int((total_lines * line_h + para_extra) * 1.18)


def _fit_text_to_height(
    text: str,
    width_emu: int,
    font_size_pt: float,
    max_h: int,
    *,
    line_spacing: float = 1.2,
) -> str:
    """Clip text so measured height fits max_h (word-safe)."""
    raw = _safe(text)
    if not raw:
        return ""
    if measure_text_height(raw, width_emu, font_size_pt, line_spacing=line_spacing) <= max_h:
        return raw
    words = raw.split()
    lo, hi = 1, len(words)
    best = words[0]
    while lo <= hi:
        mid = (lo + hi) // 2
        trial = " ".join(words[:mid])
        if measure_text_height(trial, width_emu, font_size_pt, line_spacing=line_spacing) <= max_h:
            best = trial
            lo = mid + 1
        else:
            hi = mid - 1
    return best.rstrip(".,;:") + ("…" if best != raw else "")


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

    def card(
        self,
        y: int,
        h: int = 2_200_000,
        *,
        x: int | None = None,
        w: int | None = None,
        fill: RGBColor = CARD_BG,
    ) -> None:
        left = MARGIN_X if x is None else x
        width = CONTENT_W if w is None else w
        avail = max(200_000, min(h, CONTENT_BOTTOM - y))
        shape = self.slide.shapes.add_shape(1, Emu(left), Emu(y), Emu(width), Emu(avail))
        shape.fill.solid()
        shape.fill.fore_color.rgb = fill
        shape.line.color.rgb = CARD_BORDER

    def body(
        self,
        text: str,
        y: int,
        max_h: int = 900000,
        color: RGBColor = BODY_COLOR,
        *,
        x: int | None = None,
        w: int | None = None,
        font_size: int = FS_BODY,
    ) -> int:
        """Render body text and return actual bottom Y from measured content height."""
        left = MARGIN_X if x is None else x
        width = CONTENT_W if w is None else w
        avail = max(200000, min(max_h, CONTENT_BOTTOM - y))
        chunks = [c.strip() for c in re.split(r"\n+", _safe(text)) if c.strip()]
        if not chunks:
            return y
        max_chars_total = max(200, int(avail / 230000) * 110)
        used = 0
        kept: list[str] = []
        for chunk in chunks[:8]:
            if used >= max_chars_total:
                break
            clipped = _clip_words(chunk, min(900, max_chars_total - used))
            if not clipped:
                continue
            kept.append(clipped)
            used += len(clipped)
        joined = "\n".join(kept)
        needed = measure_text_height(joined, width, font_size, line_spacing=1.2, paragraph_spacing_pt=8)
        box_h = min(avail, max(needed + 40_000, int(font_size * EMU_PER_PT)))
        box = self.slide.shapes.add_textbox(Emu(left), Emu(y), Emu(width), Emu(box_h))
        tf = box.text_frame
        tf.word_wrap = True
        first = True
        for chunk in kept:
            p = tf.paragraphs[0] if first else tf.add_paragraph()
            first = False
            p.space_after = Pt(8)
            r = p.add_run()
            r.text = chunk
            r.font.name = FONT
            r.font.size = Pt(font_size)
            r.font.color.rgb = color
        return y + box_h

    def content_card(
        self,
        *,
        title: str | None,
        text: str,
        x: int,
        y: int,
        width: int,
        min_h: int = 320_000,
        max_h: int = 2_400_000,
        padding: int = 100_000,
        tone: str = "neutral",
        title_size: int = 10,
        body_size: int = 11,
    ) -> int:
        """Draw a content-sized card; clip text to fit; return actual bottom Y."""
        fill = {
            "accent": ACCENT_SOFT,
            "warn": WARN_BG,
            "risk": RISK_BG,
            "good": GOOD_BG,
        }.get(tone, CARD_BG)
        title_s = _safe(title or "")
        body_s = _safe(text)
        inner_w = max(120_000, width - 2 * padding)
        budget = max(200_000, min(max_h, CONTENT_BOTTOM - y))
        title_h = 0
        if title_s:
            title_h = measure_text_height(title_s, inner_w, title_size, line_spacing=1.15) + 40_000
        body_budget = max(80_000, budget - 2 * padding - title_h)
        if body_s:
            body_s = _fit_text_to_height(body_s, inner_w, body_size, body_budget)
        body_h = measure_text_height(body_s, inner_w, body_size, line_spacing=1.2) if body_s else 0
        h = max(min_h, min(budget, 2 * padding + title_h + body_h + 40_000))
        self.card(y, h=h, x=x, w=width, fill=fill)
        cy = y + padding
        if title_s:
            box = self.slide.shapes.add_textbox(Emu(x + padding), Emu(cy), Emu(inner_w), Emu(max(title_h, 200_000)))
            tf = box.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            r = p.add_run()
            r.text = title_s
            r.font.name = FONT
            r.font.bold = True
            r.font.size = Pt(title_size)
            r.font.color.rgb = NAVY
            cy += title_h
        if body_s:
            rem = max(120_000, y + h - cy - padding)
            box = self.slide.shapes.add_textbox(Emu(x + padding), Emu(cy), Emu(inner_w), Emu(rem))
            tf = box.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            r = p.add_run()
            r.text = body_s
            r.font.name = FONT
            r.font.size = Pt(body_size)
            r.font.color.rgb = BODY_COLOR
        return y + h

    def metric_chips(self, metrics: list[dict[str, Any]], x: int, y: int, width: int) -> int:
        """Render 2-column metric chips; return bottom Y."""
        items = [m for m in metrics if isinstance(m, dict) and _safe(m.get("value"))][:4]
        if not items:
            return y
        cols = 2
        gap = 70_000
        chip_w = (width - gap) // cols
        chip_h = 640_000
        row_y = y
        for idx, m in enumerate(items):
            col = idx % cols
            if idx > 0 and col == 0:
                row_y += chip_h + gap
            cx = x + col * (chip_w + gap)
            tone = str(m.get("tone") or "neutral")
            fill = {"risk": RISK_BG, "warn": WARN_BG, "good": GOOD_BG}.get(tone, CARD_BG)
            value_color = {"risk": TONE_RISK, "warn": TONE_WARN, "good": TONE_GOOD}.get(tone, NAVY)
            value = _clip_words(_safe(m.get("value")), 18)
            label = _clip_words(_safe(m.get("label")), 18)
            self.card(row_y, h=chip_h, x=cx, w=chip_w, fill=fill)
            box = self.slide.shapes.add_textbox(
                Emu(cx + 50_000), Emu(row_y + 70_000), Emu(chip_w - 100_000), Emu(chip_h - 140_000)
            )
            tf = box.text_frame
            tf.word_wrap = True
            p0 = tf.paragraphs[0]
            r0 = p0.add_run()
            r0.text = value
            r0.font.name = FONT
            r0.font.bold = True
            r0.font.size = Pt(14 if len(value) > 12 else 16)
            r0.font.color.rgb = value_color
            p1 = tf.add_paragraph()
            p1.space_before = Pt(4)
            r1 = p1.add_run()
            r1.text = label
            r1.font.name = FONT
            r1.font.size = Pt(9)
            r1.font.color.rgb = MUTED_COLOR
        rows = (len(items) + cols - 1) // cols
        return y + rows * chip_h + max(0, rows - 1) * gap

    def bullets(self, items: list[str], y: int, color: RGBColor = BODY_COLOR, max_items: int = 8, max_chars: int = 280) -> int:
        kept = [_clip_words(_safe(b), max_chars) for b in items[:max_items] if _safe(b)]
        if not kept:
            return y
        text = "\n".join(f"• {b}" for b in kept)
        needed = measure_text_height(text, CONTENT_W, FS_BODY, line_spacing=1.2, paragraph_spacing_pt=6)
        avail = max(300000, min(needed + 80_000, CONTENT_BOTTOM - y))
        box = self.slide.shapes.add_textbox(Emu(MARGIN_X), Emu(y), Emu(CONTENT_W), Emu(avail))
        tf = box.text_frame
        tf.word_wrap = True
        first = True
        for bullet in kept:
            p = tf.paragraphs[0] if first else tf.add_paragraph()
            first = False
            p.space_before = Pt(4)
            p.space_after = Pt(8)
            p.line_spacing = 1.15
            r = p.add_run()
            r.text = f"• {bullet}"
            r.font.name = FONT
            r.font.size = Pt(FS_BODY)
            r.font.color.rgb = color
        return y + min(avail, needed + 60_000)


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


def _sidebar_word_budget(text: str, max_words: int = 70) -> str:
    words = _safe(text).split()
    if len(words) <= max_words:
        return " ".join(words)
    return " ".join(words[:max_words]).rstrip(".,;:") + "."


def _sidebar_analysis(ctx: _Ctx, slide: dict[str, Any], x: int, y: int, w: int, h: int) -> None:
    """Compact content-sized stack: conclusion → reason → action → provenance."""
    analysis = slide.get("visualAnalysis") or {}
    cy = y
    gap = 80_000
    max_bottom = min(y + h, CONTENT_BOTTOM)

    def room() -> int:
        return max(0, max_bottom - cy)

    if not isinstance(analysis, dict) or not analysis:
        takeaway = _safe(slide.get("clientTakeaway") or "")
        bullets = [_safe(b) for b in slide.get("bullets") or [] if _safe(b)]
        if not takeaway and not bullets:
            return
        ctx.content_card(
            title="Вывод",
            text=_sidebar_word_budget(takeaway or bullets[0], 36),
            x=x,
            y=cy,
            width=w,
            min_h=260_000,
            max_h=min(1_000_000, room()),
            tone="accent",
            title_size=11,
            body_size=11,
        )
        return

    # Reserve space for action + provenance so earlier cards do not starve them.
    reserve = 720_000
    headline = _sidebar_word_budget(_safe(analysis.get("headlineConclusion") or "Вывод"), 22)
    cy = ctx.content_card(
        title=None,
        text=headline,
        x=x,
        y=cy,
        width=w,
        min_h=240_000,
        max_h=min(620_000, max(240_000, room() - reserve)),
        tone="accent",
        body_size=12,
    )
    cy += gap

    marked = _safe(analysis.get("whatIsVisible") or "")
    why = _safe(analysis.get("whyItMatters") or "")
    reason = marked if marked else why
    if reason and room() > reserve:
        cy = ctx.content_card(
            title="Почему отмечено",
            text=_sidebar_word_budget(reason, 42),
            x=x,
            y=cy,
            width=w,
            min_h=280_000,
            max_h=min(1_100_000, max(280_000, room() - 520_000)),
            tone="warn",
            title_size=10,
            body_size=11,
        )
        cy += gap

    metrics = analysis.get("metrics") or []
    if isinstance(metrics, list) and metrics and room() > 900_000:
        # One compact chip row only when space remains.
        cy = ctx.metric_chips([m for m in metrics if isinstance(m, dict)][:2], x, cy, w)
        cy += gap

    actions = analysis.get("recommendedActions") or []
    action_text = _sidebar_word_budget(_safe(actions[0]), 16) if isinstance(actions, list) and actions else ""
    if action_text and room() > 240_000:
        cy = ctx.content_card(
            title="Действие",
            text=action_text,
            x=x,
            y=cy,
            width=w,
            min_h=220_000,
            max_h=min(520_000, room() - 160_000),
            tone="warn",
            title_size=10,
            body_size=11,
        )
        cy += gap

    footer_bits: list[str] = []
    lims = analysis.get("limitations") or []
    if isinstance(lims, list) and lims:
        footer_bits.append(_safe(lims[0]))
    prov = _safe(analysis.get("provenanceLabel") or "")
    if prov:
        footer_bits.append(prov)
    footer = _clip_words(" · ".join(footer_bits), 110)
    if footer and room() > 140_000:
        ctx.content_card(
            title=None,
            text=footer,
            x=x,
            y=cy,
            width=w,
            min_h=140_000,
            max_h=min(340_000, room()),
            tone="neutral",
            body_size=9,
            padding=60_000,
        )



def _tone_fill(tone: str) -> RGBColor:
    return {"risk": RISK_BG, "warn": WARN_BG, "good": GOOD_BG, "accent": ACCENT_SOFT}.get(tone, CARD_BG)


def _tone_value_color(tone: str) -> RGBColor:
    return {"risk": TONE_RISK, "warn": TONE_WARN, "good": TONE_GOOD}.get(tone, NAVY)


def _render_kpi_cards(ctx: _Ctx, metrics: list[dict[str, Any]], x: int, y: int, width: int, cols: int = 2) -> int:
    items = [m for m in metrics if isinstance(m, dict) and _safe(m.get("value"))][:6]
    if not items:
        return y
    gap = 80_000
    card_w = (width - gap * (cols - 1)) // cols
    card_h = 780_000
    row_y = y
    for idx, m in enumerate(items):
        col = idx % cols
        if idx > 0 and col == 0:
            row_y += card_h + gap
        cx = x + col * (card_w + gap)
        tone = str(m.get("tone") or "neutral")
        value = _clip_words(_safe(m.get("value")), 16)
        label = _clip_words(_safe(m.get("label")), 22)
        ctx.card(row_y, h=card_h, x=cx, w=card_w, fill=_tone_fill(tone))
        box = ctx.slide.shapes.add_textbox(
            Emu(cx + 70_000), Emu(row_y + 100_000), Emu(card_w - 140_000), Emu(card_h - 180_000)
        )
        tf = box.text_frame
        tf.word_wrap = True
        p0 = tf.paragraphs[0]
        r0 = p0.add_run()
        r0.text = value
        r0.font.name = FONT
        r0.font.bold = True
        r0.font.size = Pt(18 if len(value) <= 10 else 13)
        r0.font.color.rgb = _tone_value_color(tone)
        p1 = tf.add_paragraph()
        p1.space_before = Pt(6)
        r1 = p1.add_run()
        r1.text = label
        r1.font.name = FONT
        r1.font.size = Pt(11)
        r1.font.color.rgb = MUTED_COLOR
    rows = (len(items) + cols - 1) // cols
    return y + rows * card_h + max(0, rows - 1) * gap



def _render_status_badge(ctx: _Ctx, badge: dict[str, Any] | None, x: int, y: int, width: int) -> int:
    if not isinstance(badge, dict) or not _safe(badge.get("label")):
        return y
    tone = str(badge.get("tone") or "neutral")
    h = 360_000
    ctx.card(y, h=h, x=x, w=width, fill=_tone_fill(tone))
    box = ctx.slide.shapes.add_textbox(Emu(x + 90_000), Emu(y + 90_000), Emu(width - 180_000), Emu(200_000))
    tf = box.text_frame
    p = tf.paragraphs[0]
    r = p.add_run()
    r.text = _clip_words(_safe(badge.get("label")), 48)
    r.font.name = FONT
    r.font.bold = True
    r.font.size = Pt(14)
    r.font.color.rgb = _tone_value_color(tone)
    return y + h


def _render_executive_dashboard(ctx: _Ctx, slide: dict[str, Any], title: str) -> None:
    ctx.light_bg()
    y = ctx.title(title, 240000, NAVY, FS_SECTION)
    raw_narrative = str(slide.get("narrative") or "")
    paras = [p.strip() for p in re.split(r"\n+", raw_narrative) if p.strip()][:3]
    if not paras and raw_narrative:
        # Split long single paragraph into ~3 chunks on sentence boundaries.
        parts = re.split(r"(?<=[.!?])\s+", _safe(raw_narrative))
        paras = []
        buf = ""
        for part in parts:
            trial = f"{buf} {part}".strip() if buf else part
            if len(trial) > 280 and buf:
                paras.append(buf)
                buf = part
            else:
                buf = trial
            if len(paras) >= 3:
                break
        if buf and len(paras) < 3:
            paras.append(buf)
        paras = paras[:3] or [_clip_words(_safe(raw_narrative), 420)]
    left_w = int(CONTENT_W * 0.62)
    right_w = CONTENT_W - left_w - 120_000
    left_x = MARGIN_X
    right_x = MARGIN_X + left_w + 120_000
    cy = y
    for para in paras:
        cy = ctx.content_card(
            title=None,
            text=_clip_words(_safe(para), 420),
            x=left_x,
            y=cy,
            width=left_w,
            min_h=240_000,
            max_h=900_000,
            tone="neutral",
            body_size=11,
        )
        cy += 50_000
    metrics = [m for m in (slide.get("metrics") or []) if isinstance(m, dict)]
    _render_kpi_cards(ctx, metrics[:4], right_x, y, right_w, cols=2)
    bottom_y = max(cy, y + 1_600_000) + 40_000
    findings = [f for f in (slide.get("keyFindings") or []) if isinstance(f, dict)][:2]
    actions = [a for a in (slide.get("actions") or []) if isinstance(a, dict)][:1]
    cards: list[tuple[str, str, str]] = []
    for finding in findings:
        tone = str(finding.get("tone") or "warn")
        detail = _safe(finding.get("detail") or "")
        headline = _safe(finding.get("headline") or "")
        # Prefer detail; avoid duplicating headline when detail already starts with it.
        if detail and headline and detail.lower().startswith(headline.lower()[:24].lower()):
            text = _clip_words(detail, 180)
        elif detail:
            text = _clip_words(detail, 180)
        else:
            text = _clip_words(headline, 180)
        cards.append(("Риск", text, tone))
    if actions:
        act = actions[0]
        label = _safe(act.get("label"))
        text = _clip_words(label, 160)
        cards.append(("Следующий шаг", text, "accent"))
    if cards:
        gap = 80_000
        col_w = (CONTENT_W - gap * (len(cards) - 1)) // max(1, len(cards))
        fx = MARGIN_X
        card_max = min(1_500_000, max(520_000, CONTENT_BOTTOM - bottom_y - 40_000))
        for card_title, text, tone in cards:
            ctx.content_card(
                title=card_title,
                text=text,
                x=fx,
                y=bottom_y,
                width=col_w,
                min_h=420_000,
                max_h=card_max,
                tone=tone,
                title_size=11,
                body_size=11,
            )
            fx += col_w + gap


def _render_risk_matrix_grid(ctx: _Ctx, slide: dict[str, Any], title: str) -> None:
    ctx.light_bg()
    y = ctx.title(title or "Матрица рисков", 240000, NAVY, FS_SECTION)
    findings = [f for f in (slide.get("keyFindings") or []) if isinstance(f, dict)]
    if not findings:
        bullets = [_safe(b) for b in slide.get("bullets") or [] if _safe(b)]
        findings = [{"headline": b.split("—")[0].strip()[:60], "detail": b, "tone": "warn"} for b in bullets[:6]]
    badge_w = 1_700_000
    for finding in findings[:6]:
        tone = str(finding.get("tone") or "warn")
        pill = _clip_words(_safe(finding.get("status") or finding.get("severity") or ""), 22)
        headline = _clip_words(_safe(finding.get("headline") or "Тема"), 64)
        detail = _clip_words(_safe(finding.get("detail") or ""), 160)
        marker = _safe(finding.get("manualReview") or "")
        text_w = CONTENT_W - badge_w - 280_000 if pill else int(CONTENT_W * 0.9)
        left = MARGIN_X + 100_000
        h = 140_000
        h += measure_text_height(headline, text_w, 13, line_spacing=1.15)
        if detail:
            h += 30_000 + measure_text_height(detail, text_w, 11, line_spacing=1.2)
        if marker:
            h += 90_000
        h = max(520_000, min(h + 120_000, CONTENT_BOTTOM - y - 40_000))
        ctx.card(y, h=h, fill=_tone_fill(tone))
        box = ctx.slide.shapes.add_textbox(Emu(left), Emu(y + 90_000), Emu(text_w), Emu(260_000))
        tf = box.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        r = p.add_run()
        r.text = headline
        r.font.name = FONT
        r.font.bold = True
        r.font.size = Pt(13)
        r.font.color.rgb = NAVY
        text_y = y + 90_000 + measure_text_height(headline, text_w, 13, line_spacing=1.15) + 20_000
        if detail:
            fitted = _fit_text_to_height(detail, text_w, 11, max(160_000, h - (text_y - y) - 140_000))
            ctx.body(fitted, text_y, max_h=max(160_000, h - (text_y - y) - 140_000), x=left, w=text_w, font_size=11)
        if pill:
            bx = MARGIN_X + CONTENT_W - badge_w - 100_000
            by = y + 90_000
            ctx.card(by, h=260_000, x=bx, w=badge_w, fill=_tone_fill(tone))
            b = ctx.slide.shapes.add_textbox(Emu(bx + 50_000), Emu(by + 70_000), Emu(badge_w - 100_000), Emu(140_000))
            bp = b.text_frame.paragraphs[0]
            br = bp.add_run()
            br.text = pill
            br.font.name = FONT
            br.font.bold = True
            br.font.size = Pt(11)
            br.font.color.rgb = _tone_value_color(tone)
        if marker:
            ctx.body(marker, y + h - 120_000, max_h=90_000, x=left, w=text_w, font_size=9, color=MUTED_COLOR)
        y += h + 60_000
        if y > CONTENT_BOTTOM - 360_000:
            break



def _render_profile_overview(ctx: _Ctx, slide: dict[str, Any], title: str) -> None:
    ctx.light_bg()
    y = ctx.title(title, 240000, NAVY, FS_SECTION)
    y = _render_status_badge(
        ctx, slide.get("statusBadge") if isinstance(slide.get("statusBadge"), dict) else None, MARGIN_X, y, CONTENT_W
    )
    y += 80_000
    metrics = [m for m in (slide.get("metrics") or []) if isinstance(m, dict)]
    ru = [m for m in metrics if "RU" in _safe(m.get("label")).upper() or "Росс" in _safe(m.get("label"))]
    uae = [m for m in metrics if "UAE" in _safe(m.get("label")).upper() or "ОАЭ" in _safe(m.get("label"))]
    other = [m for m in metrics if m not in ru and m not in uae]
    half = (CONTENT_W - 100_000) // 2
    if ru or uae:
        left_metrics = (ru or metrics[:4])[:4]
        right_metrics = (uae or metrics[4:8])[:4]
        hdr_h = 320_000
        for label, xx in (("Россия", MARGIN_X), ("ОАЭ", MARGIN_X + half + 100_000)):
            ctx.card(y, h=hdr_h, x=xx, w=half, fill=ACCENT_SOFT)
            box = ctx.slide.shapes.add_textbox(Emu(xx + 90_000), Emu(y + 90_000), Emu(half - 180_000), Emu(160_000))
            rr = box.text_frame.paragraphs[0].add_run()
            rr.text = label
            rr.font.name = FONT
            rr.font.bold = True
            rr.font.size = Pt(14)
            rr.font.color.rgb = NAVY
        y += hdr_h + 80_000
        left_bottom = _render_kpi_cards(ctx, left_metrics, MARGIN_X, y, half, cols=2)
        right_bottom = _render_kpi_cards(ctx, right_metrics, MARGIN_X + half + 100_000, y, half, cols=2)
        y = max(left_bottom, right_bottom) + 100_000
    else:
        y = _render_kpi_cards(ctx, metrics[:8], MARGIN_X, y, CONTENT_W, cols=4) + 100_000
    if other:
        y = _render_kpi_cards(ctx, other[:4], MARGIN_X, y, CONTENT_W, cols=4) + 80_000
    findings = [f for f in (slide.get("keyFindings") or []) if isinstance(f, dict)][:3]
    for finding in findings:
        if y > CONTENT_BOTTOM - 360_000:
            break
        y = ctx.content_card(
            title=_clip_words(_safe(finding.get("headline")), 40),
            text=_clip_words(_safe(finding.get("detail")), 140),
            x=MARGIN_X,
            y=y,
            width=CONTENT_W,
            min_h=280_000,
            max_h=700_000,
            tone=str(finding.get("tone") or "neutral"),
            title_size=11,
            body_size=11,
        )
        y += 60_000



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
            # Top-align visual with sidebar (do not vertically center in full column).
            scale = min(img_w / max(iw, 1), (img_h - 60000) / max(ih, 1))
            dw, dh = int(iw * scale), int(ih * scale)
            left = MARGIN_X + (img_w - dw) // 2
            top = y + 60000
            ctx.slide.shapes.add_picture(io.BytesIO(raw), Emu(left), Emu(top), width=Emu(dw), height=Emu(dh))
        else:
            ctx.body("Визуальный материал недоступен.", y + 80000, max_h=600000, color=MUTED_COLOR)
    else:
        reason = _safe(slide.get("blockedReason") or "Визуальный материал недоступен для данного раздела.")
        ctx.body(reason, y + 80000, max_h=800000, color=MUTED_COLOR)
    if has_sidebar and side_w > 400000:
        _sidebar_analysis(ctx, slide, MARGIN_X + img_w + 120000, y + 60000, side_w, img_h - 60000)


def _add_search_table(
    ctx: _Ctx,
    y: int,
    headers: list[str],
    rows: list[list[str]],
) -> None:
    """Real PPTX table for SERP / heat-grid slides (max 10 data rows)."""
    cols = max(1, min(5, len(headers)))
    data_rows = rows[:10]
    table_rows = 1 + len(data_rows)
    avail_h = max(800000, CONTENT_BOTTOM - y - 40000)
    row_h = min(420000, max(280000, avail_h // max(table_rows, 1)))
    table_h = row_h * table_rows
    shape = ctx.slide.shapes.add_table(table_rows, cols, Emu(MARGIN_X), Emu(y), Emu(CONTENT_W), Emu(table_h))
    tbl = shape.table

    # Column widths: prefer compact rank/risk columns
    if cols >= 4:
        widths = [900000, 1800000, CONTENT_W - 900000 - 1800000 - 2200000 - 700000, 2200000, 700000][:cols]
        # Recalc if 4 cols without risk
        if cols == 4:
            widths = [900000, 2000000, CONTENT_W - 900000 - 2000000 - 2400000, 2400000]
        leftover = CONTENT_W - sum(widths)
        if leftover != 0 and widths:
            widths[min(2, len(widths) - 1)] += leftover
        for i, w in enumerate(widths):
            tbl.columns[i].width = Emu(max(500000, w))

    def paint_cell(cell: Any, text: str, *, header: bool = False, adverse: bool = False) -> None:
        cell.text = _clip_words(text, 90 if header else 70)
        for p in cell.text_frame.paragraphs:
            p.font.name = FONT
            p.font.size = Pt(10 if header else 9)
            p.font.bold = header
            p.font.color.rgb = WHITE if header else (RGBColor(0xB9, 0x1C, 0x1C) if adverse else BODY_COLOR)
        fill = cell.fill
        fill.solid()
        fill.fore_color.rgb = NAVY if header else (RGBColor(0xFE, 0xF2, 0xF2) if adverse else WHITE)

    for c, h in enumerate(headers[:cols]):
        paint_cell(tbl.cell(0, c), str(h), header=True)
    for r_idx, row in enumerate(data_rows, start=1):
        adverse = any(str(cell).strip() in ("Н", "[Н]") for cell in row) or str(row[0] if row else "").startswith("[Н]")
        if len(row) >= 5 and str(row[4]).strip() in ("Н", "N"):
            adverse = True
        for c in range(cols):
            val = str(row[c]) if c < len(row) else ""
            if c == cols - 1 and val in ("Н", "·", "N", "."):
                val = "Нежел." if val in ("Н", "N") else "·"
            paint_cell(tbl.cell(r_idx, c), val, adverse=adverse)


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

    if template == "orion_golden_executive_dashboard":
        _render_executive_dashboard(ctx, slide, title)
        return

    if template == "orion_golden_risk_matrix_grid":
        _render_risk_matrix_grid(ctx, slide, title)
        return

    if template == "orion_golden_profile_overview":
        _render_profile_overview(ctx, slide, title)
        return

    if template == "orion_golden_executive_card":
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY, FS_SECTION)
        metrics = [m for m in (slide.get("metrics") or []) if isinstance(m, dict)]
        if metrics:
            y = _render_kpi_cards(ctx, metrics[:4], MARGIN_X, y, CONTENT_W, cols=4) + 100_000
        narr = narrative.strip()
        if narr and not bullets:
            y = ctx.content_card(
                title=None,
                text=_clip_words(narr, 1800),
                x=MARGIN_X,
                y=y,
                width=CONTENT_W,
                min_h=400_000,
                max_h=min(3_200_000, CONTENT_BOTTOM - y - 100_000),
                tone="neutral",
                body_size=11,
            )
            return
        if narr:
            y = ctx.content_card(
                title=None,
                text=_clip_words(narr, 1200),
                x=MARGIN_X,
                y=y,
                width=CONTENT_W,
                min_h=320_000,
                max_h=min(2_000_000, CONTENT_BOTTOM - y - (1_200_000 if bullets else 100_000)),
                tone="neutral",
                body_size=11,
            )
            y += 100_000
        if bullets:
            ctx.bullets(bullets, y, max_items=7, max_chars=280)
        return

    if template == "orion_golden_risk_matrix":
        _render_risk_matrix_grid(ctx, slide, title or "Матрица рисков")
        return

    if template == "orion_golden_region_divider":
        ctx.dark_bg()
        ctx.title(title, 2800000, WHITE, 34)
        return

    if template == "orion_golden_metrics_dashboard":
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY, FS_SECTION)
        badge = slide.get("statusBadge") if isinstance(slide.get("statusBadge"), dict) else None
        if badge:
            y = _render_status_badge(ctx, badge, MARGIN_X, y, CONTENT_W) + 80_000
        if narrative:
            y = ctx.content_card(
                title=None,
                text=_clip_words(narrative, 420),
                x=MARGIN_X,
                y=y,
                width=CONTENT_W,
                min_h=260_000,
                max_h=800_000,
                tone="neutral",
                body_size=11,
            )
            y += 80_000
        metrics = [m for m in (slide.get("metrics") or []) if isinstance(m, dict)]
        if metrics:
            y = _render_kpi_cards(ctx, metrics[:6], MARGIN_X, y, CONTENT_W, cols=3) + 80_000
        actions = [a for a in (slide.get("actions") or []) if isinstance(a, dict)]
        if actions:
            y = ctx.content_card(
                title="Действие",
                text=_clip_words(_safe(actions[0].get("label")), 160),
                x=MARGIN_X,
                y=y,
                width=CONTENT_W,
                min_h=260_000,
                max_h=600_000,
                tone="warn",
                title_size=11,
                body_size=11,
            )
            y += 60_000
        if bullets:
            ctx.bullets(bullets, y, max_items=5, max_chars=180)
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

    if template == "orion_golden_surface_panel":
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

    if template == "orion_golden_compliance_visual_page":
        # Dow Jones / World-Check approved screenshots — same layout as Lexis visual.
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
            y = ctx.body(_clip_words(narrative, 280), y, max_h=420000, color=MUTED_COLOR)
            y = y + 40000
        table = slide.get("table") if isinstance(slide.get("table"), dict) else None
        headers = list((table or {}).get("headers") or [])
        rows = list((table or {}).get("rows") or [])
        if not rows and bullets:
            # Fallback: parse bullet lines into a compact table
            headers = ["Поз.", "Домен", "Заголовок", "Риск"]
            parsed: list[list[str]] = []
            for bullet in bullets[:10]:
                raw = _safe(bullet)
                m = re.match(
                    r"^(?:\[([Н·N.])\]\s*)?#?\s*(\d+)\s+([^\s—\-]+)\s*[—\-–]\s*(.+)$",
                    raw,
                )
                if m:
                    mark = "Н" if m.group(1) in ("Н", "N") else "·"
                    parsed.append([m.group(2), m.group(3), _clip_words(m.group(4), 70), mark])
                else:
                    parsed.append(["—", "—", _clip_words(raw, 80), "·"])
            rows = parsed
        if headers and rows:
            _add_search_table(ctx, y, headers[:5], rows[:10])
        elif bullets:
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
                r = p.add_run()
                clipped = _clip_words(bullet, 160)
                r.text = f"• {clipped}"
                r.font.name = FONT
                r.font.size = Pt(11)
                r.font.color.rgb = (
                    RGBColor(0xB9, 0x1C, 0x1C) if clipped.startswith("[Н]") else BODY_COLOR
                )
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
