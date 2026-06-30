"""Visual design tokens + reusable slide components for template v3 (Stage K3).

A single source of truth for colours, typography, spacing and the building
blocks (page frame, cards, badges, polished tables, notes) used by the polished
report template. Keeping this isolated means v1/v2/simple renderers are
untouched and the look can be tuned in one place.

No LLM, no network — pure layout helpers over python-pptx.
"""

from __future__ import annotations

from typing import Any

from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Pt

# ---------------------------------------------------------------------------
# Palette (neutral "Digital Profile Audit" brand — no third-party branding)
# ---------------------------------------------------------------------------
BRAND_PRIMARY = RGBColor(0x0E, 0x1F, 0x3A)   # deep navy
ACCENT = RGBColor(0x1C, 0x6F, 0xD6)          # blue accent
ACCENT_SOFT = RGBColor(0x9E, 0xC2, 0xF0)     # light blue
NEUTRAL_DARK = RGBColor(0x1A, 0x1F, 0x29)    # near-black ink
NEUTRAL_GRAY = RGBColor(0x68, 0x71, 0x80)    # muted text
NEUTRAL_LINE = RGBColor(0xD8, 0xDE, 0xE6)    # hairline / card border
BG_LIGHT = RGBColor(0xFF, 0xFF, 0xFF)        # page background
BG_PANEL = RGBColor(0xF3, 0xF6, 0xFB)        # subtle panel fill
TABLE_HEAD = RGBColor(0x16, 0x2C, 0x4A)
TABLE_ZEBRA = RGBColor(0xEF, 0xF3, 0xF9)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
WATERMARK_COLOR = RGBColor(0xDD, 0xE2, 0xEA)

SUCCESS = RGBColor(0x2E, 0x7D, 0x32)
WARNING = RGBColor(0xB8, 0x86, 0x00)
DANGER = RGBColor(0xB0, 0x1E, 0x1E)

RISK_COLORS = {
    "LOW": SUCCESS,
    "MEDIUM": WARNING,
    "HIGH": RGBColor(0xC6, 0x4A, 0x00),
    "CRITICAL": DANGER,
    "UNKNOWN": NEUTRAL_GRAY,
    "NONE": NEUTRAL_GRAY,
}

# Review-status badge tones (match enum keys after uppercasing).
REVIEW_STATUS_COLORS = {
    "PENDING": WARNING,
    "NEEDS_REVIEW": WARNING,
    "MATCH_CONFIRMED": DANGER,
    "FALSE_POSITIVE": SUCCESS,
    "DISMISSED": NEUTRAL_GRAY,
}

# Source-type badge tones for compliance tables.
SOURCE_TYPE_COLORS = {
    "REAL API": ACCENT,
    "MANUAL IMPORT": RGBColor(0x15, 0x65, 0xC0),
    "MOCK/DEMO": NEUTRAL_GRAY,
    "NOT CONFIGURED": NEUTRAL_GRAY,
    "STUB": NEUTRAL_GRAY,
}

# ---------------------------------------------------------------------------
# Typography (pt) and spacing (EMU; 914400 = 1 inch)
# ---------------------------------------------------------------------------
FS_COVER_TITLE = 46
FS_MAIN_TITLE = 26
FS_SECTION_TITLE = 18
FS_SUBTITLE = 13
FS_TABLE_HEAD = 11
FS_TABLE_BODY = 10
FS_METRIC_LABEL = 11
FS_METRIC_VALUE = 24
FS_BODY = 14
FS_NOTE = 10
FS_FOOTER = 9

SLIDE_W = Emu(9144000)
SLIDE_H = Emu(6858000)
MARGIN = Emu(548640)            # ~0.6"
CONTENT_W = Emu(int(SLIDE_W) - 2 * int(MARGIN))
CONTENT_TOP = Emu(1310640)      # where content starts under the header
FOOTER_Y = Emu(6492240)
GUTTER = Emu(137160)            # ~0.15" gap between cards

ROUNDED_RECT = 5
RECT = 1

# Localizable table footnote ("Showing top N of M."). Set per-render via
# ``set_table_strings`` so v3 tables honour the report language.
_SHOWING_TOP = "Showing top {n} of {total}."


def set_table_strings(showing_top: str | None) -> None:
    global _SHOWING_TOP
    if showing_top:
        _SHOWING_TOP = showing_top


# ---------------------------------------------------------------------------
# Base helpers
# ---------------------------------------------------------------------------

def blank_slide(prs):
    layouts = prs.slide_layouts
    layout = layouts[6] if len(layouts) > 6 else layouts[-1]
    return prs.slides.add_slide(layout)


def set_bg(slide, color: RGBColor) -> None:
    slide.background.fill.solid()
    slide.background.fill.fore_color.rgb = color


def textbox(slide, x, y, w, h):
    box = slide.shapes.add_textbox(x, y, w, h)
    box.text_frame.word_wrap = True
    return box


def _run(p, text: str, size: int, color: RGBColor, bold: bool = False, italic: bool = False):
    run = p.add_run()
    run.text = text
    run.font.size = Pt(size)
    run.font.color.rgb = color
    run.font.bold = bold
    run.font.italic = italic
    return run


def truncate(text: Any, length: int) -> str:
    s = "" if text is None else str(text)
    return s if len(s) <= length else s[: length - 1] + "\u2026"


# ---------------------------------------------------------------------------
# Page frame: accent bar + title + subtitle + footer + page number
# ---------------------------------------------------------------------------

def page_frame(
    slide,
    title: str,
    subtitle: str | None = None,
    brand: str = "Digital Profile Audit",
    page_no: int | None = None,
    total: int | None = None,
    watermark: str | None = None,
) -> Emu:
    set_bg(slide, BG_LIGHT)
    # top accent bar
    bar = slide.shapes.add_shape(RECT, Emu(0), Emu(0), SLIDE_W, Emu(73152))
    bar.fill.solid()
    bar.fill.fore_color.rgb = ACCENT
    bar.line.fill.background()

    if watermark:
        _watermark(slide, watermark)

    box = textbox(slide, MARGIN, Emu(228600), CONTENT_W, Emu(960120))
    tf = box.text_frame
    _run(tf.paragraphs[0], title or "", FS_MAIN_TITLE, BRAND_PRIMARY, bold=True)
    if subtitle:
        sp = tf.add_paragraph()
        _run(sp, subtitle, FS_SUBTITLE, NEUTRAL_GRAY)

    footer(slide, brand, page_no, total)
    return CONTENT_TOP


def footer(slide, brand: str, page_no: int | None, total: int | None) -> None:
    line = slide.shapes.add_shape(RECT, MARGIN, FOOTER_Y, CONTENT_W, Emu(12700))
    line.fill.solid()
    line.fill.fore_color.rgb = NEUTRAL_LINE
    line.line.fill.background()

    box = textbox(slide, MARGIN, Emu(int(FOOTER_Y) + 36000), CONTENT_W, Emu(260000))
    tf = box.text_frame
    p = tf.paragraphs[0]
    _run(p, brand, FS_FOOTER, NEUTRAL_GRAY)
    if page_no is not None:
        rbox = textbox(slide, MARGIN, Emu(int(FOOTER_Y) + 36000), CONTENT_W, Emu(260000))
        rp = rbox.text_frame.paragraphs[0]
        rp.alignment = PP_ALIGN.RIGHT
        label = f"{page_no}" + (f" / {total}" if total else "")
        _run(rp, label, FS_FOOTER, NEUTRAL_GRAY)


def _watermark(slide, text: str) -> None:
    box = textbox(slide, Emu(1371600), Emu(2900000), Emu(6400800), Emu(1200000))
    p = box.text_frame.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    _run(p, text, 66, WATERMARK_COLOR, bold=True)


# ---------------------------------------------------------------------------
# Text-height estimation (python-pptx cannot measure rendered text, so we
# approximate wrapped line counts to stack elements without overlap).
# ---------------------------------------------------------------------------

EMU_PER_PT = 12700
# Default text-frame left+right insets (~0.1" each).
_TEXT_INSET_PT = 14.0
# Conservative average glyph advance as a fraction of the font size. Slightly
# high on purpose so we over- rather than under-estimate height (no overlap).
_CHAR_W_FACTOR = 0.55
# Vertical gap kept below stacked blocks.
_BLOCK_GAP = Emu(140000)


def _emu_to_pt(emu: Emu) -> float:
    return int(emu) / EMU_PER_PT


def _wrapped_lines(text: str, size: int, width: Emu) -> int:
    """Estimate how many visual lines `text` occupies at `size` within `width`."""
    usable_pt = max(1.0, _emu_to_pt(width) - _TEXT_INSET_PT)
    char_w = max(1.0, size * _CHAR_W_FACTOR)
    chars_per_line = max(1, int(usable_pt / char_w))
    length = max(1, len(text or ""))
    return max(1, -(-length // chars_per_line))  # ceil division


def text_block_height(lines: list[str], size: int, width: Emu,
                      space_after_pt: float = 5.0, pad_pt: float = 12.0) -> Emu:
    """Estimated rendered height of a stacked set of paragraphs."""
    line_h_pt = size * 1.2
    total_pt = pad_pt
    for line in lines:
        vis = _wrapped_lines(line, size, width)
        total_pt += vis * line_h_pt + space_after_pt
    return Emu(int(total_pt * EMU_PER_PT))


# ---------------------------------------------------------------------------
# Bullets
# ---------------------------------------------------------------------------

def bullets(slide, top: Emu, lines: list[str], size: int = FS_BODY, width: Emu | None = None) -> Emu:
    lines = [l for l in lines if l]
    if not lines:
        return top
    w = width or CONTENT_W
    rendered = [f"\u2022 {line}" for line in lines]
    h = text_block_height(rendered, size, w)
    box = textbox(slide, MARGIN, top, w, h)
    tf = box.text_frame
    for i, line in enumerate(rendered):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        _run(p, line, size, NEUTRAL_DARK)
        p.space_after = Pt(5)
    return Emu(int(top) + int(h) + int(_BLOCK_GAP))


# ---------------------------------------------------------------------------
# Badges
# ---------------------------------------------------------------------------

def risk_badge(slide, x: Emu, y: Emu, level: str, w: Emu = Emu(1500000), h: Emu = Emu(470000)) -> None:
    lvl = str(level or "UNKNOWN").upper()
    shape = slide.shapes.add_shape(ROUNDED_RECT, x, y, w, h)
    shape.fill.solid()
    shape.fill.fore_color.rgb = RISK_COLORS.get(lvl, NEUTRAL_GRAY)
    shape.line.fill.background()
    tf = shape.text_frame
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    _run(p, lvl, 13, WHITE, bold=True)


def _pill_badge(slide, x: Emu, y: Emu, text: str, tone: RGBColor, w: Emu = Emu(1700000), h: Emu = Emu(420000)) -> None:
    shape = slide.shapes.add_shape(ROUNDED_RECT, x, y, w, h)
    shape.fill.solid()
    shape.fill.fore_color.rgb = tone
    shape.line.fill.background()
    tf = shape.text_frame
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    _run(p, truncate(text, 22), 10, WHITE, bold=True)


def review_status_badge(slide, x: Emu, y: Emu, status: str, label: str | None = None) -> None:
    key = str(status or "PENDING").upper()
    _pill_badge(slide, x, y, label or key, REVIEW_STATUS_COLORS.get(key, NEUTRAL_GRAY))


def source_badge(slide, x: Emu, y: Emu, source_type: str, label: str | None = None) -> None:
    key = str(source_type or "").upper()
    tone = SOURCE_TYPE_COLORS.get(key, NEUTRAL_GRAY)
    for k, v in SOURCE_TYPE_COLORS.items():
        if k in key:
            tone = v
            break
    _pill_badge(slide, x, y, label or source_type, tone, w=Emu(1900000))


def metric_card(slide, top: Emu, label: str, value: Any, tone: RGBColor = ACCENT) -> Emu:
    return metric_cards(slide, top, [{"label": label, "value": value, "tone": tone}], per_row=1)


def warning_card(slide, top: Emu, text: str) -> Emu:
    if not text:
        return top
    h = 820000
    shape = slide.shapes.add_shape(ROUNDED_RECT, MARGIN, top, CONTENT_W, Emu(h))
    shape.fill.solid()
    shape.fill.fore_color.rgb = BG_PANEL
    shape.line.color.rgb = WARNING
    shape.line.width = Pt(1.25)
    strip = slide.shapes.add_shape(RECT, MARGIN, top, Emu(64008), Emu(h))
    strip.fill.solid()
    strip.fill.fore_color.rgb = WARNING
    strip.line.fill.background()
    box = textbox(slide, Emu(int(MARGIN) + 160000), Emu(int(top) + 90000), Emu(int(CONTENT_W) - 240000), Emu(h - 160000))
    tf = box.text_frame
    _run(tf.paragraphs[0], text, FS_NOTE + 1, NEUTRAL_DARK)
    return Emu(int(top) + h + 80000)


def source_note(slide, top: Emu, text: str) -> Emu:
    return note(slide, top, text, "source")


def polished_table(slide, top: Emu, columns: list[str], rows: list[list[Any]], **kwargs) -> Emu:
    return table(slide, top, columns, rows, **kwargs)


# ---------------------------------------------------------------------------
# Cards / metrics
# ---------------------------------------------------------------------------

def card(slide, x: Emu, y: Emu, w: Emu, h: Emu, title: str, lines: list[str], tone: RGBColor = ACCENT):
    shape = slide.shapes.add_shape(ROUNDED_RECT, x, y, w, h)
    shape.fill.solid()
    shape.fill.fore_color.rgb = BG_PANEL
    shape.line.color.rgb = NEUTRAL_LINE
    shape.line.width = Pt(0.75)
    # accent strip
    strip = slide.shapes.add_shape(RECT, x, y, Emu(64008), h)
    strip.fill.solid()
    strip.fill.fore_color.rgb = tone
    strip.line.fill.background()

    box = textbox(slide, Emu(int(x) + 160000), Emu(int(y) + 90000), Emu(int(w) - 240000), Emu(int(h) - 160000))
    tf = box.text_frame
    if title:
        _run(tf.paragraphs[0], title, FS_SECTION_TITLE - 2, BRAND_PRIMARY, bold=True)
    for i, line in enumerate(lines):
        p = tf.add_paragraph() if (title or i > 0) else tf.paragraphs[0]
        _run(p, line, FS_BODY - 2, NEUTRAL_DARK)
        p.space_after = Pt(2)


def metric_cards(slide, top: Emu, cards: list[dict], per_row: int = 4) -> Emu:
    """cards: [{label, value, tone?}]. Lays a responsive grid of metric cards."""
    if not cards:
        return top
    per_row = max(1, min(per_row, len(cards)))
    gap = int(GUTTER)
    card_w = (int(CONTENT_W) - gap * (per_row - 1)) // per_row
    card_h = 980000
    y = int(top)
    for idx, c in enumerate(cards):
        col = idx % per_row
        if col == 0 and idx > 0:
            y += card_h + gap
        x = int(MARGIN) + col * (card_w + gap)
        shape = slide.shapes.add_shape(ROUNDED_RECT, Emu(x), Emu(y), Emu(card_w), Emu(card_h))
        shape.fill.solid()
        shape.fill.fore_color.rgb = BG_PANEL
        shape.line.color.rgb = NEUTRAL_LINE
        shape.line.width = Pt(0.75)
        box = textbox(slide, Emu(x + 110000), Emu(y + 90000), Emu(card_w - 180000), Emu(card_h - 160000))
        tf = box.text_frame
        _run(tf.paragraphs[0], str(c.get("label", "")), FS_METRIC_LABEL, NEUTRAL_GRAY)
        vp = tf.add_paragraph()
        val = str(c.get("value", ""))
        val_size = FS_METRIC_VALUE - (8 if len(val) > 12 else 0) - (4 if len(val) > 8 else 0)
        _run(vp, val, max(14, val_size), c.get("tone", ACCENT), bold=True)
    rows = (len(cards) + per_row - 1) // per_row
    return Emu(int(top) + rows * (card_h + gap) + 60000)


def no_data_card(slide, top: Emu, text: str) -> Emu:
    h = 760000
    shape = slide.shapes.add_shape(ROUNDED_RECT, MARGIN, top, CONTENT_W, Emu(h))
    shape.fill.solid()
    shape.fill.fore_color.rgb = BG_PANEL
    shape.line.color.rgb = NEUTRAL_LINE
    shape.line.width = Pt(0.75)
    icon = slide.shapes.add_shape(ROUNDED_RECT, Emu(int(MARGIN) + 180000), Emu(int(top) + 280000), Emu(90000), Emu(90000))
    icon.fill.solid()
    icon.fill.fore_color.rgb = NEUTRAL_LINE
    icon.line.fill.background()
    tf = shape.text_frame
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    _run(p, text, FS_BODY - 1, NEUTRAL_GRAY, italic=True)
    return Emu(int(top) + h + 80000)


def step_cards(slide, top: Emu, steps: list[str], per_row: int = 1) -> Emu:
    """Numbered process/timeline blocks for commercial pages."""
    if not steps:
        return top
    per_row = max(1, min(per_row, 2))
    gap = int(GUTTER)
    card_w = (int(CONTENT_W) - gap * (per_row - 1)) // per_row
    card_h = 720000
    y = int(top)
    for idx, step in enumerate(steps):
        col = idx % per_row
        if col == 0 and idx > 0:
            y += card_h + gap
        x = int(MARGIN) + col * (card_w + gap)
        shape = slide.shapes.add_shape(ROUNDED_RECT, Emu(x), Emu(y), Emu(card_w), Emu(card_h))
        shape.fill.solid()
        shape.fill.fore_color.rgb = BG_PANEL
        shape.line.color.rgb = NEUTRAL_LINE
        shape.line.width = Pt(0.75)
        num = slide.shapes.add_shape(ROUNDED_RECT, Emu(x + 90000), Emu(y + 90000), Emu(340000), Emu(340000))
        num.fill.solid()
        num.fill.fore_color.rgb = ACCENT
        num.line.fill.background()
        ntf = num.text_frame
        ntf.vertical_anchor = MSO_ANCHOR.MIDDLE
        np = ntf.paragraphs[0]
        np.alignment = PP_ALIGN.CENTER
        _run(np, str(idx + 1), 12, WHITE, bold=True)
        box = textbox(slide, Emu(x + 480000), Emu(y + 80000), Emu(card_w - 560000), Emu(card_h - 140000))
        tf = box.text_frame
        _run(tf.paragraphs[0], truncate(step, 120), FS_BODY - 2, NEUTRAL_DARK)
    rows = (len(steps) + per_row - 1) // per_row
    return Emu(int(top) + rows * (card_h + gap) + 60000)


# kind -> (border tone, label)
NOTE_TONES = {
    "warning": WARNING,
    "disclaimer": NEUTRAL_GRAY,
    "source": ACCENT,
    "info": ACCENT,
}


def note(slide, top: Emu, text: str, kind: str = "info") -> Emu:
    if not text:
        return top
    tone = NOTE_TONES.get(kind, ACCENT)
    prefix = {"warning": "\u26a0 ", "disclaimer": "", "source": "Source: ", "info": ""}.get(kind, "")
    full = f"{prefix}{text}"
    h = text_block_height([full], FS_NOTE, CONTENT_W, space_after_pt=0.0, pad_pt=10.0)
    box = textbox(slide, MARGIN, top, CONTENT_W, h)
    tf = box.text_frame
    p = tf.paragraphs[0]
    _run(p, full, FS_NOTE, tone, italic=(kind != "warning"))
    return Emu(int(top) + int(h) + int(_BLOCK_GAP))


# ---------------------------------------------------------------------------
# Polished table (zebra + header contrast + risk-coloured cells)
# ---------------------------------------------------------------------------

_RISK_WORDS = {"LOW", "MEDIUM", "HIGH", "CRITICAL"}
_REVIEW_WORDS = {"PENDING", "NEEDS REVIEW", "MATCH CONFIRMED", "FALSE POSITIVE", "DISMISSED"}
_SOURCE_WORDS = {
    "REAL API", "MANUAL IMPORT", "MOCK/DEMO", "NOT CONFIGURED", "STUB",
    "РЕАЛЬНЫЙ API", "РУЧНОЙ ИМПОРТ", "MOCK", "DEMO",
}


def _cell_color(val: str) -> RGBColor | None:
    up = str(val).upper().strip()
    if up in _RISK_WORDS:
        return RISK_COLORS.get(up, NEUTRAL_DARK)
    for key, color in REVIEW_STATUS_COLORS.items():
        if key.replace("_", " ") in up or up == key:
            return color
    for src, color in SOURCE_TYPE_COLORS.items():
        if src in up:
            return color
    if up in _REVIEW_WORDS:
        return WARNING
    if any(s in up for s in _SOURCE_WORDS):
        return ACCENT
    return None


def table(
    slide,
    top: Emu,
    columns: list[str],
    rows: list[list[Any]],
    max_rows: int = 12,
    col_widths: list[float] | None = None,
    note_text: str | None = None,
) -> Emu:
    total = len(rows)
    rows = rows[:max_rows]
    n_rows = len(rows) + 1
    n_cols = max(1, len(columns))
    height = Emu(min(335280 * n_rows, 4200000))
    graphic = slide.shapes.add_table(n_rows, n_cols, MARGIN, top, CONTENT_W, height)
    tbl = graphic.table

    if col_widths and len(col_widths) == n_cols:
        total_w = int(CONTENT_W)
        s = sum(col_widths)
        for c, frac in enumerate(col_widths):
            tbl.columns[c].width = Emu(int(total_w * frac / s))

    for c, col in enumerate(columns):
        cell = tbl.cell(0, c)
        cell.text = str(col)
        cell.fill.solid()
        cell.fill.fore_color.rgb = TABLE_HEAD
        para = cell.text_frame.paragraphs[0]
        para.font.bold = True
        para.font.size = Pt(FS_TABLE_HEAD)
        para.font.color.rgb = WHITE

    for r, row in enumerate(rows, start=1):
        for c in range(n_cols):
            cell = tbl.cell(r, c)
            val = row[c] if c < len(row) else ""
            cell.text = "" if val is None else str(val)
            para = cell.text_frame.paragraphs[0]
            para.font.size = Pt(FS_TABLE_BODY)
            tone = _cell_color(str(val))
            if tone:
                para.font.color.rgb = tone
                para.font.bold = True
            else:
                para.font.color.rgb = NEUTRAL_DARK
            if r % 2 == 0:
                cell.fill.solid()
                cell.fill.fore_color.rgb = TABLE_ZEBRA

    bottom = Emu(int(top) + int(height) + 140000)
    label = note_text
    if total > max_rows:
        label = _SHOWING_TOP.format(n=max_rows, total=total) + (f" {note_text}" if note_text else "")
    if label:
        bottom = note(slide, bottom, label, "source")
    return bottom


def image_grid(
    slide,
    top: Emu,
    items: list[dict[str, Any]],
    *,
    cols: int = 3,
    max_items: int = 9,
    show_identity: bool = False,
) -> Emu:
    """O5.3 — compact thumbnail grid with title + source captions."""
    import base64
    import io

    picked = items[:max_items]
    if not picked:
        return top

    gap = int(GUTTER)
    cols = max(1, min(cols, 3))
    cell_w = (int(CONTENT_W) - gap * (cols - 1)) // cols
    thumb_h = 720000
    caption_h = 280000
    row_stride = thumb_h + caption_h + gap

    y0 = int(top)
    for idx, item in enumerate(picked):
        row, col = divmod(idx, cols)
        left = int(MARGIN) + col * (cell_w + gap)
        cell_top = Emu(y0 + row * row_stride)

        b64 = item.get("thumbnailBytesBase64") or item.get("thumbnailBase64")
        source_url = str(item.get("sourcePageUrl") or item.get("url") or "")
        if b64:
            try:
                stream = io.BytesIO(base64.b64decode(b64))
                slide.shapes.add_picture(stream, Emu(left), cell_top, width=Emu(cell_w), height=Emu(thumb_h))
            except Exception:
                fallback_lines = [truncate(item.get("source"), 40)]
                if source_url:
                    fallback_lines.append(truncate(source_url, 48))
                else:
                    fallback_lines.append("thumbnail unavailable")
                card(
                    slide,
                    Emu(left),
                    cell_top,
                    Emu(cell_w),
                    Emu(thumb_h),
                    truncate(item.get("title"), 40),
                    fallback_lines,
                    tone=NEUTRAL_GRAY,
                )
        else:
            fallback_lines = [truncate(item.get("source"), 40)]
            if source_url:
                fallback_lines.append(truncate(source_url, 48))
            else:
                fallback_lines.append("thumbnail unavailable")
            card(
                slide,
                Emu(left),
                cell_top,
                Emu(cell_w),
                Emu(thumb_h),
                truncate(item.get("title"), 40),
                fallback_lines,
                tone=NEUTRAL_GRAY,
            )

        cap = truncate(item.get("title"), 42)
        src = truncate(item.get("source"), 36)
        cap_lines = [cap, src]
        if show_identity and item.get("identityDecision"):
            cap_lines.append(str(item.get("identityDecision")))
        note(slide, Emu(y0 + row * row_stride + thumb_h + 40000), " · ".join(cap_lines), "source")

    rows = (len(picked) + cols - 1) // cols
    return Emu(y0 + rows * row_stride + 80000)


def video_cards(
    slide,
    top: Emu,
    items: list[dict[str, Any]],
    link_label: str = "Open source",
    *,
    max_items: int = 8,
) -> Emu:
    """O5.4 — video cards with clickable hyperlinks."""
    picked = items[:max_items]
    if not picked:
        return top

    card_h = 720000
    gap = int(GUTTER)
    y = int(top)
    for item in picked:
        title = truncate(item.get("title"), 70)
        url = str(item.get("url") or item.get("sourcePageUrl") or "")
        domain_txt = truncate(item.get("source") or url, 48)
        reason = str(item.get("selectionReason") or item.get("identityDecision") or "")
        lines = [f"{domain_txt}"]
        if reason:
            lines.append(reason)
        if url.startswith("http"):
            lines.append(truncate(url, 72))
        card(slide, MARGIN, Emu(y), CONTENT_W, Emu(card_h), title, lines)
        card_bottom = Emu(y + card_h)
        if url.startswith("http"):
            link_box = textbox(slide, MARGIN, card_bottom, CONTENT_W, Emu(280000))
            tf = link_box.text_frame
            p = tf.paragraphs[0]
            run = p.add_run()
            run.text = link_label
            run.font.size = Pt(FS_NOTE)
            run.font.color.rgb = ACCENT
            run.font.underline = True
            try:
                run.hyperlink.address = url
            except Exception:
                pass
            card_bottom = Emu(int(card_bottom) + 300000)
        y = int(card_bottom) + gap
    return Emu(y)
