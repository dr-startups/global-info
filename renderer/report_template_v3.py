"""Polished report template v3 (Stage K3).

Same 36-page dynamic structure as v2 plus a full final commercial block, but
rendered through the shared design system in `theme.py`: consistent page frame
(accent bar + footer + page number), metric/risk cards, polished zebra tables
with risk-coloured cells, and a near-final client-facing offer block.

Render options:
  - audience: "internal" (default) shows technical notes; "client" softens them.
  - watermark_mode: "draft" (default) stamps the watermark; "none" hides it.

Every slide is built through a safe wrapper: a failing slide adds a warning +
fallback card instead of breaking the deck. Robust to empty / missing data.

No LLM, no scraping, no live SERP screenshots — only lays out report_json data.
"""

from __future__ import annotations

import io
from typing import Any, Callable

from pptx.enum.text import PP_ALIGN
from pptx.util import Emu, Pt

import theme as T
from report_mapper import build_view_model_v3


class Ctx:
    def __init__(self, brand: str, watermark: str | None, internal: bool):
        self.brand = brand
        self.watermark = watermark
        self.internal = internal
        self.page = 1
        self.total = 0


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------

def _frame(slide, ctx: Ctx, title: str, subtitle: str | None = None) -> Emu:
    return T.page_frame(
        slide,
        title,
        subtitle,
        brand=ctx.brand,
        page_no=ctx.page,
        total=ctx.total,
        watermark=ctx.watermark,
    )


def _section(prs, ctx: Ctx, title: str, subtitle: str | None = None):
    slide = T.blank_slide(prs)
    top = _frame(slide, ctx, title, subtitle)
    return slide, top


def _risk_card_value(level: str, L: dict) -> Any:
    return {"label": L["m_risk_level"], "value": str(level or "UNKNOWN"), "tone": T.RISK_COLORS.get(str(level or "UNKNOWN").upper(), T.NEUTRAL_GRAY)}


def _norm(text: Any) -> str:
    """Normalize text for duplicate detection (case/space-insensitive)."""
    return " ".join(str(text or "").split()).strip().lower()


# ===========================================================================
# 1-5 front matter
# ===========================================================================

def _p_cover(prs, vm, ctx):
    L = vm["labels"]
    slide = T.blank_slide(prs)
    T.set_bg(slide, T.BRAND_PRIMARY)
    c = vm["cover"]
    ob = vm["offerBlock"]
    # accent rule
    rule = slide.shapes.add_shape(T.RECT, T.MARGIN, Emu(1700000), Emu(2200000), Emu(54864))
    rule.fill.solid()
    rule.fill.fore_color.rgb = T.ACCENT
    rule.line.fill.background()

    box = T.textbox(slide, T.MARGIN, Emu(1900000), T.CONTENT_W, Emu(2900000))
    tf = box.text_frame
    T._run(tf.paragraphs[0], L["cover_heading"], T.FS_COVER_TITLE, T.WHITE, bold=True)
    T._run(tf.add_paragraph(), ob["cover"].get("subtitle", ""), T.FS_SUBTITLE + 3, T.ACCENT_SOFT)
    p = tf.add_paragraph()
    T._run(p, c.get("subjectFullName", ""), 26, T.WHITE, bold=True)
    p.space_before = Pt(14)
    T._run(tf.add_paragraph(), f"{L['audit_date']}: {c.get('auditDate', '')}", T.FS_SUBTITLE, T.ACCENT_SOFT)
    T._run(tf.add_paragraph(), c.get("brand", ""), T.FS_SUBTITLE, T.ACCENT_SOFT)
    contact = " · ".join(x for x in [c.get("website", ""), c.get("contact", "")] if x)
    if contact:
        T._run(tf.add_paragraph(), contact, T.FS_NOTE + 1, T.NEUTRAL_GRAY)

    T.risk_badge(slide, T.MARGIN, Emu(5050000), c.get("overallRiskLevel", "UNKNOWN"), w=Emu(1800000), h=Emu(520000))
    if ctx.watermark:
        wm = T.textbox(slide, Emu(5200000), Emu(5100000), Emu(3400000), Emu(520000))
        wp = wm.text_frame.paragraphs[0]
        wp.alignment = 2  # right
        T._run(wp, str(ctx.watermark), 24, T.RGBColor(0x3A, 0x4F, 0x73), bold=True)


def _p_contents(prs, vm, ctx):
    L = vm["labels"]
    slide, top = _section(prs, ctx, L["contents"], L["contents_subtitle"])
    sec = L["section"]
    cards = [
        {"label": f"{sec} 1", "value": L["sec_executive"]},
        {"label": f"{sec} 2", "value": L["sec_russia"]},
        {"label": f"{sec} 3", "value": L["sec_international"]},
        {"label": f"{sec} 4", "value": L["sec_compliance"]},
        {"label": f"{sec} 5", "value": L["sec_solutions"]},
        {"label": f"{sec} 6", "value": L["sec_about"]},
    ]
    top = T.metric_cards(slide, top, cards, per_row=3)
    T.bullets(slide, top, vm["contents"]["sections"])


def _p_executive(prs, vm, ctx):
    L = vm["labels"]
    e = vm["executiveSummary"]
    slide, top = _section(prs, ctx, L["executive_summary"], f"{L['overall_risk']}: {e['overallRiskLevel']}")
    o = vm["overview"]
    c = vm["compliance"]
    cards = [
        {"label": L["overall_risk"], "value": e["overallRiskLevel"], "tone": T.RISK_COLORS.get(str(e["overallRiskLevel"]).upper(), T.NEUTRAL_GRAY)},
        {"label": L["m_ru_negative"], "value": o.get("negativeShareRu", "0%")},
        {"label": L["m_uae_negative"], "value": o.get("negativeShareUae", "0%")},
        {"label": L["m_compliance_matches"], "value": c.get("activeMatches", 0), "tone": T.DANGER if c.get("activeMatches") else T.NEUTRAL_GRAY},
    ]
    top = T.metric_cards(slide, top, cards, per_row=4)
    bullet_lines = [b for b in e.get("bullets", [])[:6] if b]
    warning = e.get("dataQualityWarning") if ctx.internal else None
    # Drop the warning if it merely repeats the last bullet (no duplication).
    if warning and bullet_lines and _norm(warning) == _norm(bullet_lines[-1]):
        warning = None
    # Stack sequentially by computed text height; bullets() returns the bottom Y
    # (incl. a safe gap), so the warning always sits below the list.
    top = T.bullets(slide, top, bullet_lines)
    if warning:
        T.note(slide, top, warning, "warning")


def _p_risk_matrix(prs, vm, ctx):
    L = vm["labels"]
    rm = vm["riskMatrix"]
    slide, top = _section(prs, ctx, L["compliance_risk_matrix"], rm["subject"])
    rows = [[r["area"], T.truncate(r["problems"], 60), r["level"], T.truncate(r["consequences"], 46)] for r in rm["rows"]]
    T.table(slide, top, [L["th_compliance_area"], L["th_problems_risks"], L["th_risk"], L["th_consequences"]], rows,
            col_widths=[0.26, 0.34, 0.12, 0.28])


def _p_overview(prs, vm, ctx):
    L = vm["labels"]
    o = vm["overview"]
    slide, top = _section(prs, ctx, L["digital_profile_overview"])
    cards = [
        {"label": L["m_ru_negative_share"], "value": o.get("negativeShareRu", "0%")},
        {"label": L["m_uae_negative_share"], "value": o.get("negativeShareUae", "0%")},
        {"label": L["m_search_neg_total"], "value": f"{o.get('searchNegative', 0)}/{o.get('searchTotal', 0)}"},
        _risk_card_value(o.get("overallRiskLevel", "UNKNOWN"), L),
    ]
    top = T.metric_cards(slide, top, cards, per_row=4)
    T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(1500000), L["profile_summary"], [
        f"{L['wikipedia_label']} {o.get('wikipediaStatus', '')}",
        T.truncate(o.get("complianceSummary", ""), 120),
    ])


# ===========================================================================
# region pages (generic across RU / international)
# ===========================================================================

def _rb(block_key: str, builder: Callable, title: str, subtitle: str | None = None) -> Callable:
    def page(prs, vm, ctx):
        blk = vm[block_key]
        slide, top = _section(prs, ctx, title.replace("{label}", blk["label"]), subtitle)
        T.risk_badge(slide, Emu(int(T.SLIDE_W) - int(T.MARGIN) - 1500000), Emu(250000), blk["riskLevel"])
        if not blk["present"]:
            T.no_data_card(
                slide, top,
                blk["noDataText"] or vm["labels"]["no_evidence_region"].format(label=blk["label"]),
            )
            return
        builder(slide, top, blk, vm, ctx)

    return page


def _b_summary(slide, top, blk, vm, ctx):
    L = vm["labels"]
    s = blk["summary"]
    cards = [
        {"label": L["m_organic_total"], "value": s.get("organicTotal", 0)},
        {"label": L["m_organic_negative"], "value": s.get("organicNegative", 0), "tone": T.DANGER},
        {"label": L["m_negative_share"], "value": s.get("organicNegativeShare", "0%")},
        _risk_card_value(blk["riskLevel"], L),
    ]
    top = T.metric_cards(slide, top, cards, per_row=4)
    cards2 = [
        {"label": L["m_suggestions_nt"], "value": s.get("suggestions", "0/0")},
        {"label": L["m_images_nt"], "value": s.get("images", "0/0")},
        {"label": L["m_videos_nt"], "value": s.get("videos", "0/0")},
        {"label": L["m_knowledge"], "value": s.get("knowledgeBlockStatus", "ABSENT")},
    ]
    top = T.metric_cards(slide, top, cards2, per_row=4)
    if blk["conclusion"]:
        T.note(slide, top, blk["conclusion"], "info")


def _b_organic(slide, top, blk, vm, ctx):
    L = vm["labels"]
    o = blk["organicOverview"]
    cards = [
        {"label": L["m_organic_total"], "value": o.get("organicTotal", 0)},
        {"label": L["m_negative"], "value": o.get("organicNegative", 0), "tone": T.DANGER},
        {"label": L["m_unique_neg_urls"], "value": o.get("uniqueNegativeUrls", 0)},
        {"label": L["m_negative_share"], "value": o.get("negativeShare", "0%")},
    ]
    top = T.metric_cards(slide, top, cards, per_row=4)
    if o.get("observedQueries"):
        T.bullets(slide, top, [L["observed_queries"]] + o["observedQueries"])


def _b_results(slide, top, blk, vm, ctx):
    L = vm["labels"]
    rows = [[x["provider"], x["rank"], x["domain"], T.truncate(x["title"], 46), x["classification"]] for x in blk["topResults"]]
    if rows:
        T.table(slide, top, [L["th_provider"], L["th_rank"], L["th_domain"], L["th_title"], L["th_class"]], rows,
                col_widths=[0.13, 0.08, 0.22, 0.37, 0.20])
    else:
        T.no_data_card(slide, top, L["nd_no_organic_region"])


def _b_themes(slide, top, blk, vm, ctx):
    L = vm["labels"]
    t = blk["themes"]
    themes = [f"{x['theme']} ({x['count']})" for x in t["topThemes"]]
    top = T.bullets(slide, top, [
        L["top_themes"] + " " + (", ".join(themes) or "—"),
        L["negative_domains"] + " " + (", ".join(t["negativeDomains"]) or "—"),
    ])
    rows = [[T.truncate(u["title"], 56), u["domain"], u["classification"]] for u in t["negativeUrls"]]
    if rows:
        T.table(slide, top, [L["th_title"], L["th_domain"], L["th_class"]], rows, col_widths=[0.5, 0.3, 0.2])
    else:
        T.no_data_card(slide, top, L["nd_no_negative_urls"])


def _serp_caption(slide, top: Emu, ss: dict, L: dict) -> None:
    box = T.textbox(slide, T.MARGIN, top, T.CONTENT_W, Emu(540000))
    tf = box.text_frame
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    T._run(p, ss.get("caption") or L["serp_snapshot_caption"], T.FS_NOTE, T.NEUTRAL_GRAY, italic=True)
    # Stage N1.2 — provenance line (real / mixed / mock / empty).
    source_note = ss.get("source_note")
    if source_note:
        snp = tf.add_paragraph()
        snp.alignment = PP_ALIGN.CENTER
        T._run(snp, source_note, T.FS_NOTE, T.NEUTRAL_GRAY)
    detail = " · ".join(x for x in [ss.get("query", ""), ss.get("generatedAt", "")] if x)
    if detail:
        sp = tf.add_paragraph()
        sp.alignment = PP_ALIGN.CENTER
        T._run(sp, detail, T.FS_FOOTER, T.NEUTRAL_GRAY)


def _place_serp_image(slide, top: Emu, ss: dict, L: dict) -> None:
    """Embed the ORION-style PNG: contain-scaled, centred, above the footer."""
    caption_reserve = 600000  # room for the caption + provenance line below the image
    gap = 90000
    avail_w = int(T.CONTENT_W)
    avail_top = int(top)
    avail_h = max(1, int(T.FOOTER_Y) - avail_top - caption_reserve - gap)

    stream = io.BytesIO(ss["image_bytes"])
    img_w = int(ss.get("width") or 0)
    img_h = int(ss.get("height") or 0)

    if img_w > 0 and img_h > 0:
        scale = min(avail_w / img_w, avail_h / img_h)
        draw_w = max(1, int(img_w * scale))
        draw_h = max(1, int(img_h * scale))
        left = Emu(int(T.MARGIN) + (avail_w - draw_w) // 2)
        slide.shapes.add_picture(stream, left, top, width=Emu(draw_w), height=Emu(draw_h))
        cap_top = Emu(avail_top + draw_h + gap)
    else:
        # Unknown native size: add by width, then clamp height if needed.
        pic = slide.shapes.add_picture(stream, T.MARGIN, top, width=Emu(avail_w))
        if int(pic.height) > avail_h:
            ratio = avail_h / int(pic.height)
            pic.width = Emu(int(int(pic.width) * ratio))
            pic.height = Emu(avail_h)
        pic.left = Emu(int(T.MARGIN) + (avail_w - int(pic.width)) // 2)
        pic.top = top
        cap_top = Emu(int(pic.top) + int(pic.height) + gap)

    _serp_caption(slide, cap_top, ss, L)


def _p_snapshots(prs, vm, ctx):
    """Search screens / snapshots page (Stage S1.5).

    If a synthetic ORION-style SERP snapshot exists, render the image almost
    full-width (contain-scaled, centred) under a localized title/subtitle, with a
    small synthetic-source caption. Otherwise fall back to the original
    informational card so the page (and the 50-slide count) never changes.
    The watermark is drawn by the page frame, so it stays consistent (draft shows
    through around the image; none never appears).
    """
    L = vm["labels"]
    ss = vm.get("serp_snapshot") or {}
    blk = vm.get("ru") or {}

    if ss.get("exists") and ss.get("image_bytes"):
        slide, top = _section(prs, ctx, ss.get("title") or L["search_screens_title"], ss.get("subtitle"))
        try:
            _place_serp_image(slide, top, ss, L)
            return
        except Exception:  # noqa: BLE001 - never crash the deck on an image issue
            T.no_data_card(slide, top, L["serp_snapshot_missing"])
            return

    # Fallback: original search-screens page (title + informational card).
    title = L["pg_search_screens"].replace("{label}", blk.get("label", ""))
    slide, top = _section(prs, ctx, title)
    summary = blk.get("summary") or {}
    T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(2100000), L["search_screens_title"], [
        L["knowledge_block_status"].format(status=summary.get("knowledgeBlockStatus", "ABSENT")),
        *L["snapshot_lines"],
    ])


def _b_suggestions(slide, top, blk, vm, ctx):
    L = vm["labels"]
    sg = blk["suggestions"]
    top = T.metric_cards(slide, top, [
        {"label": L["m_total"], "value": sg["total"]},
        {"label": L["m_negative"], "value": sg["negative"], "tone": T.DANGER},
    ], per_row=2)
    if sg["list"]:
        T.bullets(slide, top, sg["list"])
    else:
        T.no_data_card(slide, top, L["nd_no_suggestions"])


def _b_related(slide, top, blk, vm, ctx):
    L = vm["labels"]
    rq = blk["relatedQueries"]
    top = T.metric_cards(slide, top, [
        {"label": L["m_total"], "value": rq["total"]},
        {"label": L["m_negative"], "value": rq["negative"], "tone": T.DANGER},
    ], per_row=2)
    if rq["list"]:
        T.bullets(slide, top, rq["list"])
    else:
        T.no_data_card(slide, top, L["nd_no_related"])


def _b_images(slide, top, blk, vm, ctx):
    L = vm["labels"]
    im = blk["images"]
    top = T.metric_cards(slide, top, [
        {"label": L["m_images_total"], "value": im["total"]},
        {"label": L["m_negative"], "value": im["negative"], "tone": T.DANGER},
    ], per_row=2)
    rows = [[T.truncate(i["title"], 60), i["source"]] for i in im["items"]]
    if rows:
        T.table(slide, top, [L["th_image_title"], L["th_source"]], rows, col_widths=[0.65, 0.35])
    else:
        T.no_data_card(slide, top, L["nd_no_images"])


def _b_videos(slide, top, blk, vm, ctx):
    L = vm["labels"]
    vi = blk["videos"]
    top = T.metric_cards(slide, top, [
        {"label": L["m_videos_total"], "value": vi["total"]},
        {"label": L["m_negative"], "value": vi["negative"], "tone": T.DANGER},
    ], per_row=2)
    rows = [[T.truncate(v["title"], 60), v["source"]] for v in vi["items"]]
    if rows:
        T.table(slide, top, [L["th_video_title"], L["th_source"]], rows, col_widths=[0.65, 0.35])
    else:
        T.no_data_card(slide, top, L["nd_no_videos"])


def _b_media(slide, top, blk, vm, ctx):
    L = vm["labels"]
    im, vi = blk["images"], blk["videos"]
    top = T.metric_cards(slide, top, [
        {"label": L["m_images_nt"], "value": f"{im['negative']}/{im['total']}"},
        {"label": L["m_videos_nt"], "value": f"{vi['negative']}/{vi['total']}"},
    ], per_row=2)
    rows = [["Image", T.truncate(i["title"], 50), i["source"]] for i in im["items"]]
    rows += [["Video", T.truncate(v["title"], 50), v["source"]] for v in vi["items"]]
    if rows:
        T.table(slide, top, [L["th_type"], L["th_title"], L["th_source"]], rows, col_widths=[0.14, 0.56, 0.30])
    else:
        T.no_data_card(slide, top, L["nd_no_media"])


def _b_knowledge(slide, top, blk, vm, ctx):
    L = vm["labels"]
    kb = blk["knowledgeBlock"]
    if kb and kb.get("title"):
        T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(2000000), kb.get("title", L["knowledge_block_default"]), [
            f"{L['m_status']}: {kb.get('status', 'ABSENT')}",
            f"{L['th_source']}: {kb.get('source', '') or '—'}",
            T.truncate(kb.get("snippet", ""), 160),
        ])
    else:
        T.no_data_card(slide, top, L["no_knowledge_content"].format(status=(kb or {}).get("status", "ABSENT")))


def _b_wikipedia(slide, top, blk, vm, ctx):
    L = vm["labels"]
    w = blk["wikipedia"]
    if w.get("exists"):
        cards = [
            {"label": L["m_status"], "value": L["m_exists"], "tone": T.SUCCESS},
            {"label": L["m_language"], "value": w.get("language") or "—"},
            {"label": L["m_notability"], "value": w.get("notabilityScore", 0)},
        ]
        top = T.metric_cards(slide, top, cards, per_row=3)
        top = T.bullets(slide, top, [w.get("pageUrl", ""), w.get("conclusion", "")])
    else:
        T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(1500000), L["wiki_not_found_title"],
               list(L["wiki_not_found_lines"]), tone=T.WARNING)


def _b_wiki_knowledge(slide, top, blk, vm, ctx):
    L = vm["labels"]
    w = blk["wikipedia"]
    kb = blk["knowledgeBlock"]
    state = L["wiki_page_exists"] if w.get("exists") else L["wiki_no_page"]
    T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(1900000), L["wiki_knowledge_title"], [
        L["wiki_context_line"].format(state=state, lang=w.get("language") or "—"),
        L["wiki_kb_line"].format(status=(kb or {}).get("status", "ABSENT")),
        L["wiki_review_line"],
    ])


def _b_findings(slide, top, blk, vm, ctx):
    L = vm["labels"]
    rows = [[f["severity"], f["theme"], T.truncate(f["title"], 46), f["reviewStatus"], f["evidenceCount"]] for f in blk["riskFindings"]]
    if rows:
        T.table(slide, top, [L["th_severity"], L["th_theme"], L["th_finding"], L["th_review"], L["th_evidence"]], rows,
                col_widths=[0.14, 0.20, 0.38, 0.16, 0.12])
    else:
        T.no_data_card(slide, top, L["nd_no_findings_region"])


def _b_data_quality(slide, top, blk, vm, ctx):
    L = vm["labels"]
    dq = blk["dataQuality"]
    top = T.metric_cards(slide, top, [
        {"label": L["m_organic_evidence"], "value": dq.get("organic", 0)},
        {"label": L["m_surface_evidence"], "value": dq.get("surfaces", 0)},
    ], per_row=2)
    if ctx.internal:
        T.bullets(slide, top, dq.get("warnings") or [L["coverage_adequate_region"]])
    else:
        T.note(slide, top, L["coverage_on_request"], "disclaimer")


def _b_recommended(slide, top, blk, vm, ctx):
    L = vm["labels"]
    T.bullets(slide, top, blk.get("recommendedActions") or [L["expand_region_collection"]])


def _b_evidence(slide, top, blk, vm, ctx):
    L = vm["labels"]
    rows = [[T.truncate(e["title"], 50), e["domain"], e["provider"], e["classification"]] for e in blk["evidenceAppendix"]]
    if rows:
        T.table(slide, top, [L["th_title"], L["th_domain"], L["th_provider"], L["th_class"]], rows, col_widths=[0.42, 0.26, 0.16, 0.16])
    else:
        T.no_data_card(slide, top, L["nd_no_evidence_region"])


def _b_conclusion(slide, top, blk, vm, ctx):
    L = vm["labels"]
    T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(1700000), f"{L['region_risk']}: {blk['riskLevel']}", [
        blk["conclusion"] or L["interim_conclusion_fallback"],
    ], tone=T.RISK_COLORS.get(str(blk["riskLevel"]).upper(), T.NEUTRAL_GRAY))


# ===========================================================================
# 32-36 compliance (R1 enterprise due diligence layout)
# ===========================================================================

def _p_compliance_overview(prs, vm, ctx):
    L = vm["labels"]
    c = vm["compliance"]
    slide, top = _section(prs, ctx, L["compliance_overview_title"])
    cards = [
        {"label": L["m_total_hits"], "value": c.get("totalHits", 0), "tone": T.ACCENT if c.get("totalHits") else T.NEUTRAL_GRAY},
        {"label": L["m_pending_review"], "value": c.get("pendingHits", 0), "tone": T.WARNING if c.get("pendingHits") else T.NEUTRAL_GRAY},
        {"label": L["m_confirmed_matches"], "value": c.get("confirmedHits", 0), "tone": T.DANGER if c.get("confirmedHits") else T.NEUTRAL_GRAY},
        {"label": L["m_false_positives"], "value": c.get("falsePositives", 0), "tone": T.SUCCESS if c.get("falsePositives") else T.NEUTRAL_GRAY},
    ]
    top = T.metric_cards(slide, top, cards, per_row=4)
    rows = [[p["provider"], p["status"], p["sourceType"]] for p in c.get("providerTable", [])]
    if rows:
        top = T.polished_table(slide, top, [L["th_provider"], L["th_provider_status"], L["th_source_type"]], rows,
                               col_widths=[0.34, 0.33, 0.33])
    else:
        top = T.no_data_card(slide, top, L["nd_no_compliance_hits"])
    T.warning_card(slide, top, c.get("reviewRequiredWarning") or L["warn_potential_review"])


def _p_compliance_risk_types(prs, vm, ctx):
    L = vm["labels"]
    c = vm["compliance"]
    slide, top = _section(prs, ctx, L["compliance_risk_types_title"])
    breakdown = c.get("riskTypeBreakdown") or []
    rows = [
        [b["riskType"], b["total"], b["pending"], b["confirmed"], b["falsePositive"]]
        for b in breakdown
    ]
    if rows:
        T.polished_table(slide, top, [L["th_risk_type"], L["th_total"], L["th_pending"], L["th_confirmed"], L["th_false_positive"]],
                         rows, col_widths=[0.28, 0.18, 0.18, 0.18, 0.18])
    else:
        T.no_data_card(slide, top, L["nd_no_risk_type_hits"])


def _p_compliance_top_matches(prs, vm, ctx):
    L = vm["labels"]
    c = vm["compliance"]
    slide, top = _section(prs, ctx, L["compliance_top_matches_title"])
    hits = c.get("topHits") or []
    rows = [
        [h["provider"], h["matchedName"], h["riskTypes"], h["score"], h["confidence"], h["reviewStatus"], h["source"]]
        for h in hits
    ]
    if rows:
        top = T.polished_table(
            slide, top,
            [L["th_provider"], L["th_matched_name"], L["th_risk_type"], L["th_score"], L["th_confidence"], L["th_review"], L["th_source"]],
            rows, max_rows=8, col_widths=[0.14, 0.20, 0.16, 0.08, 0.12, 0.16, 0.14],
        )
        if any("manual" in str(h.get("source", "")).lower() or "ручн" in str(h.get("source", "")).lower() for h in hits):
            T.source_note(slide, top, L["manual_import_note"])
    else:
        T.no_data_card(slide, top, L["nd_no_compliance_hits"])


def _p_compliance_review_quality(prs, vm, ctx):
    L = vm["labels"]
    c = vm["compliance"]
    slide, top = _section(prs, ctx, L["compliance_review_quality_title"])
    warnings = [w for w in (c.get("dataQualityWarnings") or []) if w]
    if c.get("pendingHits", 0) > 0:
        warnings.insert(0, L["lang_requires_review"])
    not_configured = [p["provider"] for p in c.get("providerTable", []) if L["src_not_configured"] in str(p.get("sourceType", ""))]
    if not_configured:
        warnings.append(f"{L['warn_provider_not_queried']} ({', '.join(not_configured[:4])})")
    if not warnings:
        warnings = [L["dq_coverage_adequate"], L["warn_not_legal"]]
    top = T.bullets(slide, top, warnings[:8])
    T.warning_card(slide, top, L["warn_not_legal"])


def _p_compliance_findings(prs, vm, ctx):
    L = vm["labels"]
    c = vm["compliance"]
    f = vm["finalConclusion"]
    slide, top = _section(prs, ctx, L["compliance_risk_findings_title"], f"{L['overall_risk']}: {f.get('overallRiskLevel', 'UNKNOWN')}")
    rows = [
        [fnd["severity"], T.truncate(fnd["title"], 52), fnd["reviewStatus"], fnd.get("evidenceCount", 0)]
        for fnd in c.get("findings", [])
    ]
    if rows:
        top = T.polished_table(slide, top, [L["th_severity"], L["th_finding"], L["th_review"], L["th_evidence"]], rows,
                               col_widths=[0.14, 0.52, 0.22, 0.12])
    else:
        top = T.no_data_card(slide, top, L["nd_no_compliance_findings"])
    if c.get("excludedFalsePositives", 0) > 0:
        top = T.note(slide, top, L["finding_excluded_fp"], "info")
    themes = ", ".join(f"{t['theme']} ({t['count']})" for t in f.get("topThemes", [])) or "—"
    top = T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(900000), L["highest_risk_themes"], [themes]) or top
    if f.get("recommendedActions"):
        T.bullets(slide, Emu(int(top) + 980000) if top else top, list(f.get("recommendedActions", []))[:4])
    T.note(slide, top, L["warn_not_legal"], "disclaimer")


def _p_final(prs, vm, ctx):
    """Legacy final slide — kept for v2 parity; v3 folds conclusion into compliance findings."""
    L = vm["labels"]
    f = vm["finalConclusion"]
    slide, top = _section(prs, ctx, L["final_title"], f"{L['overall_risk']}: {f['overallRiskLevel']}")
    T.risk_badge(slide, Emu(int(T.SLIDE_W) - int(T.MARGIN) - 1700000), Emu(250000), f["overallRiskLevel"], w=Emu(1700000))
    themes = ", ".join(f"{t['theme']} ({t['count']})" for t in f.get("topThemes", [])) or "—"
    top = T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(1100000), L["highest_risk_themes"], [themes]) or top
    top = T.bullets(slide, Emu(int(top) + 1180000) if top else top, list(f.get("recommendedActions", []))[:5])
    if ctx.internal and f.get("missingSections"):
        T.note(slide, top, L["missing_sections_inline"].format(items=", ".join(f["missingSections"])), "warning")


# ===========================================================================
# final commercial block (37+)
# ===========================================================================

def _p_offer_cover(prs, vm, ctx):
    ob = vm["offerBlock"]
    slide = T.blank_slide(prs)
    T.set_bg(slide, T.BRAND_PRIMARY)
    rule = slide.shapes.add_shape(T.RECT, T.MARGIN, Emu(2300000), Emu(2200000), Emu(54864))
    rule.fill.solid()
    rule.fill.fore_color.rgb = T.ACCENT
    rule.line.fill.background()
    box = T.textbox(slide, T.MARGIN, Emu(2500000), T.CONTENT_W, Emu(2200000))
    tf = box.text_frame
    T._run(tf.paragraphs[0], ob["cover"]["title"], T.FS_COVER_TITLE - 6, T.WHITE, bold=True)
    T._run(tf.add_paragraph(), ob["cover"]["subtitle"], T.FS_SUBTITLE + 2, T.ACCENT_SOFT)
    T._run(tf.add_paragraph(), ob["cover"]["brand"], T.FS_SUBTITLE, T.NEUTRAL_GRAY)


def _p_product_overview(prs, vm, ctx):
    L = vm["labels"]
    ob = vm["offerBlock"]["productOverview"]
    slide, top = _section(prs, ctx, L["offer_product_overview"], vm["offerBlock"]["cover"]["brand"])
    top = T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(1200000), L["offer_what_we_do"], [T.truncate(ob.get("description", ""), 220)]) or top
    top = Emu(int(top) + 1280000)
    inc = ob.get("includedItems", [])
    if inc:
        top = T.metric_cards(slide, top, [{"label": L["offer_includes"], "value": T.truncate(inc[0], 24), "tone": T.ACCENT}], per_row=1)
        top = T.bullets(slide, top, inc[1:4])
    T.note(slide, top, ob.get("audienceNote", ""), "info")


def _p_pricing_summary(prs, vm, ctx):
    L = vm["labels"]
    sols = vm["offerBlock"]["solutions"]
    slide, top = _section(prs, ctx, L["offer_solutions_pricing"], L["offer_indicative"])
    cards = [{"label": T.truncate(s["title"], 28), "value": s["price"], "tone": T.ACCENT} for s in sols[:3]]
    top = T.metric_cards(slide, top, cards, per_row=3)
    rows = [[T.truncate(s["title"], 36), s["duration"], s["price"]] for s in sols]
    if rows:
        top = T.polished_table(slide, top, [L["th_solution"], L["th_duration"], L["th_price"]], rows, col_widths=[0.5, 0.25, 0.25])
    T.note(slide, top, vm["offerBlock"]["solutions"][0].get("pricingNotes", "") if sols else "", "disclaimer")


def _p_solution_objective(prs, vm, ctx, idx: int):
    L = vm["labels"]
    s = _solution(vm, idx)
    slide, top = _section(prs, ctx, s["title"], s["subtitle"])
    top = T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(950000), L["offer_objective"], [T.truncate(s["objective"], 200)]) or top
    top = Emu(int(top) + 1030000)
    top = T.bullets(slide, top, [L["offer_included_work"]] + s["includedItems"][:5])
    if s["deliverables"]:
        top = T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(850000), L["offer_deliverables"], s["deliverables"][:4]) or top


def _p_solution_workplan(prs, vm, ctx, idx: int):
    L = vm["labels"]
    s = _solution(vm, idx)
    slide, top = _section(prs, ctx, s["title"] + L["offer_workplan_suffix"], L["offer_duration"].format(d=s["duration"]))
    steps = s["workPlan"] or [L["offer_workplan_default"]]
    top = T.step_cards(slide, top, steps[:5], per_row=1)
    if s["expectedResults"]:
        T.bullets(slide, top, [L["offer_expected_results"]] + s["expectedResults"][:4])


def _p_solution_pricing(prs, vm, ctx, idx: int):
    L = vm["labels"]
    s = _solution(vm, idx)
    slide, top = _section(prs, ctx, s["title"] + L["offer_pricing_suffix"], s["subtitle"])
    top = T.metric_cards(slide, top, [{"label": L["m_package_price"], "value": s["price"], "tone": T.ACCENT}], per_row=1)
    top = T.bullets(slide, top, [L["offer_included"]] + s["includedItems"][:5])
    T.note(slide, top, s.get("pricingNotes", ""), "disclaimer")


def _p_process(prs, vm, ctx):
    L = vm["labels"]
    ob = vm["offerBlock"]["process"]
    slide, top = _section(prs, ctx, L["offer_process_title"], L["offer_process_subtitle"])
    steps = ob.get("steps", []) or list(L["op_process_bullets"])
    top = T.step_cards(slide, top, steps[:5], per_row=1)
    T.note(slide, top, L["offer_value"], "info")


def _p_about(prs, vm, ctx):
    L = vm["labels"]
    ob = vm["offerBlock"]["contact"]
    slide, top = _section(prs, ctx, L["offer_about_title"], ob.get("company", ""))
    top = T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(1300000), L["offer_next_step"], [
        ob.get("cta", L["offer_contact_default"]),
        L["offer_email"].format(email=ob.get("email", "")),
        L["offer_website"].format(website=ob.get("website", "")),
    ], tone=T.ACCENT) or top
    top = Emu(int(top) + 1380000)
    for d in ob.get("disclaimers", []):
        top = T.note(slide, top, d, "disclaimer")


def _solution(vm, idx: int) -> dict:
    sols = vm["offerBlock"]["solutions"]
    if idx < len(sols):
        return sols[idx]
    return {
        "title": f"Solution {idx + 1}", "subtitle": "", "objective": "", "price": "—",
        "duration": "—", "includedItems": [], "deliverables": [], "expectedResults": [],
        "workPlan": [], "pricingNotes": "",
    }


# ===========================================================================
# orchestration
# ===========================================================================

def build_report_v3(
    report_json: dict,
    prs,
    data_root: str,
    warnings: list[str],
    audience: str = "internal",
    watermark_mode: str = "draft",
) -> None:
    vm, vm_warnings = build_view_model_v3(report_json, audience)
    warnings.extend(vm_warnings)
    L = vm["labels"]
    T.set_table_strings(L["showing_top"])

    brand = vm["offerBlock"]["cover"]["brand"]
    meta_wm = vm["meta"].get("watermark")
    effective_wm = None if str(watermark_mode).lower() == "none" else meta_wm
    ctx = Ctx(brand=brand, watermark=effective_wm, internal=(str(audience).lower() != "client"))

    ru_pages = [
        _rb("ru", _b_summary, L["pg_audit_summary"]),
        _rb("ru", _b_organic, L["pg_organic_overview"]),
        _rb("ru", _b_results, L["pg_top_results"]),
        _rb("ru", _b_themes, L["pg_neg_publications"]),
        _p_snapshots,
        _rb("ru", _b_suggestions, L["pg_suggestions"]),
        _rb("ru", _b_related, L["pg_related_queries"]),
        _rb("ru", _b_images, L["pg_images"]),
        _rb("ru", _b_videos, L["pg_videos"]),
        _rb("ru", _b_knowledge, L["pg_knowledge_block"]),
        _rb("ru", _b_wikipedia, L["pg_wikipedia"]),
        _rb("ru", _b_findings, L["pg_risk_findings"]),
        _rb("ru", _b_data_quality, L["pg_data_quality"]),
        _rb("ru", _b_recommended, L["pg_recommended"]),
        _rb("ru", _b_evidence, L["pg_evidence_appendix"]),
        _rb("ru", _b_conclusion, L["pg_interim_conclusion"]),
    ]
    intl_pages = [
        _rb("intl", _b_summary, L["pg_audit_summary"]),
        _rb("intl", _b_organic, L["pg_organic_overview"]),
        _rb("intl", _b_results, L["pg_top_results"]),
        _rb("intl", _b_themes, L["pg_neg_themes"]),
        _rb("intl", _b_suggestions, L["pg_suggestions"]),
        _rb("intl", _b_media, L["pg_images_videos"]),
        _rb("intl", _b_wiki_knowledge, L["pg_wiki_knowledge"]),
        _rb("intl", _b_findings, L["pg_risk_findings"]),
        _rb("intl", _b_data_quality, L["pg_data_quality"]),
        _rb("intl", _b_conclusion, L["pg_conclusion"]),
    ]
    offer_pages = [
        _p_offer_cover,
        _p_product_overview,
        _p_pricing_summary,
        lambda prs_, vm_, ctx_: _p_solution_objective(prs_, vm_, ctx_, 0),
        lambda prs_, vm_, ctx_: _p_solution_workplan(prs_, vm_, ctx_, 0),
        lambda prs_, vm_, ctx_: _p_solution_pricing(prs_, vm_, ctx_, 0),
        lambda prs_, vm_, ctx_: _p_solution_objective(prs_, vm_, ctx_, 1),
        lambda prs_, vm_, ctx_: _p_solution_workplan(prs_, vm_, ctx_, 1),
        lambda prs_, vm_, ctx_: _p_solution_pricing(prs_, vm_, ctx_, 1),
        lambda prs_, vm_, ctx_: _p_solution_objective(prs_, vm_, ctx_, 2),
        lambda prs_, vm_, ctx_: _p_solution_workplan(prs_, vm_, ctx_, 2),
        lambda prs_, vm_, ctx_: _p_solution_pricing(prs_, vm_, ctx_, 2),
        _p_process,
        _p_about,
    ]

    builders: list[Callable] = [
        _p_cover, _p_contents, _p_executive, _p_risk_matrix, _p_overview,
        *ru_pages,
        *intl_pages,
        _p_compliance_overview,
        _p_compliance_risk_types,
        _p_compliance_top_matches,
        _p_compliance_review_quality,
        _p_compliance_findings,
        *offer_pages,
    ]

    ctx.total = len(builders)
    for i, fn in enumerate(builders):
        ctx.page = i + 1
        try:
            fn(prs, vm, ctx)
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Slide {ctx.page} failed: {exc}")
            try:
                slide, top = _section(prs, ctx, L["section"])
                T.no_data_card(slide, top, L["section_render_error"].format(error=exc))
            except Exception:  # noqa: BLE001
                pass
