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

from typing import Any, Callable

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


def _risk_card_value(level: str) -> Any:
    return {"label": "Risk level", "value": str(level or "UNKNOWN"), "tone": T.RISK_COLORS.get(str(level or "UNKNOWN").upper(), T.NEUTRAL_GRAY)}


# ===========================================================================
# 1-5 front matter
# ===========================================================================

def _p_cover(prs, vm, ctx):
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
    T._run(tf.paragraphs[0], "Digital Profile", T.FS_COVER_TITLE, T.WHITE, bold=True)
    T._run(tf.add_paragraph(), ob["cover"].get("subtitle", ""), T.FS_SUBTITLE + 3, T.ACCENT_SOFT)
    p = tf.add_paragraph()
    T._run(p, c.get("subjectFullName", ""), 26, T.WHITE, bold=True)
    p.space_before = Pt(14)
    T._run(tf.add_paragraph(), f"Audit date: {c.get('auditDate', '')}", T.FS_SUBTITLE, T.ACCENT_SOFT)
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
    slide, top = _section(prs, ctx, "Contents", "What this report covers")
    cards = [
        {"label": "Section 1", "value": "Executive"},
        {"label": "Section 2", "value": "Russia"},
        {"label": "Section 3", "value": "International"},
        {"label": "Section 4", "value": "Compliance"},
        {"label": "Section 5", "value": "Solutions"},
        {"label": "Section 6", "value": "About"},
    ]
    top = T.metric_cards(slide, top, cards, per_row=3)
    T.bullets(slide, top, vm["contents"]["sections"])


def _p_executive(prs, vm, ctx):
    e = vm["executiveSummary"]
    slide, top = _section(prs, ctx, "Executive summary", f"Overall risk: {e['overallRiskLevel']}")
    o = vm["overview"]
    c = vm["compliance"]
    cards = [
        {"label": "Overall risk", "value": e["overallRiskLevel"], "tone": T.RISK_COLORS.get(str(e["overallRiskLevel"]).upper(), T.NEUTRAL_GRAY)},
        {"label": "RU negative", "value": o.get("negativeShareRu", "0%")},
        {"label": "UAE negative", "value": o.get("negativeShareUae", "0%")},
        {"label": "Compliance matches", "value": c.get("activeMatches", 0), "tone": T.DANGER if c.get("activeMatches") else T.NEUTRAL_GRAY},
    ]
    top = T.metric_cards(slide, top, cards, per_row=4)
    top = T.bullets(slide, top, e.get("bullets", [])[:6])
    if ctx.internal and e.get("dataQualityWarning"):
        T.note(slide, top, e["dataQualityWarning"], "warning")


def _p_risk_matrix(prs, vm, ctx):
    rm = vm["riskMatrix"]
    slide, top = _section(prs, ctx, "Compliance risk matrix", rm["subject"])
    rows = [[r["area"], T.truncate(r["problems"], 60), r["level"], T.truncate(r["consequences"], 46)] for r in rm["rows"]]
    T.table(slide, top, ["Compliance area", "Problems & risks", "Risk", "Possible consequences"], rows,
            col_widths=[0.26, 0.34, 0.12, 0.28])


def _p_overview(prs, vm, ctx):
    o = vm["overview"]
    slide, top = _section(prs, ctx, "Digital profile overview")
    cards = [
        {"label": "RU negative share", "value": o.get("negativeShareRu", "0%")},
        {"label": "UAE negative share", "value": o.get("negativeShareUae", "0%")},
        {"label": "Search (neg/total)", "value": f"{o.get('searchNegative', 0)}/{o.get('searchTotal', 0)}"},
        _risk_card_value(o.get("overallRiskLevel", "UNKNOWN")),
    ]
    top = T.metric_cards(slide, top, cards, per_row=4)
    T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(1500000), "Profile summary", [
        f"Wikipedia: {o.get('wikipediaStatus', '')}",
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
            T.no_data_card(slide, top, blk["noDataText"] or "No evidence collected for this region.")
            return
        builder(slide, top, blk, vm, ctx)

    return page


def _b_summary(slide, top, blk, vm, ctx):
    s = blk["summary"]
    cards = [
        {"label": "Organic total", "value": s.get("organicTotal", 0)},
        {"label": "Organic negative", "value": s.get("organicNegative", 0), "tone": T.DANGER},
        {"label": "Negative share", "value": s.get("organicNegativeShare", "0%")},
        _risk_card_value(blk["riskLevel"]),
    ]
    top = T.metric_cards(slide, top, cards, per_row=4)
    cards2 = [
        {"label": "Suggestions n/t", "value": s.get("suggestions", "0/0")},
        {"label": "Images n/t", "value": s.get("images", "0/0")},
        {"label": "Videos n/t", "value": s.get("videos", "0/0")},
        {"label": "Knowledge", "value": s.get("knowledgeBlockStatus", "ABSENT")},
    ]
    top = T.metric_cards(slide, top, cards2, per_row=4)
    if blk["conclusion"]:
        T.note(slide, top, blk["conclusion"], "info")


def _b_organic(slide, top, blk, vm, ctx):
    o = blk["organicOverview"]
    cards = [
        {"label": "Organic total", "value": o.get("organicTotal", 0)},
        {"label": "Negative", "value": o.get("organicNegative", 0), "tone": T.DANGER},
        {"label": "Unique neg URLs", "value": o.get("uniqueNegativeUrls", 0)},
        {"label": "Negative share", "value": o.get("negativeShare", "0%")},
    ]
    top = T.metric_cards(slide, top, cards, per_row=4)
    if o.get("observedQueries"):
        T.bullets(slide, top, ["Observed suggestions / queries:"] + o["observedQueries"])


def _b_results(slide, top, blk, vm, ctx):
    rows = [[x["provider"], x["rank"], x["domain"], T.truncate(x["title"], 46), x["classification"]] for x in blk["topResults"]]
    if rows:
        T.table(slide, top, ["Provider", "Rank", "Domain", "Title", "Class"], rows,
                col_widths=[0.13, 0.08, 0.22, 0.37, 0.20])
    else:
        T.no_data_card(slide, top, "No organic results collected for this region.")


def _b_themes(slide, top, blk, vm, ctx):
    t = blk["themes"]
    themes = [f"{x['theme']} ({x['count']})" for x in t["topThemes"]]
    top = T.bullets(slide, top, [
        "Top themes: " + (", ".join(themes) or "—"),
        "Negative domains: " + (", ".join(t["negativeDomains"]) or "—"),
    ])
    rows = [[T.truncate(u["title"], 56), u["domain"], u["classification"]] for u in t["negativeUrls"]]
    if rows:
        T.table(slide, top, ["Title", "Domain", "Class"], rows, col_widths=[0.5, 0.3, 0.2])
    else:
        T.no_data_card(slide, top, "No negative URLs detected.")


def _b_snapshots(slide, top, blk, vm, ctx):
    T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(2100000), "Search screens & snapshots", [
        f"Knowledge block status: {blk['summary'].get('knowledgeBlockStatus', 'ABSENT')}.",
        "Screenshot evidence is shown where captured and stored privately.",
        "Synthetic snapshots are generated from API data — they are NOT live SERP screenshots.",
        "Live browser automation / scraping is not used by this audit.",
    ])


def _b_suggestions(slide, top, blk, vm, ctx):
    sg = blk["suggestions"]
    top = T.metric_cards(slide, top, [
        {"label": "Total", "value": sg["total"]},
        {"label": "Negative", "value": sg["negative"], "tone": T.DANGER},
    ], per_row=2)
    if sg["list"]:
        T.bullets(slide, top, sg["list"])
    else:
        T.no_data_card(slide, top, "No suggestions collected for this region.")


def _b_related(slide, top, blk, vm, ctx):
    rq = blk["relatedQueries"]
    top = T.metric_cards(slide, top, [
        {"label": "Total", "value": rq["total"]},
        {"label": "Negative", "value": rq["negative"], "tone": T.DANGER},
    ], per_row=2)
    if rq["list"]:
        T.bullets(slide, top, rq["list"])
    else:
        T.no_data_card(slide, top, "No related queries collected for this region.")


def _b_images(slide, top, blk, vm, ctx):
    im = blk["images"]
    top = T.metric_cards(slide, top, [
        {"label": "Images total", "value": im["total"]},
        {"label": "Negative", "value": im["negative"], "tone": T.DANGER},
    ], per_row=2)
    rows = [[T.truncate(i["title"], 60), i["source"]] for i in im["items"]]
    if rows:
        T.table(slide, top, ["Image title", "Source"], rows, col_widths=[0.65, 0.35])
    else:
        T.no_data_card(slide, top, "No image results collected for this region.")


def _b_videos(slide, top, blk, vm, ctx):
    vi = blk["videos"]
    top = T.metric_cards(slide, top, [
        {"label": "Videos total", "value": vi["total"]},
        {"label": "Negative", "value": vi["negative"], "tone": T.DANGER},
    ], per_row=2)
    rows = [[T.truncate(v["title"], 60), v["source"]] for v in vi["items"]]
    if rows:
        T.table(slide, top, ["Video title", "Source"], rows, col_widths=[0.65, 0.35])
    else:
        T.no_data_card(slide, top, "No video results collected for this region.")


def _b_media(slide, top, blk, vm, ctx):
    im, vi = blk["images"], blk["videos"]
    top = T.metric_cards(slide, top, [
        {"label": "Images n/t", "value": f"{im['negative']}/{im['total']}"},
        {"label": "Videos n/t", "value": f"{vi['negative']}/{vi['total']}"},
    ], per_row=2)
    rows = [["Image", T.truncate(i["title"], 50), i["source"]] for i in im["items"]]
    rows += [["Video", T.truncate(v["title"], 50), v["source"]] for v in vi["items"]]
    if rows:
        T.table(slide, top, ["Type", "Title", "Source"], rows, col_widths=[0.14, 0.56, 0.30])
    else:
        T.no_data_card(slide, top, "No image/video results collected for this region.")


def _b_knowledge(slide, top, blk, vm, ctx):
    kb = blk["knowledgeBlock"]
    if kb and kb.get("title"):
        T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(2000000), kb.get("title", "Knowledge block"), [
            f"Status: {kb.get('status', 'ABSENT')}",
            f"Source: {kb.get('source', '') or '—'}",
            T.truncate(kb.get("snippet", ""), 160),
        ])
    else:
        T.no_data_card(slide, top, f"Knowledge block status: {(kb or {}).get('status', 'ABSENT')}. No content collected.")


def _b_wikipedia(slide, top, blk, vm, ctx):
    w = blk["wikipedia"]
    if w.get("exists"):
        cards = [
            {"label": "Status", "value": "Exists", "tone": T.SUCCESS},
            {"label": "Language", "value": w.get("language") or "—"},
            {"label": "Notability", "value": w.get("notabilityScore", 0)},
        ]
        top = T.metric_cards(slide, top, cards, per_row=3)
        top = T.bullets(slide, top, [w.get("pageUrl", ""), w.get("conclusion", "")])
    else:
        T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(1500000), "Wikipedia article not found", [
            "Absence of a controlled authoritative profile.",
            "Treated as a low/medium profile risk — NOT an adverse fact.",
        ], tone=T.WARNING)


def _b_wiki_knowledge(slide, top, blk, vm, ctx):
    w = blk["wikipedia"]
    kb = blk["knowledgeBlock"]
    T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(1900000), "Wikipedia / knowledge context", [
        f"Wikipedia: {'page exists' if w.get('exists') else 'no page found'} (language: {w.get('language') or '—'}).",
        f"Knowledge block status: {(kb or {}).get('status', 'ABSENT')}.",
        "Relevant language versions are reviewed where available; no data is treated as neutral.",
    ])


def _b_findings(slide, top, blk, vm, ctx):
    rows = [[f["severity"], f["theme"], T.truncate(f["title"], 46), f["reviewStatus"], f["evidenceCount"]] for f in blk["riskFindings"]]
    if rows:
        T.table(slide, top, ["Severity", "Theme", "Finding", "Review", "Evidence"], rows,
                col_widths=[0.14, 0.20, 0.38, 0.16, 0.12])
    else:
        T.no_data_card(slide, top, "No risk findings for this region. Run the Risk Classifier to populate.")


def _b_data_quality(slide, top, blk, vm, ctx):
    dq = blk["dataQuality"]
    top = T.metric_cards(slide, top, [
        {"label": "Organic evidence", "value": dq.get("organic", 0)},
        {"label": "Surface evidence", "value": dq.get("surfaces", 0)},
    ], per_row=2)
    if ctx.internal:
        T.bullets(slide, top, dq.get("warnings") or ["Evidence coverage is adequate for a preliminary regional assessment."])
    else:
        T.note(slide, top, "Evidence coverage summary available on request.", "disclaimer")


def _b_recommended(slide, top, blk, vm, ctx):
    T.bullets(slide, top, blk.get("recommendedActions") or ["Expand data collection for this region."])


def _b_evidence(slide, top, blk, vm, ctx):
    rows = [[T.truncate(e["title"], 50), e["domain"], e["provider"], e["classification"]] for e in blk["evidenceAppendix"]]
    if rows:
        T.table(slide, top, ["Title", "Domain", "Provider", "Class"], rows, col_widths=[0.42, 0.26, 0.16, 0.16])
    else:
        T.no_data_card(slide, top, "No evidence to list for this region.")


def _b_conclusion(slide, top, blk, vm, ctx):
    T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(1700000), f"Region risk: {blk['riskLevel']}", [
        blk["conclusion"] or "Region assessment is preliminary and requires manual confirmation.",
    ], tone=T.RISK_COLORS.get(str(blk["riskLevel"]).upper(), T.NEUTRAL_GRAY))


# ===========================================================================
# 32-36 compliance + final
# ===========================================================================

def _p_compliance_overview(prs, vm, ctx):
    c = vm["compliance"]
    slide, top = _section(prs, ctx, "Compliance databases — overview")
    cards = [
        {"label": "Active matches", "value": c["activeMatches"], "tone": T.DANGER if c["activeMatches"] else T.NEUTRAL_GRAY},
        {"label": "Sanctions", "value": c["sanctionsMatches"], "tone": T.DANGER if c["sanctionsMatches"] else T.NEUTRAL_GRAY},
        {"label": "PEP / RCA", "value": f"{c['pepMatches']}/{c['rcaMatches']}"},
        {"label": "Adverse media", "value": c["adverseMediaMatches"]},
    ]
    top = T.metric_cards(slide, top, cards, per_row=4)
    top = T.bullets(slide, top, ["Providers checked: " + (", ".join(c["providersChecked"]) or "—")])
    if c.get("conclusion"):
        T.note(slide, top, c["conclusion"], "info")


def _p_compliance_provider(prs, vm, ctx, key: str, title: str):
    c = vm["compliance"]
    slide, top = _section(prs, ctx, title)
    rows = [[r["provider"], r["importMethod"], r["matchType"], r["score"]] for r in c[key]]
    if rows:
        T.table(slide, top, ["Provider", "Source method", "Category", "Score"], rows, col_widths=[0.3, 0.3, 0.25, 0.15])
    else:
        T.no_data_card(slide, top, "No screening records for these providers (manual import or official API required).")


def _p_compliance_findings(prs, vm, ctx):
    c = vm["compliance"]
    slide, top = _section(prs, ctx, "Compliance database — risk findings")
    rows = [[f["severity"], f["theme"], T.truncate(f["title"], 46), f["reviewStatus"], f["evidenceCount"]] for f in c["findings"]]
    if rows:
        T.table(slide, top, ["Severity", "Theme", "Finding", "Review", "Evidence"], rows,
                col_widths=[0.14, 0.20, 0.38, 0.16, 0.12])
    else:
        T.no_data_card(slide, top, "No compliance-database risk findings recorded.")


def _p_final(prs, vm, ctx):
    f = vm["finalConclusion"]
    slide, top = _section(prs, ctx, "Final dynamic audit conclusion", f"Overall risk: {f['overallRiskLevel']}")
    T.risk_badge(slide, Emu(int(T.SLIDE_W) - int(T.MARGIN) - 1700000), Emu(250000), f["overallRiskLevel"], w=Emu(1700000))
    themes = ", ".join(f"{t['theme']} ({t['count']})" for t in f.get("topThemes", [])) or "—"
    top = T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(1100000), "Highest risk themes", [themes]) or top
    top = T.bullets(slide, Emu(int(top) + 1180000) if top else top, list(f.get("recommendedActions", []))[:5])
    if ctx.internal and f.get("missingSections"):
        T.note(slide, top, "Missing sections: " + ", ".join(f["missingSections"]), "warning")


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
    ob = vm["offerBlock"]["productOverview"]
    slide, top = _section(prs, ctx, "Product overview", vm["offerBlock"]["cover"]["brand"])
    top = T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(1300000), "What we do", [T.truncate(ob.get("description", ""), 220)]) or top
    top = Emu(int(top) + 1380000)
    top = T.bullets(slide, top, ["Includes: " + ", ".join(ob.get("includedItems", []))])
    T.note(slide, top, ob.get("audienceNote", ""), "info")


def _p_pricing_summary(prs, vm, ctx):
    sols = vm["offerBlock"]["solutions"]
    slide, top = _section(prs, ctx, "Solutions & pricing — at a glance", "Indicative packages")
    cards = [{"label": T.truncate(s["title"], 28), "value": s["price"], "tone": T.ACCENT} for s in sols[:4]]
    top = T.metric_cards(slide, top, cards, per_row=max(1, len(cards)))
    rows = [[T.truncate(s["title"], 36), s["duration"], s["price"]] for s in sols]
    if rows:
        top = T.table(slide, top, ["Solution", "Duration", "Price"], rows, col_widths=[0.5, 0.25, 0.25])
    T.note(slide, top, vm["offerBlock"]["solutions"][0].get("pricingNotes", "") if sols else "", "disclaimer")


def _p_solution_objective(prs, vm, ctx, idx: int):
    s = _solution(vm, idx)
    slide, top = _section(prs, ctx, s["title"], s["subtitle"])
    top = T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(1000000), "Objective", [T.truncate(s["objective"], 200)]) or top
    top = Emu(int(top) + 1080000)
    top = T.bullets(slide, top, ["Included work:"] + s["includedItems"])
    if s["deliverables"]:
        T.bullets(slide, top, ["Deliverables:"] + s["deliverables"])


def _p_solution_workplan(prs, vm, ctx, idx: int):
    s = _solution(vm, idx)
    slide, top = _section(prs, ctx, s["title"] + " — work plan", f"Duration: {s['duration']}")
    top = T.bullets(slide, top, s["workPlan"] or ["Work plan agreed per engagement."])
    if s["expectedResults"]:
        T.bullets(slide, top, ["Expected results:"] + s["expectedResults"])


def _p_solution_pricing(prs, vm, ctx, idx: int):
    s = _solution(vm, idx)
    slide, top = _section(prs, ctx, s["title"] + " — pricing", s["subtitle"])
    top = T.metric_cards(slide, top, [{"label": "Package price", "value": s["price"], "tone": T.ACCENT}], per_row=1)
    top = T.bullets(slide, top, ["Included:"] + s["includedItems"])
    T.note(slide, top, s.get("pricingNotes", ""), "disclaimer")


def _p_process(prs, vm, ctx):
    ob = vm["offerBlock"]["process"]
    slide, top = _section(prs, ctx, "Process / timeline", "Audit → analysis → strategy → execution → monitoring")
    steps = ob.get("steps", []) or ["Audit", "Analysis", "Strategy", "Execution", "Monitoring"]
    T.bullets(slide, top, steps)


def _p_about(prs, vm, ctx):
    ob = vm["offerBlock"]["contact"]
    slide, top = _section(prs, ctx, "About / contacts", ob.get("company", ""))
    top = T.card(slide, T.MARGIN, top, T.CONTENT_W, Emu(1300000), "Next step", [
        ob.get("cta", "Contact our team to scope an engagement."),
        f"Email: {ob.get('email', '')}",
        f"Website: {ob.get('website', '')}",
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

    brand = vm["offerBlock"]["cover"]["brand"]
    meta_wm = vm["meta"].get("watermark")
    effective_wm = None if str(watermark_mode).lower() == "none" else meta_wm
    ctx = Ctx(brand=brand, watermark=effective_wm, internal=(str(audience).lower() != "client"))

    ru_pages = [
        _rb("ru", _b_summary, "{label} — audit summary"),
        _rb("ru", _b_organic, "{label} — organic search overview"),
        _rb("ru", _b_results, "{label} — top search results"),
        _rb("ru", _b_themes, "{label} — negative publications & themes"),
        _rb("ru", _b_snapshots, "{label} — search screens / snapshots"),
        _rb("ru", _b_suggestions, "{label} — search suggestions"),
        _rb("ru", _b_related, "{label} — related queries"),
        _rb("ru", _b_images, "{label} — images"),
        _rb("ru", _b_videos, "{label} — videos"),
        _rb("ru", _b_knowledge, "{label} — knowledge block"),
        _rb("ru", _b_wikipedia, "{label} — Wikipedia"),
        _rb("ru", _b_findings, "{label} — risk findings"),
        _rb("ru", _b_data_quality, "{label} — data quality"),
        _rb("ru", _b_recommended, "{label} — recommended actions"),
        _rb("ru", _b_evidence, "{label} — evidence appendix"),
        _rb("ru", _b_conclusion, "{label} — interim conclusion"),
    ]
    intl_pages = [
        _rb("intl", _b_summary, "{label} — audit summary"),
        _rb("intl", _b_organic, "{label} — organic search overview"),
        _rb("intl", _b_results, "{label} — top search results"),
        _rb("intl", _b_themes, "{label} — negative themes"),
        _rb("intl", _b_suggestions, "{label} — suggestions"),
        _rb("intl", _b_media, "{label} — images & videos"),
        _rb("intl", _b_wiki_knowledge, "{label} — Wikipedia / knowledge context"),
        _rb("intl", _b_findings, "{label} — risk findings"),
        _rb("intl", _b_data_quality, "{label} — data quality"),
        _rb("intl", _b_conclusion, "{label} — conclusion"),
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
        lambda prs_, vm_, ctx_: _p_compliance_provider(prs_, vm_, ctx_, "dowWorldRows", "Dow Jones / World-Check summary"),
        lambda prs_, vm_, ctx_: _p_compliance_provider(prs_, vm_, ctx_, "lexisRows", "LexisNexis summary"),
        _p_compliance_findings,
        _p_final,
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
                slide, top = _section(prs, ctx, "Section")
                T.no_data_card(slide, top, f"This section could not be rendered: {exc}")
            except Exception:  # noqa: BLE001
                pass
