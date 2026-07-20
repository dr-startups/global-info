"""Sidebar, KPI cards, visual+sidebar layout, and search tables."""

from __future__ import annotations

import io
import re
from typing import Any

from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR
from pptx.util import Emu, Pt

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None  # type: ignore

from .common import (
    ACCENT,
    ACCENT_SOFT,
    BODY_COLOR,
    CARD_BG,
    CARD_BORDER,
    CONTENT_BOTTOM,
    CONTENT_W,
    EMU_PER_PT,
    FONT,
    FORBIDDEN,
    FS_BODY,
    FS_CAPTION,
    GOOD_BG,
    MARGIN_X,
    MUTED_COLOR,
    NAVY,
    RISK_BG,
    SIDEBAR_SAFE_FALLBACK,
    TONE_GOOD,
    TONE_RISK,
    TONE_WARN,
    WARN_BG,
    WHITE,
    _Ctx,
    _clip_words,
    _embed_image,
    _embed_image_contain,
    _first_visual_asset,
    _fit_text_to_height,
    _resolve_image_bytes,
    _safe,
    measure_text_height,
    record_text_layout,
)

try:
    from client_text_contract import sidebar_check_failures
except ImportError:  # pragma: no cover
    from renderer.client_text_contract import sidebar_check_failures  # type: ignore

def _sidebar_word_budget(text: str, max_words: int = 70) -> str:
    """Keep complete sentences within a soft word budget; never emit one-word stubs."""
    raw = _safe(text)
    if not raw:
        return ""
    words = raw.split()
    if len(words) <= max_words:
        return raw
    sentences = re.split(r"(?<=[.!?…])\s+", raw)
    kept: list[str] = []
    count = 0
    for sent in sentences:
        w = len(sent.split())
        if kept and count + w > max_words:
            break
        if not kept and w > max_words:
            return _clip_words(sent, max(80, max_words * 6))
        kept.append(sent)
        count += w
        if count >= max_words:
            break
    return " ".join(kept).strip() or _clip_words(raw, max(80, max_words * 6))


def _qa_preview(text: str, match_index: int = 0) -> str:
    """Short, safe preview around a matched token for QA diagnostics."""
    raw = _safe(text)
    start = max(0, match_index - 20)
    snippet = raw[start:match_index + 40].strip()
    snippet = re.sub(r"\s+", " ", snippet)
    return (snippet[:60] + "…") if len(snippet) > 60 else snippet


def _sidebar_sanitize_field(ctx: _Ctx, field: str, text: str) -> str:
    """REMEDIATION §6.2 — bad field → neutral fallback + warning (no raise)."""
    value = _safe(text)
    if not value:
        return value
    failures = sidebar_check_failures(value, field, ctx.client_text_contract)
    if not failures:
        return value
    for msg in failures:
        preview = _qa_preview(value)
        ctx.warnings.append(f"sidebar-qa:p{ctx.page}:{field}:{msg} preview=\"{preview}\"")
    return SIDEBAR_SAFE_FALLBACK


def _sidebar_analysis(ctx: _Ctx, slide: dict[str, Any], x: int, y: int, w: int, h: int) -> None:
    """Unified client sidebar panel (v57): one column, no stacked framed cards."""
    analysis = slide.get("visualAnalysis") or {}
    if not isinstance(analysis, dict):
        analysis = {}

    mode = str(analysis.get("sidebarMode") or "")
    headline = _safe(analysis.get("headlineConclusion") or slide.get("clientTakeaway") or "Вывод")
    meaning = _safe(analysis.get("clientMeaning") or analysis.get("whyItMatters") or "")
    visible = _safe(analysis.get("whatIsVisible") or "")
    explanations = analysis.get("highlightExplanations") or []
    if not isinstance(explanations, list):
        explanations = []
    actions = analysis.get("recommendedActions") or []
    action = _safe(actions[0]) if isinstance(actions, list) and actions else ""
    provenance = _safe(analysis.get("provenanceLabel") or "")
    more_n = int(analysis.get("moreSignalsCount") or 0)

    has_frames = any(
        isinstance(ex, dict) and str(ex.get("frameTone") or "") in {"red", "amber"} for ex in explanations
    )
    if mode == "adverse_explanation" or has_frames:
        mid_title = "Почему выделено"
        mid_bits = []
        for ex in explanations[:2]:
            if not isinstance(ex, dict):
                continue
            reason = _safe(ex.get("clientReason") or "")
            if reason:
                mid_bits.append(reason)
        if more_n > 0:
            mid_bits.append(f"Ещё {more_n} похожих сигналов.")
        mid_body = " ".join(mid_bits) if mid_bits else visible
    else:
        mid_title = "Что показывает экран"
        mid_body = visible or meaning

    # Soft-degrade contract violations per field (§6.2); render continues.
    headline = _sidebar_sanitize_field(ctx, "headlineConclusion", headline)
    mid_body = _sidebar_sanitize_field(ctx, "whatIsVisible", mid_body)
    meaning = _sidebar_sanitize_field(ctx, "clientMeaning", meaning)
    action = _sidebar_sanitize_field(ctx, "recommendedActions", action)

    # Draw one outer panel
    pad = 70_000
    gap = 55_000
    cy = y + pad
    max_bottom = min(y + h, CONTENT_BOTTOM) - pad
    ctx.card(y, h=min(h, max_bottom - y + pad), x=x, w=w, fill=CARD_BG)

    def write_block(
        title: str | None,
        body: str,
        *,
        field: str,
        size: float = 11,
        bold_title: bool = True,
        required: bool = False,
    ) -> None:
        nonlocal cy
        if not body:
            return
        title_h = 200_000 if title else 0
        # Prefer complete text; do not ellipsis-clip sidebar
        fitted = body
        needed = measure_text_height(fitted, w - 2 * pad, size, line_spacing=1.2)
        avail = max_bottom - cy - 160_000 - title_h
        if needed > avail:
            # Keep complete sentences only (no ellipsis). When even the first
            # sentence cannot fit: required headline → safe fallback (§6.2);
            # optional blocks are dropped whole.
            sentences = re.split(r"(?<=[.!?…])\s+", fitted)
            kept: list[str] = []
            for sent in sentences:
                trial = " ".join(kept + [sent]).strip()
                if measure_text_height(trial, w - 2 * pad, size, line_spacing=1.2) <= avail:
                    kept.append(sent)
                else:
                    break
            if not kept:
                if required:
                    ctx.warnings.append(
                        f"sidebar-qa:p{ctx.page}:{field}:overflow without complete sentence"
                    )
                    fitted = SIDEBAR_SAFE_FALLBACK
                else:
                    return
            else:
                fitted = " ".join(kept)
        if title:
            box = ctx.slide.shapes.add_textbox(Emu(x + pad), Emu(cy), Emu(w - 2 * pad), Emu(220_000))
            tf = box.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            r = p.add_run()
            r.text = title
            r.font.name = FONT
            r.font.bold = bold_title
            r.font.size = Pt(10.5)
            r.font.color.rgb = NAVY
            cy += 200_000
        bh = measure_text_height(fitted, w - 2 * pad, size, line_spacing=1.2)
        box = ctx.slide.shapes.add_textbox(Emu(x + pad), Emu(cy), Emu(w - 2 * pad), Emu(max(bh, 120_000)))
        tf = box.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        r = p.add_run()
        r.text = fitted
        r.font.name = FONT
        r.font.size = Pt(size)
        r.font.color.rgb = BODY_COLOR
        cy += bh + gap

    write_block(None, headline, field="headlineConclusion", size=12, required=True)
    write_block(mid_title, mid_body, field="whatIsVisible", size=11)
    if meaning and meaning != mid_body and meaning != headline:
        write_block("Что это значит", meaning, field="clientMeaning", size=11)
    if action:
        write_block("Что сделать", action, field="recommendedActions", size=11)
    if provenance:
        # Fine print, no frame
        if cy < max_bottom - 80_000:
            box = ctx.slide.shapes.add_textbox(Emu(x + pad), Emu(min(cy, max_bottom - 120_000)), Emu(w - 2 * pad), Emu(140_000))
            tf = box.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            r = p.add_run()
            r.text = provenance
            r.font.name = FONT
            r.font.size = Pt(8.5)
            r.font.color.rgb = MUTED_COLOR



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
        # Keep room for Russian status phrases like «Данные не собраны» / «0 / 10».
        value = _clip_words(_safe(m.get("value")), 36)
        label = _clip_words(_safe(m.get("label")), 28)
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
        r0.font.size = Pt(18 if len(value) <= 10 else 12 if len(value) <= 22 else 10)
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


def _title_line_estimate(text: str, col_width_emu: int, font_pt: float, max_lines: int = 2) -> int:
    """Word-aware line estimate mirroring TS search-results-pagination.ts."""
    text = (text or "").strip()
    if not text:
        return 1
    char_w = font_pt * EMU_PER_PT * 0.52
    max_chars = max(1, int(col_width_emu / char_w))
    words = text.split()
    lines = 1
    cur = 0
    for w in words:
        add = len(w) if cur == 0 else cur + 1 + len(w)
        if add <= max_chars:
            cur = add
        else:
            lines += 1
            cur = min(len(w), max_chars)
            if lines >= max_lines:
                return max_lines
    return min(lines, max_lines)


def _status_tone(status: str) -> tuple[str, "RGBColor"]:
    s = (status or "").strip().lower()
    if "нежелат" in s:
        return "●", RGBColor(0xB9, 0x1C, 0x1C)
    # LIKELY_SUBJECT (§2.1) and manual-review statuses — amber, not green.
    if "вероятн" in s or "проверк" in s or "требует" in s:
        return "●", RGBColor(0xC2, 0x41, 0x0C)
    return "●", RGBColor(0x04, 0x78, 0x57)


def _add_search_table(
    ctx: _Ctx,
    y: int,
    headers: list[str],
    rows: list[list[str]],
    groups: list[dict[str, Any]] | None = None,
) -> None:
    """
    Grouped SERP position table. Renders EVERY row the slide carries (no cap) —
    TS pagination already guaranteed geometric fit. Query is shown as a compact
    group-header band (spec §4), status as a colored badge (spec §5).
    """
    # Body layout is 4 cols: Позиция | Домен | Заголовок | Статус.
    # If TS sends a leading «Запрос» column, drop it — query lives in group bands.
    hdr = [str(h) for h in headers]
    data_rows = [list(r) for r in rows]
    if len(hdr) >= 5 and re.search(r"запрос|query", hdr[0], re.I):
        hdr = hdr[1:]
        data_rows = [r[1:] if len(r) > 1 else r for r in data_rows]
    cols = max(1, min(4, len(hdr)))
    headers = hdr
    groups = groups or []

    # Row plan: header + interleaved group bands + data rows.
    plan: list[tuple[str, Any]] = [("header", headers)]
    if groups:
        for g in groups:
            start = int(g.get("rowStart", 0))
            count = int(g.get("rowCount", 0))
            label = str(g.get("queryDisplay") or "")
            qtag = g.get("qTag")
            band = f"Запрос: {label}" if not qtag else f"{qtag} — {label}"
            plan.append(("group", band))
            for r in data_rows[start : start + count]:
                plan.append(("data", r))
    else:
        for r in data_rows:
            plan.append(("data", r))

    # Column widths (Позиция | Домен | Заголовок | Статус) — spec §4 proportions.
    # Two-column tables (Параметр | Значение) need a readable label column, and
    # a textual first column (e.g. «База данных») needs more than the numeric
    # position width.
    if cols == 2:
        prop = [0.24, 0.76]
    elif headers and len(str(headers[0]).strip()) > 3:
        prop = [0.14, 0.26, 0.42, 0.18][:cols]
    else:
        prop = [0.07, 0.22, 0.53, 0.18][:cols]
    widths = [max(500_000, int(CONTENT_W * p)) for p in prop]
    leftover = CONTENT_W - sum(widths)
    if leftover != 0 and widths:
        widths[2 if cols > 2 else len(widths) - 1] += leftover
    title_col_w = widths[2] if cols > 2 else widths[-1]

    # Per-row heights.
    body_pt = 10.0
    line_h = int(body_pt * EMU_PER_PT * 1.2)
    pad = int(6 * EMU_PER_PT)
    header_h = int(26 * EMU_PER_PT)
    group_h = int(18 * EMU_PER_PT)
    heights: list[int] = []
    for kind, payload in plan:
        if kind == "header":
            heights.append(header_h)
        elif kind == "group":
            heights.append(group_h)
        else:
            lines = _title_line_estimate(str(payload[2]) if len(payload) > 2 else "", title_col_w, body_pt)
            heights.append(lines * line_h + pad)

    table_rows = len(plan)
    table_h = sum(heights)
    shape = ctx.slide.shapes.add_table(table_rows, cols, Emu(MARGIN_X), Emu(y), Emu(CONTENT_W), Emu(table_h))
    tbl = shape.table
    for i, w in enumerate(widths):
        tbl.columns[i].width = Emu(w)
    for i, h in enumerate(heights):
        tbl.rows[i].height = Emu(h)

    def paint(cell: Any, text: str, *, bold: bool = False, color: Any = BODY_COLOR, bg: Any = WHITE, size: float = 10.0, clip: bool = True) -> None:
        # Status badges ("● Нежелательный") are complete labels, not clipped
        # prose — the dangling-tail trimmer would strip the word after the dot.
        cell.text = _clip_words(text, 200) if clip else _safe(text)
        cell.vertical_anchor = MSO_ANCHOR.MIDDLE
        for p in cell.text_frame.paragraphs:
            p.font.name = FONT
            p.font.size = Pt(size)
            p.font.bold = bold
            p.font.color.rgb = color
        cell.text_frame.word_wrap = True
        fill = cell.fill
        fill.solid()
        fill.fore_color.rgb = bg

    for r_idx, (kind, payload) in enumerate(plan):
        if kind == "header":
            for c in range(cols):
                label = str(payload[c]) if c < len(payload) else ""
                paint(tbl.cell(r_idx, c), label, bold=True, color=WHITE, bg=NAVY, size=10.0)
        elif kind == "group":
            merged = tbl.cell(r_idx, 0)
            merged.merge(tbl.cell(r_idx, cols - 1))
            paint(merged, str(payload), bold=True, color=NAVY, bg=ACCENT_SOFT, size=10.0)
        else:
            row = payload
            status = str(row[cols - 1] if len(row) >= cols else "").strip()
            status_l = status.lower()
            adverse = "нежелат" in status_l
            likely = "вероятн" in status_l or "проверк" in status_l or "требует" in status_l
            if adverse:
                row_bg = RGBColor(0xFE, 0xF2, 0xF2)
            elif likely:
                row_bg = RGBColor(0xFF, 0xF7, 0xED)  # soft amber for LIKELY
            else:
                row_bg = WHITE
            for c in range(cols):
                val = str(row[c]) if c < len(row) else ""
                if c == cols - 1:
                    dot, tone = _status_tone(val)
                    paint(tbl.cell(r_idx, c), f"{dot} {val}", color=tone, bg=row_bg, size=9.5, clip=False)
                else:
                    paint(tbl.cell(r_idx, c), val, bg=row_bg, size=10.0)


