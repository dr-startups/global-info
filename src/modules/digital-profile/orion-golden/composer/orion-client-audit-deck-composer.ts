/**
 * R10.9 — Client_audit deck composer from ReportSpec built via client-content adapter.
 * R10.9a — visual polish: paginated risk matrix by severity, no narrative dumps,
 * separate manual-review / appendix slides, capped SERP/Lexis density.
 */

import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
import { sanitizeOrionGoldenClientText } from "../client/client-text-sanitizer";
import { humanizeClientRiskMatrixRow } from "../client/risk-matrix-normalizer";
import type { OrionGoldenReportSpec, SectionBlock } from "../report-spec/orion-report-spec";
import type { OrionGoldenDeckManifest, OrionGoldenDeckSlide } from "../composer/orion-deck-composer";

function slidesFromBlock(sectionKey: string, block: SectionBlock): OrionGoldenDeckSlide[] {
  return (block.slideSpecs ?? []).map((spec) => ({
    slideKey: spec.slideKey,
    sectionKey,
    template: spec.template,
    title: spec.title,
    pageNumber: 0,
    bullets: (spec.bullets ?? []).slice(0, 8),
    // R10.9a — do not dump full block narrative onto every slide (causes overlap)
    narrative: undefined,
    assetRefs: block.visualAssets,
  }));
}

function asClientBullet(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const candidate = [rec.title, rec.summary, rec.text, rec.theme, rec.label]
      .find((v) => typeof v === "string" && v.trim());
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

function sanitizeSlide(slide: OrionGoldenDeckSlide): OrionGoldenDeckSlide {
  return {
    ...slide,
    title: sanitizeOrionGoldenClientText(slide.title),
    narrative: slide.narrative
      ? sanitizeOrionGoldenClientText(slide.narrative).slice(0, 520)
      : undefined,
    bullets: slide.bullets
      ?.map((b) => sanitizeOrionGoldenClientText(asClientBullet(b)).slice(0, 140))
      .filter((b) => Boolean(b) && !/\[object Object\]/i.test(b))
      .slice(0, 8),
  };
}

function severityRank(level: string): number {
  const l = level.toLowerCase();
  if (/критич|critical/.test(l)) return 0;
  if (/высок|high/.test(l)) return 1;
  if (/средн|medium/.test(l)) return 2;
  if (/проверк|review|ручн/.test(l)) return 3;
  return 4;
}

function riskMatrixSlides(reportSpec: OrionGoldenReportSpec): OrionGoldenDeckSlide[] {
  const matrix = (reportSpec.riskMatrix ?? [])
    .map((r) => humanizeClientRiskMatrixRow({ theme: r.theme, level: r.level, summary: r.summary }))
    .sort((a, b) => severityRank(a.level) - severityRank(b.level));

  if (matrix.length === 0) {
    return [
      {
        slideKey: "risk-matrix-empty",
        sectionKey: "compliance_risk_matrix",
        template: "orion_golden_risk_matrix",
        title: "Матрица рисков",
        pageNumber: 0,
        bullets: ["Существенных подтверждённых тем риска не выявлено на текущем этапе."],
      },
    ];
  }

  const slides: OrionGoldenDeckSlide[] = [];
  const perPage = 5;
  for (let i = 0; i < matrix.length; i += perPage) {
    const chunk = matrix.slice(i, i + perPage);
    const pageIdx = Math.floor(i / perPage) + 1;
    slides.push({
      slideKey: `risk-matrix-${pageIdx}`,
      sectionKey: "compliance_risk_matrix",
      template: "orion_golden_risk_matrix",
      title:
        matrix.length > perPage
          ? `Матрица рисков (${pageIdx}/${Math.ceil(matrix.length / perPage)})`
          : "Матрица рисков",
      pageNumber: 0,
      bullets: chunk.map((r) => {
        const theme = sanitizeOrionGoldenClientText(r.theme)
          .replace(/\bWRONG[_\s-]?SUBJECT\b/gi, "другой субъект")
          .slice(0, 70);
        const level = sanitizeOrionGoldenClientText(r.level).slice(0, 40);
        const summary = sanitizeOrionGoldenClientText(r.summary)
          .replace(/\bWRONG[_\s-]?SUBJECT\b/gi, "другой субъект")
          .replace(/\bGPT\b/g, "модельный анализ")
          .slice(0, 55);
        return summary ? `${theme} — ${level}: ${summary}` : `${theme} — ${level}`;
      }),
    });
  }
  return slides;
}

function includeBlock(block: SectionBlock): boolean {
  return (
    (block.slideSpecs?.length ?? 0) > 0 ||
    Boolean(block.narrative?.trim()) ||
    (block.evidenceCards?.length ?? 0) > 0
  );
}

function assetSlides(
  sectionKey: string,
  template: string,
  titlePrefix: string,
  assets: ReportAssetV1[],
  maxAssets: number
): OrionGoldenDeckSlide[] {
  return assets.slice(0, maxAssets).map((asset, idx) => ({
    slideKey: `${sectionKey}-${asset.assetRef}`,
    sectionKey,
    template,
    title: asset.title || `${titlePrefix} ${idx + 1}`,
    pageNumber: 0,
    bullets: asset.caption ? [sanitizeOrionGoldenClientText(asset.caption).slice(0, 160)] : undefined,
    assetRefs: [asset.assetRef],
  }));
}

function chunkBullets(
  sectionKey: string,
  template: string,
  title: string,
  bullets: string[],
  perSlide: number
): OrionGoldenDeckSlide[] {
  const out: OrionGoldenDeckSlide[] = [];
  const clean = bullets.map((b) => sanitizeOrionGoldenClientText(b).slice(0, 200)).filter(Boolean);
  for (let i = 0; i < clean.length; i += perSlide) {
    out.push({
      slideKey: `${sectionKey}-${Math.floor(i / perSlide) + 1}`,
      sectionKey,
      template,
      title:
        clean.length > perSlide
          ? `${title} (${Math.floor(i / perSlide) + 1})`
          : title,
      pageNumber: 0,
      bullets: clean.slice(i, i + perSlide),
    });
  }
  return out;
}

/**
 * Compose a client_audit deck: content from adapter ReportSpec, no commercial filler.
 */
export function composeOrionClientAuditDeck(
  reportSpec: OrionGoldenReportSpec,
  assets: ReportAssetV1[] = []
): OrionGoldenDeckManifest {
  const serpAssets = assets.filter((a) => a.kind === "synthetic_serp" && a.status === "ready");
  const lexisAssets = assets.filter((a) => a.kind === "lexis_visual_page" && a.status === "ready");

  const sections: Array<{ sectionKey: string; slides: OrionGoldenDeckSlide[] }> = [
    {
      sectionKey: "cover",
      slides: [
        {
          slideKey: "cover",
          sectionKey: "cover",
          template: "orion_golden_cover",
          title: reportSpec.subject.reportTitle,
          pageNumber: 0,
          narrative: reportSpec.subject.displayName,
        },
      ],
    },
    {
      sectionKey: "global_toc",
      slides: chunkBullets(
        "global_toc",
        "orion_golden_toc",
        "Содержание",
        reportSpec.globalToc.map((t) => t.title).slice(0, 18),
        12
      ),
    },
    {
      sectionKey: "executive_summary",
      slides: [
        {
          slideKey: "executive-1",
          sectionKey: "executive_summary",
          template: "orion_golden_executive_card",
          title: "Резюме",
          pageNumber: 0,
          narrative: sanitizeOrionGoldenClientText(
            reportSpec.executiveSummary.executiveSummary
          ).slice(0, 480),
          bullets: [
            ...reportSpec.executiveSummary.mainRisks.slice(0, 3),
            ...reportSpec.executiveSummary.finalRecommendations.slice(0, 3),
          ]
            .map((b) => sanitizeOrionGoldenClientText(asClientBullet(b)).slice(0, 140))
            .filter((b) => Boolean(b) && !/\[object Object\]/i.test(b)),
        },
      ],
    },
    {
      sectionKey: "compliance_risk_matrix",
      slides: riskMatrixSlides(reportSpec),
    },
  ];

  const contentBlocks: Array<{ sectionKey: string; block: SectionBlock }> = [
    { sectionKey: "ru_audit_summary", block: reportSpec.ruAuditSummary },
    { sectionKey: "ru_search_results", block: reportSpec.ruSearchResults },
    { sectionKey: "ru_wikipedia", block: reportSpec.ruWikipedia },
    { sectionKey: "uae_audit_summary", block: reportSpec.uaeAuditSummary },
    { sectionKey: "uae_search_results", block: reportSpec.uaeSearchResults },
    { sectionKey: "uae_wikipedia", block: reportSpec.uaeWikipedia },
    { sectionKey: "compliance_databases", block: reportSpec.complianceDatabases },
    { sectionKey: "lexisnexis", block: reportSpec.lexisNexis },
    { sectionKey: "dow_jones", block: reportSpec.dowJones },
    { sectionKey: "world_check", block: reportSpec.worldCheck },
  ];

  for (const { sectionKey, block } of contentBlocks) {
    if (!includeBlock(block)) continue;
    sections.push({ sectionKey, slides: slidesFromBlock(sectionKey, block) });
  }

  // R10.9a — reduce SERP/Lexis density (max 2 SERP + 3 Lexis visual pages)
  if (serpAssets.length > 0) {
    sections.push({
      sectionKey: "ru_serp_screenshots",
      slides: assetSlides(
        "ru_serp_screenshots",
        "orion_golden_serp_screenshot",
        "Снимок выдачи",
        serpAssets,
        2
      ),
    });
  }

  if (lexisAssets.length > 0) {
    sections.push({
      sectionKey: "lexisnexis_visual",
      slides: assetSlides(
        "lexisnexis",
        "orion_golden_lexis_visual_page",
        "LexisNexis",
        lexisAssets,
        3
      ),
    });
  }

  if (includeBlock(reportSpec.offer) && reportSpec.offer.qaMetadata.sectionKey === "recommendations") {
    sections.push({
      sectionKey: "recommendations",
      slides: slidesFromBlock("recommendations", reportSpec.offer),
    });
  }

  if (includeBlock(reportSpec.appendix)) {
    const manualSpecs = reportSpec.appendix.slideSpecs.filter((s) =>
      s.slideKey.startsWith("manual-review")
    );
    const appendixSpecs = reportSpec.appendix.slideSpecs.filter(
      (s) => !s.slideKey.startsWith("manual-review")
    );
    if (manualSpecs.length) {
      sections.push({
        sectionKey: "manual_review_required",
        slides: slidesFromBlock("manual_review_required", {
          ...reportSpec.appendix,
          slideSpecs: manualSpecs,
          narrative: "",
        }),
      });
    }
    if (appendixSpecs.length) {
      sections.push({
        sectionKey: "appendix",
        slides: slidesFromBlock("appendix", {
          ...reportSpec.appendix,
          slideSpecs: appendixSpecs,
          narrative: "",
        }),
      });
    }
  }

  let page = 1;
  const sectionManifests: OrionGoldenDeckManifest["sectionManifests"] = [];
  const finalSlides: OrionGoldenDeckSlide[] = [];

  for (const section of sections) {
    const slides = section.slides.filter(
      (s) => s.title || s.narrative || (s.bullets?.length ?? 0) > 0 || (s.assetRefs?.length ?? 0) > 0
    );
    if (slides.length === 0) continue;
    for (const s of slides) s.pageNumber = page++;
    sectionManifests.push({ sectionKey: section.sectionKey, slideCount: slides.length, slides });
    finalSlides.push(...slides.map(sanitizeSlide));
  }

  const toc = finalSlides
    .filter((s) => s.sectionKey !== "cover")
    .filter((_, idx, arr) => idx === 0 || arr[idx - 1]?.sectionKey !== arr[idx].sectionKey)
    .slice(0, 30)
    .map((s) => ({ title: s.title, pageNumber: s.pageNumber }));

  const pageNumberMap: Record<string, number> = {};
  for (const s of finalSlides) pageNumberMap[s.slideKey] = s.pageNumber;

  return {
    version: "r10-orion-golden-deck-manifest-v1",
    slideCount: finalSlides.length,
    sectionManifests,
    finalSlides,
    toc,
    pageNumberMap,
  };
}
