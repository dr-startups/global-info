"""Per-template slide dispatch (_render_slide)."""

from __future__ import annotations

from typing import Any

from pptx.dml.color import RGBColor

from .common import (
    BODY_COLOR,
    CONTENT_W,
    FS_BODY,
    FS_SECTION,
    MARGIN_X,
    MUTED_COLOR,
    WHITE,
    _Ctx,
    _asset_map,
    _embed_image,
    _embed_image_contain,
    _first_visual_asset,
    _safe,
)
from .executive import (
    _render_executive_dashboard,
    _render_profile_overview,
    _render_risk_matrix_grid,
)
from .visual import (
    _add_search_table,
    _render_visual_with_sidebar,
    _sidebar_analysis,
)

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
            max_items=22,
            max_chars=120,
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
            ctx.bullets(bullets, y, max_items=5, max_chars=260)
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
        # Coverage empty states carry a full client explanation (what the
        # surface is, why it matters, recommendation) — allow multi-paragraph.
        ctx.body(
            narrative or "Для данного раздела недостаточно подтверждённых данных.",
            y,
            2600000,
        )
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


