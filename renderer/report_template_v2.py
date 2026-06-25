"""Full dynamic audit report template v2 (Stage K2).

Extends the corporate template to the full 36-page dynamic structure:
  1-5    Cover / Contents / Executive / Risk Matrix / Overview
  6-21   Russia (RU) digital-profile audit block
  22-31  UAE / International audit block
  32-36  Compliance databases + final dynamic conclusion
Followed by static offer pages (37+).

Reuses the v1 styling/builders. Every page is built through a safe wrapper: a
failing slide produces a fallback note + a warning instead of breaking the deck.
Robust against empty cases and missing regions/sections.

No LLM, no network, no live SERP screenshots — only lays out report_json data.
"""

from __future__ import annotations

from typing import Any, Callable

from report_mapper import build_view_model_v2
from report_template_v1 import (
    ACCENT,
    INK,
    MUTED,
    NAVY,
    WHITE,
    _bg,
    _blank,
    _bullets,
    _empty_note,
    _header,
    _risk_badge,
    _section,
    _table,
    _textbox,
    set_table_strings,
)
from pptx.util import Emu, Pt


# --- shared mini helpers -----------------------------------------------------

# Localized "Metric"/"Value" headers for key/value tables, set per render.
_KV_HEADERS = ["Metric", "Value"]


def _kv_table(slide, top, pairs: list[tuple[str, Any]]):
    return _table(slide, top, list(_KV_HEADERS), [[k, v] for k, v in pairs])


def _note(slide, top, text: str):
    return _empty_note(slide, top, text)


def _price(offer: dict, value: Any) -> str:
    currency = offer.get("currency", "EUR")
    try:
        return f"{int(value):,} {currency}"
    except (TypeError, ValueError):
        return f"0 {currency}"


# ===========================================================================
# 1-5: front matter
# ===========================================================================

def _p_cover(prs, vm):
    slide = prs.slides.add_slide(_blank(prs))
    _bg(slide, NAVY)
    c = vm["cover"]
    box = _textbox(slide, Emu(457200), Emu(1828800), Emu(8229600), Emu(3000000))
    tf = box.text_frame
    r = tf.paragraphs[0].add_run()
    r.text = "Digital Profile"
    r.font.size = Pt(44)
    r.font.bold = True
    r.font.color.rgb = WHITE
    for text, size, color in [
        (c["subjectFullName"], 26, (0x9E, 0xC2, 0xF0)),
        (f"{vm['labels']['audit_date']}: {c['auditDate']}", 14, (0xC9, 0xD6, 0xEA)),
        (c["brand"], 14, (0xC9, 0xD6, 0xEA)),
        (" · ".join(x for x in [c.get("website", ""), c.get("contact", "")] if x), 12, (0x8A, 0x9C, 0xBC)),
    ]:
        if not text:
            continue
        p = tf.add_paragraph()
        run = p.add_run()
        run.text = text
        run.font.size = Pt(size)
        from pptx.dml.color import RGBColor

        run.font.color.rgb = RGBColor(*color)
    _risk_badge(slide, Emu(457200), Emu(5200000), c["overallRiskLevel"])
    if vm["meta"].get("watermark"):
        wm = _textbox(slide, Emu(2057400), Emu(6050000), Emu(5029200), Emu(560000))
        run = wm.text_frame.paragraphs[0].add_run()
        run.text = str(vm["meta"]["watermark"])
        run.font.size = Pt(26)
        run.font.bold = True
        from pptx.dml.color import RGBColor

        run.font.color.rgb = RGBColor(0x3A, 0x4F, 0x73)


def _p_contents(prs, vm):
    L = vm["labels"]
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    top = _header(slide, L["contents"])
    _bullets(slide, top, vm["contents"]["sections"])


def _p_executive(prs, vm):
    L = vm["labels"]
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    e = vm["executiveSummary"]
    top = _header(slide, L["executive_summary"], f"{L['overall_risk']}: {e['overallRiskLevel']}")
    _risk_badge(slide, Emu(7000000), Emu(228600), e["overallRiskLevel"])
    lines = list(e.get("bullets", []))
    for g in e.get("keyFindings", [])[:5]:
        if g.get("title"):
            lines.append(g["title"])
    top = _bullets(slide, top, lines[:10])
    if e.get("dataQualityWarning"):
        _note(slide, top, f"{L['pg_data_quality_plain']}: {e['dataQualityWarning']}")


def _p_risk_matrix(prs, vm):
    L = vm["labels"]
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    rm = vm["riskMatrix"]
    top = _header(slide, L["compliance_risk_matrix"], rm["subject"])
    _risk_badge(slide, Emu(7000000), Emu(228600), rm["overallRiskLevel"])
    rows = [[r["area"], r["problems"], r["level"], r["consequences"]] for r in rm["rows"]]
    _table(slide, top, [L["th_compliance_area"], L["th_problems_risks"], L["th_risk"], L["th_consequences"]], rows)


def _p_overview(prs, vm):
    L = vm["labels"]
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    o = vm["overview"]
    top = _header(slide, L["digital_profile_overview"])
    _risk_badge(slide, Emu(7000000), Emu(228600), o.get("overallRiskLevel", "UNKNOWN"))
    _kv_table(
        slide,
        top,
        [
            (L["m_ru_negative_share"], o.get("negativeShareRu", "0%")),
            (L["m_uae_negative_share"], o.get("negativeShareUae", "0%")),
            (L["ov_search_total_neg"], f"{o.get('searchTotal', 0)} / {o.get('searchNegative', 0)}"),
            (L["area_wikipedia"], o.get("wikipediaStatus", "")),
            (L["sec_compliance"], o.get("complianceSummary", "")),
        ],
    )


# ===========================================================================
# region pages (used for RU and UAE/International)
# ===========================================================================

def _rb(block_key: str, builder: Callable[[Any, dict, dict], None], title: str, subtitle: str | None = None) -> Callable:
    def page(prs, vm):
        L = vm["labels"]
        slide = _section(prs, vm, vm["meta"].get("watermark"))
        blk = vm[block_key]
        full_title = title.replace("{label}", blk["label"])
        top = _header(slide, full_title, subtitle)
        _risk_badge(slide, Emu(7000000), Emu(228600), blk["riskLevel"])
        if not blk["present"]:
            _note(slide, top, blk["noDataText"] or L["no_evidence_region"].format(label=blk["label"]))
            return
        builder(slide, blk, vm)

    return page


def _b_summary(slide, blk, vm):
    L = vm["labels"]
    s = blk["summary"]
    top = Emu(1280160)
    top = _kv_table(
        slide,
        top,
        [
            (L["m_organic_total"], s.get("organicTotal", 0)),
            (L["m_organic_negative"], s.get("organicNegative", 0)),
            (L["m_negative_share"], s.get("organicNegativeShare", "0%")),
            (L["m_suggestions_nt"], s.get("suggestions", "0/0")),
            (L["m_images_nt"], s.get("images", "0/0")),
            (L["m_videos_nt"], s.get("videos", "0/0")),
            (L["m_knowledge"], s.get("knowledgeBlockStatus", "ABSENT")),
        ],
    )
    _bullets(slide, top, [blk["conclusion"]] if blk["conclusion"] else [])


def _b_organic_overview(slide, blk, vm):
    L = vm["labels"]
    o = blk["organicOverview"]
    top = Emu(1280160)
    top = _kv_table(
        slide,
        top,
        [
            (L["m_organic_total"], o.get("organicTotal", 0)),
            (L["m_organic_negative"], o.get("organicNegative", 0)),
            (L["m_unique_neg_urls"], o.get("uniqueNegativeUrls", 0)),
            (L["m_unique_neg_urls"], o.get("totalUniqueUrls", 0)),
            (L["m_negative_share"], o.get("negativeShare", "0%")),
        ],
    )
    if o.get("observedQueries"):
        _bullets(slide, top, [L["observed_queries"]] + o["observedQueries"])


def _b_top_results(slide, blk, vm):
    L = vm["labels"]
    rows = [[x["provider"], x["rank"], x["domain"], x["title"], x["classification"]] for x in blk["topResults"]]
    if rows:
        _table(slide, Emu(1280160), [L["th_provider"], L["th_rank"], L["th_domain"], L["th_title"], L["th_class"]], rows)
    else:
        _note(slide, Emu(1280160), L["nd_no_organic_region"])


def _b_themes(slide, blk, vm):
    L = vm["labels"]
    t = blk["themes"]
    top = Emu(1280160)
    themes = [f"{x['theme']} ({x['count']})" for x in t["topThemes"]]
    top = _bullets(
        slide,
        top,
        [
            L["top_themes"] + " " + (", ".join(themes) or "—"),
            L["negative_domains"] + " " + (", ".join(t["negativeDomains"]) or "—"),
        ],
    )
    rows = [[u["title"], u["domain"], u["classification"]] for u in t["negativeUrls"]]
    if rows:
        _table(slide, top, [L["th_title"], L["th_domain"], L["th_class"]], rows)
    else:
        _note(slide, top, L["nd_no_negative_urls"])


def _b_snapshots(slide, blk, vm):
    L = vm["labels"]
    _bullets(
        slide,
        Emu(1280160),
        [
            L["knowledge_block_status"].format(status=blk["summary"].get("knowledgeBlockStatus", "ABSENT")),
            *L["snapshot_lines"],
        ],
    )


def _b_suggestions(slide, blk, vm):
    L = vm["labels"]
    sg = blk["suggestions"]
    top = _header_metrics(slide, f"{L['m_total']}: {sg['total']}  ·  {L['m_negative']}: {sg['negative']}")
    if sg["list"]:
        _bullets(slide, top, sg["list"])
    else:
        _note(slide, top, L["nd_no_suggestions"])


def _b_related(slide, blk, vm):
    L = vm["labels"]
    rq = blk["relatedQueries"]
    top = _header_metrics(slide, f"{L['m_total']}: {rq['total']}  ·  {L['m_negative']}: {rq['negative']}")
    if rq["list"]:
        _bullets(slide, top, rq["list"])
    else:
        _note(slide, top, L["nd_no_related"])


def _b_images(slide, blk, vm):
    L = vm["labels"]
    im = blk["images"]
    top = _header_metrics(slide, f"{L['m_images_total']}: {im['total']}  ·  {L['m_negative']}: {im['negative']}")
    rows = [[i["title"], i["source"]] for i in im["items"]]
    if rows:
        _table(slide, top, [L["th_image_title"], L["th_source"]], rows)
    else:
        _note(slide, top, L["nd_no_images"])


def _b_videos(slide, blk, vm):
    L = vm["labels"]
    vi = blk["videos"]
    top = _header_metrics(slide, f"{L['m_videos_total']}: {vi['total']}  ·  {L['m_negative']}: {vi['negative']}")
    rows = [[v["title"], v["source"]] for v in vi["items"]]
    if rows:
        _table(slide, top, [L["th_video_title"], L["th_source"]], rows)
    else:
        _note(slide, top, L["nd_no_videos"])


def _b_images_videos(slide, blk, vm):
    L = vm["labels"]
    im, vi = blk["images"], blk["videos"]
    top = _header_metrics(slide, f"{L['m_images_nt']}: {im['negative']}/{im['total']}  ·  {L['m_videos_nt']}: {vi['negative']}/{vi['total']}")
    rows = [["Image", i["title"], i["source"]] for i in im["items"]]
    rows += [["Video", v["title"], v["source"]] for v in vi["items"]]
    if rows:
        _table(slide, top, [L["th_type"], L["th_title"], L["th_source"]], rows)
    else:
        _note(slide, top, L["nd_no_media"])


def _b_knowledge(slide, blk, vm):
    L = vm["labels"]
    kb = blk["knowledgeBlock"]
    top = Emu(1280160)
    if kb and kb.get("title"):
        top = _kv_table(
            slide,
            top,
            [
                (L["m_status"], kb.get("status", "ABSENT")),
                (L["th_title"], kb.get("title", "")),
                (L["th_source"], kb.get("source", "") or "—"),
            ],
        )
        if kb.get("snippet"):
            _bullets(slide, top, [kb["snippet"]])
    else:
        _note(slide, top, L["no_knowledge_content"].format(status=(kb or {}).get("status", "ABSENT")))


def _b_wikipedia(slide, blk, vm):
    L = vm["labels"]
    w = blk["wikipedia"]
    top = Emu(1280160)
    if w.get("exists"):
        top = _kv_table(
            slide,
            top,
            [
                ("URL", w.get("pageUrl") or "—"),
                (L["m_language"], w.get("language") or "—"),
                (L["m_notability"], w.get("notabilityScore", 0)),
            ],
        )
        _bullets(slide, top, [w.get("conclusion", "")])
    else:
        _bullets(slide, top, [L["wiki_not_found_title"] + ".", *L["wiki_not_found_lines"]])


def _b_wiki_knowledge(slide, blk, vm):
    L = vm["labels"]
    w = blk["wikipedia"]
    kb = blk["knowledgeBlock"]
    top = Emu(1280160)
    state = L["wiki_page_exists"] if w.get("exists") else L["wiki_no_page"]
    _bullets(
        slide,
        top,
        [
            L["wiki_context_line"].format(state=state, lang=w.get("language") or "—"),
            L["wiki_kb_line"].format(status=(kb or {}).get("status", "ABSENT")),
            L["wiki_review_line"],
        ],
    )


def _b_findings(slide, blk, vm):
    L = vm["labels"]
    rows = [[f["severity"], f["theme"], f["title"], f["reviewStatus"], f["evidenceCount"]] for f in blk["riskFindings"]]
    if rows:
        _table(slide, Emu(1280160), [L["th_severity"], L["th_theme"], L["th_finding"], L["th_review"], L["th_evidence"]], rows)
    else:
        _note(slide, Emu(1280160), L["nd_no_findings_region"])


def _b_data_quality(slide, blk, vm):
    L = vm["labels"]
    dq = blk["dataQuality"]
    top = _kv_table(
        slide,
        Emu(1280160),
        [
            (L["m_organic_evidence"], dq.get("organic", 0)),
            (L["m_surface_evidence"], dq.get("surfaces", 0)),
        ],
    )
    _bullets(slide, top, dq.get("warnings") or [L["coverage_adequate_region"]])


def _b_recommended(slide, blk, vm):
    L = vm["labels"]
    _bullets(slide, Emu(1280160), blk.get("recommendedActions") or [L["expand_region_collection"]])


def _b_evidence(slide, blk, vm):
    L = vm["labels"]
    rows = [[e["title"], e["domain"], e["provider"], e["classification"]] for e in blk["evidenceAppendix"]]
    if rows:
        _table(slide, Emu(1280160), [L["th_title"], L["th_domain"], L["th_provider"], L["th_class"]], rows)
    else:
        _note(slide, Emu(1280160), L["nd_no_evidence_region"])


def _b_conclusion(slide, blk, vm):
    L = vm["labels"]
    top = Emu(1280160)
    _bullets(
        slide,
        top,
        [
            f"{L['region_risk']}: {blk['riskLevel']}.",
            blk["conclusion"] or L["interim_conclusion_fallback"],
        ],
    )


def _header_metrics(slide, subtitle: str):
    # Region pages already drew the header; add a metrics subtitle line.
    box = _textbox(slide, Emu(457200), Emu(1097280), Emu(8229600), Emu(360000))
    run = box.text_frame.paragraphs[0].add_run()
    run.text = subtitle
    run.font.size = Pt(12)
    run.font.color.rgb = MUTED
    return Emu(1500000)


# ===========================================================================
# 32-36: compliance + final
# ===========================================================================

def _p_compliance_overview(prs, vm):
    L = vm["labels"]
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    c = vm["compliance"]
    top = _header(slide, L["compliance_overview_title"])
    top = _kv_table(
        slide,
        top,
        [
            (L["providers_checked"], ", ".join(c["providersChecked"]) or "—"),
            (L["m_active_matches"], c["activeMatches"]),
            (L["m_pep_rca"], f"{c['pepMatches']} / {c['rcaMatches']}"),
            (L["m_sanctions"], c["sanctionsMatches"]),
            (L["m_adverse_media"], c["adverseMediaMatches"]),
        ],
    )
    _bullets(slide, top, [c["conclusion"]] if c["conclusion"] else [])


def _p_compliance_provider(prs, vm, key: str, title: str):
    L = vm["labels"]
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    c = vm["compliance"]
    top = _header(slide, title)
    rows = [[r["provider"], r["importMethod"], r["matchType"], r["score"]] for r in c[key]]
    if rows:
        _table(slide, top, [L["th_provider"], L["th_source_method"], L["th_category"], L["th_score"]], rows)
    else:
        _note(slide, top, L["nd_no_screening"])


def _p_compliance_findings(prs, vm):
    L = vm["labels"]
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    c = vm["compliance"]
    top = _header(slide, L["compliance_findings_title"])
    rows = [[f["severity"], f["theme"], f["title"], f["reviewStatus"], f["evidenceCount"]] for f in c["findings"]]
    if rows:
        _table(slide, top, [L["th_severity"], L["th_theme"], L["th_finding"], L["th_review"], L["th_evidence"]], rows)
    else:
        _note(slide, top, L["nd_no_compliance_findings"])


def _p_final(prs, vm):
    L = vm["labels"]
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    f = vm["finalConclusion"]
    top = _header(slide, L["final_title"], f"{L['overall_risk']}: {f['overallRiskLevel']}")
    _risk_badge(slide, Emu(7000000), Emu(228600), f["overallRiskLevel"])
    themes = ", ".join(f"{t['theme']} ({t['count']})" for t in f.get("topThemes", [])) or "—"
    lines = [L["highest_risk_themes_inline"].format(themes=themes)]
    lines += list(f.get("recommendedActions", []))[:5]
    if f.get("missingSections"):
        lines.append(L["missing_sections_inline"].format(items=", ".join(f["missingSections"])))
    top = _bullets(slide, top, lines)
    _note(slide, top, L["next_pages_note"])


# ===========================================================================
# static offer pages (37+)
# ===========================================================================

def _p_offer(prs, vm):
    # Render the already-localized offer pages from the view model so the
    # commercial block follows the report language (RU / EN).
    for page in vm["offerPages"]:
        slide = prs.slides.add_slide(_blank(prs))
        _bg(slide, WHITE)
        top = _header(slide, page.get("title", ""), page.get("subtitle"))
        if page.get("bullets"):
            top = _bullets(slide, top, page["bullets"])
        tbl = page.get("table")
        if tbl and tbl.get("columns"):
            _table(slide, top, tbl["columns"], tbl.get("rows", []))


# ===========================================================================
# orchestration
# ===========================================================================

def build_report_v2(report_json: dict, prs, data_root: str, warnings: list[str]) -> None:
    global _KV_HEADERS
    vm, vm_warnings = build_view_model_v2(report_json)
    warnings.extend(vm_warnings)
    L = vm["labels"]
    set_table_strings(L["showing_top"])
    _KV_HEADERS = [L["th_metric"], L["th_value"]]

    ru_pages = [
        ("ru_summary", _rb("ru", _b_summary, L["pg_audit_summary"])),
        ("ru_organic", _rb("ru", _b_organic_overview, L["pg_organic_overview"])),
        ("ru_results", _rb("ru", _b_top_results, L["pg_top_results"])),
        ("ru_themes", _rb("ru", _b_themes, L["pg_neg_publications"])),
        ("ru_snapshots", _rb("ru", _b_snapshots, L["pg_search_screens"])),
        ("ru_suggestions", _rb("ru", _b_suggestions, L["pg_suggestions"])),
        ("ru_related", _rb("ru", _b_related, L["pg_related_queries"])),
        ("ru_images", _rb("ru", _b_images, L["pg_images"])),
        ("ru_videos", _rb("ru", _b_videos, L["pg_videos"])),
        ("ru_knowledge", _rb("ru", _b_knowledge, L["pg_knowledge_block"])),
        ("ru_wikipedia", _rb("ru", _b_wikipedia, L["pg_wikipedia"])),
        ("ru_findings", _rb("ru", _b_findings, L["pg_risk_findings"])),
        ("ru_quality", _rb("ru", _b_data_quality, L["pg_data_quality"])),
        ("ru_recommended", _rb("ru", _b_recommended, L["pg_recommended"])),
        ("ru_evidence", _rb("ru", _b_evidence, L["pg_evidence_appendix"])),
        ("ru_conclusion", _rb("ru", _b_conclusion, L["pg_interim_conclusion"])),
    ]
    intl_pages = [
        ("intl_summary", _rb("intl", _b_summary, L["pg_audit_summary"])),
        ("intl_organic", _rb("intl", _b_organic_overview, L["pg_organic_overview"])),
        ("intl_results", _rb("intl", _b_top_results, L["pg_top_results"])),
        ("intl_themes", _rb("intl", _b_themes, L["pg_neg_themes"])),
        ("intl_suggestions", _rb("intl", _b_suggestions, L["pg_suggestions"])),
        ("intl_media", _rb("intl", _b_images_videos, L["pg_images_videos"])),
        ("intl_wiki", _rb("intl", _b_wiki_knowledge, L["pg_wiki_knowledge"])),
        ("intl_findings", _rb("intl", _b_findings, L["pg_risk_findings"])),
        ("intl_quality", _rb("intl", _b_data_quality, L["pg_data_quality"])),
        ("intl_conclusion", _rb("intl", _b_conclusion, L["pg_conclusion"])),
    ]

    builders: list[tuple[str, Callable]] = [
        ("cover", _p_cover),
        ("contents", _p_contents),
        ("executive", _p_executive),
        ("risk_matrix", _p_risk_matrix),
        ("overview", _p_overview),
        *ru_pages,
        *intl_pages,
        ("compliance_overview", _p_compliance_overview),
        ("compliance_dow_world", lambda prs_, vm_: _p_compliance_provider(prs_, vm_, "dowWorldRows", L["dow_world_title"])),
        ("compliance_lexis", lambda prs_, vm_: _p_compliance_provider(prs_, vm_, "lexisRows", L["lexis_title"])),
        ("compliance_findings", _p_compliance_findings),
        ("final_conclusion", _p_final),
        ("offer_block", _p_offer),
    ]

    for name, fn in builders:
        try:
            fn(prs, vm)
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Slide '{name}' failed: {exc}")
            try:
                slide = prs.slides.add_slide(_blank(prs))
                _bg(slide, WHITE)
                _header(slide, name.replace("_", " ").title())
                _empty_note(slide, Emu(1280160), f"This section could not be rendered: {exc}")
            except Exception:  # noqa: BLE001
                pass
