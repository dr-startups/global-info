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


# R3.6 — identityDecision may arrive as internal raw enums (internal audience) or
# as client-safe tokens after client sanitization. Both must resolve identically
# so client image/video highlighting matches internal selection.
_ID_EXACT = ("EXACT_SUBJECT", "subject_confirmed")
_ID_LIKELY = ("LIKELY_SUBJECT", "subject_likely")


def _id_is_exact(value: Any) -> bool:
    return str(value or "") in _ID_EXACT


def _id_is_likely(value: Any) -> bool:
    return str(value or "") in _ID_LIKELY


def _id_is_subject(value: Any) -> bool:
    return _id_is_exact(value) or _id_is_likely(value)


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


def _merge_surface_section(a: dict, b: dict) -> dict:
    """Merge a surface bucket (relatedQueries, suggestions, etc.) from two region blocks."""
    return {
        "total": (a.get("total") or 0) + (b.get("total") or 0),
        "negative": (a.get("negative") or 0) + (b.get("negative") or 0),
        "list": list(a.get("list") or []) + list(b.get("list") or []),
        "items": list(a.get("items") or []) + list(b.get("items") or []),
        "collectionStatus": "COLLECTED"
        if (a.get("collectionStatus") == "COLLECTED" or b.get("collectionStatus") == "COLLECTED")
        else (a.get("collectionStatus") or b.get("collectionStatus") or ""),
        "statusMessage": a.get("statusMessage") or b.get("statusMessage") or "",
    }


def _combine_intl_block(uae: dict, international: dict, label: str) -> dict:
    """Visual UAE/International section (pages 22–31) with separate subregion data."""
    present = bool(uae.get("present") or international.get("present"))
    base = international if international.get("present") else uae
    uae_sum = uae.get("summary") or {}
    intl_sum = international.get("summary") or {}
    merged_summary = {
        "organicTotal": (uae_sum.get("organicTotal") or 0) + (intl_sum.get("organicTotal") or 0),
        "organicNegative": (uae_sum.get("organicNegative") or 0) + (intl_sum.get("organicNegative") or 0),
        "organicNegativeShare": base.get("summary", {}).get("organicNegativeShare", "0%"),
        "suggestions": f"{(uae.get('suggestions') or {}).get('negative', 0) + (international.get('suggestions') or {}).get('negative', 0)}/{(uae.get('suggestions') or {}).get('total', 0) + (international.get('suggestions') or {}).get('total', 0)}",
        "images": f"{(uae.get('images') or {}).get('negative', 0) + (international.get('images') or {}).get('negative', 0)}/{(uae.get('images') or {}).get('total', 0) + (international.get('images') or {}).get('total', 0)}",
        "videos": f"{(uae.get('videos') or {}).get('negative', 0) + (international.get('videos') or {}).get('negative', 0)}/{(uae.get('videos') or {}).get('total', 0) + (international.get('videos') or {}).get('total', 0)}",
        "knowledgeBlockStatus": base.get("summary", {}).get("knowledgeBlockStatus", "ABSENT"),
        "uaeOrganicTotal": uae_sum.get("organicTotal", 0),
        "internationalOrganicTotal": intl_sum.get("organicTotal", 0),
        "uaeRelatedTotal": (uae.get("relatedQueries") or {}).get("total", 0),
        "internationalRelatedTotal": (international.get("relatedQueries") or {}).get("total", 0),
    }
    return {
        **base,
        "code": "INTL",
        "label": label,
        "present": present,
        "noDataText": "" if present else (uae.get("noDataText") or international.get("noDataText") or ""),
        "subregions": {"uae": uae, "international": international},
        "summary": merged_summary,
        "relatedQueries": _merge_surface_section(
            uae.get("relatedQueries") or {}, international.get("relatedQueries") or {}
        ),
        "suggestions": _merge_surface_section(
            uae.get("suggestions") or {}, international.get("suggestions") or {}
        ),
        "images": _merge_surface_section(uae.get("images") or {}, international.get("images") or {}),
        "videos": _merge_surface_section(uae.get("videos") or {}, international.get("videos") or {}),
        "organicOverview": {
            "organicTotal": merged_summary["organicTotal"],
            "organicNegative": merged_summary["organicNegative"],
            "uniqueNegativeUrls": (uae.get("organicOverview") or {}).get("uniqueNegativeUrls", 0)
            + (international.get("organicOverview") or {}).get("uniqueNegativeUrls", 0),
            "totalUniqueUrls": (uae.get("organicOverview") or {}).get("totalUniqueUrls", 0)
            + (international.get("organicOverview") or {}).get("totalUniqueUrls", 0),
            "negativeShare": merged_summary["organicNegativeShare"],
            "observedQueries": list(
                dict.fromkeys(
                    list((uae.get("organicOverview") or {}).get("observedQueries") or [])
                    + list((international.get("organicOverview") or {}).get("observedQueries") or [])
                )
            )[:8],
        },
        "topResults": list(uae.get("topResults") or []) + list(international.get("topResults") or [])[:20],
    }


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
            "present": (
                (r.get("organicTotal", 0) or 0)
                + (r.get("relatedQueriesTotal", 0) or 0)
                + (r.get("suggestionsTotal", 0) or 0)
                + len(r.get("topSuggestions", []) or [])
                > 0
                or str(r.get("collectionStatus", "")).upper() == "COLLECTED"
            ),
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
            "topThemes": _selected_risk_themes(report_json, audit),
            "byLevel": (audit.get("riskSummary", {}) or risk).get("findingsByLevel", {}) or {},
            "consequences": list(L["rm_default_consequences"]),
        },
        "digitalProfileOverview": {
            "negativeShareRu": pct((_region(regions_raw, "RU") or {}).get("organicNegativeShare", 0)),
            "negativeShareUae": pct((_region(regions_raw, "UAE") or {}).get("organicNegativeShare", 0)),
            "negativeShareInternational": pct(
                (_region(regions_raw, "INTERNATIONAL") or {}).get("organicNegativeShare", 0)
            ),
            "searchTotal": search.get("totalResults", 0),
            "searchNegative": search.get("negativeResults", 0),
            "searchNegativeShare": pct(search.get("negativeShare", 0)),
            "complianceSummary": compliance.get("conclusion", L["no_compliance_recorded"]),
            "wikipediaStatus": L["present"] if wiki.get("exists") else L["not_found"],
        },
        "regions": {
            "RU": region_vm("RU"),
            "UAE": region_vm("UAE"),
            "INTERNATIONAL": region_vm("INTERNATIONAL"),
        },
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

COMPLIANCE_THEMES = {"sanctions", "pep_rca", "compliance_database", "pep", "rca", "adverse_media"}


def _compliance_stale_title(title: str) -> bool:
    t = str(title or "").upper()
    markers = (
        "WORLD_CHECK",
        "DOW_JONES",
        "LEXIS",
        "SANCTIONS",
        " PEP ",
        "RCA",
        "POTENTIAL PEP",
        "POTENTIAL SANCTIONS",
    )
    return any(m in t for m in markers)


def _selected_evidence_meta(report_json: dict) -> dict:
    return report_json.get("selectedEvidence") or {}


def _selected_risk_themes(report_json: dict, audit: dict) -> list[dict]:
    """O5.4.1 — top themes for page 36 from selected subject-matched findings only."""
    selected = _selected_evidence_meta(report_json)
    findings = selected.get("riskFindings", {}).get("selectedSubjectMatchedOnly") or []
    compliance_active = _compliance_evidence_active(report_json)
    counts: dict[str, int] = {}
    for f in findings:
        theme = str(f.get("theme", "") or "").strip()
        if not theme:
            continue
        tl = theme.lower()
        if not compliance_active and tl in COMPLIANCE_THEMES:
            continue
        if _compliance_stale_title(str(f.get("title", ""))):
            continue
        counts[tl] = counts.get(tl, 0) + max(1, int(f.get("evidenceCount", 1) or 1))
    return [{"theme": k, "count": v} for k, v in sorted(counts.items(), key=lambda x: (-x[1], x[0]))][:8]


def _image_thumbnail_b64(item: dict) -> str | None:
    return item.get("thumbnailBytesBase64") or item.get("thumbnailBase64")


def _map_selected_image_item(card: dict) -> dict:
    url = card.get("sourceUrl") or card.get("url") or ""
    b64 = _image_thumbnail_b64(card)
    return {
        "title": truncate(card.get("title"), 50),
        "source": card.get("sourceDomain") or domain(url),
        "sourcePageUrl": url,
        "url": url,
        "thumbnailStorageKey": card.get("thumbnailStorageKey"),
        "thumbnailBase64": b64,
        "thumbnailBytesBase64": card.get("thumbnailBytesBase64") or b64,
        "thumbnailMimeType": card.get("thumbnailMimeType"),
        "identityDecision": card.get("identityDecision") or "",
        "hasThumbnail": bool(b64),
        "subjectMatched": bool(card.get("subjectMatched", True)),
    }


def _map_selected_video_item(card: dict) -> dict:
    url = card.get("url") or card.get("sourcePageUrl") or ""
    return {
        "title": truncate(card.get("title"), 50),
        "source": card.get("sourceDomain") or domain(url),
        "url": url,
        "identityDecision": card.get("identityDecision") or "",
        "selectionReason": card.get("selectionReason") or "",
    }


def _apply_selected_evidence_vm_overrides(report_json: dict, vm: dict) -> None:
    """O5.4.1 — sync selected image/video/organic cards onto region VM blocks."""
    se = _selected_evidence_meta(report_json)
    if not se:
        return

    region_cards = {
        "ru": se.get("regions", {}).get("ru") or {},
        "intl": se.get("regions", {}).get("international") or {},
    }

    for blk_key, cards in region_cards.items():
        blk = vm.get(blk_key)
        if not blk:
            continue
        img_cards = list(cards.get("images") or [])
        vid_cards = list(cards.get("videos") or [])
        organic_cards = list(cards.get("organicSelected") or [])
        if img_cards:
            mapped = [_map_selected_image_item(c) for c in img_cards]
            blk["images"] = {
                **(blk.get("images") or {}),
                "items": mapped,
                "selected": len(mapped),
            }
        if vid_cards:
            mapped_v = [_map_selected_video_item(c) for c in vid_cards]
            blk["videos"] = {
                **(blk.get("videos") or {}),
                "items": mapped_v,
                "selected": len(mapped_v),
            }
        if cards.get("noIntlSubjectResults"):
            blk["noIntlSubjectResults"] = True
            blk["topResults"] = []
        elif organic_cards and blk_key == "intl":
            blk["topResults"] = [
                {
                    "provider": "GOOGLE",
                    "rank": str(idx + 1),
                    "domain": domain(item.get("domain") or item.get("url")),
                    "title": truncate(item.get("title"), 60),
                    "classification": str(item.get("classification", "")),
                }
                for idx, item in enumerate(organic_cards[:20])
            ]

    # Global selectedEvidence image list — fallback when region sync is sparse.
    global_images = se.get("images", {}).get("selectedSubjectMatched") or []
    ru_blk = vm.get("ru")
    if ru_blk and global_images:
        ru_items = list((ru_blk.get("images") or {}).get("items") or [])
        if len(global_images) > len(ru_items):
            mapped = [_map_selected_image_item(c) for c in global_images]
            ru_blk["images"] = {
                **(ru_blk.get("images") or {}),
                "items": mapped,
                "selected": len(mapped),
            }

    global_videos = se.get("videos", {}).get("selectedSubjectMatched") or []
    if ru_blk and global_videos:
        ru_vids = list((ru_blk.get("videos") or {}).get("items") or [])
        if len(global_videos) > len(ru_vids):
            mapped_v = [_map_selected_video_item(c) for c in global_videos]
            ru_blk["videos"] = {
                **(ru_blk.get("videos") or {}),
                "items": mapped_v,
                "selected": len(mapped_v),
            }


def _compliance_evidence_active(report_json: dict) -> bool:
    meta = (_selected_evidence_meta(report_json).get("compliance") or {})
    if meta.get("manualConfirmedOnly") or meta.get("providersRun"):
        return True
    comp = report_json.get("complianceSummary") or {}
    return int(comp.get("totalHits") or 0) > 0 or int(comp.get("confirmedHits") or 0) > 0

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
    collection_status = str(r.get("collectionStatus", "") or "").upper()
    not_collected = collection_status in ("NOT_QUERIED", "NOT_CONFIGURED", "NOT_SUPPORTED")
    if collection_status == "COLLECTED":
        present = True
    elif not_collected:
        present = False
    else:
        present = organic_total + surfaces_total > 0
    no_data_text = ""
    if not present:
        no_data_text = r.get("statusMessage") or L["no_evidence_region"].format(label=label)

    return {
        "code": code,
        "label": label,
        "present": present,
        "noDataText": no_data_text,
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
            "groups": [
                {
                    "label": str(g.get("label", "")),
                    "items": [truncate(x, 80) for x in (g.get("items") or [])],
                }
                for g in (r.get("suggestionGroups") or [])
            ],
            "exposureDisclaimer": str(r.get("exposureDisclaimer") or ""),
        },
        "relatedQueries": {
            "total": r.get("relatedQueriesTotal", 0),
            "negative": r.get("relatedQueriesNegative", 0),
            "list": [truncate(s, 80) for s in (r.get("topRelatedQueries") or [])[:15]],
            "collectionStatus": collection_status,
            "statusMessage": r.get("statusMessage", ""),
        },
        "images": {
            "total": r.get("imagesTotal", 0),
            "selected": r.get("imagesSelected", len(r.get("topImages", []) or [])),
            "negative": r.get("imagesNegative", 0),
            "items": [
                {
                    "title": truncate(i.get("title"), 50),
                    "source": i.get("source") or domain(i.get("url")),
                    "sourcePageUrl": i.get("sourcePageUrl") or i.get("url") or "",
                    "url": i.get("sourcePageUrl") or i.get("url") or "",
                    "thumbnailStorageKey": i.get("thumbnailStorageKey"),
                    "thumbnailBase64": _image_thumbnail_b64(i),
                    "thumbnailBytesBase64": i.get("thumbnailBytesBase64") or i.get("thumbnailBase64"),
                    "thumbnailMimeType": i.get("thumbnailMimeType"),
                    "identityDecision": i.get("identityDecision") or "",
                    "hasThumbnail": bool(_image_thumbnail_b64(i)),
                    "subjectMatched": _id_is_subject(i.get("identityDecision")),
                }
                for i in (r.get("topImages", []) or [])[:9]
            ],
            "selectionNote": str(r.get("imageSelectionNote") or ""),
        },
        "videos": {
            "total": r.get("videosTotal", 0),
            "selected": r.get("videosSelected", len(r.get("topVideos", []) or [])),
            "negative": r.get("videosNegative", 0),
            "selectionNote": str(r.get("videoSelectionNote") or ""),
            "items": [
                {
                    "title": truncate(v.get("title"), 50),
                    "source": v.get("source") or domain(v.get("url")),
                    "url": v.get("url") or "",
                    "identityDecision": v.get("identityDecision") or "",
                    "selectionReason": (
                        "exact subject"
                        if _id_is_exact(v.get("identityDecision"))
                        else "likely subject"
                        if _id_is_likely(v.get("identityDecision"))
                        else "manual include"
                        if str(v.get("reportEligibility") or "") == "CLIENT_INCLUDE"
                        else "selected"
                    ),
                }
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
                "classification": str(e.get("classification") or e.get("class") or ""),
                "type": str(e.get("type", "ORGANIC")),
                "identity": str(e.get("identity") or ""),
                "review": str(e.get("review") or ""),
                "link": str(e.get("link") or ""),
            }
            for e in (r.get("evidenceAppendix", []) or [])[:20]
        ],
        "excludedAppendix": [
            {
                "title": truncate(e.get("title"), 55),
                "domain": domain(e.get("domain")),
                "reason": str(e.get("reason", "")),
                "identityDecision": str(e.get("identityDecision", "")),
            }
            for e in (r.get("excludedAppendix", []) or [])[:20]
        ],
        "noIntlSubjectResults": bool(r.get("noIntlSubjectResults")),
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
    selected = _selected_evidence_meta(report_json)
    if selected.get("riskFindings"):
        top_findings = [
            {
                "severity": risk_level(f.get("severity")),
                "theme": str(f.get("theme", "")),
                "title": truncate(f.get("title"), 70),
                "reviewStatus": str(f.get("reviewStatus", "PENDING")),
                "evidenceCount": f.get("evidenceCount", 0),
            }
            for f in (selected.get("riskFindings", {}).get("selectedSubjectMatchedOnly") or [])
        ]
    compliance_active = _compliance_evidence_active(report_json)
    search_findings = [
        f
        for f in top_findings
        if f["theme"].lower() not in COMPLIANCE_THEMES and not _compliance_stale_title(f.get("title", ""))
    ]
    if compliance_active:
        compliance_findings = [f for f in top_findings if f["theme"].lower() in COMPLIANCE_THEMES]
    else:
        compliance_findings = []
        search_findings = [
            f for f in search_findings if not _compliance_stale_title(f.get("title", ""))
        ]

    wiki = base["wikipedia"]
    recommended = base["recommendedActions"]

    ru = _region_block(_region(regions_raw, "RU"), "RU", L["region_ru"], wiki, search_findings, L)
    uae_sub = _region_block(
        _region(regions_raw, "UAE"), "UAE", L.get("region_uae", L["region_intl"]), wiki, search_findings, L
    )
    intl_sub = _region_block(
        _region(regions_raw, "INTERNATIONAL"),
        "INTERNATIONAL",
        L.get("region_international", L["region_intl"]),
        wiki,
        search_findings,
        L,
    )
    intl = _combine_intl_block(uae_sub, intl_sub, L["region_intl"])
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
        "topThemes": _selected_risk_themes(report_json, audit),
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

    risk_matrix = _build_risk_matrix_rows(base, ru, intl, wiki, compliance_active=compliance_active)

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
    _apply_selected_evidence_vm_overrides(report_json, vm)
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


def _filter_client_region_block(blk: dict) -> dict:
    """O5 — client report shows only CLIENT_INCLUDE surface items."""
    out = dict(blk)
    for key in ("suggestions", "relatedQueries", "images", "videos"):
        section = dict(out.get(key) or {})
        items_key = "items" if key in ("images", "videos") else "list"
        raw = list(section.get(items_key) or [])
        if items_key == "list":
            section[items_key] = raw
        else:
            section[items_key] = raw
        out[key] = section
    return out


def _evidence_quality_vm(eq: dict | None, L: dict, internal: bool) -> dict:
    if not eq or not internal:
        return {"present": False}
    totals = eq.get("totals") or {}
    return {
        "present": True,
        "collected": totals.get("collected", 0),
        "clientIncluded": totals.get("clientIncluded", 0),
        "reviewRequired": totals.get("reviewRequired", 0),
        "excluded": totals.get("excluded", 0),
        "duplicates": totals.get("duplicates", 0),
        "topExclusionReasons": list(eq.get("topExclusionReasons") or [])[:5],
        "reviewQueueCount": len(eq.get("reviewQueue") or []),
        "title": L.get("evidence_quality_title", "Evidence quality"),
    }


def _subject_image_query_variants(subject: str, L: dict) -> list[str]:
    parts = [p for p in str(subject or "").split() if p.strip()]
    out: list[str] = []
    if subject:
        out.append(str(subject).strip())
    if len(parts) >= 2:
        out.append(f"{parts[1]} {parts[0]}")
    if len(parts) >= 3:
        out.append(f"{parts[0]} {parts[1]} {parts[2]}")
        out.append(f"{parts[1]} {parts[2]} {parts[0]}")
        bio_tpl = L.get("orion_images_query_bio", "{name} biography")
        out.append(bio_tpl.format(name=f"{parts[1]} {parts[0]}"))
    seen: set[str] = set()
    deduped: list[str] = []
    for q in out:
        q = truncate(q, 52)
        if q and q not in seen:
            seen.add(q)
            deduped.append(q)
    return deduped


def _audit_image_to_item(i: dict) -> dict:
    url = i.get("sourcePageUrl") or i.get("url") or ""
    b64 = _image_thumbnail_b64(i)
    return {
        "title": truncate(i.get("title"), 50),
        "source": i.get("source") or domain(url),
        "sourcePageUrl": url,
        "url": url,
        "thumbnailStorageKey": i.get("thumbnailStorageKey"),
        "thumbnailBase64": b64,
        "thumbnailBytesBase64": i.get("thumbnailBytesBase64") or b64,
        "thumbnailMimeType": i.get("thumbnailMimeType"),
        "identityDecision": i.get("identityDecision") or "",
        "hasThumbnail": bool(b64),
        "subjectMatched": _id_is_subject(i.get("identityDecision")),
    }


def _orion_short_query(subject: str, queries: list[str]) -> str:
    parts = [p for p in str(subject or "").split() if p.strip()]
    if len(parts) >= 2:
        short = f"{parts[0]} {parts[1]}"
        return truncate(short, 32)
    if queries:
        return truncate(str(queries[0]), 32)
    return truncate(subject, 32)


def _build_orion_image_grid(r: dict, items: list[dict]) -> list[dict]:
    pool: list[dict] = []
    seen: set[str] = set()

    def _add(raw: dict) -> None:
        if not raw.get("hasThumbnail") and not _image_thumbnail_b64(raw):
            return
        key = str(raw.get("thumbnailStorageKey") or raw.get("url") or raw.get("title") or "")
        if key and key in seen:
            return
        if key:
            seen.add(key)
        pool.append({**raw, "highlight": False})

    for it in items:
        _add(it)
    for i in (r.get("topImages") or []):
        _add(_audit_image_to_item(i))

    if not pool:
        return []

    selected_keys: list[str] = []
    for it in items:
        if not it.get("subjectMatched"):
            continue
        key = str(it.get("thumbnailStorageKey") or it.get("url") or it.get("title") or "")
        if key and key not in selected_keys:
            selected_keys.append(key)

    max_grid = 12
    max_hi = 3
    grid: list[dict] = []
    hi_count = 0
    for it in pool:
        key = str(it.get("thumbnailStorageKey") or it.get("url") or it.get("title") or "")
        mark = key in selected_keys and hi_count < max_hi
        if mark:
            hi_count += 1
        grid.append({**it, "highlight": mark})
        if len(grid) >= max_grid:
            break

    idx = 0
    while len(grid) < max_grid and pool:
        src = pool[idx % len(pool)]
        grid.append({**src, "highlight": False})
        idx += 1
        if idx > max_grid * 2:
            break
    return grid[:max_grid]


def _build_orion_image_queries(r: dict, subject: str, L: dict) -> list[str]:
    queries: list[str] = []
    for s in (r.get("topSuggestions") or [])[:3]:
        if s:
            queries.append(truncate(str(s), 48))
    for s in (r.get("topRelatedQueries") or [])[:2]:
        if s:
            queries.append(truncate(str(s), 48))
    for q in _subject_image_query_variants(subject, L):
        if q not in queries:
            queries.append(q)
    return queries[:4]


def _build_orion_summary_bullets(blk: dict, L: dict) -> list[str]:
    bullets: list[str] = []
    themes = list((blk.get("themes") or {}).get("topThemes") or [])
    for t in themes[:2]:
        theme = str(t.get("theme") or "").strip()
        if theme:
            bullets.append(truncate(theme, 72))
    if not bullets:
        for u in list((blk.get("themes") or {}).get("negativeUrls") or [])[:2]:
            title = str(u.get("title") or "").strip()
            if title:
                bullets.append(truncate(title, 72))
    if not bullets:
        findings = list(blk.get("riskFindings") or [])
        for f in findings[:2]:
            title = str(f.get("title") or "").strip()
            if title:
                bullets.append(truncate(title, 72))
    if not bullets:
        bullets.append(truncate(L.get("orion_images_why_body", "") or "—", 42))
    return bullets[:1]


def enrich_ru_orion_images(blk: dict, report_json: dict, *, subject: str, audit_date: str, L: dict) -> None:
    """Slide 13 ORION layout — enrich RU block with presentation VM fields."""
    if not blk or blk.get("code") != "RU":
        return
    audit = report_json.get("auditSummary") or {}
    r = _region(audit.get("regions") or [], "RU") or {}
    im = dict(blk.get("images") or {})
    selected = int(im.get("selected") or len(im.get("items") or []))
    total = int(im.get("total") or 0)
    items = list(im.get("items") or [])
    queries = _build_orion_image_queries(r, subject, L)
    primary_query = queries[0] if queries else truncate(subject, 40)
    blk["orionImages"] = {
        "section": L.get("orion_images_section", "04  Images"),
        "headline": L.get("orion_images_headline", ""),
        "asOf": L.get("orion_images_as_of", "as of {date}").format(date=audit_date or "—"),
        "brand": str((report_json.get("offer") or {}).get("companyName") or L.get("op_default_product", "ORION")),
        "metricX": selected,
        "metricY": total,
        "metricLabel": L.get("orion_images_metric", "{x} из {y}").format(x=selected, y=total),
        "summaryLine": L.get("orion_images_summary_line", ""),
        "summaryBullets": _build_orion_summary_bullets(blk, L),
        "queriesTitle": L.get("orion_images_queries_title", "Search queries"),
        "queries": queries,
        "primaryQuery": _orion_short_query(subject, queries),
        "brandDisplay": L.get("orion_images_brand_compact", L.get("op_default_product", "Digital Profile Audit")),
        "whyTitle": L.get("orion_images_why_title", ""),
        "whyBody": truncate(L.get("orion_images_why_body", ""), 160),
        "gridTitle": L.get("orion_images_grid_title", "Images"),
        "tabs": [
            L.get("orion_images_tab_search", "search"),
            L.get("orion_images_tab_images", "images"),
            L.get("orion_images_tab_video", "video"),
            L.get("orion_images_tab_maps", "maps"),
            L.get("orion_images_tab_products", "products"),
            L.get("orion_images_tab_translator", "translator"),
            L.get("orion_images_tab_all", "all"),
        ],
        "gridItems": _build_orion_image_grid(r, items),
        "noData": L.get("orion_images_no_data", "No images."),
    }


def _is_review_appendix_entry(entry: dict) -> bool:
    v = " ".join(
        str(entry.get(k, "") or "")
        for k in ("review", "classification", "identity")
    ).lower()
    return any(tok in v for tok in ("review", "pending", "needs", "провер"))


def _appendix_region_vm(blk: dict) -> dict:
    evidence_rows = list(blk.get("evidenceAppendix") or [])
    excluded_rows = list(blk.get("excludedAppendix") or [])
    confirmed = [e for e in evidence_rows if not _is_review_appendix_entry(e)]
    review = [e for e in evidence_rows if _is_review_appendix_entry(e)]
    return {
        "label": blk.get("label", ""),
        "riskLevel": blk.get("riskLevel", "UNKNOWN"),
        "confirmed": confirmed,
        "review": review,
        "excluded": excluded_rows,
    }


def _appendix_overview_vm(vm: dict, L: dict) -> dict:
    ru = _appendix_region_vm(vm.get("ru") or {})
    intl = _appendix_region_vm(vm.get("intl") or {})
    return {
        "title": L.get("r31_appendix_overview_title", "Evidence appendix overview"),
        "cards": [
            {"label": L.get("r31_appendix_card_confirmed", "Confirmed evidence"), "value": len(ru["confirmed"]) + len(intl["confirmed"])},
            {"label": L.get("r31_appendix_card_review", "Review queue"), "value": len(ru["review"]) + len(intl["review"])},
            {"label": L.get("r31_appendix_card_excluded", "Excluded / noise"), "value": len(ru["excluded"]) + len(intl["excluded"])},
            {"label": L.get("r31_appendix_card_media", "Media evidence"), "value": int((vm.get("ru") or {}).get("images", {}).get("selected", 0) or 0) + int((vm.get("ru") or {}).get("videos", {}).get("selected", 0) or 0) + int((vm.get("intl") or {}).get("images", {}).get("selected", 0) or 0) + int((vm.get("intl") or {}).get("videos", {}).get("selected", 0) or 0)},
        ],
        "lines": [
            L.get("r31_appendix_overview_line_confirmed", "Confirmed materials are grouped separately from items pending analyst review."),
            L.get("r31_appendix_overview_line_excluded", "Excluded and noise materials are preserved for traceability and quality control."),
            L.get("r31_appendix_overview_line_media", "Media evidence is summarized across Russian and international segments."),
        ],
    }


def _media_evidence_overview_vm(vm: dict, L: dict) -> dict:
    ru = vm.get("ru") or {}
    intl = vm.get("intl") or {}
    ru_img = ru.get("images") or {}
    ru_vid = ru.get("videos") or {}
    in_img = intl.get("images") or {}
    in_vid = intl.get("videos") or {}
    return {
        "cards": [
            {"label": L.get("r31_media_images_total", "Images selected"), "value": int(ru_img.get("selected", 0) or 0) + int(in_img.get("selected", 0) or 0)},
            {"label": L.get("r31_media_videos_total", "Videos selected"), "value": int(ru_vid.get("selected", 0) or 0) + int(in_vid.get("selected", 0) or 0)},
            {"label": L.get("r31_media_ru_coverage", "RU media coverage"), "value": f"{int(ru_img.get('selected', 0) or 0)}/{int((ru_img.get('total', 0) or 0) + (ru_vid.get('total', 0) or 0))}"},
            {"label": L.get("r31_media_intl_coverage", "INTL media coverage"), "value": f"{int(in_img.get('selected', 0) or 0)}/{int((in_img.get('total', 0) or 0) + (in_vid.get('total', 0) or 0))}"},
        ],
        "lines": [
            L.get("r31_media_line_images", "Image search evidence is prioritized by relevance to the subject."),
            L.get("r31_media_line_videos", "Video evidence is retained with source references for analyst verification."),
            L.get("r31_media_line_sources", "Coverage combines Russian and international source sets without duplicate leakage."),
        ],
    }


def _risk_reasoning_overview_vm(vm: dict, L: dict) -> dict:
    final = vm.get("finalConclusion") or {}
    rows = list((vm.get("riskMatrix") or {}).get("rows") or [])
    intel = (vm.get("complianceRiskIntel") or {}).get("riskReasoning") or {}
    return {
        "overallRiskLevel": final.get("overallRiskLevel", "UNKNOWN"),
        "topThemes": list(final.get("topThemes") or []),
        "rows": rows,
        "recommendedActions": list(final.get("recommendedActions") or []),
        "warnings": list(final.get("warnings") or []),
        "supportingSignals": [
            L.get("r31_risk_signal_search", "Search profile signals"),
            L.get("r31_risk_signal_compliance", "Compliance and regulatory signals"),
            L.get("r31_risk_signal_media", "Media and narrative signals"),
        ],
        # Stage R3.5 — client-safe reasoning intelligence (already localized in TS).
        "reasoningSummary": str(intel.get("reasoningSummary") or ""),
        "recommendedAction": str(intel.get("recommendedAction") or ""),
        "legalSafeDisclaimer": str(intel.get("legalSafeDisclaimer") or ""),
        "limitingFactors": [str(x) for x in (intel.get("limitingFactors") or []) if str(x)],
        "evidenceBuckets": {
            "confirmed": int(intel.get("confirmedCount", 0) or 0),
            "review": int(intel.get("reviewCount", 0) or 0),
            "excluded": int(intel.get("excludedCount", 0) or 0),
        },
        "signalBuckets": {
            "compliance": int(intel.get("complianceSignals", 0) or 0),
            "media": int(intel.get("mediaSignals", 0) or 0),
            "organic": int(intel.get("organicSignals", 0) or 0),
        },
    }


def _risk_reasoning_by_region_vm(vm: dict, L: dict) -> dict:
    def _one(blk: dict) -> dict:
        summary = blk.get("summary") or {}
        themes = list((blk.get("themes") or {}).get("topThemes") or [])
        return {
            "label": blk.get("label", ""),
            "riskLevel": blk.get("riskLevel", "UNKNOWN"),
            "conclusion": blk.get("conclusion") or L.get("interim_conclusion_fallback", ""),
            "signals": [
                f"{L.get('m_organic_negative', 'Negative organic')}: {summary.get('organicNegative', 0)}",
                f"{L.get('m_suggestions_nt', 'Suggestions')}: {summary.get('suggestions', '0/0')}",
                f"{L.get('m_images_nt', 'Images')}: {summary.get('images', '0/0')}",
            ],
            "themes": [str(t.get("theme", "")) for t in themes[:3] if str(t.get("theme", ""))],
        }

    return {"ru": _one(vm.get("ru") or {}), "intl": _one(vm.get("intl") or {})}


def _r34_raw_cards(entries: list[dict]) -> list[dict]:
    """Client-safe raw card payloads for R3.4 source cards (formatting done in template)."""
    cards: list[dict] = []
    for e in entries or []:
        cards.append(
            {
                "title": str(e.get("title") or ""),
                "domain": str(e.get("domain") or e.get("link") or ""),
                "reason": str(e.get("reason") or ""),
            }
        )
    return cards


def _r34_appendix_vm(vm: dict, L: dict, internal: bool) -> dict:
    """R3.4 — deeper evidence appendix display groups (additive, reuses R3.1/R3.3 VM)."""
    ef = vm.get("entityFiltering") or {}
    counts = ef.get("counts") or {}
    conf_ru = vm.get("evidenceConfirmedRu") or {}
    rev_ru = vm.get("evidenceReviewRu") or {}
    exc_ru = vm.get("evidenceExcludedRu") or {}
    conf_intl = vm.get("evidenceConfirmedIntl") or {}
    rev_intl = vm.get("evidenceReviewIntl") or {}
    exc_intl = vm.get("evidenceExcludedIntl") or {}
    media_ov = vm.get("mediaEvidenceOverview") or {}
    risk_ov = vm.get("riskReasoningOverview") or {}

    n_confirmed = len(conf_ru.get("confirmed") or []) + len(conf_intl.get("confirmed") or [])
    n_review = len(rev_ru.get("rows") or []) + len(rev_intl.get("rows") or [])
    n_excluded = len(exc_ru.get("rows") or []) + len(exc_intl.get("rows") or [])
    n_media = int(counts.get("strictSubject", 0) or 0)  # placeholder if unused
    media_cards = list(media_ov.get("cards") or [])

    nav_cards = [
        {"label": L.get("r31_appendix_card_confirmed", "Confirmed evidence"), "value": n_confirmed},
        {"label": L.get("r31_appendix_card_review", "Review queue"), "value": n_review},
        {"label": L.get("r31_appendix_card_excluded", "Excluded / noise"), "value": n_excluded},
        {"label": L.get("r31_appendix_card_media", "Media evidence"), "value": (media_cards[0].get("value") if media_cards else 0)},
    ]
    sections = [
        L.get("r34_map_section_confirmed", ""),
        L.get("r34_map_section_review", ""),
        L.get("r34_map_section_excluded", ""),
        L.get("r34_map_section_media", ""),
        L.get("r34_map_section_provenance", ""),
        L.get("r34_map_section_risk", ""),
    ]

    excluded_cards = [
        {"label": L.get("r34_excluded_card_excluded", "Excluded by identity"), "value": int(counts.get("excludedByIdentity", 0) or 0)},
        {"label": L.get("r34_excluded_card_namesake", "Namesakes"), "value": int(counts.get("namesake", 0) or 0)},
        {"label": L.get("r34_excluded_card_intl", "International suppressed"), "value": int(ef.get("internationalSuppressionCount", 0) or 0)},
        {"label": L.get("r34_excluded_card_media", "Media suppressed"), "value": int(ef.get("mediaSuppressionCount", 0) or 0)},
    ]
    # topExclusionReasons is internal-only (sanitized out for client audience upstream).
    excluded_reasons: list[str] = []
    if internal:
        for r in list(ef.get("topExclusionReasons") or [])[:4]:
            reason = str((r or {}).get("reason") or "").strip()
            cnt = int((r or {}).get("count", 0) or 0)
            if reason:
                # Humanize raw snake_case reason codes into compact analyst-safe wording.
                human = reason.replace("_", " ").strip().capitalize()
                excluded_reasons.append(f"{human} — {cnt}")

    return {
        "navCards": nav_cards,
        "sections": [s for s in sections if s],
        "confirmedRu": _r34_raw_cards(list(conf_ru.get("confirmed") or [])),
        "reviewRu": _r34_raw_cards(list(rev_ru.get("rows") or [])),
        "confirmedIntl": _r34_raw_cards(list(conf_intl.get("confirmed") or [])),
        "reviewIntl": _r34_raw_cards(list(rev_intl.get("rows") or [])),
        "excluded": {"cards": excluded_cards, "reasons": excluded_reasons},
        "media": {"cards": media_cards[:4], "lines": list(media_ov.get("lines") or [])[:3]},
        "risk": {
            "overallRiskLevel": risk_ov.get("overallRiskLevel", "UNKNOWN"),
            "topThemes": list(risk_ov.get("topThemes") or []),
            "recommendedActions": list(risk_ov.get("recommendedActions") or []),
        },
    }


def _provider_diagnostics_vm(block: dict, L: dict, internal: bool) -> dict:
    src = block or {}
    summary = src.get("summary") or {}
    runtime = src.get("runtimeStrategy") or {}
    rows = []
    for p in list(src.get("providers") or []):
        capability = str(p.get("capabilityLevel") or "none")
        selected = bool(p.get("selectedByStrategy"))
        fallback_reason = str(p.get("fallbackReason") or "").strip()
        runtime_kind = str(p.get("runtimeKind") or "").strip()
        prod_ready = bool(p.get("productionReady"))
        note = str(
            p.get("internalDetail")
            if internal and p.get("internalDetail")
            else p.get("safeDetail")
            or p.get("message")
            or "—"
        )
        note += f" | capability={capability}; selected={str(selected).lower()}"
        if runtime_kind:
            note += f"; kind={runtime_kind}"
        note += f"; prod_ready={str(prod_ready).lower()}"
        if fallback_reason:
            note += f"; fallback={fallback_reason}"
        rows.append(
            {
                "source": str(p.get("label") or p.get("id") or "—"),
                "category": str(p.get("category") or "unknown"),
                "mode": str(p.get("runtimeMode") or "unknown"),
                "status": str(p.get("status") or "unknown"),
                "risk": str(p.get("risk") or "unknown"),
                "note": note,
            }
        )
    runtime_notes = [
        f"Runtime mode: {str(runtime.get('mode') or 'legacy_mock_first')}",
        f"Fallback policy: {str(runtime.get('fallbackPolicy') or 'allow_mock_fallback')}",
        f"Selected order: {', '.join([str(x) for x in list(runtime.get('selectedOrder') or [])]) or '—'}",
    ]
    runtime_notes.extend([str(x) for x in list(runtime.get("warnings") or []) if str(x)])
    fallback_events = list(runtime.get("fallbackEvents") or [])
    if fallback_events:
        runtime_notes.append(f"Fallback events: {len(fallback_events)}")
    # R4.1 — richer summary + source provenance overview (internal-only).
    total_providers = int(summary.get("totalProviders", len(rows)) or 0)
    manual_count = int(summary.get("manualCount", 0) or 0)
    unavailable_count = int(summary.get("unavailableCount", 0) or 0)
    prod_ready_count = int(summary.get("productionReadyCount", 0) or 0)
    runtime_notes.append(
        f"Providers: {total_providers} total; {prod_ready_count} production-ready; "
        f"{manual_count} manual; {unavailable_count} unavailable."
    )
    provenance = list(src.get("sourceProvenance") or [])
    if provenance:
        prov_bits = []
        for row in provenance:
            collected = row.get("collected")
            included = row.get("included")
            label = str(row.get("sourceProviderLabel") or row.get("sourceProvider") or "—")
            decision = str(row.get("inclusionDecision") or "")
            if collected is not None or included is not None:
                prov_bits.append(
                    f"{label}: {int(included or 0)}/{int(collected or 0)} ({decision})"
                )
            else:
                prov_bits.append(f"{label}: {decision}")
        if prov_bits:
            runtime_notes.append("Source provenance — " + "; ".join(prov_bits))
    return {
        "title": L.get("r32_provider_diag_title", "Provider diagnostics"),
        "subtitle": L.get(
            "r32_provider_diag_subtitle",
            "Runtime capability matrix from current configuration and resolver state.",
        ),
        "cards": [
            {
                "label": L.get("r32_provider_diag_real_ready", "Real / Ready"),
                "value": f"{int(summary.get('realCount', 0) or 0)} / {int(summary.get('readyCount', 0) or 0)}",
            },
            {
                "label": L.get("r32_provider_diag_mock_stub", "Mock / Stub"),
                "value": int(summary.get("mockOrStubCount", 0) or 0),
            },
            {
                "label": L.get("r32_provider_diag_high_risk", "High risk"),
                "value": int(summary.get("highRiskCount", 0) or 0),
            },
            {
                "label": L.get("r32_provider_diag_prod_ready", "Production ready"),
                "value": L.get("yes", "Yes")
                if bool(summary.get("productionReady"))
                else L.get("no", "No"),
            },
        ],
        "rows": rows,
        "auditNotes": runtime_notes + list((src.get("auditMode") or {}).get("notes") or []),
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

    vm["evidenceQuality"] = _evidence_quality_vm(report_json.get("evidenceQuality"), vm["labels"], internal)
    if not internal:
        for key in ("ru", "intl"):
            blk = vm.get(key)
            if blk:
                vm[key] = _filter_client_region_block(blk)

    ru_blk = vm.get("ru")
    if ru_blk:
        enrich_ru_orion_images(
            ru_blk,
            report_json,
            subject=str((vm.get("cover") or {}).get("subjectFullName") or ""),
            audit_date=str((vm.get("cover") or {}).get("auditDate") or ""),
            L=vm["labels"],
        )

    vm["evidenceConfirmedRu"] = _appendix_region_vm(vm.get("ru") or {})
    vm["evidenceReviewRu"] = {"rows": list(vm["evidenceConfirmedRu"]["review"])}
    vm["evidenceExcludedRu"] = {"rows": list(vm["evidenceConfirmedRu"]["excluded"])}
    vm["evidenceConfirmedIntl"] = _appendix_region_vm(vm.get("intl") or {})
    vm["evidenceReviewIntl"] = {"rows": list(vm["evidenceConfirmedIntl"]["review"])}
    vm["evidenceExcludedIntl"] = {"rows": list(vm["evidenceConfirmedIntl"]["excluded"])}
    vm["appendixOverview"] = _appendix_overview_vm(vm, vm["labels"])
    vm["mediaEvidenceOverview"] = _media_evidence_overview_vm(vm, vm["labels"])
    # Stage R3.5 — normalized compliance/risk intelligence (client-safe display model).
    vm["complianceRiskIntel"] = report_json.get("complianceRiskIntel") or {}
    vm["riskReasoningOverview"] = _risk_reasoning_overview_vm(vm, vm["labels"])
    vm["riskReasoningByRegion"] = _risk_reasoning_by_region_vm(vm, vm["labels"])
    vm["providerDiagnostics"] = _provider_diagnostics_vm(
        report_json.get("providerDiagnostics") or {},
        vm["labels"],
        internal,
    )
    vm["entityFiltering"] = report_json.get("entityFiltering") or {}
    vm["appendixConclusion"] = {
        "title": vm["labels"].get("r31_appendix_conclusion_title", "Appendix conclusion"),
        "lines": [
            vm["labels"].get(
                "r31_appendix_conclusion_line_1",
                "Detailed evidence is retained for analyst verification and traceability.",
            ),
            vm["labels"].get(
                "r31_appendix_conclusion_line_2",
                "The appendix structure supports transparent navigation between confirmed materials and review items.",
            ),
        ],
    }
    vm["r34Appendix"] = _r34_appendix_vm(vm, vm["labels"], internal)

    return vm, warnings


def _build_risk_matrix_rows(base: dict, ru: dict, intl: dict, wiki: dict, compliance_active: bool = True) -> dict:
    cdb = base["complianceDatabases"]
    L = base["labels"]
    uae_share = intl["summary"].get("organicNegativeShare", "0%") if intl["present"] else L["rm_no_data"]
    sanctions_level = "LOW"
    if compliance_active:
        sanctions_level = (
            "CRITICAL"
            if cdb["sanctionsMatches"] > 0
            else ("HIGH" if cdb["pepMatches"] + cdb["rcaMatches"] > 0 else "LOW")
        )
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
            "level": sanctions_level,
            "consequences": L["cons_compliance"],
        },
        {
            "area": L["area_intl_compliance"],
            "problems": L["rm_problems_intl"].format(
                a=cdb["activeMatches"] if compliance_active else 0, n=len(cdb["providersChecked"])
            ),
            "level": "HIGH" if compliance_active and cdb["activeMatches"] > 0 else ("LOW" if cdb["providersChecked"] else "UNKNOWN"),
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
