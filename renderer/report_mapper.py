"""Map a Digital Profile ``report_json`` into a safe TemplateViewModel (Stage K1).

This is the single normalization layer for the corporate template renderer. It
coerces every optional field to a safe value so the renderer never crashes on
empty arrays / missing sections, formats percentages / dates / risk levels, and
collects warnings about missing data.

No LLM, no network — pure transformation of the data passed in report_json.
"""

from __future__ import annotations

import base64
from datetime import datetime
from typing import Any

from report_i18n import labels as i18n_labels, normalize_lang, watermark_text


def _report_lang(report_json: dict) -> str:
    meta = report_json.get("meta", {}) or {}
    return normalize_lang(report_json.get("reportLanguage") or meta.get("language"))


def _get(d: Any, *path: str, default: Any = None) -> Any:
    cur = d
    for key in path:
        if isinstance(cur, dict) and key in cur and cur[key] is not None:
            cur = cur[key]
        else:
            return default
    return cur


def pct(share: Any) -> str:
    try:
        return f"{round(float(share) * 100)}%"
    except (TypeError, ValueError):
        return "0%"


def fmt_date(iso: Any) -> str:
    if not iso:
        return ""
    try:
        return datetime.fromisoformat(str(iso).replace("Z", "+00:00")).strftime("%Y-%m-%d")
    except ValueError:
        return str(iso)[:10]


def risk_level(value: Any) -> str:
    s = str(value or "UNKNOWN").upper()
    return s if s in ("LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN", "NONE") else "UNKNOWN"


def truncate(text: Any, length: int = 80) -> str:
    s = "" if text is None else str(text)
    return s if len(s) <= length else s[: length - 1] + "\u2026"


def domain(url: Any) -> str:
    if not url:
        return ""
    s = str(url)
    for prefix in ("https://", "http://"):
        if s.startswith(prefix):
            s = s[len(prefix):]
    if s.startswith("www."):
        s = s[4:]
    return s.split("/")[0][:60]


def _region(regions: list[dict], code: str) -> dict | None:
    for r in regions:
        if str(r.get("region", "")).upper() == code:
            return r
    return None


def build_view_model(report_json: dict) -> tuple[dict, list[str]]:
    warnings: list[str] = []
    lang = _report_lang(report_json)
    L = i18n_labels(lang)
    meta = report_json.get("meta", {}) or {}
    subject = report_json.get("subject", {}) or {}
    audit = report_json.get("auditSummary") or {}
    risk = report_json.get("riskSummary") or {}
    offer = report_json.get("offer") or {}

    if not audit:
        warnings.append("auditSummary missing from report_json; analytical pages use fallbacks.")

    search = audit.get("searchSummary", {}) or {}
    surfaces = audit.get("surfacesSummary", {}) or {}
    wiki = audit.get("wikipediaSummary", {}) or {}
    compliance = audit.get("complianceDatabaseSummary", {}) or {}
    data_quality = audit.get("dataQualitySummary", {}) or {}
    regions_raw = audit.get("regions", []) or []

    overall_risk = risk_level(audit.get("overallRiskLevel") or risk.get("highestRiskLevel"))

    def region_vm(code: str) -> dict:
        r = _region(regions_raw, code)
        if not r:
            warnings.append(f"No evidence collected for region {code}.")
            return {
                "code": code,
                "present": False,
                "language": "ru" if code == "RU" else "en",
                "organicTotal": 0,
                "organicNegative": 0,
                "organicNegativeShare": "0%",
                "uniqueNegativeUrls": 0,
                "suggestions": "0/0",
                "images": "0/0",
                "videos": "0/0",
                "knowledgeBlockStatus": "ABSENT",
                "riskLevel": "UNKNOWN",
                "conclusion": L["no_evidence_region"].format(label=code),
                "topResults": [],
                "topSuggestions": [],
                "topImages": [],
                "topVideos": [],
            }
        return {
            "code": code,
            "present": (r.get("organicTotal", 0) or 0) + len(r.get("topSuggestions", []) or []) > 0,
            "language": r.get("language", "en"),
            "organicTotal": r.get("organicTotal", 0),
            "organicNegative": r.get("organicNegative", 0),
            "organicNegativeShare": pct(r.get("organicNegativeShare", 0)),
            "uniqueNegativeUrls": r.get("uniqueNegativeUrls", 0),
            "suggestions": f"{r.get('suggestionsNegative', 0)}/{r.get('suggestionsTotal', 0)}",
            "images": f"{r.get('imagesNegative', 0)}/{r.get('imagesTotal', 0)}",
            "videos": f"{r.get('videosNegative', 0)}/{r.get('videosTotal', 0)}",
            "knowledgeBlockStatus": r.get("knowledgeBlockStatus", "ABSENT"),
            "riskLevel": risk_level(r.get("regionRiskLevel")),
            "conclusion": r.get("regionConclusion", ""),
            "topResults": [
                {
                    "provider": str(x.get("provider", "")),
                    "rank": "" if x.get("rank") is None else str(x.get("rank")),
                    "domain": domain(x.get("domain") or x.get("url")),
                    "title": truncate(x.get("title"), 70),
                    "classification": str(x.get("classification", "")),
                }
                for x in (r.get("topResults", []) or [])[:20]
            ],
            "topSuggestions": [truncate(s, 80) for s in (r.get("topSuggestions", []) or [])[:15]],
            "topImages": [
                {"title": truncate(i.get("title"), 60), "url": domain(i.get("url"))}
                for i in (r.get("topImages", []) or [])[:10]
            ],
            "topVideos": [
                {"title": truncate(v.get("title"), 60), "url": domain(v.get("url"))}
                for v in (r.get("topVideos", []) or [])[:10]
            ],
        }

    if not data_quality.get("warnings"):
        pass
    else:
        warnings.extend(str(w) for w in data_quality.get("warnings", []))

    currency = offer.get("currency", "EUR")

    def price(value: Any) -> str:
        try:
            return f"{int(value):,} {currency}"
        except (TypeError, ValueError):
            return f"0 {currency}"

    product = offer.get("productName", L["op_default_product"])
    offer_pages = [
        {
            "title": L["offer_product_overview"],
            "subtitle": product,
            "bullets": list(L["op_product_overview_bullets"]),
        },
        {
            "title": L["op_solution1_title"],
            "subtitle": f"{offer.get('solution1Title', '')} — {price(offer.get('solution1Price'))}",
            "bullets": list(L["op_solution1_bullets"]),
        },
        {
            "title": L["op_solution2_title"],
            "subtitle": f"{offer.get('solution2Title', '')} — {price(offer.get('solution2Price'))}",
            "bullets": list(L["op_solution2_bullets"]),
        },
        {
            "title": L["op_solution3_title"],
            "subtitle": f"{offer.get('solution3Title', '')} — {price(offer.get('solution3Price'))}",
            "bullets": list(L["op_solution3_bullets"]),
        },
        {
            "title": L["op_process_title"],
            "subtitle": L["op_process_subtitle"],
            "bullets": list(L["op_process_bullets"]),
        },
        {
            "title": L["op_pricing_title"],
            "subtitle": offer.get("pricingNotes", ""),
            "table": {
                "columns": [L["th_package"], L["th_price"]],
                "rows": [
                    [offer.get("solution1Title", ""), price(offer.get("solution1Price"))],
                    [offer.get("solution2Title", ""), price(offer.get("solution2Price"))],
                    [offer.get("solution3Title", ""), price(offer.get("solution3Price"))],
                ],
            },
            "bullets": [],
        },
        {
            "title": L["op_about_title"],
            "subtitle": offer.get("companyName", product),
            "bullets": [
                L["op_contact"].format(email=offer.get("contactEmail", "")),
                L["op_website"].format(website=offer.get("website", "")),
                L["op_about_note"],
            ],
        },
    ]

    view_model = {
        "report_language": lang,
        "labels": L,
        "meta": {
            "watermark": watermark_text(lang, meta.get("watermark")),
            "caseNumber": meta.get("caseNumber", ""),
            "title": meta.get("title", L["op_default_product"]),
            "generatedAt": fmt_date(meta.get("generatedAt") or audit.get("generatedAt")),
            "brand": offer.get("companyName", L["op_default_product"]),
        },
        "cover": {
            "reportTitle": meta.get("title", L["op_default_product"]),
            "subjectFullName": subject.get("fullName", audit.get("subjectFullName", L["unknown_subject"])),
            "auditDate": fmt_date(meta.get("generatedAt") or audit.get("generatedAt")),
            "brand": offer.get("companyName", L["op_default_product"]),
            "overallRiskLevel": overall_risk,
        },
        "executiveSummary": {
            "bullets": list(audit.get("executiveSummary", []) or []) or [L["no_audit_summary"]],
            "keyFindings": list(audit.get("keyFindings", []) or []),
            "overallRiskLevel": overall_risk,
        },
        "riskMatrix": {
            "subject": subject.get("fullName", L["unknown_subject"]),
            "overallRiskLevel": overall_risk,
            "highestRiskLevel": risk_level(risk.get("highestRiskLevel", overall_risk)),
            "totalFindings": (audit.get("riskSummary", {}) or risk).get("totalFindings", 0),
            "topThemes": [
                {"theme": str(t.get("theme", "")), "count": t.get("count", 0)}
                for t in (search.get("topNegativeThemes", []) or [])
            ],
            "byLevel": (audit.get("riskSummary", {}) or risk).get("findingsByLevel", {}) or {},
            "consequences": list(L["rm_default_consequences"]),
        },
        "digitalProfileOverview": {
            "negativeShareRu": pct((_region(regions_raw, "RU") or {}).get("organicNegativeShare", 0)),
            "negativeShareUae": pct((_region(regions_raw, "UAE") or {}).get("organicNegativeShare", 0)),
            "searchTotal": search.get("totalResults", 0),
            "searchNegative": search.get("negativeResults", 0),
            "searchNegativeShare": pct(search.get("negativeShare", 0)),
            "complianceSummary": compliance.get("conclusion", L["no_compliance_recorded"]),
            "wikipediaStatus": L["present"] if wiki.get("exists") else L["not_found"],
        },
        "regions": {"RU": region_vm("RU"), "UAE": region_vm("UAE")},
        "search": {
            "negativeDomains": list(search.get("negativeDomains", []) or [])[:10],
            "topNegativeThemes": [
                {"theme": str(t.get("theme", "")), "count": t.get("count", 0)}
                for t in (search.get("topNegativeThemes", []) or [])
            ],
            "topNegativeUrls": [
                {"title": truncate(u.get("title") or u.get("url"), 70), "url": domain(u.get("url"))}
                for u in (search.get("topNegativeUrls", []) or [])[:10]
            ],
        },
        "surfaces": {
            "screenshots": surfaces.get("screenshots", 0),
            "syntheticSnapshots": surfaces.get("syntheticSnapshots", 0),
            "knowledgeBlocks": _get(surfaces, "knowledgeBlocks", "total", default=0),
            "knowledgeMismatches": _get(surfaces, "knowledgeBlocks", "mismatches", default=0),
        },
        "wikipedia": {
            "exists": bool(wiki.get("exists")),
            "status": L["present"] if wiki.get("exists") else L["not_found"],
            "pageUrl": wiki.get("pageUrl") or "",
            "language": wiki.get("language") or "",
            "notabilityScore": wiki.get("notabilityScore", 0),
            "conclusion": wiki.get("conclusion", ""),
        },
        "complianceDatabases": {
            "providersChecked": list(compliance.get("providersChecked", []) or []),
            "activeMatches": compliance.get("activeMatches", 0),
            "pepMatches": compliance.get("pepMatches", 0),
            "rcaMatches": compliance.get("rcaMatches", 0),
            "sanctionsMatches": compliance.get("sanctionsMatches", 0),
            "adverseMediaMatches": compliance.get("adverseMediaMatches", 0),
            "conclusion": compliance.get("conclusion", ""),
        },
        "riskFindings": {
            "topFindings": [
                {
                    "severity": risk_level(f.get("severity")),
                    "theme": str(f.get("theme", "")),
                    "title": truncate(f.get("title"), 70),
                    "reviewStatus": str(f.get("reviewStatus", "PENDING")),
                    "evidenceCount": f.get("evidenceCount", 0),
                }
                for f in ((audit.get("riskSummary", {}) or risk).get("topFindings", []) or [])
            ],
            "totalFindings": (audit.get("riskSummary", {}) or risk).get("totalFindings", 0),
        },
        "dataQuality": {
            "evidenceCount": data_quality.get("evidenceCount", 0),
            "reviewedFindings": data_quality.get("reviewedFindings", 0),
            "pendingFindings": data_quality.get("pendingFindings", 0),
            "dismissedFindings": data_quality.get("dismissedFindings", 0),
            "missingSections": list(data_quality.get("missingSections", []) or []),
            "warnings": list(data_quality.get("warnings", []) or []),
        },
        "recommendedActions": list(audit.get("recommendedActions", []) or [])
        or [L["recommended_fallback"]],
        "offerPages": offer_pages,
    }

    return view_model, warnings


# ===========================================================================
# Template v2 — full 36-page dynamic audit view model (Stage K2)
# ===========================================================================

COMPLIANCE_THEMES = {"sanctions", "pep_rca", "compliance_database"}


def _dynamic_page(report_json: dict, kind: str) -> dict | None:
    for p in report_json.get("dynamicPages", []) or []:
        if p.get("kind") == kind:
            return p
    return None


def _region_block(
    r: dict | None, code: str, label: str, wiki: dict, findings: list[dict], L: dict
) -> dict:
    if not r:
        no_data = L["no_evidence_region"].format(label=label)
        return {
            "code": code,
            "label": label,
            "present": False,
            "noDataText": no_data,
            "riskLevel": "UNKNOWN",
            "conclusion": no_data,
            "summary": {},
            "organicOverview": {},
            "topResults": [],
            "themes": {"topThemes": [], "negativeDomains": [], "negativeUrls": []},
            "suggestions": {"total": 0, "negative": 0, "list": []},
            "relatedQueries": {"total": 0, "negative": 0, "list": []},
            "images": {"total": 0, "negative": 0, "items": []},
            "videos": {"total": 0, "negative": 0, "items": []},
            "knowledgeBlock": None,
            "wikipedia": wiki,
            "riskFindings": [],
            "dataQuality": {"organic": 0, "surfaces": 0, "warnings": [L["no_region_data"].format(label=label)]},
            "recommendedActions": [],
            "evidenceAppendix": [],
        }

    organic_total = r.get("organicTotal", 0) or 0
    surfaces_total = (
        (r.get("suggestionsTotal", 0) or 0)
        + (r.get("relatedQueriesTotal", 0) or 0)
        + (r.get("imagesTotal", 0) or 0)
        + (r.get("videosTotal", 0) or 0)
    )
    present = organic_total + surfaces_total > 0

    return {
        "code": code,
        "label": label,
        "present": present,
        "noDataText": "" if present else L["no_evidence_region"].format(label=label),
        "riskLevel": risk_level(r.get("regionRiskLevel")),
        "conclusion": r.get("regionConclusion", ""),
        "summary": {
            "organicTotal": organic_total,
            "organicNegative": r.get("organicNegative", 0),
            "organicNegativeShare": pct(r.get("organicNegativeShare", 0)),
            "suggestions": f"{r.get('suggestionsNegative', 0)}/{r.get('suggestionsTotal', 0)}",
            "images": f"{r.get('imagesNegative', 0)}/{r.get('imagesTotal', 0)}",
            "videos": f"{r.get('videosNegative', 0)}/{r.get('videosTotal', 0)}",
            "knowledgeBlockStatus": r.get("knowledgeBlockStatus", "ABSENT"),
        },
        "organicOverview": {
            "organicTotal": organic_total,
            "organicNegative": r.get("organicNegative", 0),
            "uniqueNegativeUrls": r.get("uniqueNegativeUrls", 0),
            "totalUniqueUrls": r.get("totalUniqueUrls", 0),
            "negativeShare": pct(r.get("organicNegativeShare", 0)),
            "observedQueries": [truncate(s, 70) for s in (r.get("topSuggestions", []) or [])[:8]],
        },
        "topResults": [
            {
                "provider": str(x.get("provider", "")),
                "rank": "" if x.get("rank") is None else str(x.get("rank")),
                "domain": domain(x.get("domain") or x.get("url")),
                "title": truncate(x.get("title"), 60),
                "classification": str(x.get("classification", "")),
            }
            for x in (r.get("topResults", []) or [])[:20]
        ],
        "themes": {
            "topThemes": [
                {"theme": str(t.get("theme", "")), "count": t.get("count", 0)}
                for t in (r.get("topThemes", []) or [])
            ],
            "negativeDomains": list(r.get("topNegativeDomains", []) or [])[:10],
            "negativeUrls": [
                {
                    "title": truncate(u.get("title"), 60),
                    "domain": domain(u.get("domain") or u.get("url")),
                    "classification": str(u.get("classification", "")),
                }
                for u in (r.get("topNegativeUrls", []) or [])[:10]
            ],
        },
        "suggestions": {
            "total": r.get("suggestionsTotal", 0),
            "negative": r.get("suggestionsNegative", 0),
            "list": [truncate(s, 80) for s in (r.get("topSuggestions", []) or [])[:15]],
        },
        "relatedQueries": {
            "total": r.get("relatedQueriesTotal", 0),
            "negative": r.get("relatedQueriesNegative", 0),
            "list": [truncate(s, 80) for s in (r.get("topRelatedQueries", []) or [])[:15]],
        },
        "images": {
            "total": r.get("imagesTotal", 0),
            "negative": r.get("imagesNegative", 0),
            "items": [
                {"title": truncate(i.get("title"), 50), "source": domain(i.get("url"))}
                for i in (r.get("topImages", []) or [])[:10]
            ],
        },
        "videos": {
            "total": r.get("videosTotal", 0),
            "negative": r.get("videosNegative", 0),
            "items": [
                {"title": truncate(v.get("title"), 50), "source": domain(v.get("url"))}
                for v in (r.get("topVideos", []) or [])[:10]
            ],
        },
        "knowledgeBlock": (
            {
                "status": r.get("knowledgeBlockStatus", "ABSENT"),
                "title": truncate((r.get("knowledgeBlock") or {}).get("title"), 80),
                "snippet": truncate((r.get("knowledgeBlock") or {}).get("snippet"), 180),
                "source": domain((r.get("knowledgeBlock") or {}).get("source")),
            }
            if r.get("knowledgeBlock")
            else {"status": r.get("knowledgeBlockStatus", "ABSENT"), "title": "", "snippet": "", "source": ""}
        ),
        "wikipedia": wiki,
        "riskFindings": findings,
        "dataQuality": {
            "organic": organic_total,
            "surfaces": surfaces_total,
            "warnings": [] if present else [L["no_region_data"].format(label=label)],
        },
        "recommendedActions": [],
        "evidenceAppendix": [
            {
                "title": truncate(e.get("title"), 55),
                "domain": domain(e.get("domain")),
                "provider": str(e.get("provider", "")),
                "classification": str(e.get("classification", "")),
            }
            for e in (r.get("evidenceAppendix", []) or [])[:15]
        ],
    }


def build_view_model_v2(report_json: dict) -> tuple[dict, list[str]]:
    base, warnings = build_view_model(report_json)
    lang = base["report_language"]
    L = base["labels"]
    audit = report_json.get("auditSummary") or {}
    offer = report_json.get("offer") or {}
    regions_raw = audit.get("regions", []) or []

    top_findings = [
        {
            "severity": risk_level(f.get("severity")),
            "theme": str(f.get("theme", "")),
            "title": truncate(f.get("title"), 70),
            "reviewStatus": str(f.get("reviewStatus", "PENDING")),
            "evidenceCount": f.get("evidenceCount", 0),
        }
        for f in ((audit.get("riskSummary", {}) or {}).get("topFindings", []) or [])
    ]
    search_findings = [f for f in top_findings if f["theme"] not in COMPLIANCE_THEMES]
    compliance_findings = [f for f in top_findings if f["theme"] in COMPLIANCE_THEMES]

    wiki = base["wikipedia"]
    recommended = base["recommendedActions"]

    ru = _region_block(_region(regions_raw, "RU"), "RU", L["region_ru"], wiki, search_findings, L)
    intl = _region_block(_region(regions_raw, "UAE"), "UAE", L["region_intl"], wiki, search_findings, L)
    ru["recommendedActions"] = recommended
    intl["recommendedActions"] = recommended

    # Compliance per-provider rows come from the report's compliance dynamic page.
    comp_page = _dynamic_page(report_json, "COMPLIANCE_DATABASES")
    comp_rows = []
    if comp_page and comp_page.get("table"):
        for row in comp_page["table"].get("rows", []) or []:
            comp_rows.append(
                {
                    "provider": str(row[0]) if len(row) > 0 else "",
                    "importMethod": str(row[1]) if len(row) > 1 else "",
                    "matchType": str(row[2]) if len(row) > 2 else "",
                    "score": str(row[3]) if len(row) > 3 else "",
                }
            )
    cdb = base["complianceDatabases"]
    compliance = {
        **cdb,
        "rows": comp_rows,
        "dowWorldRows": [r for r in comp_rows if r["provider"] in ("DOW_JONES", "WORLD_CHECK")],
        "lexisRows": [r for r in comp_rows if r["provider"] == "LEXISNEXIS"],
        "findings": compliance_findings,
        "dataQuality": base["dataQuality"],
    }

    final_conclusion = {
        "overallRiskLevel": base["cover"]["overallRiskLevel"],
        "topThemes": base["riskMatrix"].get("topThemes", []),
        "recommendedActions": recommended,
        "warnings": base["dataQuality"]["warnings"],
        "missingSections": base["dataQuality"]["missingSections"],
    }

    cover = {
        **base["cover"],
        "website": offer.get("website", ""),
        "contact": offer.get("contactEmail", ""),
    }

    contents = {"sections": list(L["contents_list"])}

    executive = {
        **base["executiveSummary"],
        "keyFindings": [
            {"title": str(g.get("title", "")), "points": list(g.get("points", []) or [])}
            for g in (audit.get("keyFindings", []) or [])
        ][:5],
        "dataQualityWarning": (base["dataQuality"]["warnings"] or [""])[0],
    }

    risk_matrix = _build_risk_matrix_rows(base, ru, intl, wiki)

    vm = {
        "report_language": lang,
        "labels": L,
        "meta": base["meta"],
        "cover": cover,
        "contents": contents,
        "executiveSummary": executive,
        "riskMatrix": risk_matrix,
        "overview": base["digitalProfileOverview"] | {"overallRiskLevel": base["cover"]["overallRiskLevel"]},
        "ru": ru,
        "intl": intl,
        "compliance": compliance,
        "finalConclusion": final_conclusion,
        "offerPages": base["offerPages"],
        "offer": offer,
    }
    return vm, warnings


# ===========================================================================
# Template v3 — polished view model: adds a structured commercial offerBlock
# ===========================================================================

def _fmt_price(value: Any, currency: str) -> str:
    try:
        return f"{int(value):,} {currency}"
    except (TypeError, ValueError):
        return f"0 {currency}"


def _offer_block(offer: dict, L: dict) -> dict:
    currency = offer.get("currency", "EUR")
    brand = offer.get("brandName") or offer.get("companyName") or L["op_default_product"]

    solutions_raw = offer.get("solutions") or []
    if not solutions_raw:
        # Fallback to flat fields so the block is never empty.
        solutions_raw = [
            {
                "title": "Solution 1 — Digital Profile",
                "subtitle": offer.get("solution1Title", "Basic"),
                "price": offer.get("solution1Price", 0),
            },
            {
                "title": "Solution 2 — Compliance Databases",
                "subtitle": offer.get("solution2Title", "Standard"),
                "price": offer.get("solution2Price", 0),
            },
            {
                "title": "Solution 3 — Wikipedia & Authority",
                "subtitle": offer.get("solution3Title", "Enterprise"),
                "price": offer.get("solution3Price", 0),
            },
        ]

    solutions = []
    for s in solutions_raw:
        solutions.append(
            {
                "title": s.get("title", ""),
                "subtitle": s.get("subtitle", ""),
                "objective": s.get("objective", ""),
                "price": _fmt_price(s.get("price"), s.get("currency", currency)),
                "duration": s.get("duration", "—"),
                "includedItems": list(s.get("includedItems", []) or []),
                "deliverables": list(s.get("deliverables", []) or []),
                "expectedResults": list(s.get("expectedResults", []) or []),
                "workPlan": list(s.get("workPlan", []) or []),
                "pricingNotes": s.get("pricingNotes", offer.get("pricingNotes", "")),
            }
        )

    return {
        "cover": {
            "title": offer.get("productName", brand),
            "subtitle": offer.get("reportSubtitle", L["offer_default_subtitle"]),
            "brand": brand,
        },
        "productOverview": {
            "description": offer.get("companyDescription", ""),
            "includedItems": [s["subtitle"] for s in solutions],
            "value": L["offer_value"],
            "audienceNote": L["offer_audience_note"],
        },
        "solutions": solutions,
        "process": {"steps": list(offer.get("processSteps", []) or [])},
        "contact": {
            "company": offer.get("companyName", brand),
            "email": offer.get("contactEmail", ""),
            "website": offer.get("website", ""),
            "cta": offer.get("callToAction", ""),
            "disclaimers": list(offer.get("disclaimers", []) or []),
        },
    }


def _serp_snapshot_vm(ss: dict | None, L: dict) -> dict:
    """Normalize the optional report_json.serpSnapshot into a safe view model.

    The image arrives as render-time base64 (``imageBase64``) injected by the
    Node renderer service — the stateless renderer has no access to private
    storage. ``exists`` is true only when bytes are present and decodable, so a
    missing/unreadable image safely falls back to the no-data card.
    """
    ss = ss or {}
    image_b64 = ss.get("imageBase64")
    image_bytes = None
    if image_b64:
        try:
            image_bytes = base64.b64decode(image_b64)
        except Exception:  # noqa: BLE001 - any decode error -> treat as missing
            image_bytes = None
    meta = ss.get("metadata") or {}
    # Stage N1.2 — map sourceMode to a localized provenance sentence.
    source_mode = str(meta.get("sourceMode") or "MOCK_ONLY").upper()
    source_note_map = {
        "REAL_ONLY": L["serp_snapshot_source_real"],
        "MIXED": L["serp_snapshot_source_mixed"],
        "MOCK_ONLY": L["serp_snapshot_source_mock"],
        "EMPTY": L["serp_snapshot_source_empty"],
    }
    return {
        "exists": bool(image_bytes),
        "image_bytes": image_bytes,
        "id": str(ss.get("id", "")),
        "query": str(ss.get("query", "")),
        "mode": str(ss.get("mode", "SYNTHETIC")),
        "themeCount": meta.get("themeCount", 0) or 0,
        "highlightedCount": meta.get("highlightedCount", 0) or 0,
        "engines": list(meta.get("engines", []) or []),
        "generatedAt": fmt_date(meta.get("generatedAt")),
        "width": int(meta.get("width", 0) or 0),
        "height": int(meta.get("height", 0) or 0),
        "title": L["serp_snapshot_page_title"],
        "subtitle": L["serp_snapshot_page_subtitle"],
        "caption": L["serp_snapshot_caption"],
        "source_mode": source_mode,
        "source_note": source_note_map.get(source_mode, L["serp_snapshot_source_mock"]),
    }


def build_view_model_v3(report_json: dict, audience: str = "internal") -> tuple[dict, list[str]]:
    vm, warnings = build_view_model_v2(report_json)
    offer = report_json.get("offer") or {}
    vm["audience"] = "client" if str(audience).lower() == "client" else "internal"
    vm["offerBlock"] = _offer_block(offer, vm["labels"])
    serp = _serp_snapshot_vm(report_json.get("serpSnapshot"), vm["labels"])
    vm["serp_snapshot"] = serp
    if not serp["exists"]:
        # Stage S1.5 renderWarning: the ORION-style page uses fallback text.
        warnings.append("SERP snapshot is missing; search-screens page uses fallback text.")
    return vm, warnings


def _build_risk_matrix_rows(base: dict, ru: dict, intl: dict, wiki: dict) -> dict:
    cdb = base["complianceDatabases"]
    L = base["labels"]
    uae_share = intl["summary"].get("organicNegativeShare", "0%") if intl["present"] else L["rm_no_data"]
    rows = [
        {
            "area": L["area_search_profile"],
            "problems": L["rm_problems_search"].format(
                ru=ru["summary"].get("organicNegativeShare", "0%"), uae=uae_share
            ),
            "level": risk_level(
                ru["riskLevel"] if ru["present"] else (intl["riskLevel"] if intl["present"] else "UNKNOWN")
            ),
            "consequences": L["cons_reputational"],
        },
        {
            "area": L["area_wikipedia"],
            "problems": L["rm_wiki_exists"] if wiki.get("exists") else L["rm_wiki_absent"],
            "level": "LOW" if wiki.get("exists") else "MEDIUM",
            "consequences": L["cons_narrative"],
        },
        {
            "area": L["area_sanctions"],
            "problems": L["rm_problems_sanctions"].format(
                s=cdb["sanctionsMatches"], p=cdb["pepMatches"], r=cdb["rcaMatches"]
            ),
            "level": "CRITICAL" if cdb["sanctionsMatches"] > 0 else ("HIGH" if cdb["pepMatches"] + cdb["rcaMatches"] > 0 else "LOW"),
            "consequences": L["cons_compliance"],
        },
        {
            "area": L["area_intl_compliance"],
            "problems": L["rm_problems_intl"].format(
                a=cdb["activeMatches"], n=len(cdb["providersChecked"])
            ),
            "level": "HIGH" if cdb["activeMatches"] > 0 else ("LOW" if cdb["providersChecked"] else "UNKNOWN"),
            "consequences": L["cons_edd"],
        },
        {
            "area": L["area_other_sources"],
            "problems": L["rm_problems_other"].format(
                n=ru["suggestions"]["negative"] + ru["images"]["negative"] + ru["videos"]["negative"]
            ),
            "level": risk_level(ru["riskLevel"]) if ru["present"] else "UNKNOWN",
            "consequences": L["cons_secondary"],
        },
    ]
    return {
        "subject": base["riskMatrix"]["subject"],
        "overallRiskLevel": base["cover"]["overallRiskLevel"],
        "rows": rows,
        "topThemes": base["riskMatrix"].get("topThemes", []),
    }
