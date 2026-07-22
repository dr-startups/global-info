"""Per-template slide dispatch (_render_slide)."""

from __future__ import annotations

import io
import re
from typing import Any

from pptx.dml.color import RGBColor
from pptx.util import Emu, Pt

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None  # type: ignore

from .common import (
    BODY_COLOR,
    CARD_BG,
    CARD_BORDER,
    CONTENT_BOTTOM,
    CONTENT_W,
    FONT,
    FS_BODY,
    FS_CAPTION,
    FS_SECTION,
    MARGIN_X,
    MUTED_COLOR,
    NAVY,
    WHITE,
    _Ctx,
    _clip_words,
    _embed_image,
    _resolve_image_bytes,
    _safe,
    _safe_preserve_breaks,
    _trim_dangling_tail,
)
from .executive import (
    _render_executive_dashboard,
    _render_profile_overview,
    _render_risk_matrix_grid,
)
from .visual import (
    _add_search_table,
    _render_kpi_cards,
    _render_status_badge,
    _render_visual_with_sidebar,
)

def _render_slide(ctx: _Ctx, slide: dict[str, Any], assets: dict[str, dict[str, Any]]) -> None:
    template = str(slide.get("template") or "")
    # Level 2.5 — named pre-built layout variant picked by the GPT composer.
    # Validated upstream (TS registry); unknown values fall back to default.
    variant = str(slide.get("layoutVariant") or "")
    title = _safe(slide.get("title") or "ORION")
    narrative = _safe(slide.get("narrative") or "")
    # PDF-47 — keep structured theme newlines; _safe() collapses them and then
    # nested «…«…»» quotes cannot reflow → theme-only stubs («Офшоры»).
    bullets = [
        _safe_preserve_breaks(b)
        for b in slide.get("bullets") or []
        if _safe_preserve_breaks(b)
    ]
    refs = slide.get("assetRefs") or []
    primary = assets.get(str(refs[0])) if refs else None

    if template == "orion_golden_cover":
        ctx.dark_bg()
        # Design v2 cover: gold kicker → large title → subject line → meta rule.
        kicker = ctx.slide.shapes.add_textbox(
            Emu(MARGIN_X), Emu(1_450_000), Emu(CONTENT_W), Emu(300_000)
        )
        kp = kicker.text_frame.paragraphs[0]
        kr = kp.add_run()
        kr.text = "ОТЧЁТ О ЦИФРОВОМ ПРОФИЛЕ"
        kr.font.name = FONT
        kr.font.bold = True
        kr.font.size = Pt(12)
        kr.font.color.rgb = RGBColor(0xC0, 0x9A, 0x4F)
        y = ctx.title("ORION Digital Profile", 1_850_000, WHITE, 38)
        ctx.body(narrative or title, y + 100_000, max_h=900_000, color=RGBColor(0xBF, 0xDB, 0xFE), font_size=14)
        rule = ctx.slide.shapes.add_shape(
            1, Emu(MARGIN_X), Emu(5_650_000), Emu(2_400_000), Emu(16_000)
        )
        rule.fill.solid()
        rule.fill.fore_color.rgb = RGBColor(0xC0, 0x9A, 0x4F)
        rule.line.fill.background()
        ctx.body(
            "Клиентский аудит · предварительная оценка · конфиденциально",
            5_800_000,
            max_h=400000,
            color=MUTED_COLOR,
        )
        return

    if template == "orion_golden_toc":
        # PDF-36 E.5 — structured TOC: gold index numbers + hairline rows
        # instead of a plain bullet list.
        ctx.dark_bg()
        y = ctx.title("Содержание отчёта", 400000, WHITE, FS_SECTION)
        entries = [
            _clip_words(b, 110)
            for b in (bullets or ["Резюме", "Россия", "ОАЭ", "Compliance", "LexisNexis", "Рекомендации"])
        ][:10]
        row_h = min(560_000, max(420_000, (CONTENT_BOTTOM - y - 200_000) // max(1, len(entries))))
        ry = y + 150_000
        for i, entry in enumerate(entries, start=1):
            num = ctx.slide.shapes.add_textbox(Emu(MARGIN_X), Emu(ry), Emu(560_000), Emu(row_h))
            np_ = num.text_frame.paragraphs[0]
            nr = np_.add_run()
            nr.text = f"{i:02d}"
            nr.font.name = FONT
            nr.font.bold = True
            nr.font.size = Pt(16)
            nr.font.color.rgb = RGBColor(0xC0, 0x9A, 0x4F)
            box = ctx.slide.shapes.add_textbox(
                Emu(MARGIN_X + 640_000), Emu(ry + 20_000), Emu(CONTENT_W - 640_000), Emu(row_h)
            )
            tf = box.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            r = p.add_run()
            r.text = entry
            r.font.name = FONT
            r.font.size = Pt(13)
            r.font.color.rgb = WHITE
            rule = ctx.slide.shapes.add_shape(
                1, Emu(MARGIN_X), Emu(ry + row_h - 60_000), Emu(CONTENT_W), Emu(9_000)
            )
            rule.fill.solid()
            rule.fill.fore_color.rgb = RGBColor(0x24, 0x33, 0x52)
            rule.line.fill.background()
            ry += row_h
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
        if variant == "accent-headline" and narrative.strip():
            # Accent-headline: the lead sentence in an accent card, the rest
            # of the narrative below it, then the detail bullets.
            narr_full = narrative.strip()
            sentences = re.split(r"(?<=[.!?…])\s+", narr_full)
            lead = sentences[0] if sentences else narr_full
            rest = " ".join(sentences[1:]).strip()
            y = ctx.content_card(
                title=None,
                text=_clip_words(lead, 420),
                x=MARGIN_X,
                y=y,
                width=CONTENT_W,
                min_h=360_000,
                max_h=1_100_000,
                tone="accent",
                body_size=13,
            )
            y += 100_000
            if rest:
                y = ctx.content_card(
                    title=None,
                    text=_clip_words(rest, 1400),
                    x=MARGIN_X,
                    y=y,
                    width=CONTENT_W,
                    min_h=320_000,
                    max_h=min(2_400_000, CONTENT_BOTTOM - y - (1_200_000 if bullets else 100_000)),
                    tone="neutral",
                    body_size=11,
                )
                y += 100_000
            if bullets:
                ctx.bullets(bullets, y, max_items=6, max_chars=900)
            return
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
            ctx.bullets(bullets, y, max_items=6, max_chars=900)
        return

    if template == "orion_golden_risk_matrix":
        _render_risk_matrix_grid(ctx, slide, title or "Матрица рисков")
        return

    if template == "orion_golden_region_divider":
        ctx.dark_bg()
        if variant == "hero":
            # Hero divider: tall gold bar + large title + lead paragraph.
            bar = ctx.slide.shapes.add_shape(
                5, Emu(MARGIN_X), Emu(2_450_000), Emu(110_000), Emu(1_600_000)
            )
            bar.fill.solid()
            bar.fill.fore_color.rgb = RGBColor(0xC0, 0x9A, 0x4F)
            bar.line.fill.background()
            text_x = MARGIN_X + 300_000
            text_w = CONTENT_W - 300_000
            box = ctx.slide.shapes.add_textbox(Emu(text_x), Emu(2_450_000), Emu(text_w), Emu(900_000))
            tf = box.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            r = p.add_run()
            r.text = _safe(title)
            r.font.name = FONT
            r.font.bold = True
            r.font.size = Pt(36)
            r.font.color.rgb = WHITE
            if narrative:
                ctx.body(
                    narrative,
                    3_450_000,
                    max_h=1_500_000,
                    color=RGBColor(0xBF, 0xDB, 0xFE),
                    font_size=13,
                    x=text_x,
                    w=text_w,
                )
            return
        ctx.title(title, 2800000, WHITE, 34)
        return

    if template == "orion_golden_metrics_dashboard":
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY, FS_SECTION)
        badge = slide.get("statusBadge") if isinstance(slide.get("statusBadge"), dict) else None
        if badge:
            y = _render_status_badge(ctx, badge, MARGIN_X, y, CONTENT_W) + 80_000
        if variant == "kpi-first":
            # KPI-first: headline numbers lead the page, the narrative and the
            # action follow — same content, inverted visual hierarchy.
            metrics_kf = [m for m in (slide.get("metrics") or []) if isinstance(m, dict)]
            if metrics_kf:
                y = _render_kpi_cards(ctx, metrics_kf[:6], MARGIN_X, y, CONTENT_W, cols=3) + 100_000
            if narrative:
                # PDF-36 E.4 — cards height-fit; no 420-char starvation.
                y = ctx.content_card(
                    title=None,
                    text=narrative,
                    x=MARGIN_X,
                    y=y,
                    width=CONTENT_W,
                    min_h=260_000,
                    max_h=1_100_000,
                    tone="neutral",
                    body_size=11,
                )
                y += 80_000
            actions_kf = [a for a in (slide.get("actions") or []) if isinstance(a, dict)]
            if actions_kf:
                y = ctx.content_card(
                    title="Действие",
                    text=_safe(actions_kf[0].get("label")),
                    x=MARGIN_X,
                    y=y,
                    width=CONTENT_W,
                    min_h=260_000,
                    max_h=800_000,
                    tone="warn",
                    title_size=11,
                    body_size=11,
                )
                y += 60_000
            if bullets:
                ctx.bullets(bullets, y, max_items=3, max_chars=900)
            return
        # PDF-40 G.4/G.5 / PDF-45 — scorecard → narrative → theme cards.
        # Fewer cards per page + higher char budget; overflow continues.
        metrics = [m for m in (slide.get("metrics") or []) if isinstance(m, dict)]
        if metrics:
            y = _render_kpi_cards(ctx, metrics[:6], MARGIN_X, y, CONTENT_W, cols=3) + 80_000
        if narrative:
            y = ctx.content_card(
                title=None,
                text=narrative,
                x=MARGIN_X,
                y=y,
                width=CONTENT_W,
                min_h=220_000,
                max_h=900_000 if metrics else 1_100_000,
                tone="neutral",
                body_size=11,
            )
            y += 70_000
        actions = [a for a in (slide.get("actions") or []) if isinstance(a, dict)]
        if actions and not bullets:
            # Action card only when there is room; with theme bullets the action
            # is already in whatToCheck / cont pages — avoid crowding.
            y = ctx.content_card(
                title="Действие",
                text=_safe(actions[0].get("label")),
                x=MARGIN_X,
                y=y,
                width=CONTENT_W,
                min_h=220_000,
                max_h=700_000,
                tone="warn",
                title_size=11,
                body_size=11,
            )
            y += 50_000
        elif actions and bullets and (CONTENT_BOTTOM - y) > 1_800_000:
            y = ctx.content_card(
                title="Действие",
                text=_safe(actions[0].get("label")),
                x=MARGIN_X,
                y=y,
                width=CONTENT_W,
                min_h=200_000,
                max_h=520_000,
                tone="warn",
                title_size=11,
                body_size=10.5,
            )
            y += 50_000
        if bullets:
            ctx.bullets(bullets, y, max_items=3, max_chars=900)
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
        max_rows = max(1, int((CONTENT_BOTTOM - y + gap) // (cell_h + gap)))
        max_cells = max_rows * cols
        for idx, ref in enumerate(refs):
            if idx >= max_cells:
                break
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
                shape = ctx.slide.shapes.add_shape(5, Emu(cx), Emu(cy), Emu(cell_w), Emu(cell_h))
                try:
                    shape.adjustments[0] = 0.05
                except Exception:  # noqa: BLE001
                    pass
                shape.fill.solid()
                shape.fill.fore_color.rgb = CARD_BG
                shape.line.color.rgb = CARD_BORDER
                shape.line.width = Pt(0.75)
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
            # Keep 1–2 complete sentences above the table; never end on «как/и/с».
            intro = _safe(narrative)
            sentences = [s.strip() for s in re.split(r"(?<=[.!?…])\s+", intro) if s.strip()]
            complete = [
                s
                for s in sentences
                if s.endswith((".", "!", "?", "…"))
                and not re.search(r"(?:\bкак|\bи|\bс|\bв|\bпо|,|;|—)\s*$", s, re.I)
            ]
            if complete:
                intro = " ".join(complete[:2])
            else:
                intro = "Таблица фиксирует сохранённые позиции поисковой выдачи."
            intro = _trim_dangling_tail(intro)
            y = ctx.body(intro, y, max_h=900000, color=MUTED_COLOR)
            y = y + 40000
        table = slide.get("table") if isinstance(slide.get("table"), dict) else None
        headers = list((table or {}).get("headers") or [])
        rows = list((table or {}).get("rows") or [])
        groups = list((table or {}).get("groups") or [])
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
            # Render every row the (paginated) slide carries — no hidden cap.
            # Keep up to 5 headers so Запрос can be stripped inside the helper
            # without also dropping Статус.
            _add_search_table(ctx, y, headers[:5], rows, groups)
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
                clipped = _clip_words(bullet, 240)
                r.text = f"• {clipped}"
                r.font.name = FONT
                r.font.size = Pt(11)
                r.font.color.rgb = (
                    RGBColor(0xB9, 0x1C, 0x1C) if clipped.startswith("[Н]") else BODY_COLOR
                )
        return

    if template == "orion_golden_no_data_compact":
        # C.2 — honest empty state as a structured page: status card,
        # "what it means" card, recommendation card, methodology footnote.
        ctx.light_bg()
        y = ctx.title(title, 320000, NAVY)
        status_text = narrative or "Для данного раздела недостаточно подтверждённых данных."
        # PDF-36 D.3 — cards height-fit with font step-down; no char starvation.
        y = ctx.content_card(
            title="Статус сбора",
            text=status_text,
            x=MARGIN_X,
            y=y,
            width=CONTENT_W,
            min_h=380_000,
            max_h=1_700_000,
            tone="accent",
            title_size=11,
            body_size=12,
        )
        y += 110_000
        if bullets:
            why_text = "\n".join(bullets[:4])
            y = ctx.content_card(
                title="Что это означает",
                text=why_text,
                x=MARGIN_X,
                y=y,
                width=CONTENT_W,
                min_h=360_000,
                max_h=2_200_000,
                tone="neutral",
                title_size=11,
                body_size=11,
            )
            y += 110_000
        actions_nd = [a for a in (slide.get("actions") or []) if isinstance(a, dict)]
        if actions_nd:
            y = ctx.content_card(
                title="Что проверить",
                text=_safe(actions_nd[0].get("label")),
                x=MARGIN_X,
                y=y,
                width=CONTENT_W,
                min_h=320_000,
                max_h=1_100_000,
                tone="warn",
                title_size=11,
                body_size=11,
            )
            y += 110_000
        methodology = _safe(slide.get("methodologyNote") or "")
        source_note = _safe(slide.get("sourceNote") or "")
        footnote = " ".join(x for x in (methodology, source_note) if x)
        if footnote and y < CONTENT_BOTTOM - 400_000:
            ctx.body(
                _clip_words(footnote, 300),
                y,
                max_h=CONTENT_BOTTOM - y - 60_000,
                color=MUTED_COLOR,
                font_size=9,
            )
        return

    if template == "orion_golden_audit_dashboard":
        # ORION regional résumé: themes left-ish via bullets top, KPI counters below.
        ctx.light_bg()
        y = ctx.title(title, 280000, NAVY, FS_SECTION)
        if narrative:
            # PDF-36 D.3 — ctx.body height-fits with font step-down; feed it
            # the full text instead of a pre-starved 520-char slice.
            y = ctx.body(_clip_words(narrative, 760), y, max_h=1200000)
            y = y + 80000
        if bullets:
            ctx.bullets(bullets, y, max_items=14, max_chars=340)
        return

    # orion_golden_prose (continuation themes) + default section / appendix
    ctx.light_bg()
    y = ctx.title(title, 280000, NAVY, FS_SECTION)
    # PDF-36 D.3 / PDF-47 — page bottom is the real budget; theme cards need
    # the full 900-char structured budget (520 starved nested-quote bullets).
    short_narrative = _clip_words(narrative, 900) if narrative else ""
    if short_narrative and not bullets:
        ctx.body(short_narrative, y, max_h=CONTENT_BOTTOM - y - 100000)
        return
    if short_narrative:
        y = ctx.body(short_narrative, y, max_h=1100000)
        y = y + 80000
    if bullets:
        ctx.bullets(bullets, y, max_items=9, max_chars=900)


