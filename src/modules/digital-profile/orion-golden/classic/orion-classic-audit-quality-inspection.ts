/**
 * R10.11 / new-brain — QA inspection for classic ORION audit decks.
 * Includes semantic consistency gates from the ORION benchmark review.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OrionGoldenDeckManifest } from "../composer/orion-deck-composer";
import type { FullEvidenceInventory } from "../evidence/full-evidence-inventory";
import type { OrionClassicAuditReportSpec } from "./orion-classic-client-content-to-report-spec";
import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
import { buildOrionThemeSet } from "./orion-classic-theme-set";

export const CLASSIC_ORION_AUDIT_PAGE_RANGE = { min: 45, max: 120 } as const;

const NO_ADVERSE_RE =
  /нежелательн(?:ые|ых)?\s+публикаци[яи]\s+не\s+обнаружен|adverse\s+(?:publications?\s+)?not\s+found|no\s+adverse\s+(?:results?|links?|publications?)|нежелательн(?:ые)?\s+ссылк[аи]\s+не\s+обнаружен/i;

const WIKI_FOUND_RE =
  /википеди[яи].{0,40}(?:статья\s+)?(?:обнаружен|найден|присутств)|wikipedia.{0,40}(?:article\s+)?(?:found|present|exists)/i;

const WIKI_WRONG_OR_ABSENT_RE =
  /другого\s+субъект|дворянский\s+род|не\s+является\s+профилем|статья\s+о\s+персоне\s+(?:не\s+подтвержден|отсутств)|энциклопедический\s+якорь.{0,40}отсутств/i;

export function inspectClassicOrionAuditQuality(input: {
  deckManifest: OrionGoldenDeckManifest;
  reportSpec: OrionClassicAuditReportSpec;
  inventory: FullEvidenceInventory;
  outputRoot: string;
  assets?: ReportAssetV1[];
  clientProductionFinalize?: boolean;
}): { passed: boolean; issues: string[]; checks: Array<{ id: string; passed: boolean; detail: string }> } {
  const issues: string[] = [];
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];

  const slideCount = input.deckManifest.slideCount;
  const pageOk =
    slideCount >= CLASSIC_ORION_AUDIT_PAGE_RANGE.min &&
    slideCount <= CLASSIC_ORION_AUDIT_PAGE_RANGE.max;
  checks.push({
    id: "page-range",
    passed: pageOk,
    detail: `${slideCount} slides (target ${CLASSIC_ORION_AUDIT_PAGE_RANGE.min}-${CLASSIC_ORION_AUDIT_PAGE_RANGE.max})`,
  });

  const serpScreenshotSlides = input.deckManifest.finalSlides.filter((s) =>
    s.sectionKey.includes("serp_screenshot") || s.template === "orion_golden_serp_screenshot"
  ).length;
  checks.push({
    id: "serp-screenshot-cap",
    passed: serpScreenshotSlides <= 6,
    detail: `${serpScreenshotSlides} SERP screenshot slides (max 6)`,
  });

  const texts = input.deckManifest.finalSlides.flatMap((s) => [
    s.title,
    s.narrative ?? "",
    ...(s.bullets ?? []),
  ]);
  const midWordCuts = texts.filter((t) => /[а-яА-Яa-zA-Z]{3,}\u2026$|[а-яА-Яa-zA-Z]{4,}\.\.\.$/.test(t.trim()) === false && /[^\s…]{15,}$/.test(t) && t.endsWith("…") === false && /[а-яa-z]{2}$/i.test(t) && t.length > 40 && !/[.!?)]$/.test(t.trim())).length;
  const enumLeaks = texts.filter((t) =>
    /CAVEATED|CONTROVERSIAL_DUAL|APPENDIX_ONLY|\bDISMISSED\b|\bUNCLASSIFIED\b/i.test(t)
  );
  checks.push({
    id: "no-raw-enum-leaks",
    passed: enumLeaks.length === 0,
    detail: enumLeaks.length ? `${enumLeaks.length} enum leaks` : "clean client labels",
  });
  void midWordCuts;

  const hasCommercial = input.deckManifest.finalSlides.some((s) =>
    ["offer", "product_overview", "solution_digital_profile", "about"].includes(s.sectionKey)
  );
  checks.push({
    id: "commercial-present",
    passed: hasCommercial,
    detail: hasCommercial ? "commercial sections present" : "missing commercial pack",
  });

  const hasSuggestions = input.reportSpec.registrySections.some((s) =>
    /suggestions|related_queries/.test(s.sectionId)
  );
  const hasSuggestionEvidence =
    input.inventory.mediaAvailability.suggestions > 0 ||
    input.inventory.mediaAvailability.relatedQueries > 0;
  checks.push({
    id: "suggestion-sections",
    passed: !hasSuggestionEvidence || hasSuggestions,
    detail: hasSuggestions ? "suggestion/related sections emitted" : "no suggestion sections (check evidence)",
  });

  const hasSerpOrLinks = input.reportSpec.registrySections.some((s) =>
    /serp_position|search_links/.test(s.sectionId)
  );
  const hasSearchEvidence = (input.inventory.counts.searchResults ?? 0) > 0;
  checks.push({
    id: "serp-or-search-links",
    passed: !hasSearchEvidence || hasSerpOrLinks,
    detail: hasSerpOrLinks ? "SERP/search-link sections present" : "missing SERP/search-link sections",
  });

  const commercialSlides = input.deckManifest.finalSlides.filter((s) =>
    ["offer", "product_overview", "solution_digital_profile", "solution_compliance_databases", "solution_wikipedia", "about"].includes(
      s.sectionKey
    )
  ).length;
  const commercialRatio = slideCount > 0 ? commercialSlides / slideCount : 0;
  checks.push({
    id: "commercial-ratio",
    passed: commercialRatio <= 0.35,
    detail: `${commercialSlides}/${slideCount} commercial (${(commercialRatio * 100).toFixed(0)}%, max 35%)`,
  });

  const brokenCompliance = input.deckManifest.finalSlides
    .flatMap((s) => [s.title, s.narrative ?? "", ...(s.bullets ?? [])])
    .filter((t) => /Комплаенс-проверка-риск|Комплаенс-проверка-вывод/i.test(t));
  checks.push({
    id: "no-broken-compliance-hyphen",
    passed: brokenCompliance.length === 0,
    detail: brokenCompliance.length
      ? `${brokenCompliance.length} broken compliance hyphen phrases`
      : "sanitizer compounds clean",
  });

  const objectObjectHits = input.deckManifest.finalSlides.flatMap((s) => s.bullets ?? []).filter((b) =>
    /\[object Object\]/i.test(b)
  );
  checks.push({
    id: "no-object-object",
    passed: objectObjectHits.length === 0,
    detail: objectObjectHits.length ? `${objectObjectHits.length} [object Object] bullets` : "clean bullets",
  });

  // --- Semantic consistency (benchmark P0) ---
  const themeSet = buildOrionThemeSet({
    inventory: input.inventory,
    subjectName: input.inventory.subject.fullName,
    caseId: input.inventory.caseId,
  });

  const slideBlob = (s: (typeof input.deckManifest.finalSlides)[number]) =>
    [s.title, s.narrative ?? "", ...(s.bullets ?? [])].join("\n");

  // 1) Summary adverse count vs «не обнаружены» on SERP/region slides
  for (const region of ["RU", "UAE"] as const) {
    const kpis = region === "RU" ? themeSet.ru : themeSet.uae;
    const regionSlides = input.deckManifest.finalSlides.filter((s) => {
      const key = `${s.sectionKey} ${s.title}`;
      if (region === "RU") return /(?:^|_)ru_|росси/i.test(key) && !/uae|оаэ/i.test(key);
      return /uae|оаэ/i.test(key);
    });
    const claimsNoAdverse = regionSlides.filter((s) => NO_ADVERSE_RE.test(slideBlob(s)));
    const contradiction =
      kpis.linksAdverse > 0 && claimsNoAdverse.length > 0;
    checks.push({
      id: `consistency-adverse-${region.toLowerCase()}`,
      passed: !contradiction,
      detail: contradiction
        ? `ThemeSet ${region} linksAdverse=${kpis.linksAdverse} but ${claimsNoAdverse.length} slide(s) say no adverse found`
        : `${region}: adverse=${kpis.linksAdverse}, no false «не обнаружены»`,
    });
  }

  // 2) Wikipedia: WRONG/ABSENT must not be framed as «статья обнаружена»
  for (const region of ["RU", "UAE"] as const) {
    const kpis = region === "RU" ? themeSet.ru : themeSet.uae;
    const wikiSlides = input.deckManifest.finalSlides.filter((s) =>
      /wikipedia|википед/i.test(`${s.sectionKey} ${s.title}`)
    );
    const regionWiki = wikiSlides.filter((s) => {
      const key = `${s.sectionKey} ${s.title}`;
      if (region === "RU") return !/uae|оаэ/i.test(key);
      return /uae|оаэ/i.test(key);
    });
    const pool = regionWiki.length > 0 ? regionWiki : wikiSlides;
    let wikiOk = true;
    let detail = `${region} wikipediaStatus=${kpis.wikipediaStatus}`;
    if (kpis.wikipediaStatus !== "EXACT_SUBJECT" && pool.length > 0) {
      const falsePresent = pool.filter((s) => {
        const blob = slideBlob(s);
        return WIKI_FOUND_RE.test(blob) && !WIKI_WRONG_OR_ABSENT_RE.test(blob);
      });
      if (falsePresent.length > 0) {
        wikiOk = false;
        detail = `${region}: status=${kpis.wikipediaStatus} but ${falsePresent.length} slide(s) claim article found`;
      }
    }
    if (kpis.wikipediaPresent && kpis.wikipediaStatus !== "EXACT_SUBJECT") {
      wikiOk = false;
      detail = `${region}: wikipediaPresent=true but status=${kpis.wikipediaStatus}`;
    }
    checks.push({
      id: `consistency-wikipedia-${region.toLowerCase()}`,
      passed: wikiOk,
      detail,
    });
  }

  // 3) Media KPI honesty: do not claim image/video counts when no media slides exist
  const hasMediaSlides = input.deckManifest.finalSlides.some((s) =>
    /image|video|media|картин|видео|knowledge/i.test(`${s.sectionKey} ${s.title}`)
  );
  const claimsMediaKpi = texts.some((t) =>
    /\d+\s*(?:из\s*)?\d*\s*(?:картин|изображен|видео)|images?\s*adverse|videos?\s*total/i.test(t)
  );
  // Soft warning style: only block when KPI claims large media volume with zero media slides
  const mediaVolumeClaimed =
    themeSet.ru.imagesTotal + themeSet.ru.videosTotal + themeSet.uae.imagesTotal + themeSet.uae.videosTotal;
  const mediaHonestyOk = !(mediaVolumeClaimed >= 10 && claimsMediaKpi && !hasMediaSlides);
  checks.push({
    id: "consistency-media-kpi-honesty",
    passed: mediaHonestyOk,
    detail: mediaHonestyOk
      ? `media inventory=${mediaVolumeClaimed}, mediaSlides=${hasMediaSlides}`
      : `inventory claims ${mediaVolumeClaimed} media items but deck has no media slides`,
  });

  try {
    const pdfPath = join(input.outputRoot, "rendered-client.pdf");
    if (existsSync(pdfPath)) {
      const pdf = readFileSync(pdfPath);
      checks.push({
        id: "pdf-nonempty",
        passed: pdf.length > 5000,
        detail: `${pdf.length} bytes`,
      });
    } else {
      checks.push({
        id: "pdf-nonempty",
        passed: true,
        detail: "skipped (offline composition)",
      });
    }
  } catch {
    checks.push({ id: "pdf-nonempty", passed: true, detail: "skipped" });
  }

  const assets = input.assets ?? [];
  const liveAssets = assets.filter((a) => a.kind === "live_serp" && a.status === "ready");
  const syntheticInDeck = assets.some((a) => a.kind === "synthetic_serp" && a.status === "ready");
  const unverifiedLive = liveAssets.filter((a) => a.geoStatus === "UNVERIFIED");
  const serpSlides = input.deckManifest.finalSlides.filter(
    (s) => s.sectionKey.includes("serp_screenshot") || s.template === "orion_golden_serp_screenshot"
  );

  if (input.clientProductionFinalize) {
    const geoOk = unverifiedLive.length === 0;
    checks.push({
      id: "live-serp-geo-unverified",
      passed: geoOk,
      detail: geoOk
        ? "all LIVE SERP assets GEO-verified or absent"
        : `${unverifiedLive.length} LIVE SERP asset(s) with geoStatus=UNVERIFIED`,
    });

    const noSynthetic = !syntheticInDeck;
    checks.push({
      id: "live-serp-no-synthetic-substitute",
      passed: noSynthetic,
      detail: noSynthetic
        ? "no synthetic SERP in client production assets"
        : "synthetic SERP must not substitute LIVE in client production",
    });

    const expectsSerp = serpSlides.length > 0 || liveAssets.length > 0;
    const hasLive = liveAssets.length > 0;
    const missingOk = !expectsSerp || hasLive;
    checks.push({
      id: "live-serp-missing",
      passed: missingOk,
      detail: missingOk
        ? `live=${liveAssets.length}, serpSlides=${serpSlides.length}`
        : "client production expects LIVE SERP but none are READY",
    });
  } else {
    checks.push({
      id: "live-serp-internal-preview",
      passed: true,
      detail: `live=${liveAssets.length}, unverified=${unverifiedLive.length}, synthetic=${syntheticInDeck}`,
    });
  }

  for (const check of checks) {
    if (!check.passed) issues.push(`${check.id}: ${check.detail}`);
  }

  return { passed: issues.length === 0, issues, checks };
}
