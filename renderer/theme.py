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
# Content must stay above footer band (0.2" above footer rule).
CONTENT_SAFE_BOTTOM = Emu(int(FOOTER_Y) - 182880)

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
    title_width: Emu | None = None,
) -> Emu:
    set_bg(slide, BG_LIGHT)
    # top accent bar
    bar = slide.shapes.add_shape(RECT, Emu(0), Emu(0), SLIDE_W, Emu(73152))
    bar.fill.solid()
    bar.fill.fore_color.rgb = ACCENT
    bar.line.fill.background()

    if watermark:
        _watermark(slide, watermark)

    tw = title_width or CONTENT_W
    box = textbox(slide, MARGIN, Emu(228600), tw, Emu(960120))
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


def assert_shape_within_safe_area(
    shape,
    context: str,
    warnings: list[str] | None = None,
    *,
    strict: bool = False,
) -> bool:
    """Layout guard: shape bottom must not intrude on footer/page-number band."""
    try:
        bottom = int(shape.top) + int(shape.height)
    except Exception:
        return True
    limit = int(CONTENT_SAFE_BOTTOM)
    ok = bottom <= limit
    if not ok:
        msg = f"Layout safe-area overflow ({context}): bottom={bottom} > {limit}"
        if strict:
            raise ValueError(msg)
        if warnings is not None:
            warnings.append(msg)
    return ok


def _shape_bottom(shape) -> int:
    return int(shape.top) + int(shape.height)


def assert_no_vertical_overlap(zones: list[tuple[int, int]], min_gap: int | None = None) -> bool:
    """zones: list of (top, bottom) in EMU; must be sorted top-to-bottom."""
    gap = int(min_gap if min_gap is not None else CARD_ZONE_GAP)
    for i in range(len(zones) - 1):
        if zones[i][1] + gap > zones[i + 1][0]:
            return False
    return True


# ---------------------------------------------------------------------------
# Bullets
# ---------------------------------------------------------------------------

def bullets(
    slide,
    top: Emu,
    lines: list[str],
    size: int = FS_BODY,
    width: Emu | None = None,
    *,
    max_items: int = 8,
    bottom_limit: Emu | None = None,
    overflow_note: str | None = None,
    emit_overflow_note: bool = True,
    shown_out: list[int] | None = None,
    layout_warnings: list[str] | None = None,
) -> Emu:
    """Bounded bullet list — never draws below footer safe line."""
    lines = [l for l in lines if l]
    if not lines:
        if shown_out is not None:
            shown_out.clear()
            shown_out.append(0)
        return top
    w = width or CONTENT_W
    limit = int(bottom_limit or CONTENT_SAFE_BOTTOM)
    cap = max(1, max_items)
    overflow_tpl = overflow_note or "+ {n} more items preserved in evidence."
    overflow_reserve = int(
        text_block_height([overflow_tpl.format(n=99)], FS_NOTE, w, space_after_pt=0.0, pad_pt=8.0)
    ) + int(_BLOCK_GAP)

    shown: list[str] = []
    for line in lines[:cap]:
        trial = shown + [line]
        rendered = [f"\u2022 {x}" for x in trial]
        h = text_block_height(rendered, size, w)
        need_overflow = len(lines) > len(trial)
        reserve = overflow_reserve if (need_overflow and emit_overflow_note) else 0
        if int(top) + int(h) + reserve > limit:
            break
        shown.append(line)
    if not shown:
        shown = [lines[0]]

    remaining = len(lines) - len(shown)
    if remaining > 0 and emit_overflow_note:
        while remaining > 0:
            rendered = [f"\u2022 {line}" for line in shown]
            h = text_block_height(rendered, size, w)
            if int(top) + int(h) + overflow_reserve <= limit:
                break
            if len(shown) <= 1:
                break
            shown.pop()
            remaining = len(lines) - len(shown)

    if shown_out is not None:
        shown_out.clear()
        shown_out.append(len(shown))

    rendered = [f"\u2022 {line}" for line in shown]
    h = text_block_height(rendered, size, w)
    box = textbox(slide, MARGIN, top, w, h)
    tf = box.text_frame
    for i, line in enumerate(rendered):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        _run(p, line, size, NEUTRAL_DARK)
        p.space_after = Pt(5)
    bottom = Emu(int(top) + int(h) + int(_BLOCK_GAP))
    assert_shape_within_safe_area(box, "bullets", layout_warnings)
    remaining = len(lines) - len(shown)
    if remaining > 0 and emit_overflow_note:
        bottom = _safe_content_note(slide, bottom, overflow_tpl.format(n=remaining), "info")
    return bottom


def bounded_bullet_sections(
    slide,
    top: Emu,
    sections: list[dict[str, Any]],
    *,
    max_items_per_section: int = 8,
    overflow_note: str | None = None,
    layout_warnings: list[str] | None = None,
) -> Emu:
    """Render labelled bullet groups; one overflow note total; stay above footer safe line."""
    if not sections:
        return top
    limit = int(CONTENT_SAFE_BOTTOM)
    overflow_tpl = overflow_note or "+ {n} more items preserved in evidence."
    overflow_reserve = int(
        text_block_height([overflow_tpl.format(n=99)], FS_NOTE, CONTENT_W, space_after_pt=0.0, pad_pt=8.0)
    ) + int(_BLOCK_GAP)
    section_label_h = int(text_block_height(["Section"], FS_NOTE, CONTENT_W, space_after_pt=0.0, pad_pt=8.0))
    min_bullet_h = int(text_block_height(["\u2022 item"], FS_BODY, CONTENT_W))

    total_items = sum(len(s.get("items") or []) for s in sections)
    shown_total = 0

    for sec in sections:
        label = str(sec.get("label") or "")
        items = [str(x) for x in (sec.get("items") or []) if x]
        if not items and not label:
            continue
        need_label = bool(label)
        label_reserve = section_label_h + int(_BLOCK_GAP) if need_label else 0
        will_hide = shown_total < total_items
        reserve = overflow_reserve if will_hide else 0
        if int(top) + label_reserve + min_bullet_h + reserve > limit:
            break
        if need_label:
            top = note(slide, top, label, "section")
        if items:
            count_box: list[int] = []
            bullet_limit = limit - reserve if will_hide else limit
            top = bullets(
                slide,
                top,
                items,
                max_items=max_items_per_section,
                bottom_limit=Emu(bullet_limit),
                emit_overflow_note=False,
                shown_out=count_box,
                layout_warnings=layout_warnings,
            )
            shown_total += count_box[0] if count_box else 0

    hidden = total_items - shown_total
    if hidden > 0:
        top = _safe_content_note(slide, top, overflow_tpl.format(n=hidden), "info")
    return top


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

def card(slide, x: Emu, y: Emu, w: Emu, h: Emu, title: str, lines: list[str], tone: RGBColor = ACCENT) -> Emu:
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
    return Emu(int(y) + int(h) + int(_BLOCK_GAP))


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


def _safe_content_note(slide, top: Emu, text: str, kind: str = "info") -> Emu:
    """Draw note only if it fits above CONTENT_SAFE_BOTTOM."""
    if not text:
        return top
    tone = NOTE_TONES.get(kind, ACCENT)
    prefix = {"warning": "\u26a0 ", "disclaimer": "", "source": "Source: ", "info": ""}.get(kind, "")
    full = f"{prefix}{text}"
    h = int(text_block_height([full], FS_NOTE, CONTENT_W, space_after_pt=0.0, pad_pt=10.0))
    if int(top) + h > int(CONTENT_SAFE_BOTTOM):
        return top
    return note(slide, top, text, kind)


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


TABLE_ROW_H = 350000
TABLE_NOTE_GAP = 320000
TABLE_SAFE_MARGIN = 220000
TABLE_PDF_BLEED = 140000


def _table_footnote(total: int, shown: int, note_text: str | None) -> str | None:
    if total > shown:
        base = _SHOWING_TOP.format(n=shown, total=total)
        return f"{base} {note_text}".strip() if note_text else base
    return note_text


def _table_footnote_height(label: str | None) -> int:
    if not label:
        return 0
    return (
        int(text_block_height([label], FS_NOTE, CONTENT_W, space_after_pt=0.0, pad_pt=10.0))
        + TABLE_NOTE_GAP
        + TABLE_SAFE_MARGIN
        + TABLE_PDF_BLEED
    )


def _max_table_data_rows(top: Emu, footnote: str | None) -> int:
    """Conservative row cap — reserves footnote + PDF export bleed before drawing rows."""
    reserve = _table_footnote_height(footnote)
    available_bottom = max(0, int(CONTENT_SAFE_BOTTOM) - reserve)
    avail_h = max(0, available_bottom - int(top))
    max_rows_including_header = avail_h // TABLE_ROW_H
    return max(1, max_rows_including_header - 1)


def table(
    slide,
    top: Emu,
    columns: list[str],
    rows: list[list[Any]],
    max_rows: int = 12,
    col_widths: list[float] | None = None,
    note_text: str | None = None,
    *,
    layout_warnings: list[str] | None = None,
) -> Emu:
    """Safe-area table: rows paginated; footnote always below table, never overlapping."""
    total = len(rows)
    shown_count = min(total, max_rows)
    while shown_count > 0:
        footnote = _table_footnote(total, shown_count, note_text)
        space_rows = _max_table_data_rows(top, footnote)
        if shown_count <= space_rows:
            break
        shown_count -= 1
    shown_count = max(0, shown_count)
    footnote = _table_footnote(total, shown_count, note_text)
    rows = rows[:shown_count]
    if not rows:
        if footnote:
            return note(slide, top, footnote, "info")
        return top
    n_rows = len(rows) + 1
    n_cols = max(1, len(columns))
    height = Emu(TABLE_ROW_H * n_rows)
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
        para.word_wrap = False

    for r, row in enumerate(rows, start=1):
        for c in range(n_cols):
            cell = tbl.cell(r, c)
            val = row[c] if c < len(row) else ""
            cell.text = "" if val is None else str(val)
            para = cell.text_frame.paragraphs[0]
            para.font.size = Pt(FS_TABLE_BODY)
            para.word_wrap = False
            tone = _cell_color(str(val))
            if tone:
                para.font.color.rgb = tone
                para.font.bold = True
            else:
                para.font.color.rgb = NEUTRAL_DARK
            if r % 2 == 0:
                cell.fill.solid()
                cell.fill.fore_color.rgb = TABLE_ZEBRA

    assert_shape_within_safe_area(graphic, "table", layout_warnings)
    tbl_bottom = int(top) + int(height)
    note_top = tbl_bottom + TABLE_NOTE_GAP + TABLE_PDF_BLEED
    bottom = Emu(note_top)
    if footnote:
        bottom = note(slide, Emu(note_top), footnote, "info")
    if note_text:
        bottom = note(slide, bottom, note_text, "source")
    return bottom


# O5.4.2 / v16 — media card layout constants.
CARD_PAD = Emu(91440)  # ~0.1"
# Vertical gaps between fixed caption zones inside media cards (~8 px).
CARD_ZONE_GAP = Emu(101600)
IMG_TITLE_ZONE_H = Emu(266700)   # max ~2 title lines
IMG_DOMAIN_ZONE_H = Emu(139700)  # 1 domain line
IMG_BADGE_ZONE_H = Emu(139700)   # 1 identity badge line (extra line height)
IMAGE_AREA_FRAC = 0.50
MIN_IMAGE_VISUAL_EMU = 1333350
MIN_GALLERY_IMG_H = 1143000
MIN_GALLERY_IMG_W = 1524000
MIN_GALLERY_CARD_IMG_FRAC = 0.45
MAX_GALLERY_ITEMS = 4
MAX_VIDEO_ITEMS = 4
MAX_UPSCALE_RATIO = 2.0
MAX_INTL_SLIDE_FRAC = 0.55
IMG_SLOT_FRAC = 0.50
CARD_BOTTOM_PAD = 91440
GAL_TITLE_ZONE_H = 228600   # max 2 title lines
GAL_DOMAIN_ZONE_H = 101600  # 1 domain line
GAL_BADGE_ZONE_H = 101600
GAL_TWO_LINE_INNER_H = 2400000


def _gallery_title_zone_h(inner_h: int) -> int:
    return int(GAL_TITLE_ZONE_H) if inner_h >= GAL_TWO_LINE_INNER_H else int(GAL_DOMAIN_ZONE_H)


VID_PLAY_DOMAIN_ZONE_H = 101600  # play icon + domain row (text-only cards)
VID_TITLE_ZONE_H = 228600        # max 2 title lines
VID_DOMAIN_ZONE_H = 101600         # domain under real thumbnail
VID_BADGE_ZONE_H = 101600
VID_BUTTON_ZONE_H = 165100
VID_THUMB_MIN_H = 280000
VID_TWO_LINE_INNER_H = 2000000
MIN_THUMB_B64_LEN = 2000


def _video_title_zone_h(inner_h: int) -> int:
    return int(VID_TITLE_ZONE_H) if inner_h >= VID_TWO_LINE_INNER_H else int(VID_DOMAIN_ZONE_H)


def short_display_url(url: str, max_len: int = 38) -> str:
    from urllib.parse import urlparse

    try:
        p = urlparse(str(url or "").strip())
        host = (p.netloc or "").replace("www.", "")
        path = (p.path or "").strip("/")
        display = f"{host}/{path}" if path else host
        return truncate(display or url, max_len)
    except Exception:
        return truncate(url, max_len)


def _fit_picture_cover(slide, stream, box_left: int, box_top: int, box_w: int, box_h: int):
    """Cover-crop image into box; preserve aspect ratio; center; clip to box."""
    if hasattr(stream, "seek"):
        stream.seek(0)
    pic = slide.shapes.add_picture(stream, box_left, box_top)
    scale = max(box_w / max(pic.width, 1), box_h / max(pic.height, 1))
    sw = int(pic.width * scale)
    sh = int(pic.height * scale)
    pic.width = sw
    pic.height = sh
    pic.left = box_left + (box_w - sw) // 2
    pic.top = box_top + (box_h - sh) // 2
    if sw > box_w:
        crop = (sw - box_w) / max(sw, 1)
        pic.crop_left = crop / 2
        pic.crop_right = crop / 2
    if sh > box_h:
        crop = (sh - box_h) / max(sh, 1)
        pic.crop_top = crop / 2
        pic.crop_bottom = crop / 2
    pic.left = box_left
    pic.top = box_top
    pic.width = box_w
    pic.height = box_h
    return pic


def _fit_picture_contain(slide, stream, box_left: int, box_top: int, box_w: int, box_h: int):
    """Place image scaled to fit box; preserve aspect ratio; center in box."""
    if hasattr(stream, "seek"):
        stream.seek(0)
    pic = slide.shapes.add_picture(stream, box_left, box_top)
    scale = min(box_w / max(pic.width, 1), box_h / max(pic.height, 1), 1.0)
    pic.width = int(pic.width * scale)
    pic.height = int(pic.height * scale)
    pic.left = box_left + (box_w - pic.width) // 2
    pic.top = box_top + (box_h - pic.height) // 2
    return pic


def _card_text_zone(
    slide,
    x: int,
    y: int,
    w: int,
    h: int,
    text: str,
    size: int,
    color: RGBColor,
    *,
    bold: bool = False,
    italic: bool = False,
    hyperlink: str | None = None,
    layout_warnings: list[str] | None = None,
    context: str = "card_zone",
    word_wrap: bool = False,
) -> int:
    """Fixed-height text zone; returns bottom y (EMU)."""
    box = textbox(slide, Emu(x), Emu(y), Emu(w), Emu(h))
    tf = box.text_frame
    tf.word_wrap = word_wrap
    tf.auto_size = None
    tf.vertical_anchor = MSO_ANCHOR.TOP
    p = tf.paragraphs[0]
    p.line_spacing = 1.0
    p.space_after = Pt(0)
    if hyperlink and text:
        run = p.add_run()
        run.text = text
        run.font.size = Pt(size)
        run.font.color.rgb = color
        run.font.bold = bold
        run.font.italic = italic
        run.font.underline = True
        try:
            run.hyperlink.address = hyperlink
        except Exception:
            pass
    else:
        _run(p, text, size, color, bold=bold, italic=italic)
    assert_shape_within_safe_area(box, context, layout_warnings)
    return y + h


def _image_bytes_from_item(item: dict[str, Any]) -> bytes | None:
    import base64

    b64 = item.get("thumbnailBytesBase64") or item.get("thumbnailBase64")
    if not b64 or len(str(b64)) < MIN_THUMB_B64_LEN:
        return None
    try:
        return base64.b64decode(b64)
    except Exception:
        return None


def _image_item_key(item: dict[str, Any]) -> str:
    import hashlib

    key = str(item.get("thumbnailStorageKey") or item.get("imageUrl") or item.get("url") or "")
    if key:
        return key
    raw = _image_bytes_from_item(item)
    if raw:
        return hashlib.sha256(raw).hexdigest()
    return str(item.get("title") or "")


def _dedupe_gallery_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for it in items:
        k = _image_item_key(it)
        if k and k in seen:
            continue
        if k:
            seen.add(k)
        out.append(it)
    return out


def _layout_image_card_zones(
    ih: int,
    *,
    show_identity: bool,
    intl_compact: bool = False,
) -> dict[str, tuple[int, int]] | None:
    """Return fixed y-zones (top, bottom) relative to card top for image + captions."""
    pad = int(CARD_PAD)
    gap = int(CARD_ZONE_GAP)
    inner_h = max(1, ih - 2 * pad)
    title_h = _gallery_title_zone_h(inner_h)
    domain_h = int(GAL_DOMAIN_ZONE_H)
    badge_h = int(GAL_BADGE_ZONE_H) if show_identity else 0
    bottom_pad = int(CARD_BOTTOM_PAD)
    text_stack = title_h + gap + domain_h + bottom_pad
    if show_identity:
        text_stack += gap + badge_h
    slot_frac = 0.42 if intl_compact else IMG_SLOT_FRAC
    max_img_h = inner_h - text_stack - gap
    if max_img_h < 400000:
        return None
    min_img = min(int(MIN_GALLERY_IMG_H), max(450000, int(inner_h * 0.38)))
    img_h = min(int(inner_h * slot_frac), max_img_h)
    if img_h < min_img:
        if max_img_h >= min_img:
            img_h = min(min_img, max_img_h)
        else:
            img_h = max_img_h
    if img_h < 350000:
        return None
    y = pad
    zones: dict[str, tuple[int, int]] = {"img": (y, y + img_h)}
    y = zones["img"][1] + gap
    zones["title"] = (y, y + title_h)
    y = zones["title"][1] + gap
    zones["domain"] = (y, y + domain_h)
    if show_identity:
        y = zones["domain"][1] + gap
        zones["badge"] = (y, y + badge_h)
    if not assert_no_vertical_overlap(list(zones.values())):
        return None
    if zones[list(zones.keys())[-1]][1] > ih - bottom_pad:
        return None
    return zones


def _fit_picture_for_card(
    slide,
    stream,
    box_left: int,
    box_top: int,
    box_w: int,
    box_h: int,
    *,
    allow_cover: bool = True,
):
    """Cover or contain; never upscale beyond MAX_UPSCALE_RATIO."""
    if hasattr(stream, "seek"):
        stream.seek(0)
    pic = slide.shapes.add_picture(stream, box_left, box_top)
    nw, nh = int(pic.width), int(pic.height)
    if nw <= 0 or nh <= 0:
        return pic
    upscale = max(box_w / nw, box_h / nh)
    if upscale > MAX_UPSCALE_RATIO or not allow_cover:
        scale = min(box_w / nw, box_h / nh, 1.0)
        pic.width = int(nw * scale)
        pic.height = int(nh * scale)
        pic.left = box_left + (box_w - pic.width) // 2
        pic.top = box_top + (box_h - pic.height) // 2
        return pic
    try:
        slide.shapes._spTree.remove(pic._element)
    except Exception:
        pass
    if hasattr(stream, "seek"):
        stream.seek(0)
    return _fit_picture_cover(slide, stream, box_left, box_top, box_w, box_h)


def _image_card_caption_heights(show_identity: bool) -> tuple[int, int, int, int]:
    """Return title_h, domain_h, badge_h, caption_stack_h (incl. gaps)."""
    gap = int(CARD_ZONE_GAP)
    title_h = int(IMG_TITLE_ZONE_H)
    domain_h = int(IMG_DOMAIN_ZONE_H)
    badge_h = int(IMG_BADGE_ZONE_H) if show_identity else 0
    stack = title_h + gap + domain_h
    if show_identity:
        stack += gap + badge_h
    return title_h, domain_h, badge_h, stack


def _gallery_caption_heights(show_identity: bool, inner_h: int | None = None) -> tuple[int, int, int, int]:
    """Compact caption stack for evidence gallery cards."""
    gap = int(CARD_ZONE_GAP)
    ih_ref = inner_h if inner_h is not None else GAL_TWO_LINE_INNER_H
    title_h = _gallery_title_zone_h(ih_ref)
    domain_h = int(GAL_DOMAIN_ZONE_H)
    badge_h = int(GAL_BADGE_ZONE_H) if show_identity else 0
    stack = title_h + gap + domain_h
    if show_identity:
        stack += gap + badge_h
    return title_h, domain_h, badge_h, stack


def _image_card_min_height(show_identity: bool) -> int:
    _, _, _, cap_stack = _gallery_caption_heights(show_identity, inner_h=0)
    pad = int(CARD_PAD)
    gap = int(CARD_ZONE_GAP)
    return 2 * pad + MIN_GALLERY_IMG_H + cap_stack + gap


def _gallery_notes_reserve_height(
    labels: dict[str, str],
    total: int,
    *,
    max_shown: int = MAX_GALLERY_ITEMS,
) -> int:
    """Conservative vertical reserve for overflow notes below the gallery grid."""
    if total <= 0:
        return 0
    candidates: list[str] = []
    if total > max_shown:
        candidates.append(
            labels.get("media_showing_images", "Showing {shown} of {total} subject-matched images.").format(
                shown=max_shown, total=total,
            )
        )
        extra = labels.get("media_saved_in_evidence", "+ {n} saved in evidence.")
        if extra:
            candidates.append(extra.format(n=max(1, total - max_shown)))
    else:
        candidates.append(
            labels.get("media_gallery_skipped", "{n} images skipped (thumbnail too small or unavailable).").format(n=1)
        )
    h = 0
    for line in candidates[:2]:
        h += int(text_block_height([line], FS_NOTE, CONTENT_W, space_after_pt=0.0, pad_pt=8.0))
        h += int(_BLOCK_GAP)
    return h + 100000


def _gallery_layout_candidates(try_n: int) -> list[tuple[int, int]]:
    if try_n <= 1:
        return [(1, 1)]
    if try_n == 2:
        return [(2, 1), (1, 1)]
    if try_n == 3:
        return [(3, 1), (2, 2)]
    return [(2, 2)]


def _gallery_grid_bottom(top: int, rows: int, row_h: int, gap: int) -> int:
    if rows <= 0:
        return int(top)
    return int(top) + rows * row_h + max(0, rows - 1) * gap


def _plan_image_gallery(
    count: int,
    top: Emu,
    *,
    show_identity: bool = False,
    max_shown: int = MAX_GALLERY_ITEMS,
    labels: dict[str, str] | None = None,
) -> tuple[int, int, int, int, int]:
    """Pick cols/rows/count so the full grid + notes fit within CONTENT_SAFE_BOTTOM."""
    labels = labels or {}
    usable = min(count, max_shown)
    gap = int(GUTTER)
    note_reserve = _gallery_notes_reserve_height(labels, count, max_shown=max_shown)
    safe_bottom = int(CONTENT_SAFE_BOTTOM)
    top_i = int(top)
    min_card_h = _image_card_min_height(show_identity)
    inner_min_w = MIN_GALLERY_IMG_W

    for try_n in range(usable, 0, -1):
        for cols, rows in _gallery_layout_candidates(try_n):
            avail_h = max(1, safe_bottom - top_i - note_reserve)
            max_row = (avail_h - gap * max(0, rows - 1)) // max(rows, 1)
            if max_row < min_card_h:
                continue
            cell_w = (int(CONTENT_W) - gap * (cols - 1)) // cols
            if cell_w - 2 * int(CARD_PAD) < inner_min_w:
                continue
            grid_bottom = _gallery_grid_bottom(top_i, rows, max_row, gap)
            if grid_bottom > safe_bottom - note_reserve:
                continue
            if _layout_image_card_zones(max_row, show_identity=show_identity) is None:
                continue
            return try_n, cols, rows, cell_w, max_row
    return 0, 0, 0, 0, 0


def _image_gallery_geometry(
    count: int,
    top: Emu,
    *,
    show_identity: bool = False,
    max_shown: int = 6,
) -> tuple[int, int, int, int]:
    """Backward-compatible wrapper — returns geometry for the best-fit plan."""
    n, cols, rows, cell_w, row_h = _plan_image_gallery(
        count, top, show_identity=show_identity, max_shown=max_shown,
    )
    if n <= 0:
        return 2, 1, int(CONTENT_W), _image_card_min_height(show_identity)
    return cols, rows, cell_w, row_h


def _layout_video_card_zones(
    ih: int,
    *,
    show_badge: bool,
    has_thumb: bool,
) -> dict[str, tuple[int, int]] | None:
    """Video card zones — text-only (play+domain) or thumbnail + captions + button."""
    pad = int(CARD_PAD)
    gap = int(CARD_ZONE_GAP)
    bottom_pad = int(CARD_BOTTOM_PAD)
    inner_h = max(1, ih - 2 * pad)
    btn_h = int(VID_BUTTON_ZONE_H)
    title_h = _video_title_zone_h(inner_h)
    badge_h = int(VID_BADGE_ZONE_H) if show_badge else 0

    y = ih - pad - bottom_pad
    button = (y - btn_h, y)
    y = button[0] - gap
    if show_badge:
        badge = (y - badge_h, y)
        y = badge[0] - gap
    else:
        badge = None
    title = (y - title_h, y)
    y = title[0] - gap

    zones: dict[str, tuple[int, int]] = {"title": title, "button": button}
    if badge:
        zones["badge"] = badge

    if has_thumb:
        domain_h = int(VID_DOMAIN_ZONE_H)
        domain = (y - domain_h, y)
        y = domain[0] - gap
        thumb_bottom = y
        if thumb_bottom - pad < int(VID_THUMB_MIN_H):
            return None
        zones["thumb"] = (pad, thumb_bottom)
        zones["domain"] = domain
    else:
        header_h = int(VID_PLAY_DOMAIN_ZONE_H)
        header = (y - header_h, y)
        if header[0] < pad:
            return None
        zones["header"] = header

    if not assert_no_vertical_overlap(sorted(zones.values(), key=lambda z: z[0])):
        return None
    return zones


def _video_card_min_height(*, show_badge: bool, has_thumb: bool = False) -> int:
    pad = 2 * int(CARD_PAD)
    gap = int(CARD_ZONE_GAP)
    bottom = int(CARD_BOTTOM_PAD)
    stack = int(VID_PLAY_DOMAIN_ZONE_H) + gap + int(VID_TITLE_ZONE_H) + gap + int(VID_BUTTON_ZONE_H) + bottom
    if show_badge:
        stack += gap + int(VID_BADGE_ZONE_H)
    if has_thumb:
        stack += gap + int(VID_THUMB_MIN_H) + int(VID_DOMAIN_ZONE_H) + gap
    return pad + stack


def _video_notes_reserve_height(labels: dict[str, str], total: int, *, max_shown: int) -> int:
    if total <= max_shown:
        return 0
    candidates = [
        labels.get("media_showing_videos", "Showing {shown} of {total} subject-matched videos.").format(
            shown=max_shown, total=total,
        ),
        labels.get("media_videos_saved_evidence", "+ {n} videos saved in evidence.").format(n=max(1, total - max_shown)),
    ]
    h = 0
    for line in candidates:
        if not line:
            continue
        h += int(text_block_height([line], FS_NOTE, CONTENT_W, space_after_pt=0.0, pad_pt=8.0))
        h += int(_BLOCK_GAP)
    return h + 100000


def _plan_video_grid(
    count: int,
    top: Emu,
    *,
    show_badge: bool = False,
    max_shown: int = MAX_VIDEO_ITEMS,
    labels: dict[str, str] | None = None,
) -> tuple[int, int, int]:
    """Return (plan_n, row_h, cols) so grid + notes fit within CONTENT_SAFE_BOTTOM."""
    labels = labels or {}
    usable = min(count, max_shown)
    cols = 2
    gap = int(GUTTER)
    note_reserve = _video_notes_reserve_height(labels, count, max_shown=max_shown)
    safe_bottom = int(CONTENT_SAFE_BOTTOM)
    top_i = int(top)
    min_row = _video_card_min_height(show_badge=show_badge, has_thumb=False)

    for try_n in range(usable, 0, -1):
        rows = max(1, (try_n + cols - 1) // cols)
        avail_h = max(1, safe_bottom - top_i - note_reserve)
        max_row = (avail_h - gap * max(0, rows - 1)) // max(rows, 1)
        if max_row < min_row:
            continue
        grid_bottom = top_i + rows * max_row + max(0, rows - 1) * gap
        if grid_bottom > safe_bottom - note_reserve:
            continue
        if _layout_video_card_zones(max_row, show_badge=show_badge, has_thumb=False) is None:
            continue
        return try_n, max_row, cols
    return 0, 0, cols


def _image_native_size(raw: bytes) -> tuple[int, int] | None:
    """Read width/height from PNG/JPEG headers without Pillow."""
    if len(raw) >= 24 and raw[:8] == b"\x89PNG\r\n\x1a\n":
        return int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
    if len(raw) >= 4 and raw[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(raw):
            if raw[i] != 0xFF:
                i += 1
                continue
            marker = raw[i + 1]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h = int.from_bytes(raw[i + 5 : i + 7], "big")
                w = int.from_bytes(raw[i + 7 : i + 9], "big")
                return w, h
            if marker in (0xD8, 0xD9):
                break
            seg_len = int.from_bytes(raw[i + 2 : i + 4], "big")
            i += 2 + max(seg_len, 2)
    return None


def _intl_image_acceptable(raw: bytes, slot_w: int, slot_h: int) -> bool:
    """Reject thumbnails that would upscale beyond quality gate."""
    size = _image_native_size(raw)
    if not size:
        return len(raw) >= MIN_THUMB_B64_LEN * 3 // 4
    nw, nh = size
    if nw <= 0 or nh <= 0:
        return False
    upscale = max(slot_w / nw, slot_h / nh)
    if upscale > MAX_UPSCALE_RATIO:
        return False
    slide_w = int(SLIDE_W) * MAX_INTL_SLIDE_FRAC
    slide_h = int(SLIDE_H) * MAX_INTL_SLIDE_FRAC
    disp_w = nw * min(slot_w / nw, slot_h / nh, 1.0)
    disp_h = nh * min(slot_w / nw, slot_h / nh, 1.0)
    return disp_w <= slide_w and disp_h <= slide_h


def add_image_card(
    slide,
    x: Emu,
    y: Emu,
    w: Emu,
    h: Emu,
    item: dict[str, Any],
    *,
    show_identity: bool = False,
    link_label: str = "Source",
    layout_warnings: list[str] | None = None,
    intl_compact: bool = False,
    allow_cover: bool = True,
) -> bool:
    """Image card with fixed zones — title/domain/badge never overlap image or each other."""
    import io

    ix, iy, iw, ih = int(x), int(y), int(w), int(h)
    pad = int(CARD_PAD)
    gap = int(CARD_ZONE_GAP)
    inner_w = max(1, iw - 2 * pad)
    inner_x = ix + pad
    zones = _layout_image_card_zones(ih, show_identity=show_identity, intl_compact=intl_compact)
    if not zones and show_identity:
        show_identity = False
        zones = _layout_image_card_zones(ih, show_identity=False, intl_compact=intl_compact)
    if not zones:
        return False
    if iy + ih > int(CONTENT_SAFE_BOTTOM):
        return False

    raw = _image_bytes_from_item(item)
    if not raw:
        return False
    if intl_compact and not _intl_image_acceptable(raw, inner_w, zones["img"][1] - zones["img"][0]):
        return False

    frame = slide.shapes.add_shape(ROUNDED_RECT, Emu(ix), Emu(iy), Emu(iw), Emu(ih))
    frame.fill.solid()
    frame.fill.fore_color.rgb = BG_LIGHT
    frame.line.color.rgb = NEUTRAL_LINE
    frame.line.width = Pt(0.75)

    img_top, img_bottom = zones["img"]
    img_box_h = img_bottom - img_top
    img_slot = slide.shapes.add_shape(
        ROUNDED_RECT, Emu(inner_x), Emu(iy + img_top), Emu(inner_w), Emu(img_box_h),
    )
    img_slot.fill.solid()
    img_slot.fill.fore_color.rgb = BG_PANEL
    img_slot.line.color.rgb = NEUTRAL_LINE
    pic_ok = False
    try:
        pic = _fit_picture_for_card(
            slide, io.BytesIO(raw), inner_x, iy + img_top, inner_w, img_box_h,
            allow_cover=allow_cover and not intl_compact,
        )
        pic_ok = int(pic.width) >= 1 and int(pic.height) >= 1
        pic_bottom = int(pic.top) + int(pic.height)
        pic_right = int(pic.left) + int(pic.width)
        if pic_ok and (
            int(pic.top) < iy + img_top - 5000
            or pic_bottom > iy + img_bottom + 5000
            or int(pic.left) < inner_x - 5000
            or pic_right > inner_x + inner_w + 5000
        ):
            pic_ok = False
        if pic_ok and not intl_compact and allow_cover:
            pic_ok = int(pic.width) >= MIN_GALLERY_IMG_W // 3 and int(pic.height) >= MIN_GALLERY_IMG_H // 3
        if pic_ok:
            assert_shape_within_safe_area(pic, "image_card_picture", layout_warnings)
        else:
            try:
                slide.shapes._spTree.remove(pic._element)
            except Exception:
                pass
    except Exception:
        pic_ok = False
    if not pic_ok:
        for shape in (frame, img_slot):
            try:
                slide.shapes._spTree.remove(shape._element)
            except Exception:
                pass
        return False

    source_url = str(item.get("sourcePageUrl") or item.get("url") or item.get("imageUrl") or "")
    title_top, title_bottom = zones["title"]
    title_zone_h = title_bottom - title_top
    two_line_title = title_zone_h >= int(GAL_TITLE_ZONE_H) - 5000
    domain = truncate(item.get("source") or short_display_url(source_url), 32 if two_line_title else 28)
    title = truncate(item.get("title"), 44 if two_line_title else 26)

    _card_text_zone(
        slide, inner_x, iy + title_top, inner_w, title_zone_h,
        title, FS_NOTE, BRAND_PRIMARY, bold=True,
        word_wrap=two_line_title,
        layout_warnings=layout_warnings, context="image_card_title",
    )
    dom_top, dom_bottom = zones["domain"]
    _card_text_zone(
        slide, inner_x, iy + dom_top, inner_w, dom_bottom - dom_top,
        domain, FS_NOTE, ACCENT if source_url.startswith("http") else NEUTRAL_GRAY,
        hyperlink=source_url if source_url.startswith("http") else None,
        word_wrap=False,
        layout_warnings=layout_warnings, context="image_card_domain",
    )
    if show_identity and item.get("identityDecision") and "badge" in zones:
        b_top, b_bottom = zones["badge"]
        _card_text_zone(
            slide, inner_x, iy + b_top, inner_w, b_bottom - b_top,
            truncate(str(item.get("identityDecision")), 22), FS_NOTE - 1, NEUTRAL_GRAY,
            italic=True, word_wrap=False,
            layout_warnings=layout_warnings, context="image_card_badge",
        )

    zone_list = [zones[k] for k in ("img", "title", "domain") + (("badge",) if "badge" in zones else ())]
    if not assert_no_vertical_overlap([(iy + z[0], iy + z[1]) for z in zone_list]):
        try:
            slide.shapes._spTree.remove(frame._element)
        except Exception:
            pass
        return False

    assert_shape_within_safe_area(frame, "image_card_frame", layout_warnings)
    return True


def add_video_card(
    slide,
    x: Emu,
    y: Emu,
    w: Emu,
    h: Emu,
    item: dict[str, Any],
    link_label: str = "Open source",
    layout_warnings: list[str] | None = None,
) -> bool:
    """Video card — text-only (play+domain, title, button) or real thumbnail when available."""
    import io

    ix, iy, iw, ih = int(x), int(y), int(w), int(h)
    pad = int(CARD_PAD)
    inner_w = max(1, iw - 2 * pad)
    inner_x = ix + pad
    url = str(item.get("url") or item.get("sourcePageUrl") or "")
    domain = truncate(item.get("source") or short_display_url(url), 32)
    identity = truncate(item.get("selectionReason") or item.get("identityDecision") or "", 22)
    has_badge = bool(identity)
    raw = _image_bytes_from_item(item)
    has_thumb = bool(raw)

    zones = _layout_video_card_zones(ih, show_badge=has_badge, has_thumb=has_thumb)
    if not zones and has_badge:
        has_badge = False
        identity = ""
        zones = _layout_video_card_zones(ih, show_badge=False, has_thumb=has_thumb)
    if not zones and has_thumb:
        has_thumb = False
        zones = _layout_video_card_zones(ih, show_badge=has_badge, has_thumb=False)
    if not zones:
        return False
    if iy + ih > int(CONTENT_SAFE_BOTTOM):
        return False

    title_top, title_bottom = zones["title"]
    title_zone_h = title_bottom - title_top
    two_line_title = title_zone_h >= int(VID_TITLE_ZONE_H) - 5000
    title = truncate(item.get("title"), 44 if two_line_title else 26)

    frame = slide.shapes.add_shape(ROUNDED_RECT, Emu(ix), Emu(iy), Emu(iw), Emu(ih))
    frame.fill.solid()
    frame.fill.fore_color.rgb = BG_LIGHT
    frame.line.color.rgb = NEUTRAL_LINE
    frame.line.width = Pt(0.75)

    thumb_ok = False
    if has_thumb and "thumb" in zones:
        t_top, t_bottom = zones["thumb"]
        thumb_h = t_bottom - t_top
        thumb_box = slide.shapes.add_shape(
            ROUNDED_RECT, Emu(inner_x), Emu(iy + t_top), Emu(inner_w), Emu(thumb_h),
        )
        thumb_box.fill.solid()
        thumb_box.fill.fore_color.rgb = BG_PANEL
        thumb_box.line.color.rgb = NEUTRAL_LINE
        try:
            pic = _fit_picture_for_card(
                slide, io.BytesIO(raw), inner_x, iy + t_top, inner_w, thumb_h, allow_cover=True,
            )
            thumb_ok = int(pic.width) >= 1 and int(pic.height) >= 1
            if not thumb_ok:
                try:
                    slide.shapes._spTree.remove(pic._element)
                except Exception:
                    pass
        except Exception:
            thumb_ok = False
        if not thumb_ok:
            for shape in (thumb_box,):
                try:
                    slide.shapes._spTree.remove(shape._element)
                except Exception:
                    pass
            try:
                slide.shapes._spTree.remove(frame._element)
            except Exception:
                pass
            return add_video_card(
                slide, x, y, w, h, {**item, "thumbnailBytesBase64": None, "thumbnailBase64": None},
                link_label=link_label, layout_warnings=layout_warnings,
            )

    if has_thumb and thumb_ok and "domain" in zones:
        d_top, d_bottom = zones["domain"]
        _card_text_zone(
            slide, inner_x, iy + d_top, inner_w, d_bottom - d_top,
            domain, FS_NOTE, NEUTRAL_GRAY, word_wrap=False,
            layout_warnings=layout_warnings, context="video_card_domain",
        )
    elif "header" in zones:
        h_top, h_bottom = zones["header"]
        h_h = h_bottom - h_top
        _card_text_zone(
            slide, inner_x, iy + h_top, inner_w, h_h,
            f"\u25b6  {domain}", FS_NOTE, NEUTRAL_GRAY, word_wrap=False,
            layout_warnings=layout_warnings, context="video_card_header",
        )

    _card_text_zone(
        slide, inner_x, iy + title_top, inner_w, title_zone_h,
        title, FS_NOTE, BRAND_PRIMARY, bold=True, word_wrap=two_line_title,
        layout_warnings=layout_warnings, context="video_card_title",
    )
    if has_badge and "badge" in zones:
        b_top, b_bottom = zones["badge"]
        _card_text_zone(
            slide, inner_x, iy + b_top, inner_w, b_bottom - b_top,
            identity, FS_NOTE - 1, NEUTRAL_GRAY, italic=True, word_wrap=False,
            layout_warnings=layout_warnings, context="video_card_badge",
        )
    btn_top, btn_bottom = zones["button"]
    _card_text_zone(
        slide, inner_x, iy + btn_top, inner_w, btn_bottom - btn_top,
        link_label, FS_NOTE, ACCENT if url.startswith("http") else NEUTRAL_GRAY,
        bold=True, hyperlink=url if url.startswith("http") else None, word_wrap=False,
        layout_warnings=layout_warnings, context="video_card_button",
    )

    zone_keys = (["thumb"] if thumb_ok else []) + (["domain"] if thumb_ok else ["header"])
    zone_keys += ["title"] + (["badge"] if has_badge else []) + ["button"]
    zone_keys = [k for k in zone_keys if k in zones]
    zone_pts = sorted([(iy + zones[k][0], iy + zones[k][1]) for k in zone_keys], key=lambda z: z[0])
    if not assert_no_vertical_overlap(zone_pts):
        try:
            slide.shapes._spTree.remove(frame._element)
        except Exception:
            pass
        return False

    assert_shape_within_safe_area(frame, "video_card", layout_warnings)
    return True


def _grid_geometry(
    count: int,
    top: Emu,
    *,
    max_shown: int = 6,
    min_row_h: int = 560000,
    max_row_h: int = 1150000,
) -> tuple[int, int, int, int]:
    """Return cols, rows, cell_w, row_h fitting within footer safe area."""
    shown = min(count, max_shown)
    cols = 2 if shown <= 4 else 3
    rows = max(1, (shown + cols - 1) // cols)
    gap = int(GUTTER)
    note_reserve = 260000 if count > max_shown else 0  # overflow note below grid only
    avail_h = max(1, int(CONTENT_SAFE_BOTTOM) - int(top) - note_reserve)
    row_h = (avail_h - gap * max(0, rows - 1)) // max(rows, 1)
    row_h = max(min_row_h, min(row_h, max_row_h))
    cell_w = (int(CONTENT_W) - gap * (cols - 1)) // cols
    return cols, rows, cell_w, row_h


def _safe_gallery_note(slide, top: Emu, text: str) -> Emu:
    """Draw note only if it fits above footer safe line."""
    if not text:
        return top
    h = int(text_block_height([text], FS_NOTE, CONTENT_W, space_after_pt=0.0, pad_pt=10.0))
    if int(top) + h > int(CONTENT_SAFE_BOTTOM):
        return top
    return note(slide, top, text, "info")


def image_grid(
    slide,
    top: Emu,
    items: list[dict[str, Any]],
    *,
    cols: int = 3,
    max_items: int = MAX_GALLERY_ITEMS,
    show_identity: bool = False,
    labels: dict[str, str] | None = None,
    layout_warnings: list[str] | None = None,
    intl_compact: bool = False,
    allow_cover: bool = False,
) -> Emu:
    """Image evidence gallery — max 4 validated cards, deduped; grid + notes stay in safe area."""
    labels = labels or {}
    deduped = _dedupe_gallery_items(items)
    total = len(items)
    usable = [it for it in deduped if _image_bytes_from_item(it)]
    skipped_bytes = len(deduped) - len(usable)
    dup_skipped = len(items) - len(deduped)
    if not usable:
        if total > 0:
            msg = labels.get("nd_gallery_no_usable_images", "Selected images unavailable for gallery display.")
            return note(slide, top, msg, "info")
        return top

    plan_n, cols, rows, cell_w, row_h = _plan_image_gallery(
        len(usable), top, show_identity=show_identity, max_shown=max_items, labels=labels,
    )
    if plan_n <= 0:
        msg = labels.get("nd_gallery_no_usable_images", "Selected images unavailable for gallery display.")
        return note(slide, top, msg, "info")

    gap = int(GUTTER)
    y0 = int(top)
    rendered = 0
    skipped_layout = 0
    candidate_idx = 0
    max_slots = plan_n

    while rendered < max_slots and candidate_idx < len(usable):
        item = usable[candidate_idx]
        candidate_idx += 1
        row, col = divmod(rendered, cols)
        left = int(MARGIN) + col * (cell_w + gap)
        cell_top = y0 + row * (row_h + gap)
        if cell_top + row_h > int(CONTENT_SAFE_BOTTOM):
            break
        if add_image_card(
            slide, Emu(left), Emu(cell_top), Emu(cell_w), Emu(row_h),
            item, show_identity=show_identity,
            link_label=labels.get("media_source_link", "Source"),
            layout_warnings=layout_warnings,
            intl_compact=intl_compact,
            allow_cover=allow_cover,
        ):
            rendered += 1
        else:
            skipped_layout += 1

    if rendered == 0:
        msg = labels.get("nd_gallery_no_usable_images", "Selected images unavailable for gallery display.")
        return note(slide, top, msg, "info")

    actual_rows = max(1, (rendered + cols - 1) // cols)
    bottom = Emu(_gallery_grid_bottom(y0, actual_rows, row_h, gap))
    skipped = skipped_bytes + skipped_layout + dup_skipped + max(0, len(usable) - candidate_idx)
    hidden = max(0, total - rendered)
    if skipped > 0:
        tpl = labels.get("media_gallery_skipped", "{n} images skipped (thumbnail too small or unavailable).")
        bottom = _safe_gallery_note(slide, bottom, tpl.format(n=skipped))
    if total > rendered:
        tpl = labels.get("media_showing_images", "Showing {shown} of {total} subject-matched images.")
        bottom = _safe_gallery_note(slide, bottom, tpl.format(shown=rendered, total=total))
    if hidden > 0:
        extra = labels.get("media_saved_in_evidence", "+ {n} saved in evidence.")
        if extra:
            bottom = _safe_gallery_note(slide, bottom, extra.format(n=hidden))
    return bottom


def video_cards(
    slide,
    top: Emu,
    items: list[dict[str, Any]],
    link_label: str = "Open source",
    *,
    max_items: int = MAX_VIDEO_ITEMS,
    labels: dict[str, str] | None = None,
    layout_warnings: list[str] | None = None,
) -> Emu:
    """Compact 2-column video grid — max 4 cards; text-only when no real thumbnail."""
    labels = labels or {}
    total = len(items)
    if not items:
        return top

    plan_n, row_h, cols = _plan_video_grid(
        len(items), top, max_shown=max_items, labels=labels,
    )
    if plan_n <= 0:
        return top

    gap = int(GUTTER)
    cell_w = (int(CONTENT_W) - gap * (cols - 1)) // cols
    y0 = int(top)
    rendered = 0
    skipped = 0

    for item in items:
        if rendered >= plan_n:
            break
        row, col = divmod(rendered, cols)
        left = int(MARGIN) + col * (cell_w + gap)
        cell_top = y0 + row * (row_h + gap)
        if cell_top + row_h > int(CONTENT_SAFE_BOTTOM):
            break
        if add_video_card(
            slide, Emu(left), Emu(cell_top), Emu(cell_w), Emu(row_h),
            item, link_label=link_label, layout_warnings=layout_warnings,
        ):
            rendered += 1
        else:
            skipped += 1

    if rendered == 0:
        return top
    actual_rows = max(1, (rendered + cols - 1) // cols)
    bottom = Emu(_gallery_grid_bottom(y0, actual_rows, row_h, gap) + int(_BLOCK_GAP))
    hidden = max(0, total - rendered)
    if total > rendered:
        tpl = labels.get("media_showing_videos", "Showing {shown} of {total} subject-matched videos.")
        bottom = _safe_gallery_note(slide, bottom, tpl.format(shown=rendered, total=total))
    if hidden > 0:
        extra = labels.get("media_videos_saved_evidence", "+ {n} videos saved in evidence.")
        if extra:
            bottom = _safe_gallery_note(slide, bottom, extra.format(n=hidden))
    return bottom
