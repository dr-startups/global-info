"""Corporate audit report template v1 (Stage K1).

Builds a multi-page PPTX in a compliance-audit structure: dynamic analytical
pages (from the audit summary) followed by static commercial offer pages. The
visual style is intentionally simple-but-presentational (dark cover, blue
accent, light tables, risk badges) and is meant to be refined in K2.

Robustness: each slide is built in isolation. If one slide fails, the error is
captured as a warning and the rest of the deck still renders.

No LLM, no network — only lays out the data passed in report_json.
"""

from __future__ import annotations

from typing import Any, Callable

from pptx.dml.color import RGBColor
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Emu, Pt

from report_mapper import build_view_model

# --- palette -----------------------------------------------------------------
NAVY = RGBColor(0x0E, 0x1F, 0x3A)
ACCENT = RGBColor(0x1C, 0x6F, 0xD6)
INK = RGBColor(0x1A, 0x1A, 0x1A)
MUTED = RGBColor(0x6B, 0x6B, 0x6B)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
TABLE_HEAD = RGBColor(0x1F, 0x3A, 0x5F)
TABLE_ALT = RGBColor(0xEF, 0xF3, 0xF9)
WATERMARK_COLOR = RGBColor(0xDD, 0xDD, 0xDD)

RISK_COLORS = {
    "LOW": RGBColor(0x2E, 0x7D, 0x32),
    "MEDIUM": RGBColor(0xB8, 0x86, 0x00),
    "HIGH": RGBColor(0xC6, 0x4A, 0x00),
    "CRITICAL": RGBColor(0xB0, 0x1E, 0x1E),
    "UNKNOWN": RGBColor(0x6B, 0x6B, 0x6B),
    "NONE": RGBColor(0x6B, 0x6B, 0x6B),
}

SLIDE_W = Emu(9144000)
SLIDE_H = Emu(6858000)
MARGIN = Emu(457200)
CONTENT_W = Emu(8229600)
MAX_TABLE_ROWS = 12


def _blank(prs):
    layouts = prs.slide_layouts
    return layouts[6] if len(layouts) > 6 else layouts[-1]


def _bg(slide, color: RGBColor) -> None:
    slide.background.fill.solid()
    slide.background.fill.fore_color.rgb = color


def _textbox(slide, x, y, w, h):
    box = slide.shapes.add_textbox(x, y, w, h)
    box.text_frame.word_wrap = True
    return box


def _watermark(slide, text: str) -> None:
    box = _textbox(slide, Emu(1371600), Emu(2743200), Emu(6400800), Emu(1371600))
    p = box.text_frame.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run = p.add_run()
    run.text = text
    run.font.size = Pt(72)
    run.font.bold = True
    run.font.color.rgb = WATERMARK_COLOR


def _header(slide, title: str, subtitle: str | None = None) -> Emu:
    bar = slide.shapes.add_shape(1, Emu(0), Emu(0), SLIDE_W, Emu(64000))
    bar.fill.solid()
    bar.fill.fore_color.rgb = ACCENT
    bar.line.fill.background()
    box = _textbox(slide, MARGIN, Emu(228600), CONTENT_W, Emu(914400))
    tf = box.text_frame
    run = tf.paragraphs[0].add_run()
    run.text = title or ""
    run.font.size = Pt(26)
    run.font.bold = True
    run.font.color.rgb = NAVY
    if subtitle:
        sp = tf.add_paragraph()
        srun = sp.add_run()
        srun.text = subtitle
        srun.font.size = Pt(13)
        srun.font.color.rgb = MUTED
    return Emu(1280160)


def _bullets(slide, top: Emu, lines: list[str], size: int = 14) -> Emu:
    if not lines:
        return top
    box = _textbox(slide, MARGIN, top, CONTENT_W, Emu(3600000))
    tf = box.text_frame
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        run = p.add_run()
        run.text = f"\u2022 {line}"
        run.font.size = Pt(size)
        run.font.color.rgb = INK
        p.space_after = Pt(4)
    return Emu(int(top) + 320000 * max(1, len(lines)))


def _risk_badge(slide, x: Emu, y: Emu, level: str) -> None:
    lvl = str(level or "UNKNOWN").upper()
    shape = slide.shapes.add_shape(5, x, y, Emu(1600000), Emu(520000))
    shape.fill.solid()
    shape.fill.fore_color.rgb = RISK_COLORS.get(lvl, RISK_COLORS["UNKNOWN"])
    shape.line.fill.background()
    tf = shape.text_frame
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run = p.add_run()
    run.text = lvl
    run.font.size = Pt(14)
    run.font.bold = True
    run.font.color.rgb = WHITE


def _table(slide, top: Emu, columns: list[str], rows: list[list[Any]], note: str | None = None) -> Emu:
    total = len(rows)
    rows = rows[:MAX_TABLE_ROWS]
    n_rows = len(rows) + 1
    n_cols = max(1, len(columns))
    height = Emu(min(360000 * n_rows, 4400000))
    graphic = slide.shapes.add_table(n_rows, n_cols, MARGIN, top, CONTENT_W, height)
    table = graphic.table
    for c, col in enumerate(columns):
        cell = table.cell(0, c)
        cell.text = str(col)
        cell.fill.solid()
        cell.fill.fore_color.rgb = TABLE_HEAD
        para = cell.text_frame.paragraphs[0]
        para.font.bold = True
        para.font.size = Pt(11)
        para.font.color.rgb = WHITE
    for r, row in enumerate(rows, start=1):
        for c in range(n_cols):
            cell = table.cell(r, c)
            val = row[c] if c < len(row) else ""
            cell.text = "" if val is None else str(val)
            para = cell.text_frame.paragraphs[0]
            para.font.size = Pt(10)
            para.font.color.rgb = INK
            if r % 2 == 0:
                cell.fill.solid()
                cell.fill.fore_color.rgb = TABLE_ALT
    bottom = Emu(int(top) + int(height) + 120000)
    label = note
    if total > MAX_TABLE_ROWS:
        label = f"Showing top {MAX_TABLE_ROWS} of {total}." + (f" {note}" if note else "")
    if label:
        box = _textbox(slide, MARGIN, bottom, CONTENT_W, Emu(360000))
        run = box.text_frame.paragraphs[0].add_run()
        run.text = label
        run.font.size = Pt(10)
        run.font.italic = True
        run.font.color.rgb = MUTED
        bottom = Emu(int(bottom) + 360000)
    return bottom


def _empty_note(slide, top: Emu, text: str) -> Emu:
    box = _textbox(slide, MARGIN, top, CONTENT_W, Emu(700000))
    run = box.text_frame.paragraphs[0].add_run()
    run.text = text
    run.font.size = Pt(13)
    run.font.italic = True
    run.font.color.rgb = MUTED
    return Emu(int(top) + 600000)


# --- slide builders ----------------------------------------------------------

def _slide_cover(prs, vm, _dr):
    slide = prs.slides.add_slide(_blank(prs))
    _bg(slide, NAVY)
    cover = vm["cover"]
    box = _textbox(slide, MARGIN, Emu(2057400), CONTENT_W, Emu(2743200))
    tf = box.text_frame
    r = tf.paragraphs[0].add_run()
    r.text = cover["reportTitle"]
    r.font.size = Pt(40)
    r.font.bold = True
    r.font.color.rgb = WHITE
    p2 = tf.add_paragraph()
    r2 = p2.add_run()
    r2.text = cover["subjectFullName"]
    r2.font.size = Pt(24)
    r2.font.color.rgb = RGBColor(0x9E, 0xC2, 0xF0)
    p3 = tf.add_paragraph()
    r3 = p3.add_run()
    r3.text = f"Audit date: {cover['auditDate']}   ·   {cover['brand']}"
    r3.font.size = Pt(14)
    r3.font.color.rgb = RGBColor(0xC9, 0xD6, 0xEA)
    _risk_badge(slide, MARGIN, Emu(5000000), cover["overallRiskLevel"])
    if vm["meta"].get("watermark"):
        box2 = _textbox(slide, Emu(2057400), Emu(6000000), Emu(5029200), Emu(600000))
        run = box2.text_frame.paragraphs[0].add_run()
        run.text = str(vm["meta"]["watermark"])
        run.font.size = Pt(28)
        run.font.bold = True
        run.font.color.rgb = RGBColor(0x3A, 0x4F, 0x73)


def _section(prs, vm, watermark):
    slide = prs.slides.add_slide(_blank(prs))
    _bg(slide, WHITE)
    if watermark:
        _watermark(slide, watermark)
    return slide


def _slide_contents(prs, vm, _dr):
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    top = _header(slide, "Contents")
    _bullets(slide, top, [
        "1. Executive summary",
        "2. Compliance risk matrix",
        "3. Digital profile overview",
        "4. RU search audit",
        "5. Wikipedia",
        "6. UAE / international search audit",
        "7. Compliance databases",
        "8. Risk findings",
        "9. Data quality",
        "10. Recommended actions",
        "11. Services & pricing",
    ])


def _slide_executive(prs, vm, _dr):
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    top = _header(slide, "Executive summary", f"Overall risk: {vm['executiveSummary']['overallRiskLevel']}")
    _risk_badge(slide, Emu(7000000), Emu(228600), vm["executiveSummary"]["overallRiskLevel"])
    _bullets(slide, top, vm["executiveSummary"]["bullets"])


def _slide_risk_matrix(prs, vm, _dr):
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    rm = vm["riskMatrix"]
    top = _header(slide, "Compliance risk matrix", rm["subject"])
    _risk_badge(slide, Emu(7000000), Emu(228600), rm["overallRiskLevel"])
    rows = [[k, str(v)] for k, v in (rm.get("byLevel") or {}).items()]
    if not rows:
        rows = [["No findings", "0"]]
    top = _table(slide, top, ["Risk level", "Findings"], rows)
    themes = ", ".join(f"{t['theme']} ({t['count']})" for t in rm.get("topThemes", [])) or "—"
    _bullets(slide, top, [
        f"Highest risk level: {rm['highestRiskLevel']}",
        f"Total findings: {rm['totalFindings']}",
        f"Top themes: {themes}",
        "Possible consequences: " + "; ".join(rm.get("consequences", [])),
    ])


def _slide_overview(prs, vm, _dr):
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    o = vm["digitalProfileOverview"]
    top = _header(slide, "Digital profile overview")
    _bullets(slide, top, [
        f"RU negative share: {o['negativeShareRu']}  ·  UAE negative share: {o['negativeShareUae']}",
        f"Organic results: {o['searchTotal']} total, {o['searchNegative']} negative ({o['searchNegativeShare']}).",
        f"Wikipedia: {o['wikipediaStatus']}.",
        f"Compliance: {o['complianceSummary']}",
    ])


def _region_summary_slide(code: str) -> Callable:
    def builder(prs, vm, _dr):
        slide = _section(prs, vm, vm["meta"].get("watermark"))
        r = vm["regions"][code]
        title = "RU search audit" if code == "RU" else "UAE / international search audit"
        top = _header(slide, title, f"Region risk: {r['riskLevel']}")
        _risk_badge(slide, Emu(7000000), Emu(228600), r["riskLevel"])
        if not r["present"]:
            _empty_note(slide, top, f"No evidence collected for this region ({code}).")
            return
        top = _table(slide, top, ["Metric", "Value"], [
            ["Organic total", r["organicTotal"]],
            ["Organic negative", r["organicNegative"]],
            ["Negative share", r["organicNegativeShare"]],
            ["Unique negative URLs", r["uniqueNegativeUrls"]],
            ["Suggestions (neg/total)", r["suggestions"]],
            ["Images (neg/total)", r["images"]],
            ["Videos (neg/total)", r["videos"]],
            ["Knowledge block", r["knowledgeBlockStatus"]],
        ])
        _bullets(slide, top, [r["conclusion"]] if r["conclusion"] else [])
    return builder


def _region_results_slide(code: str) -> Callable:
    def builder(prs, vm, _dr):
        slide = _section(prs, vm, vm["meta"].get("watermark"))
        r = vm["regions"][code]
        title = f"{code} top search results"
        top = _header(slide, title)
        rows = [[x["provider"], x["rank"], x["domain"], x["title"], x["classification"]] for x in r["topResults"]]
        if not rows:
            _empty_note(slide, top, "No organic results collected for this region.")
            return
        _table(slide, top, ["Provider", "Rank", "Domain", "Title", "Class"], rows)
    return builder


def _slide_ru_themes(prs, vm, _dr):
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    s = vm["search"]
    top = _header(slide, "RU negative themes & domains")
    themes = [f"{t['theme']} ({t['count']})" for t in s["topNegativeThemes"]]
    top = _bullets(slide, top, ["Top themes: " + (", ".join(themes) or "—"),
                                "Negative domains: " + (", ".join(s["negativeDomains"]) or "—")])
    rows = [[u["title"], u["url"]] for u in s["topNegativeUrls"]]
    if rows:
        _table(slide, top, ["Title", "Domain"], rows)
    else:
        _empty_note(slide, top, "No negative URLs detected.")


def _slide_ru_suggestions(prs, vm, _dr):
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    r = vm["regions"]["RU"]
    top = _header(slide, "RU suggestions & related queries", f"Suggestions (neg/total): {r['suggestions']}")
    if r["topSuggestions"]:
        _bullets(slide, top, r["topSuggestions"])
    else:
        _empty_note(slide, top, "No suggestions collected for this region.")


def _slide_ru_media(prs, vm, _dr):
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    r = vm["regions"]["RU"]
    top = _header(slide, "RU images & videos", f"Images: {r['images']}  ·  Videos: {r['videos']}")
    rows = [["Image", i["title"], i["url"]] for i in r["topImages"]]
    rows += [["Video", v["title"], v["url"]] for v in r["topVideos"]]
    if rows:
        _table(slide, top, ["Type", "Title", "Source"], rows)
    else:
        _empty_note(slide, top, "No image/video results collected for this region.")


def _slide_ru_knowledge(prs, vm, _dr):
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    r = vm["regions"]["RU"]
    su = vm["surfaces"]
    top = _header(slide, "RU knowledge block & screenshots")
    _bullets(slide, top, [
        f"Knowledge block status: {r['knowledgeBlockStatus']}.",
        f"Knowledge blocks: {su['knowledgeBlocks']} (mismatches: {su['knowledgeMismatches']}).",
        f"Screenshots: {su['screenshots']}.",
        f"Synthetic snapshots: {su['syntheticSnapshots']} (generated previews, not live captures).",
    ])


def _slide_wikipedia(prs, vm, _dr):
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    w = vm["wikipedia"]
    top = _header(slide, "Wikipedia summary", w["status"])
    top = _table(slide, top, ["Field", "Value"], [
        ["Exists", "Yes" if w["exists"] else "No"],
        ["Page URL", w["pageUrl"] or "—"],
        ["Language", w["language"] or "—"],
        ["Notability score", w["notabilityScore"]],
    ])
    _bullets(slide, top, [w["conclusion"]] if w["conclusion"] else [])


def _slide_compliance(prs, vm, _dr):
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    c = vm["complianceDatabases"]
    top = _header(slide, "Compliance databases")
    top = _table(slide, top, ["Metric", "Value"], [
        ["Providers checked", ", ".join(c["providersChecked"]) or "—"],
        ["Active matches", c["activeMatches"]],
        ["PEP matches", c["pepMatches"]],
        ["RCA matches", c["rcaMatches"]],
        ["Sanctions matches", c["sanctionsMatches"]],
        ["Adverse media matches", c["adverseMediaMatches"]],
    ])
    _bullets(slide, top, [c["conclusion"]] if c["conclusion"] else [])


def _slide_risk_findings(prs, vm, _dr):
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    rf = vm["riskFindings"]
    top = _header(slide, "Risk findings", f"Active findings: {rf['totalFindings']}")
    rows = [[f["severity"], f["theme"], f["title"], f["reviewStatus"], f["evidenceCount"]] for f in rf["topFindings"]]
    if rows:
        _table(slide, top, ["Severity", "Theme", "Finding", "Review", "Evidence"], rows)
    else:
        _empty_note(slide, top, "No risk findings. Run the Risk Classifier to populate this section.")


def _slide_data_quality(prs, vm, _dr):
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    d = vm["dataQuality"]
    top = _header(slide, "Data quality")
    top = _table(slide, top, ["Metric", "Value"], [
        ["Evidence items", d["evidenceCount"]],
        ["Reviewed findings", d["reviewedFindings"]],
        ["Pending findings", d["pendingFindings"]],
        ["Dismissed findings", d["dismissedFindings"]],
        ["Missing sections", ", ".join(d["missingSections"]) or "none"],
    ])
    _bullets(slide, top, d["warnings"] or ["Evidence coverage is adequate for a preliminary assessment."])


def _slide_recommended(prs, vm, _dr):
    slide = _section(prs, vm, vm["meta"].get("watermark"))
    top = _header(slide, "Recommended actions & next steps")
    _bullets(slide, top, vm["recommendedActions"])


def _offer_slide(page: dict) -> Callable:
    def builder(prs, vm, _dr):
        slide = prs.slides.add_slide(_blank(prs))
        _bg(slide, WHITE)
        top = _header(slide, page.get("title", ""), page.get("subtitle"))
        if page.get("bullets"):
            top = _bullets(slide, top, page["bullets"])
        tbl = page.get("table")
        if tbl and tbl.get("columns"):
            _table(slide, top, tbl["columns"], tbl.get("rows", []))
    return builder


def build_report_v1(report_json: dict, prs, data_root: str, warnings: list[str]) -> None:
    vm, vm_warnings = build_view_model(report_json)
    warnings.extend(vm_warnings)

    builders: list[tuple[str, Callable]] = [
        ("cover", _slide_cover),
        ("contents", _slide_contents),
        ("executive", _slide_executive),
        ("risk_matrix", _slide_risk_matrix),
        ("overview", _slide_overview),
        ("ru_summary", _region_summary_slide("RU")),
        ("ru_results", _region_results_slide("RU")),
        ("ru_themes", _slide_ru_themes),
        ("ru_suggestions", _slide_ru_suggestions),
        ("ru_media", _slide_ru_media),
        ("ru_knowledge", _slide_ru_knowledge),
        ("wikipedia", _slide_wikipedia),
        ("uae_summary", _region_summary_slide("UAE")),
        ("uae_results", _region_results_slide("UAE")),
        ("compliance", _slide_compliance),
        ("risk_findings", _slide_risk_findings),
        ("data_quality", _slide_data_quality),
        ("recommended", _slide_recommended),
    ]
    for page in vm["offerPages"]:
        builders.append((f"offer:{page.get('title', '')}", _offer_slide(page)))

    for name, fn in builders:
        try:
            fn(prs, vm, data_root)
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Slide '{name}' failed: {exc}")
