"""Executive dashboard, risk matrix grid, and profile overview templates."""

from __future__ import annotations

import re
from typing import Any

from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.util import Emu, Pt

from .common import (
    ACCENT,
    ACCENT_SOFT,
    BODY_COLOR,
    CARD_BG,
    CARD_BORDER,
    CONTENT_BOTTOM,
    CONTENT_W,
    FONT,
    FS_BODY,
    FS_CAPTION,
    FS_SECTION,
    GOOD_BG,
    MARGIN_X,
    MUTED_COLOR,
    NAVY,
    RISK_BG,
    TITLE_COLOR,
    WARN_BG,
    WHITE,
    _Ctx,
    _bullet_line_style,
    _clip_structured_bullet,
    _clip_words,
    _fit_text_to_height,
    _safe,
    _split_structured_bullet,
    _trim_dangling_tail,
    measure_text_height,
)
from .visual import (
    _render_kpi_cards,
    _render_status_badge,
    _title_line_estimate,
    _tone_fill,
    _tone_value_color,
)

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
        # PDF-36 D.3 — content_card height-fits with font step-down; the old
        # 420-char pre-clip starved the §7.2 line and lead conclusions.
        cy = ctx.content_card(
            title=None,
            text=_safe(para),
            x=left_x,
            y=cy,
            width=left_w,
            min_h=240_000,
            max_h=1_100_000,
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
            text = detail
        elif detail:
            text = detail
        else:
            text = headline
        # Guard dangling tails from upstream clips.
        text = _trim_dangling_tail(_safe(text))
        cards.append(("Риск", text, tone))
    if actions:
        act = actions[0]
        label = _safe(act.get("label"))
        # Keep a complete sentence for the narrow action card — never mid-phrase
        # stubs like «…и карту ключевых» (PDF review). No pre-_clip_words.
        text = label
        if len(text) > 200:
            punct = max(text.rfind(". "), text.rfind("! "), text.rfind("? "), text.rfind("; "))
            if punct > 60:
                text = text[: punct + 1].strip()
            else:
                text = _clip_words(text, 160)
                if text and text[-1] not in ".!?…":
                    text = text.rstrip(".,;: ") + "."
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
    badge_w = 1_900_000
    dangling = re.compile(
        r"(?:\bв\s+т\.?\s*ч\.?|\bс\s+[А-ЯA-Z]\.?|\b[А-ЯA-Z]\.?|,|;|—|–|-)\s*$",
        re.I,
    )
    for finding in findings[:6]:
        tone = str(finding.get("tone") or "warn")
        pill = _safe(finding.get("status") or finding.get("severity") or "")
        if len(pill) > 28:
            pill = _clip_words(pill, 28)
        headline = _safe(finding.get("headline") or "Тема")
        if len(headline) > 72:
            headline = _clip_words(headline, 72)
        detail = _clip_structured_bullet(_safe(finding.get("detail") or ""), 520)
        # Prefer complete source text; only sentence-fit if height is tight.
        marker = _safe(finding.get("manualReview") or "")
        # Embed "requires review" into status instead of a cramped footer.
        if marker and re.search(r"требует", pill or "", re.I) is None and "проверк" in marker.lower():
            if pill and "проверк" not in pill.lower():
                pill = pill  # keep level; marker dropped from footer
        text_w = CONTENT_W - badge_w - 220_000 if pill else int(CONTENT_W * 0.92)
        left = MARGIN_X + 100_000
        pad_y = 80_000
        headline_h = measure_text_height(headline, text_w, 13, line_spacing=1.15)
        # PDF-36 E.2 — a card that cannot fit whole above the footer is not
        # drawn at all (TS pagination carries the rest to the continuation
        # page); a half-card bleeding into the footer reads as a defect.
        remaining = CONTENT_BOTTOM - y - 40_000
        if remaining < max(420_000, pad_y + headline_h + pad_y):
            break
        detail_font = 11
        if detail:
            # Grow card to fit complete detail when possible.
            detail_h = measure_text_height(detail, text_w, detail_font, line_spacing=1.2)
            needed = pad_y + headline_h + 40_000 + detail_h + pad_y
            max_h = max(480_000, remaining)
            if needed > max_h:
                # PDF-36 D.3 — font step-down before dropping sentences.
                for candidate in (10, 9.5):
                    cand_h = measure_text_height(detail, text_w, candidate, line_spacing=1.2)
                    if pad_y + headline_h + 40_000 + cand_h + pad_y <= max_h:
                        detail_font = candidate
                        detail_h = cand_h
                        needed = pad_y + headline_h + 40_000 + detail_h + pad_y
                        break
            if needed > max_h:
                fitted = _fit_text_to_height(detail, text_w, detail_font, max(180_000, max_h - pad_y - headline_h - pad_y - 40_000))
                if dangling.search(fitted.replace("\n", " ")) or fitted != detail and not fitted.rstrip().endswith((".", "!", "?")):
                    # Fall back to first complete sentence only.
                    sentences = re.split(r"(?<=[.!?])\s+", detail.replace("\n", " "))
                    fitted = sentences[0].rstrip(".,;: ") + ("." if sentences and not sentences[0].endswith((".", "!", "?")) else "")
                    if dangling.search(fitted):
                        raise RuntimeError(f"ORION risk-matrix dangling detail on p{ctx.page}: {fitted[-40:]}")
                detail = fitted
                detail_h = measure_text_height(detail, text_w, detail_font, line_spacing=1.2)
            h = min(max_h, pad_y + headline_h + 40_000 + detail_h + pad_y)
        else:
            h = max(420_000, pad_y + headline_h + pad_y)
        h = max(420_000, min(h, remaining))
        ctx.card(y, h=h, fill=_tone_fill(tone))
        # Headline
        box = ctx.slide.shapes.add_textbox(Emu(left), Emu(y + pad_y), Emu(text_w), Emu(max(headline_h + 20_000, 160_000)))
        tf = box.text_frame
        tf.word_wrap = True
        p = tf.paragraphs[0]
        r = p.add_run()
        r.text = headline
        r.font.name = FONT
        r.font.bold = True
        r.font.size = Pt(13)
        r.font.color.rgb = NAVY
        text_y = y + pad_y + headline_h + 30_000
        if detail:
            rem = max(140_000, y + h - text_y - pad_y)
            box = ctx.slide.shapes.add_textbox(Emu(left), Emu(text_y), Emu(text_w), Emu(rem))
            tf = box.text_frame
            tf.word_wrap = True
            # PDF-38 F.1 — hierarchical detail: stats body, muted Sources/Examples.
            detail_lines = _split_structured_bullet(detail) or [detail]
            first = True
            for li, line in enumerate(detail_lines):
                p = tf.paragraphs[0] if first else tf.add_paragraph()
                first = False
                p.space_before = Pt(0 if li == 0 else 1)
                p.space_after = Pt(1)
                p.line_spacing = 1.12
                bold, line_color, size_pt = _bullet_line_style(line, is_first=(li == 0))
                # Inside a card the headline already carries the theme — demote
                # a repeated guillemet theme line to body weight.
                if li == 0 and line.startswith("«"):
                    bold, line_color, size_pt = False, BODY_COLOR, float(detail_font)
                elif not bold:
                    size_pt = float(detail_font) if line_color == BODY_COLOR else FS_CAPTION + 0.5
                r = p.add_run()
                r.text = line
                r.font.name = FONT
                r.font.bold = bold
                r.font.size = Pt(size_pt)
                r.font.color.rgb = line_color
        if pill:
            # E.1 — badge height from conservative wrap estimate; long Russian
            # labels like «Требует подтверждения» always get ≥2 lines of room
            # so the plate border never bisects the text (PDF 36 p5–7).
            bx = MARGIN_X + CONTENT_W - badge_w - 80_000
            by = y + pad_y
            inner_w = badge_w - 140_000
            pill_size = 10
            lines = _title_line_estimate(pill, inner_w, pill_size, max_lines=3)
            if len(pill) > 14 or " " in pill:
                lines = max(lines, 2)
            line_h = int(pill_size * 12_700 * 1.35)
            need = lines * line_h + 60_000
            bh = min(max(360_000, need + 140_000), max(360_000, h - 2 * pad_y))
            # Soft tone fill, no hard border — a stroked plate was reading as
            # a mid-text strike-through after LibreOffice PDF conversion.
            ctx.card(by, h=bh, x=bx, w=badge_w, fill=_tone_fill(tone), border=None)
            b = ctx.slide.shapes.add_textbox(
                Emu(bx + 70_000), Emu(by + 70_000), Emu(inner_w), Emu(bh - 140_000)
            )
            btf = b.text_frame
            btf.word_wrap = True
            bp = btf.paragraphs[0]
            bp.alignment = PP_ALIGN.CENTER
            br = bp.add_run()
            br.text = pill
            br.font.name = FONT
            br.font.bold = True
            br.font.size = Pt(pill_size)
            br.font.color.rgb = _tone_value_color(tone)
        y += h + 50_000
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
            title=_clip_words(_safe(finding.get("headline")), 48),
            text=_safe(finding.get("detail") or ""),
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



