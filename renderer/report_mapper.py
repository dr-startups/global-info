"""Map a Digital Profile ``report_json`` into a safe TemplateViewModel (Stage K1).

This is the single normalization layer for the corporate template renderer. It
coerces every optional field to a safe value so the renderer never crashes on
empty arrays / missing sections, formats percentages / dates / risk levels, and
collects warnings about missing data.

No LLM, no network — pure transformation of the data passed in report_json.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any


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
                "conclusion": f"No evidence collected for this region ({code}).",
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

    offer_pages = [
        {
            "title": "Product overview",
            "subtitle": offer.get("productName", "Digital Profile Audit"),
            "bullets": [
                "Evidence-first digital profile and compliance audits.",
                "Every statement references verifiable evidence (URL, screenshot, record).",
                "Official-API or manual import only — no scraping, no leaked databases.",
            ],
        },
        {
            "title": "Solution 1 — Digital Profile",
            "subtitle": f"{offer.get('solution1Title', 'Basic')} — {price(offer.get('solution1Price'))}",
            "bullets": [
                "Open-source search audit across regions.",
                "Search surfaces: suggestions, images, videos, knowledge blocks.",
                "Risk findings with human review.",
            ],
        },
        {
            "title": "Solution 2 — Compliance Databases",
            "subtitle": f"{offer.get('solution2Title', 'Standard')} — {price(offer.get('solution2Price'))}",
            "bullets": [
                "Screening via LexisNexis / Dow Jones / World-Check (official API or manual import).",
                "PEP / RCA / sanctions / adverse-media categorization.",
                "Documented match status and evidence.",
            ],
        },
        {
            "title": "Solution 3 — Wikipedia & Authority",
            "subtitle": f"{offer.get('solution3Title', 'Enterprise')} — {price(offer.get('solution3Price'))}",
            "bullets": [
                "Authoritative profile assessment and notability review.",
                "Knowledge-panel consistency checks.",
                "Ongoing monitoring of the digital footprint.",
            ],
        },
        {
            "title": "Process",
            "subtitle": "How an engagement runs",
            "bullets": [
                "1. Scope & lawful basis.",
                "2. Evidence collection (search, surfaces, compliance).",
                "3. Deterministic risk classification.",
                "4. Analyst review.",
                "5. Report delivery (PPTX / PDF).",
            ],
        },
        {
            "title": "Pricing",
            "subtitle": offer.get("pricingNotes", ""),
            "table": {
                "columns": ["Package", "Price"],
                "rows": [
                    [offer.get("solution1Title", "Basic"), price(offer.get("solution1Price"))],
                    [offer.get("solution2Title", "Standard"), price(offer.get("solution2Price"))],
                    [offer.get("solution3Title", "Enterprise"), price(offer.get("solution3Price"))],
                ],
            },
            "bullets": [],
        },
        {
            "title": "About",
            "subtitle": offer.get("companyName", "Digital Profile Audit"),
            "bullets": [
                f"Contact: {offer.get('contactEmail', '')}",
                f"Website: {offer.get('website', '')}",
                "Reports are advisory; all findings require manual verification.",
            ],
        },
    ]

    view_model = {
        "meta": {
            "watermark": meta.get("watermark"),
            "caseNumber": meta.get("caseNumber", ""),
            "title": meta.get("title", "Digital Profile Audit"),
            "generatedAt": fmt_date(meta.get("generatedAt") or audit.get("generatedAt")),
            "brand": offer.get("companyName", "Digital Profile Audit"),
        },
        "cover": {
            "reportTitle": meta.get("title", "Digital Profile Audit"),
            "subjectFullName": subject.get("fullName", audit.get("subjectFullName", "Unknown subject")),
            "auditDate": fmt_date(meta.get("generatedAt") or audit.get("generatedAt")),
            "brand": offer.get("companyName", "Digital Profile Audit"),
            "overallRiskLevel": overall_risk,
        },
        "executiveSummary": {
            "bullets": list(audit.get("executiveSummary", []) or []) or ["No audit summary available yet."],
            "keyFindings": list(audit.get("keyFindings", []) or []),
            "overallRiskLevel": overall_risk,
        },
        "riskMatrix": {
            "subject": subject.get("fullName", "Unknown subject"),
            "overallRiskLevel": overall_risk,
            "highestRiskLevel": risk_level(risk.get("highestRiskLevel", overall_risk)),
            "totalFindings": (audit.get("riskSummary", {}) or risk).get("totalFindings", 0),
            "topThemes": [
                {"theme": str(t.get("theme", "")), "count": t.get("count", 0)}
                for t in (search.get("topNegativeThemes", []) or [])
            ],
            "byLevel": (audit.get("riskSummary", {}) or risk).get("findingsByLevel", {}) or {},
            "consequences": [
                "Reputational exposure in open-source search.",
                "Compliance review obligations if matches are confirmed.",
                "Potential onboarding / due-diligence delays.",
            ],
        },
        "digitalProfileOverview": {
            "negativeShareRu": pct((_region(regions_raw, "RU") or {}).get("organicNegativeShare", 0)),
            "negativeShareUae": pct((_region(regions_raw, "UAE") or {}).get("organicNegativeShare", 0)),
            "searchTotal": search.get("totalResults", 0),
            "searchNegative": search.get("negativeResults", 0),
            "searchNegativeShare": pct(search.get("negativeShare", 0)),
            "complianceSummary": compliance.get("conclusion", "No compliance screening recorded."),
            "wikipediaStatus": "Present" if wiki.get("exists") else "Not found",
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
            "status": "Page exists" if wiki.get("exists") else "No page found",
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
        or ["Expand data collection and re-run the audit."],
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


def _region_block(r: dict | None, code: str, label: str, wiki: dict, findings: list[dict]) -> dict:
    if not r:
        return {
            "code": code,
            "label": label,
            "present": False,
            "noDataText": f"No evidence collected for this region ({label}).",
            "riskLevel": "UNKNOWN",
            "conclusion": f"No evidence collected for this region ({label}).",
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
            "dataQuality": {"organic": 0, "surfaces": 0, "warnings": [f"No {label} data collected."]},
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
        "noDataText": "" if present else f"No evidence collected for this region ({label}).",
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
            "warnings": [] if present else [f"No {label} data collected."],
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

    ru = _region_block(_region(regions_raw, "RU"), "RU", "Russia", wiki, search_findings)
    intl = _region_block(_region(regions_raw, "UAE"), "UAE", "UAE / International", wiki, search_findings)
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

    contents = {
        "sections": [
            "1. Executive Summary",
            "2. Russia: Digital Profile",
            "3. UAE / International: Digital Profile",
            "4. Compliance Databases",
            "5. Offer / Solutions",
            "6. About",
        ]
    }

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


def _build_risk_matrix_rows(base: dict, ru: dict, intl: dict, wiki: dict) -> dict:
    cdb = base["complianceDatabases"]
    rows = [
        {
            "area": "Search profile (Google/Yandex)",
            "problems": f"RU negative share {ru['summary'].get('organicNegativeShare', '0%')}, "
            f"UAE {intl['summary'].get('organicNegativeShare', '0%') if intl['present'] else 'no data'}",
            "level": risk_level(
                ru["riskLevel"] if ru["present"] else (intl["riskLevel"] if intl["present"] else "UNKNOWN")
            ),
            "consequences": "Reputational exposure in open-source search.",
        },
        {
            "area": "Wikipedia",
            "problems": "Authoritative page exists" if wiki.get("exists") else "No authoritative page found",
            "level": "LOW" if wiki.get("exists") else "MEDIUM",
            "consequences": "Limited control over the public narrative.",
        },
        {
            "area": "Sanctions / compliance mentions",
            "problems": f"{cdb['sanctionsMatches']} sanctions, {cdb['pepMatches']} PEP, {cdb['rcaMatches']} RCA match(es)",
            "level": "CRITICAL" if cdb["sanctionsMatches"] > 0 else ("HIGH" if cdb["pepMatches"] + cdb["rcaMatches"] > 0 else "LOW"),
            "consequences": "Compliance obligations and onboarding delays if confirmed.",
        },
        {
            "area": "International compliance databases",
            "problems": f"{cdb['activeMatches']} active match(es) across {len(cdb['providersChecked'])} provider(s)",
            "level": "HIGH" if cdb["activeMatches"] > 0 else ("LOW" if cdb["providersChecked"] else "UNKNOWN"),
            "consequences": "Enhanced due-diligence may be required.",
        },
        {
            "area": "Other sources / search surfaces",
            "problems": f"Negative suggestions/images/videos detected: "
            f"{ru['suggestions']['negative'] + ru['images']['negative'] + ru['videos']['negative']}",
            "level": risk_level(ru["riskLevel"]) if ru["present"] else "UNKNOWN",
            "consequences": "Secondary reputational signals to monitor.",
        },
    ]
    return {
        "subject": base["riskMatrix"]["subject"],
        "overallRiskLevel": base["cover"]["overallRiskLevel"],
        "rows": rows,
        "topThemes": base["riskMatrix"].get("topThemes", []),
    }
