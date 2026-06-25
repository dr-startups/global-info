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
