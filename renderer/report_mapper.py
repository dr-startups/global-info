"""Map a Digital Profile ``report_json`` into a safe TemplateViewModel (Stage K1).

This is the single normalization layer for the corporate template renderer. It
coerces every optional field to a safe value so the renderer never crashes on
empty arrays / missing sections, formats percentages / dates / risk levels, and
collects warnings about missing data.

No LLM, no network — pure transformation of the data passed in report_json.
"""

from __future__ import annotations

import base64
import re
from datetime import datetime
from typing import Any

from report_i18n import labels as i18n_labels, normalize_lang, watermark_text

_INTERNAL_HYGIENE_RE = re.compile(
    r"demo\s*/\s*mock|mock rows|excluded from production|исключены из метрик|"
    r"data hygiene|fixture|sourcemode|provideradapter|raw metadata|"
    r"unlinked risk findings|несвязанн|serp snapshot.*refresh|stale or inconsistent serp|"
    r"serp snapshot не удалось|устаревший.*serp snapshot",
    re.I,
)


def _is_internal_hygiene_text(text: str) -> bool:
    return bool(_INTERNAL_HYGIENE_RE.search(str(text or "")))


def _has_cyrillic(text: str) -> bool:
    return bool(re.search(r"[\u0400-\u04FF]", str(text or "")))


def _filter_client_text_lines(lines: list[str], lang: str) -> list[str]:
    out: list[str] = []
    for line in lines:
        t = str(line or "")
        if _is_internal_hygiene_text(t):
            continue
        if lang == "en" and _has_cyrillic(t):
            continue
        out.append(line)
    return out


def _normalize_report_warning_item(item: Any) -> tuple[str, str]:
    """Return (text, audience) from structured or legacy warning entry."""
    if isinstance(item, dict):
        return str(item.get("text", "")), str(item.get("audience", "all"))
    return str(item), "internal" if _is_internal_hygiene_text(str(item)) else "all"


def _warnings_for_render(raw: list[Any] | None, internal: bool) -> list[str]:
    out: list[str] = []
    for item in raw or []:
        text, aud = _normalize_report_warning_item(item)
        if not text.strip():
            continue
        if not internal and (aud == "internal" or _is_internal_hygiene_text(text)):
            continue
        if text not in out:
            out.append(text)
    return out


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

COMPLIANCE_RISK_TYPES = (
    "SANCTIONS",
    "PEP",
    "WATCHLIST",
    "ADVERSE_MEDIA",
    "LAW_ENFORCEMENT",
    "LEGAL",
    "OTHER",
)

_PROVIDER_LABELS = {
    "DOW_JONES": "Dow Jones",
    "LEXISNEXIS": "LexisNexis",
    "WORLD_CHECK": "World-Check",
    "MANUAL_IMPORT": "Manual Import",
    "OTHER": "Other",
}


def _parse_risk_types(raw: Any) -> list[str]:
    if isinstance(raw, list):
        return [str(x).strip().upper() for x in raw if str(x).strip()]
    if raw is None:
        return []
    text = str(raw).strip()
    if not text or text == "—":
        return []
    return [p.strip().upper() for p in text.replace(";", ",").split(",") if p.strip()]


def _review_status_label(status: str, L: dict) -> str:
    key = str(status or "PENDING").upper()
    mapping = {
        "PENDING": L["rev_pending"],
        "NEEDS_REVIEW": L["rev_needs_review"],
        "MATCH_CONFIRMED": L["rev_match_confirmed"],
        "FALSE_POSITIVE": L["rev_false_positive"],
        "DISMISSED": L["rev_dismissed"],
    }
    return mapping.get(key, key.replace("_", " ").title())


def _hit_source_label(source: str, import_method: str, L: dict) -> str:
    src = str(source or import_method or "").upper()
    if src in ("MANUAL", "MANUAL_IMPORT") or "MANUAL" in str(import_method or "").upper():
        return L["src_manual_import"]
    if src == "MOCK" or "MOCK" in src:
        return L["src_mock_demo"]
    if src in ("OFFICIAL_API", "REAL"):
        return L["src_real_api"]
    return L["src_manual_import"]


def _provider_source_type(ps: dict, L: dict) -> str:
    name = str(ps.get("name", "")).upper()
    if name == "MANUAL_IMPORT":
        return L["src_manual_import"]
    status = str(ps.get("status", "")).upper()
    if status in ("DISABLED", "NOT_CONFIGURED"):
        return L["src_not_configured"]
    if ps.get("supportsRealCalls") and ps.get("configured") and ps.get("enabled"):
        if status == "PROVIDER_NOT_IMPLEMENTED":
            return L["src_stub"]
        return L["src_real_api"]
    if status == "PROVIDER_NOT_IMPLEMENTED":
        return L["src_stub"]
    return L["src_not_configured"]


def _provider_status_label(ps: dict, L: dict) -> str:
    status = str(ps.get("status", "")).upper()
    if status in ("DISABLED", "NOT_CONFIGURED"):
        return L["src_not_configured"]
    if status == "ENABLED":
        return L["src_real_api"] if ps.get("supportsRealCalls") else L["src_manual_import"]
    if status == "PROVIDER_NOT_IMPLEMENTED":
        return L["src_stub"]
    return status.replace("_", " ").title()


def _parse_comp_row(row: list) -> dict:
    """Parse COMPLIANCE_DATABASES table row (legacy 4-col or current 6-col)."""
    if len(row) >= 6:
        return {
            "provider": str(row[0] or ""),
            "source": str(row[1] or ""),
            "matchedName": str(row[2] or ""),
            "riskTypes": str(row[3] or ""),
            "score": str(row[4] if row[4] is not None else "—"),
            "reviewStatus": str(row[5] or "PENDING"),
            "importMethod": str(row[1] or ""),
            "matchType": str(row[3] or ""),
        }
    return {
        "provider": str(row[0]) if len(row) > 0 else "",
        "importMethod": str(row[1]) if len(row) > 1 else "",
        "matchType": str(row[2]) if len(row) > 2 else "",
        "score": str(row[3]) if len(row) > 3 else "—",
        "source": str(row[1]) if len(row) > 1 else "",
        "matchedName": "",
        "riskTypes": str(row[2]) if len(row) > 2 else "",
        "reviewStatus": "PENDING",
    }


def _risk_type_breakdown(rows: list[dict]) -> list[dict]:
    stats = {rt: {"riskType": rt, "total": 0, "pending": 0, "confirmed": 0, "falsePositive": 0} for rt in COMPLIANCE_RISK_TYPES}
    for r in rows:
        rts = _parse_risk_types(r.get("riskTypes") or r.get("matchType"))
        if not rts:
            rts = ["OTHER"]
        status = str(r.get("reviewStatus", "PENDING")).upper()
        for rt in rts:
            if rt not in stats:
                stats[rt] = {"riskType": rt, "total": 0, "pending": 0, "confirmed": 0, "falsePositive": 0}
            stats[rt]["total"] += 1
            if status in ("PENDING", "NEEDS_REVIEW"):
                stats[rt]["pending"] += 1
            elif status == "MATCH_CONFIRMED":
                stats[rt]["confirmed"] += 1
            elif status in ("FALSE_POSITIVE", "DISMISSED"):
                stats[rt]["falsePositive"] += 1
    return [stats[rt] for rt in COMPLIANCE_RISK_TYPES if stats[rt]["total"] > 0]


def _safe_compliance_finding_title(f: dict, L: dict) -> str:
    status = str(f.get("reviewStatus", "PENDING")).upper()
    theme = str(f.get("theme", "") or "compliance")
    if status == "MATCH_CONFIRMED":
        return L["finding_confirmed"].format(theme=theme)
    return L["finding_potential"].format(theme=theme)


def _is_demo_comp_row(row: dict) -> bool:
    src = str(row.get("source", "") or row.get("importMethod", "")).upper()
    if src == "MOCK" or "MOCK" in src:
        return True
    return False


def _filter_comp_rows(rows: list[dict], include_demo: bool) -> list[dict]:
    if include_demo:
        return rows
    return [r for r in rows if not _is_demo_comp_row(r)]


def _build_compliance_vm(comp_rows: list[dict], comp_layer: dict, cdb: dict, compliance_findings: list[dict], L: dict, include_demo: bool = False) -> dict:
    comp_rows = _filter_comp_rows(comp_rows, include_demo)
    provider_statuses = comp_layer.get("providerStatuses") or []
    top_hits_raw = comp_layer.get("topHits") or []

    provider_table = []
    for ps in provider_statuses:
        name = str(ps.get("name", ""))
        provider_table.append(
            {
                "provider": _PROVIDER_LABELS.get(name, ps.get("label") or name),
                "status": _provider_status_label(ps, L),
                "sourceType": _provider_source_type(ps, L),
            }
        )

    top_hits = []
    for h in top_hits_raw:
        src = _hit_source_label(str(h.get("source", "")), "", L)
        top_hits.append(
            {
                "provider": _PROVIDER_LABELS.get(str(h.get("provider", "")), str(h.get("provider", ""))),
                "matchedName": truncate(h.get("matchedName"), 48),
                "riskTypes": ", ".join(_parse_risk_types(h.get("riskTypes"))) or "—",
                "score": h.get("matchScore") if h.get("matchScore") is not None else "—",
                "confidence": str(h.get("confidence") or "—"),
                "reviewStatus": _review_status_label(str(h.get("reviewStatus", "PENDING")), L),
                "source": src,
            }
        )

    if not top_hits and comp_rows:
        for r in comp_rows[:10]:
            top_hits.append(
                {
                    "provider": _PROVIDER_LABELS.get(r.get("provider", ""), r.get("provider", "")),
                    "matchedName": truncate(r.get("matchedName") or "—", 48),
                    "riskTypes": ", ".join(_parse_risk_types(r.get("riskTypes") or r.get("matchType"))) or "—",
                    "score": r.get("score", "—"),
                    "confidence": "—",
                    "reviewStatus": _review_status_label(r.get("reviewStatus", "PENDING"), L),
                    "source": _hit_source_label(r.get("source", ""), r.get("importMethod", ""), L),
                }
            )

    findings = [
        {
            **f,
            "title": _safe_compliance_finding_title(f, L),
            "reviewStatus": _review_status_label(f.get("reviewStatus", "PENDING"), L),
        }
        for f in compliance_findings
    ]

    dq_warnings: list[str] = []
    total_hits = int(comp_layer.get("totalHits", len(comp_rows)) or 0)
    pending_hits = int(comp_layer.get("pendingHits", 0) or 0)
    if total_hits == 0 and not comp_rows:
        dq_warnings.append(L["nd_no_compliance_hits"])
    elif pending_hits > 0 or total_hits > 0:
        dq_warnings.append(L["warn_potential_review"])

    return {
        **cdb,
        "rows": comp_rows,
        "dowWorldRows": [r for r in comp_rows if r.get("provider") in ("DOW_JONES", "WORLD_CHECK")],
        "lexisRows": [r for r in comp_rows if r.get("provider") == "LEXISNEXIS"],
        "findings": findings,
        "allFindingsCount": len(compliance_findings),
        "excludedFalsePositives": comp_layer.get("falsePositives", 0),
        "reviewRequiredWarning": L["warn_potential_review"],
        "pendingHits": comp_layer.get("pendingHits", 0),
        "confirmedHits": comp_layer.get("confirmedHits", 0),
        "falsePositives": comp_layer.get("falsePositives", 0),
        "totalHits": comp_layer.get("totalHits", len(comp_rows)),
        "providerTable": provider_table,
        "riskTypeBreakdown": _risk_type_breakdown(comp_rows),
        "topHits": top_hits,
        "dataQualityWarnings": dq_warnings,
    }


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
            comp_rows.append(_parse_comp_row(list(row)))
    cdb = base["complianceDatabases"]
    comp_layer = report_json.get("complianceSummary") or {}
    include_demo = bool((report_json.get("meta") or {}).get("demo"))
    if not include_demo:
        compliance_findings = [
            f for f in compliance_findings
            if not str(f.get("title", "")).upper().startswith("[DEMO]")
        ]
    compliance = _build_compliance_vm(comp_rows, comp_layer, cdb, compliance_findings, L, include_demo)
    compliance["dataQuality"] = base["dataQuality"]

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


def _serp_snapshot_vm(
    ss: dict | None,
    L: dict,
    audience: str = "internal",
    audit_search: dict | None = None,
) -> dict:
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
    audit_search = audit_search or {}
    # Stage N1.2 — map sourceMode to a localized provenance sentence.
    source_mode = str(meta.get("sourceMode") or "MOCK_ONLY").upper()
    has_real = bool(meta.get("hasRealResults"))
    report_count = int(meta.get("reportResultCount") or audit_search.get("totalResults") or 0)
    internal = str(audience).lower() != "client"

    if internal:
        source_note_map = {
            "REAL_ONLY": L["serp_snapshot_source_real"],
            "MIXED": L["serp_snapshot_source_mixed"],
            "MOCK_ONLY": L["serp_snapshot_source_mock"],
            "EMPTY": L["serp_snapshot_source_empty"],
        }
        source_note = source_note_map.get(source_mode, L["serp_snapshot_source_mock"])
        if source_mode in ("MIXED", "MOCK_ONLY") and report_count > 0:
            source_note = L.get("serp_snapshot_source_internal_filtered", source_note)
    else:
        if report_count <= 0:
            source_note = L["serp_snapshot_source_client_empty"]
        elif has_real and source_mode == "REAL_ONLY":
            source_note = L["serp_snapshot_source_client_real"]
        else:
            source_note = L["serp_snapshot_source_client_available"]
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
        "source_note": source_note,
    }


def build_view_model_v3(report_json: dict, audience: str = "internal") -> tuple[dict, list[str]]:
    vm, warnings = build_view_model_v2(report_json)
    internal = str(audience).lower() != "client"
    lang = vm.get("report_language") or _report_lang(report_json)
    vm["audience"] = "client" if not internal else "internal"
    vm["offerBlock"] = _offer_block(report_json.get("offer") or {}, vm["labels"])
    audit_search = (report_json.get("auditSummary") or {}).get("searchSummary") or {}
    serp = _serp_snapshot_vm(report_json.get("serpSnapshot"), vm["labels"], audience, audit_search)
    vm["serp_snapshot"] = serp
    if not serp["exists"]:
        # Stage S1.5 renderWarning: the ORION-style page uses fallback text.
        warnings.append("SERP snapshot is missing; search-screens page uses fallback text.")

    executive = dict(vm.get("executiveSummary") or {})
    bullets = list(executive.get("bullets") or [])
    if internal:
        executive["bullets"] = bullets
    else:
        executive["bullets"] = _filter_client_text_lines(bullets, lang)
        executive["dataQualityWarning"] = None
    vm["executiveSummary"] = executive

    compliance = vm.get("compliance") or {}
    if not internal and compliance.get("dataQualityWarnings"):
        compliance = dict(compliance)
        compliance["dataQualityWarnings"] = _filter_client_text_lines(
            list(compliance.get("dataQualityWarnings") or []), lang
        )
        vm["compliance"] = compliance

    for w in _warnings_for_render((report_json.get("meta") or {}).get("reportWarnings"), internal):
        if w not in warnings:
            warnings.append(w)
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
