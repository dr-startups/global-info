/**
 * R10.11 — Classic ORION audit ReportSpec: 1:1 registry section mapping + commercial pack.
 * Inventory-backed fallbacks keep SERP/themes/suggestions usable when section GPT JSON is absent.
 */

import { classifyAutocompleteQuery } from "../../evidence-quality/autocomplete-class";
import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
import type { OrionClientContent } from "../content/orion-client-content-builder";
import type { FullEvidenceInventory } from "../evidence/full-evidence-inventory";
import type { ExecutiveSynthesisOutput } from "../gpt/orion-executive-synthesis-from-sections";
import type { SectionDerivedRiskMatrix } from "../sections/orion-risk-matrix-from-sections";
import { getClientAuditSections } from "../sections/orion-section-registry";
import { sanitizeOrionGoldenClientText, humanizeRiskTheme } from "../client/client-text-sanitizer";
import { humanizeClientRiskMatrixRow } from "../client/risk-matrix-normalizer";
import type { OrionGoldenReportSpec, SectionBlock } from "../report-spec/orion-report-spec";
import {
  type ClientContentToReportSpecInput,
} from "../report-spec/orion-client-content-to-report-spec";
import { buildOrionClassicCommercialPack } from "./orion-classic-commercial-pack";
import {
  bulletsPerSlideForSection,
  maxSlidesForSection,
  templateForRegistrySection,
} from "./orion-classic-section-template-map";
import {
  asClientBullet,
  chunkItems,
  isClientActionRecommendation,
  isDemoOrPlaceholderClientText,
  isEnglishComplianceStub,
  sanitizeClassicBullets,
  sanitizeExecutiveClientText,
  scrubClientFacingProse,
  splitCompleteChunks,
  stripNumberedClientPrefix,
  truncateAtWordBoundary,
} from "./orion-classic-text-utils";
import {
  buildAnnotatedLinkCards,
  buildComplianceDbSlides,
  buildComplianceProviderBullets,
  buildDecisionConsequences,
  buildOrionThemeSet,
  buildSerpHeatGridBullets,
  complianceToClientClaim,
  orionStyleRiskMatrixRows,
  regionalAuditDashboardBlock,
  shortSubjectDative,
  themeSetBullets,
  wikipediaClientNarrative,
  wikipediaStatusLine,
  classifyWikipediaHit,
  type OrionThemeSet,
} from "./orion-classic-theme-set";

export type OrionClassicAuditReportSpec = OrionGoldenReportSpec & {
  reportMode: "classic_orion_audit";
  registrySections: Array<{ sectionId: string; order: number; block: SectionBlock }>;
};

type ClientSection = NonNullable<OrionClientContent["sections"]>[number];
type RegionBucket = "RU" | "UAE";

function mapGlobalRiskLevel(
  level: string
): OrionGoldenReportSpec["executiveSummary"]["globalRiskLevel"] {
  const map: Record<string, OrionGoldenReportSpec["executiveSummary"]["globalRiskLevel"]> = {
    Низкий: "low",
    Средний: "medium",
    Высокий: "high",
    Критический: "critical",
    "Требует проверки": "review_required",
    low: "low",
    medium: "medium",
    high: "high",
    critical: "critical",
    review_required: "review_required",
  };
  return map[level] ?? "review_required";
}

function normalizeRegion(raw: string | undefined): string {
  return String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/^INTERNATIONAL$/, "INTL");
}

function matchesRegion(itemRegion: string | undefined, bucket: RegionBucket): boolean {
  const r = normalizeRegion(itemRegion);
  if (bucket === "RU") return r === "RU" || r === "GLOBAL" || r === "" || r === "RUSSIA";
  return r === "UAE" || r === "INTL" || r === "AE" || r === "GLOBAL_INTL";
}

function domainOf(url: string | undefined): string {
  if (!url) return "";
  return url
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    ?.slice(0, 48) ?? "";
}

function positionOf(item: FullEvidenceInventory["items"][number]): number {
  const rm = item.rawMetadata ?? {};
  const candidates = [rm.position, rm.rank, rm.serpPosition, rm.resultPosition];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 0;
}

function riskClassificationBlob(item: FullEvidenceInventory["items"][number]): string {
  const rm = item.rawMetadata ?? {};
  const nested = rm.riskClassification;
  const parts: string[] = [
    String(item.classification ?? ""),
    String(rm.themeLabel ?? ""),
    String(rm.riskTheme ?? ""),
    String(rm.category ?? ""),
    String(rm.classification ?? ""),
  ];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const n = nested as Record<string, unknown>;
    const auto = n.auto && typeof n.auto === "object" ? (n.auto as Record<string, unknown>) : null;
    parts.push(String(n.classification ?? ""), String(auto?.classification ?? ""), String(auto?.theme ?? ""));
  }
  return parts.join(" ").toLowerCase();
}

function themeLabelOf(item: FullEvidenceInventory["items"][number]): string {
  const rm = item.rawMetadata ?? {};
  const nested = rm.riskClassification;
  let raw = "";
  if (typeof rm.themeLabel === "string" && rm.themeLabel.trim()) raw = rm.themeLabel.trim();
  else if (typeof rm.riskTheme === "string" && rm.riskTheme.trim()) raw = rm.riskTheme.trim();
  else if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const n = nested as Record<string, unknown>;
    const auto = n.auto && typeof n.auto === "object" ? (n.auto as Record<string, unknown>) : null;
    raw = String(auto?.theme ?? auto?.classification ?? "").trim();
  }
  if (!raw) raw = String(item.classification ?? "").trim();
  if (!raw) return "Нежелательная тема";
  // Drop internal workflow / dismissed labels from client deck
  if (
    /^(dismissed|news|corporate[_\s]?registry|unclassified|biography|neutral|identity|caveated[_\s]?analysis|controversial[_\s]?dual[_\s]?use|appendix[_\s]?only)$/i.test(
      raw.replace(/\s+/g, "_")
    )
  ) {
    return "";
  }
  return humanizeRiskTheme(raw);
}

function buildComplianceOverviewBullets(themeSet: OrionThemeSet): {
  narrative: string;
  bullets: string[];
} {
  const providerClaims = themeSet.complianceSignals.map((c) =>
    complianceToClientClaim(c, themeSet.subjectName)
  );
  const sDat = shortSubjectDative(themeSet.subjectName);
  const fallbackProviders =
    providerClaims.length > 0
      ? providerClaims
      : [
          `В Dow Jones — предварительное совпадение по ${sDat}; требуется сверка полного профиля`,
          "По World-Check и LexisNexis доступны предварительные сигналы совпадения по имени; требуется сверка полных профилей.",
        ];
  const contextBits = themeSet.complianceSignals
    .flatMap((c) => c.openSourceContext)
    .filter((b, i, arr) => arr.findIndex((x) => x.slice(0, 40) === b.slice(0, 40)) === i)
    // Skip contour line if provider claims already embed the same open-source names.
    .filter((b) => {
      if (!/смежный открытый контур/i.test(b)) return true;
      const claimsJoined = providerClaims.join(" ");
      return !/махмудов|бокарев|трансмаш|ликсутов|лавров/i.test(claimsJoined);
    })
    .slice(0, 2);
  // Provider-focused overview; optional shared open-source context once.
  return {
    narrative:
      "В международных базах данных зафиксированы следующие предварительные сигналы:",
    bullets: sanitizeClassicBullets(
      [
        ...fallbackProviders,
        ...contextBits,
        "Сигналы предварительные: требуется сверка полного профиля и первоисточников.",
      ],
      320
    ).slice(0, 6),
  };
}

function isComplianceOverviewSection(sectionId: string): boolean {
  return (
    sectionId.includes("compliance_database") ||
    sectionId.includes("sanctions") ||
    sectionId.includes("compliance_media") ||
    sectionId.includes("other_public_databases")
  );
}

/** Word-ish boundary that works for Cyrillic (JS \\b is ASCII-only). */
const WB = "(?:^|[^\\p{L}\\p{N}_])";
const WE = "(?=$|[^\\p{L}\\p{N}_])";

function isNoiseSuggestion(query: string): boolean {
  const q = query.toLowerCase().trim();
  // Generic media / entertainment / autocomplete junk (Glinka packs)
  const mediaJunk = new RegExp(
    `${WB}(?:слушать|музык\\p{L}*|войн[еа]|стих(?:ов|и|а)?|онлайн|youtube|ютуб|piano|violin|concerto|lyrics|gallery|dance|танц\\p{L}*|photograph(?:er|y)?|photos?|videos?|imagery|imagenes|фотограф\\p{L}*|recording|quotes?|молодост\\p{L}*|newshour|newsletter|newspaper|rubinstein|ruskin|images?(?:\\s+(?:free|and\\s+quotes))?|video(?:\\s+(?:live|recording|смотреть))?|videos?\\s+youtube|news(?:letter|paper|hour|\\s*(?:today|article|202\\d))?|autocomplete\\s+(?:lyrics|piano|pdf|analysis)|interview(?:s|\\s+(?:questions|смотреть|видео|pdf|20\\d{2}))?|интервью(?:\\s+(?:смотреть|видео))?|видео(?:\\s+(?:смотреть|ютуб))?|фото(?:\\s*(?:в\\s+молодости|графии))?|фотографии|profiles?|profile(?:\\s+(?:picture|nyc|pdf))?|images?\\s+for\\s+sale|russian\\s+(?:translation|dance)|university|uae\\s+email|\\.?pdf)${WE}`,
    "iu"
  );
  if (mediaJunk.test(q)) return true;

  if (
    /подсказки\s+(слушать|в\s+музыке|в\s+войне|слушать\s+онлайн)/iu.test(q) ||
    /публикация\s+стих|related queries|image gallery|images free|uaeraine|uaeu|russkov|russo(?:\s|$)/iu.test(q)
  ) {
    return true;
  }

  // Soft family / gossip without compliance signal
  if (/(?:^|[^\p{L}])(?:дети|жена|муж|семья|детишки)(?:$|[^\p{L}])/iu.test(q)) {
    return true;
  }

  // Truncated / typo UAE autocomplete tails (uaec, uaev, uaem, glinka … russian alone)
  if (/\buae[a-z]\b/i.test(q) || /\buae\s+202\d\b/i.test(q)) return true;
  if (/\b(?:russian|russia|ruskin)\b/i.test(q) && !/(?:трансмаш|санкц|криминал|linkedin|биограф|wikipedia)/iu.test(q)) {
    return true;
  }

  // Soft social/media filler without compliance signal
  const softMedia =
    /(?:фото|видео|интервью|стих|ютуб|youtube|dance|photograph|photos?|videos?|imagery|imagenes|newsletter|newshour|interviews?|\.pdf|\bpdf\b)/iu;
  const complianceSignal =
    /(?:трансмаш|санкц|криминал|суд|арест|pep|rca|википед|wikipedia|биограф|инн|дата\s+рожден|linkedin|rupep|forbes|компромат)/iu;
  if (/^(?:глинк\p{L}*|glinka)/iu.test(q) && softMedia.test(q) && !complianceSignal.test(q)) {
    return true;
  }

  // Bare FIO-only suggestion (no topical token) — low client value on a packed slide
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length <= 3 && /^(?:глинк|glinka|сергей|sergey|михайлович|mikhaylovich)/iu.test(tokens[0] ?? "")) {
    const topical = tokens.some((t) =>
      /(?:трансмаш|биограф|википед|wikipedia|linkedin|инн|рожден|санкц|криминал|публикация|сми)/iu.test(t)
    );
    if (!topical) return true;
  }

  // Composer / musician namesake bleed
  if (/(?:михаил|mikhail|composer|композитор)/iu.test(q) && /глинк|glinka/iu.test(q)) {
    return true;
  }
  return /^(?:deripaska|oleg)\s+(?:oleg\s+)?(?:vladimirovich\s+)?(?:related|image|video|news|profile|interview\s+\d{4})/iu.test(
    q
  );
}

/** Prefer compliance-relevant autocomplete over soft biography filler. */
function suggestionRelevanceBoost(query: string): number {
  const q = query.toLowerCase();
  let boost = 0;
  if (/(?:трансмаш|махмудов|бокарев|ликсутов|санкц|криминал|суд|арест|pep|rca|компромат|rupep|rucriminal|forbes|офшор|лнр)/iu.test(q)) {
    boost += 80;
  }
  if (/(?:википед|wikipedia|биограф|инн|дата\s+рожден|linkedin|огрн|публикац|сми)/iu.test(q)) {
    boost += 35;
  }
  if (/(?:фото|видео|интервью|стих|ютуб|youtube|dance|photograph|photos?|videos?|imagery|quotes|newsletter|imagenes|дети|жена)/iu.test(q)) {
    boost -= 30;
  }
  return boost;
}

function buildExecutiveFromClient(
  client: OrionClientContent,
  executive?: ExecutiveSynthesisOutput | null,
  riskMatrix?: SectionDerivedRiskMatrix | null
): OrionGoldenReportSpec["executiveSummary"] {
  const matrixSource = client.riskMatrixSummary ?? riskMatrix;
  const riskMatrixRows = (matrixSource?.rows ?? [])
    .filter((r) => !r.requiresManualReview || Boolean(r.caveat) || Boolean(r.summary?.trim()))
    .map((r) => ({
      theme: sanitizeOrionGoldenClientText(r.theme),
      level: sanitizeOrionGoldenClientText(r.level),
      summary: sanitizeOrionGoldenClientText(
        r.requiresManualReview || r.caveat
          ? `${r.summary}${r.caveat ? ` — ${r.caveat}` : " — требует ручной проверки"}`
          : r.summary
      ),
    }));

  const sectionExec = (client.sections ?? []).find((s) => s.sectionId === "01_executive_summary");
  const execText =
    executive?.executiveSummary ||
    sectionExec?.narrative ||
    client.executiveSummaryDraft ||
    "Резюме формируется на основе секционного анализа.";

  const fromSynthesis = executive?.mainRisks?.map((r) => stripNumberedClientPrefix(asClientBullet(r))) ?? [];
  const fromSection =
    sectionExec?.keyFindings
      ?.filter((f) => !/^рекомендуемое действие$/i.test(f.title))
      .map((f) => stripNumberedClientPrefix(asClientBullet(f.summary || f.title))) ?? [];
  const fromFindings = client.approvedFindings
    .slice(0, 6)
    .map((f) => stripNumberedClientPrefix(asClientBullet(f.summary || f.title)));

  const mainRisks = (fromSynthesis.length > 0 ? fromSynthesis : fromSection.length > 0 ? fromSection : fromFindings).slice(
    0,
    6
  );

  const rawRecs = (executive?.finalRecommendations ?? client.recommendations ?? []).map(asClientBullet);
  const filteredRecs = rawRecs.filter(isClientActionRecommendation);

  return {
    executiveSummary: sanitizeExecutiveClientText(execText, 2200),
    globalRiskLevel: mapGlobalRiskLevel(
      executive?.globalRiskLevel ?? matrixSource?.globalRiskLevel ?? "Требует проверки"
    ),
    riskMatrix: riskMatrixRows,
    mainRisks: sanitizeClassicBullets(mainRisks, 280),
    possibleConsequences: sanitizeClassicBullets(
      executive?.possibleConsequences?.map(asClientBullet) ?? [],
      280
    ),
    finalRecommendations: sanitizeClassicBullets(filteredRecs, 280),
    nextSteps: sanitizeClassicBullets(executive?.nextSteps?.map(asClientBullet) ?? [], 280),
    generatedBy: "gpt-5.5",
  };
}

function adverseThemeRows(
  inventory: FullEvidenceInventory | undefined,
  region?: RegionBucket,
  themeSet?: OrionThemeSet | null
): Array<{ theme: string; count: number }> {
  if (themeSet) {
    const themes =
      region == null
        ? themeSet.themes
        : themeSet.themes.filter((t) => t.regions.includes(region) || t.regions.length === 0);
    if (themes.length > 0) return themes.map((t) => ({ theme: t.title, count: t.count }));
  }
  if (!inventory) return [];
  const counts = new Map<string, number>();

  for (const item of inventory.items) {
    if (region && !matchesRegion(item.region, region)) continue;
    const et = item.evidenceType.toLowerCase();
    if (et !== "search_result" && et !== "risk_finding" && et !== "compliance_hit") continue;

    const blob = riskClassificationBlob(item);
    const titleBlob = `${item.title} ${item.snippet ?? ""}`.toLowerCase();
    const adverseHint =
      /adverse|negative|undesirable|нежелат|негатив|санкц|sanction|корруп|corrupt|мошен|fraud|арест|arrest|уголов|criminal|суд|lawsuit|pep|watchlist|rca|компромат|offshore|офшор|risk_finding|compliance_hit/i.test(
        `${blob} ${titleBlob} ${et}`
      );
    if (!adverseHint) continue;

    const key = themeLabelOf(item);
    if (!key) continue;
    const clean = sanitizeOrionGoldenClientText(key).replace(/_/g, " ").trim();
    if (!clean || /^(biography|unclassified|neutral|identity)$/i.test(clean)) continue;
    counts.set(clean, (counts.get(clean) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([theme, count]) => ({ theme, count }));
}

function applyThemeSetToExecutive(
  executive: OrionGoldenReportSpec["executiveSummary"],
  themeSet: OrionThemeSet
): OrionGoldenReportSpec["executiveSummary"] {
  const matrixRows = orionStyleRiskMatrixRows(themeSet).map((r) =>
    humanizeClientRiskMatrixRow(r)
  );
  const decision = buildDecisionConsequences(themeSet);
  return {
    ...executive,
    executiveSummary: sanitizeExecutiveClientText(themeSet.executiveNarrative, 2600),
    mainRisks: sanitizeClassicBullets(themeSet.executiveBullets, 360).slice(0, 8),
    possibleConsequences: sanitizeClassicBullets(decision.consequences, 280),
    nextSteps: sanitizeClassicBullets([decision.recommendation, themeSet.nextStep], 320),
    riskMatrix: matrixRows.length > 0 ? matrixRows : executive.riskMatrix,
  };
}

function buildOrionExecutiveSlides(
  executive: OrionGoldenReportSpec["executiveSummary"],
  themeSet: OrionThemeSet
): SectionBlock["slideSpecs"] {
  const decision = buildDecisionConsequences(themeSet);
  const matrixRows = orionStyleRiskMatrixRows(themeSet).slice(0, 6);
  // Decision slide: consequences + short theme labels — full claim matrix lives in section 02.
  const decisionBullets = sanitizeClassicBullets(
    [
      ...decision.consequences.slice(0, 4),
      ...matrixRows
        .filter((r) => r.theme !== "Международные базы")
        .slice(0, 4)
        .map((r) => `${r.theme} — ${r.level}`),
      decision.recommendation,
    ],
    280
  ).slice(0, 8);
  const themeBullets = sanitizeClassicBullets(themeSet.executiveBullets, 400).slice(0, 7);
  // Visual slide: KPI + short labels only (no third copy of full executive claims).
  const visualBullets = sanitizeClassicBullets(
    [
      ...matrixRows.slice(0, 5).map((r) => `${r.theme} — ${r.level}`),
      `Россия: ${themeSet.ru.linksAdversePct}% · ${themeSet.ru.overallBadge}`,
      `ОАЭ: ${themeSet.uae.linksAdversePct}% · ${themeSet.uae.overallBadge}`,
    ],
    200
  ).slice(0, 7);
  return [
    {
      slideKey: "executive-1",
      template: "orion_golden_executive_card",
      title: "Резюме",
      narrative: executive.executiveSummary || themeSet.executiveNarrative,
      bullets: themeBullets.slice(0, 7),
    },
    {
      slideKey: "executive-decision",
      template: "orion_golden_risk_matrix",
      title: `${themeSet.subjectName} — ${decision.headline}`,
      narrative: truncateAtWordBoundary(
        `${decision.headline}. Уровень риска: ${decision.riskLevel}. Ниже — вероятные последствия и ключевые темы; детальная матрица — на следующем блоке.`,
        700
      ),
      bullets: decisionBullets,
    },
    {
      slideKey: "executive-visual",
      template: "orion_golden_executive_card",
      title: "Ключевые темы и базы данных",
      narrative: [
        `Краткий указатель тем цифрового профиля (без повтора полного резюме).`,
        `Россия: ${themeSet.ru.linksAdversePct}% потенциально нежелательных · ${themeSet.ru.overallBadge}.`,
        `ОАЭ: ${themeSet.uae.linksAdversePct}% потенциально нежелательных · ${themeSet.uae.overallBadge}.`,
      ].join(" "),
      bullets: visualBullets,
    },
  ];
}

function buildRegionalAuditSummaryBlock(
  themeSet: OrionThemeSet,
  region: RegionBucket,
  title: string
): SectionBlock {
  const dash = regionalAuditDashboardBlock({ themeSet, region, title });
  return {
    sectionTitle: sanitizeOrionGoldenClientText(title),
    metrics: {
      mode: "regional_audit_dashboard",
      adversePct: region === "RU" ? themeSet.ru.linksAdversePct : themeSet.uae.linksAdversePct,
      badge: dash.badge,
    },
    narrative: truncateAtWordBoundary(
      `${dash.narrative} Оценка профиля: ${dash.badge}.`,
      700
    ),
    tables: [],
    evidenceCards: dash.bullets.map((b) => ({ title: "Тема", summary: b })),
    visualAssets: [],
    slideSpecs: [
      {
        slideKey: `${region.toLowerCase()}-audit-dashboard`,
        template: "orion_golden_audit_dashboard",
        title,
        narrative: truncateAtWordBoundary(
          `${dash.narrative} Оценка профиля: ${dash.badge}.`,
          500
        ),
        bullets: sanitizeClassicBullets([...dash.bullets, ...dash.kpiLines], 320).slice(0, 12),
      },
    ],
    sourceRefs: [],
    qaMetadata: { sectionKey: region === "RU" ? "10_ru_audit_summary" : "30_uae_audit_summary" },
  };
}

function serpPositionTable(
  inventory: FullEvidenceInventory | undefined,
  region: RegionBucket
): Array<{ headers: string[]; rows: string[][] }> {
  if (!inventory) return [];
  type Row = { rank: number; domain: string; title: string; url: string };
  const byQuery = new Map<string, Row[]>();

  for (const item of inventory.items) {
    if (item.evidenceType !== "search_result") continue;
    if (!matchesRegion(item.region, region)) continue;
    const query = item.query?.trim() || "основной запрос";
    const list = byQuery.get(query) ?? [];
    const url = String(item.sourceUrl ?? "").slice(0, 90);
    if (url && list.some((r) => r.url === url)) continue;
    list.push({
      rank: positionOf(item) || list.length + 1,
      domain: domainOf(item.sourceUrl),
      title: truncateAtWordBoundary(item.title, 70),
      url: url || "—",
    });
    byQuery.set(query, list);
  }

  const tables: Array<{ headers: string[]; rows: string[][] }> = [];
  const sortedQueries = [...byQuery.entries()].sort((a, b) => b[1].length - a[1].length);
  // Cap to 2 query tables per region — avoid 6 identical narrative pages
  for (const [, rows] of sortedQueries.slice(0, 2)) {
    const ordered = [...rows]
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 10)
      .map((r, idx) => ({ ...r, rank: r.rank || idx + 1 }));
    tables.push({
      headers: ["Поз.", "Домен", "Заголовок", "URL"],
      rows: ordered.map((r) => [String(r.rank), r.domain || "—", r.title, r.url || "—"]),
    });
  }
  return tables;
}

function serpTableBullets(
  inventory: FullEvidenceInventory | undefined,
  region: RegionBucket
): string[] {
  const tables = serpPositionTable(inventory, region);
  const bullets: string[] = [];
  const seen = new Set<string>();
  for (const table of tables) {
    for (const row of table.rows.slice(0, 10)) {
      const [pos, domain, title, url] = row;
      const key = (url && url !== "—" ? url : `${domain}|${title}`).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      bullets.push(`#${pos} ${domain} — ${title}${url && url !== "—" ? ` (${url})` : ""}`);
    }
  }
  return bullets.slice(0, 16);
}

function searchLinkBullets(
  inventory: FullEvidenceInventory | undefined,
  region: RegionBucket
): string[] {
  if (!inventory) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of inventory.items) {
    if (item.evidenceType !== "search_result" || !matchesRegion(item.region, region)) continue;
    const url = String(item.sourceUrl ?? "");
    const domain = domainOf(item.sourceUrl);
    const line = `${domain} ${item.title} ${url}`;
    if (isDemoOrPlaceholderClientText(line)) continue;
    const key = url.toLowerCase() || `${domain}|${item.title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const urlSuffix = item.sourceUrl ? ` — ${String(item.sourceUrl).slice(0, 70)}` : "";
    out.push(`${domain || "источник"}: ${truncateAtWordBoundary(item.title, 90)}${urlSuffix}`);
    if (out.length >= 12) break;
  }
  return out;
}

function suggestionBullets(
  inventory: FullEvidenceInventory | undefined,
  subjectName: string,
  surfaceType: "suggestion" | "related_query",
  provider?: "yandex" | "google",
  region?: RegionBucket
): string[] {
  if (!inventory) return [];
  const typeMatchers =
    surfaceType === "related_query"
      ? ["related_query", "related query"]
      : ["suggestion", "search_suggestion"];

  const scored = inventory.items
    .filter((item) => {
      const et = item.evidenceType.toLowerCase();
      if (!typeMatchers.some((t) => et.includes(t.replace("_", "")) || et === t)) return false;
      if (provider && !String(item.provider).toLowerCase().includes(provider)) return false;
      if (region && !matchesRegion(item.region, region)) return false;
      const q = (item.query || item.title || "").trim();
      if (isDemoOrPlaceholderClientText(q)) return false;
      if (isNoiseSuggestion(q)) return false;
      return true;
    })
    .map((item) => {
      const query = (item.query || item.title || "").trim();
      const cls = classifyAutocompleteQuery(query, subjectName);
      const riskBoost = cls === "RISK_QUERY" ? 100 : 0;
      const subjectBoost =
        cls === "EXACT_SUBJECT_QUERY" || cls === "SUBJECT_BROAD_QUERY" ? 40 : 0;
      const adjacentPenalty =
        cls === "NAMESAKE_QUERY" || cls === "IRRELEVANT_QUERY" || cls === "GENERIC_QUERY" ? -40 : 0;
      const relevance = suggestionRelevanceBoost(query);
      return {
        query,
        cls,
        score: riskBoost + subjectBoost + adjacentPenalty + relevance + Math.min(query.length, 40),
      };
    })
    .filter((row) => row.query.length >= 3)
    .filter(
      (row) =>
        row.cls === "RISK_QUERY" ||
        row.cls === "EXACT_SUBJECT_QUERY" ||
        row.cls === "SUBJECT_BROAD_QUERY" ||
        row.cls === "TYPO_OR_SIMILAR_QUERY"
    )
    .sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const out: string[] = [];
  // Prefer risk queries first (one slide budget ≈ 14 lines).
  for (const row of scored) {
    if (row.cls !== "RISK_QUERY") continue;
    const key = row.query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${row.query} ⚠ рискованный запрос`);
    if (out.length >= 14) return out;
  }
  for (const row of scored) {
    const key = row.query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row.query);
    if (out.length >= 14) break;
  }
  return out;
}

function wikipediaBullets(
  inventory: FullEvidenceInventory | undefined,
  region: RegionBucket,
  subjectName?: string
): string[] {
  if (!inventory) return [];
  const subject = subjectName || inventory.subject.fullName;
  const langPrefer = region === "RU" ? ["RU", "RUSSIAN"] : ["EN", "AE", "UAE", "AR", "INTL", "ENGLISH"];
  const items = inventory.items.filter((i) => {
    if (i.evidenceType !== "wikipedia") return false;
    const blob = `${i.title} ${i.snippet ?? ""} ${i.sourceUrl ?? ""}`;
    if (isDemoOrPlaceholderClientText(blob)) return false;
    if (/отсутств|not\s+found|no\s+article|не\s+найден|page not found/i.test(blob)) return false;
    return Boolean(i.sourceUrl && /wikipedia\.org/i.test(i.sourceUrl)) || /статья найдена|article found/i.test(blob);
  });
  // For UAE, do not fall back to RU wikipedia — that creates KPI/bullet mismatch.
  const preferred = items.filter((i) => langPrefer.includes(normalizeRegion(i.region)));
  const pool =
    region === "UAE"
      ? preferred.filter((i) => {
          const url = String(i.sourceUrl ?? "");
          return /\/\/(en|ar)\.wikipedia\.org/i.test(url) || !/\/\/ru\.wikipedia\.org/i.test(url);
        })
      : preferred.length > 0
        ? preferred
        : items;

  const exact: string[] = [];
  const wrongOrAmbiguous: string[] = [];
  for (const i of pool.slice(0, 8)) {
    const classified = classifyWikipediaHit({
      title: String(i.title ?? ""),
      url: i.sourceUrl,
      snippet: i.snippet,
      subjectName: subject,
    });
    const url = i.sourceUrl ? ` — ${i.sourceUrl}` : "";
    if (classified.status === "EXACT_SUBJECT") {
      exact.push(`${i.title}: статья соответствует субъекту${url}`);
    } else if (classified.status === "WRONG_SUBJECT") {
      wrongOrAmbiguous.push(
        `${i.title}: страница другого субъекта / рода — не засчитывается как профиль${url}`
      );
    } else if (classified.status === "AMBIGUOUS") {
      wrongOrAmbiguous.push(`${i.title}: принадлежность субъекту не подтверждена${url}`);
    }
  }
  // Client bullets: exact first; if none — explain wrong/absent (never «статья найдена» for family page).
  if (exact.length > 0) return exact.slice(0, 4);
  return wrongOrAmbiguous.slice(0, 4);
}

function complianceBullets(
  inventory: FullEvidenceInventory | undefined,
  providerHint?: string
): string[] {
  if (!inventory) return [];
  const out: string[] = [];
  for (const item of inventory.items) {
    const et = item.evidenceType.toLowerCase();
    if (et !== "compliance_hit" && et !== "risk_finding") continue;
    const blob = `${item.title} ${item.snippet ?? ""} ${item.provider ?? ""}`;
    if (isDemoOrPlaceholderClientText(blob) || isEnglishComplianceStub(blob)) continue;
    if (providerHint) {
      const ok =
        String(item.provider).toLowerCase().includes(providerHint.toLowerCase()) ||
        String(item.title).toLowerCase().includes(providerHint.toLowerCase()) ||
        riskClassificationBlob(item).includes(providerHint.toLowerCase());
      if (!ok) continue;
    }
    const line = truncateAtWordBoundary(
      `${item.title}${item.snippet ? ` — ${item.snippet}` : ""}`,
      200
    );
    if (!line || isEnglishComplianceStub(line)) continue;
    out.push(line);
    if (out.length >= 8) break;
  }
  return out;
}

function inventoryFallbackBlock(
  sectionId: string,
  title: string,
  subjectName: string,
  inventory?: FullEvidenceInventory,
  themeSet?: OrionThemeSet | null
): SectionBlock | null {
  const template = templateForRegistrySection(sectionId);
  const perSlide = bulletsPerSlideForSection(sectionId);
  const region: RegionBucket = sectionId.startsWith("3") ? "UAE" : "RU";
  let bullets: string[] = [];
  let tables: SectionBlock["tables"] = [];
  let narrative = "";

  if (sectionId.includes("serp_position")) {
    if (inventory && themeSet) {
      const heat = buildSerpHeatGridBullets(inventory, region, 18);
      bullets = heat.bullets;
      narrative = heat.narrative;
    } else {
      tables = serpPositionTable(inventory, region);
      bullets = serpTableBullets(inventory, region);
      narrative =
        region === "RU"
          ? "Таблица позиций в российской поисковой выдаче по сохранённым результатам."
          : "Таблица позиций в международной / ОАЭ выдаче по сохранённым результатам.";
    }
  } else if (sectionId.includes("search_links")) {
    if (themeSet) {
      const cards = buildAnnotatedLinkCards(themeSet, region, 10);
      const heat = inventory ? buildSerpHeatGridBullets(inventory, region, 8) : null;
      bullets = cards.length > 0 ? cards : searchLinkBullets(inventory, region);
      narrative =
        cards.length > 0
          ? `Ссылки в TOP выдачи ведут на нежелательные публикации (${region}). Карточки размечены темами резюме.`
          : heat?.narrative ?? "Ключевые ссылки поисковой выдачи.";
    } else {
      bullets = searchLinkBullets(inventory, region);
      narrative = "Ключевые ссылки поисковой выдачи (домен, заголовок, URL).";
    }
  } else if (sectionId.includes("undesirable_theme")) {
    if (themeSet) {
      bullets = sanitizeClassicBullets(
        orionStyleRiskMatrixRows(themeSet)
          .filter((r) => r.theme !== "Международные базы")
          .map((r) => `${r.theme} — ${r.level}`),
        180
      ).slice(0, 6);
      narrative =
        "Краткий указатель тематических кластеров региона (полные формулировки — в резюме).";
    } else {
      const themes = adverseThemeRows(inventory, region, themeSet);
      bullets = themes.map((t) => t.theme);
      narrative = "Кластеры потенциально нежелательных тем.";
    }
  } else if (sectionId.includes("suggestions") || sectionId.includes("related_queries")) {
    const provider = sectionId.includes("yandex")
      ? "yandex"
      : sectionId.includes("google")
        ? "google"
        : undefined;
    const surfaceType = sectionId.includes("related") ? "related_query" : "suggestion";
    bullets = suggestionBullets(inventory, subjectName, surfaceType, provider, region);
    const kpis = themeSet ? (region === "RU" ? themeSet.ru : themeSet.uae) : null;
    narrative =
      surfaceType === "related_query"
        ? kpis
          ? `Похожие запросы: ${kpis.relatedAdverse} из ${kpis.relatedTotal} с нежелательным контекстом.`
          : "Аудит похожих запросов по сохранённым данным региона."
        : kpis
          ? `Поисковые подсказки: ${kpis.suggestionsAdverse} из ${kpis.suggestionsTotal} указывают на нежелательные темы. Подсказки появляются раньше результатов поиска.`
          : "Аудит поисковых подсказок по сохранённым данным региона.";
  } else if (sectionId.includes("wikipedia")) {
    const kpis = themeSet ? (region === "RU" ? themeSet.ru : themeSet.uae) : null;
    bullets = wikipediaBullets(inventory, region, subjectName);
    if (kpis) {
      narrative = wikipediaClientNarrative(kpis);
      if (bullets.length === 0) {
        bullets = [wikipediaStatusLine(kpis)];
      }
    } else {
      const present = bullets.length > 0;
      narrative = present
        ? "Проверка справочного профиля Wikipedia."
        : "В Википедии устойчивая статья о персоне не подтверждена — энциклопедический якорь цифрового профиля не используется.";
    }
  } else if (sectionId.includes("dow_jones") || sectionId.includes("world_check") || sectionId.includes("lexisnexis")) {
    const hint = sectionId.includes("dow") ? "dow" : sectionId.includes("world") ? "world" : "lexis";
    const fromTheme = themeSet
      ? buildComplianceDbSlides(themeSet).filter((s) =>
          hint === "dow"
            ? /dow/i.test(s.title)
            : hint === "world"
              ? /world/i.test(s.title)
              : /lexis/i.test(s.title)
        )
      : [];
    if (fromTheme[0]) {
      narrative = fromTheme[0].narrative;
      bullets = sanitizeClassicBullets(fromTheme[0].bullets, 320);
    } else {
      bullets = sanitizeClassicBullets(complianceBullets(inventory, hint), 280);
      narrative =
        hint === "dow"
          ? "Материалы Dow Jones / RCA по субъекту."
          : hint === "world"
            ? "Материалы World-Check по субъекту."
            : "Материалы LexisNexis по субъекту.";
    }
    // Always prefer ThemeSet client claim over inventory EN stubs / GPT name-match.
    if (themeSet) {
      const signal = themeSet.complianceSignals.find((c) =>
        hint === "dow"
          ? /dow/i.test(c.provider)
          : hint === "world"
            ? /world/i.test(c.provider)
            : /lexis/i.test(c.provider)
      );
      const sDat = shortSubjectDative(themeSet.subjectName);
      if (signal) {
        narrative = complianceToClientClaim(signal, themeSet.subjectName);
        bullets = sanitizeClassicBullets(
          buildComplianceProviderBullets(signal, themeSet.subjectName),
          320
        );
      } else {
        const claim =
          hint === "dow"
            ? `В Dow Jones — предварительное совпадение по ${sDat}; требуется сверка полного профиля`
            : hint === "world"
              ? "По World-Check доступен предварительный сигнал совпадения по имени; требуется сверка полного профиля."
              : "По LexisNexis доступен предварительный сигнал совпадения по имени; требуется сверка полного профиля.";
        narrative = claim;
        bullets = sanitizeClassicBullets(
          [
            hint === "dow"
              ? "Имя-совпадение зафиксировано; полный профиль и категория риска требуют лицензионной выгрузки."
              : hint === "world"
                ? "Совпадение по полному имени без раскрытой категории риска в текущем контуре отчёта."
                : "Медиа- и профильную карточку нужно сверить с первоисточниками до риск-решения.",
            "Сигнал предварительный: без полной карточки не считается подтверждённым риском.",
          ],
          320
        );
      }
    }
  } else if (isComplianceOverviewSection(sectionId)) {
    if (themeSet) {
      // Only the primary summary section gets the full overview; siblings are skipped upstream.
      const overview = buildComplianceOverviewBullets(themeSet);
      bullets = overview.bullets;
      narrative = overview.narrative;
    } else {
      bullets = complianceBullets(inventory);
      narrative = "Сводка комплаенс-сигналов и публичных баз.";
    }
  } else if (sectionId.includes("audit_summary") || sectionId === "03_digital_profile_overview") {
    if (themeSet && sectionId.includes("audit_summary")) {
      return buildRegionalAuditSummaryBlock(
        themeSet,
        region,
        title
      );
    }
    if (themeSet && sectionId === "03_digital_profile_overview") {
      const matrixRows = orionStyleRiskMatrixRows(themeSet).slice(0, 5);
      // Keep RU+UAE KPI on the same slide — never emit a lonely (2/2) leftover.
      bullets = sanitizeClassicBullets(
        [
          ...matrixRows.map((r) => `${r.theme} — ${r.level}`),
          `Россия: ${themeSet.ru.linksAdversePct}% · ${themeSet.ru.overallBadge}`,
          `ОАЭ: ${themeSet.uae.linksAdversePct}% · ${themeSet.uae.overallBadge}`,
        ],
        200
      ).slice(0, 7);
      narrative = truncateAtWordBoundary(
        [
          "Короткий указатель цифрового профиля по регионам и темам.",
          `Россия — ${themeSet.ru.overallBadge}; ОАЭ — ${themeSet.uae.overallBadge}.`,
          "Полные формулировки — в резюме и матрице комплаенс-рисков.",
        ].join(" "),
        500
      );
    } else {
      const themes = adverseThemeRows(inventory, region === "UAE" ? "UAE" : undefined, themeSet);
      bullets = [
        ...themes.slice(0, 5).map((t) => t.theme),
        ...searchLinkBullets(inventory, region).slice(0, 4),
      ];
      narrative = `Сводка цифрового следа (${region}) на основе ThemeSet / inventory.`;
    }
  }

  bullets = sanitizeClassicBullets(bullets, 220);
  if (bullets.length === 0 && tables.length === 0) return null;

  const slideSpecs: SectionBlock["slideSpecs"] = [];
  if (tables.length > 0) {
    for (const [tIdx, table] of tables.entries()) {
      const rowBullets = table.rows.slice(0, perSlide).map((row) => {
        const [pos, domain, titleText, url] = row;
        return `#${pos} ${domain} — ${titleText}${url && url !== "—" ? ` · ${url}` : ""}`;
      });
      slideSpecs.push({
        slideKey: `${sectionId}-table-${tIdx + 1}`,
        template,
        title: tables.length > 1 ? `${title} (${tIdx + 1}/${tables.length})` : title,
        bullets: rowBullets,
      });
    }
  } else {
    const maxSlides = maxSlidesForSection(sectionId);
    const chunks = chunkItems(bullets, perSlide).slice(0, maxSlides);
    for (const [idx, chunk] of chunks.entries()) {
      slideSpecs.push({
        slideKey: `${sectionId}-${idx + 1}`,
        template,
        title: chunks.length > 1 ? `${title} (${idx + 1}/${chunks.length})` : title,
        bullets: chunk,
      });
    }
  }

  return {
    sectionTitle: sanitizeOrionGoldenClientText(title),
    metrics: {
      findings: bullets.length,
      tables: tables.length,
      source: "inventory_fallback",
    },
    narrative: truncateAtWordBoundary(narrative, 600),
    tables,
    evidenceCards: bullets.slice(0, 12).map((b, idx) => ({
      title: `Сигнал ${idx + 1}`,
      summary: b,
    })),
    visualAssets: [],
    slideSpecs,
    sourceRefs: [],
    qaMetadata: { sectionKey: sectionId },
  };
}

function blockFromClientSection(
  section: ClientSection,
  subjectName: string,
  inventory?: FullEvidenceInventory,
  themeSet?: OrionThemeSet | null
): SectionBlock | null {
  if (section.status === "NOT_APPLICABLE" || section.status === "DATA_POOR" || section.status === "COLLAPSED") {
    return null;
  }
  if (!section.narrative?.trim() && (section.keyFindings?.length ?? 0) === 0) {
    return null;
  }

  if (
    themeSet &&
    (section.sectionId === "10_ru_audit_summary" || section.sectionId === "30_uae_audit_summary")
  ) {
    return buildRegionalAuditSummaryBlock(
      themeSet,
      section.sectionId.startsWith("3") ? "UAE" : "RU",
      section.title
    );
  }

  const template = templateForRegistrySection(section.sectionId);
  const perSlide = bulletsPerSlideForSection(section.sectionId);
  const title = sanitizeOrionGoldenClientText(section.title);
  const region: RegionBucket = section.sectionId.startsWith("3") ? "UAE" : "RU";
  const sectionNarrative = scrubClientFacingProse(section.narrative ?? "");

  let bullets: string[] = [];
  const gptFindings = section.keyFindings
    .slice(0, 5)
    .map((f) => {
      const title = stripNumberedClientPrefix(String(f.title ?? "").trim());
      const summary = scrubClientFacingProse(String(f.summary ?? "").trim());
      // Prefer summary alone when title is generic / duplicates summary
      const line =
        !title ||
        /^(тема риска|рекомендуемое действие|finding)$/i.test(title) ||
        summary.startsWith(title)
          ? summary || title
          : summary
            ? `${title} — ${summary}`
            : title;
      const withCaveat = f.caveat && !/ручной проверк/i.test(f.caveat) ? `${line} (${f.caveat})` : line;
      return truncateAtWordBoundary(withCaveat, 280);
    })
    .filter(Boolean);

  if (section.sectionId.includes("undesirable_theme") && themeSet) {
    bullets = themeSetBullets(themeSet, region);
  } else if (section.sectionId === "53_recommendations") {
    const actionBullets = sanitizeClassicBullets(
      [
        ...(themeSet
          ? [
              themeSet.nextStep,
              "Получить полные профили LexisNexis, Dow Jones и World-Check и сверить идентификацию с первоисточниками (в т.ч. RCA/PEP-контур).",
              "Провести верификацию санкционных ассоциаций (Трансмашхолдинг / Махмудов / Бокарев) и сюжетов Молдавия / Ликсутов / ЛНР перед комплаенс-решением.",
              "Сформировать целевой цифровой профиль и план вытеснения нежелательных ссылок из TOP выдачи.",
            ]
          : []),
        ...gptFindings.filter(isClientActionRecommendation),
      ],
      320
    )
      .filter((b) => !/\d+\s*WEAK|\d+\s*Требует уточнения|слабую\/неизвестную привязку/i.test(b))
      .slice(0, 5);
    bullets = actionBullets;
  } else if (section.sectionId.includes("suggestions") || section.sectionId.includes("related_queries")) {
    const provider = section.sectionId.includes("yandex")
      ? "yandex"
      : section.sectionId.includes("google")
        ? "google"
        : undefined;
    const surfaceType = section.sectionId.includes("related") ? "related_query" : "suggestion";
    const fromInventory = suggestionBullets(inventory, subjectName, surfaceType, provider, region);
    // Risk-first inventory wins; GPT extras only fill remaining one-slide budget.
    const gptClean = gptFindings.filter((b) => !isDemoOrPlaceholderClientText(b) && !isNoiseSuggestion(b));
    bullets = [...fromInventory];
    for (const g of gptClean) {
      if (bullets.length >= 14) break;
      if (bullets.some((b) => b.toLowerCase().includes(g.slice(0, 40).toLowerCase()))) continue;
      bullets.push(g);
    }
  } else if (section.sectionId.includes("undesirable_theme")) {
    const themes = adverseThemeRows(inventory, region, themeSet);
    const themeBullets = themes.map((t) => t.theme);
    bullets = gptFindings.length > 0 ? [...gptFindings, ...themeBullets.slice(0, 4)] : themeBullets;
  } else if (section.sectionId.includes("serp_position")) {
    if (inventory) {
      const heat = buildSerpHeatGridBullets(inventory, region, 18);
      bullets = heat.bullets.length > 0 ? heat.bullets : gptFindings;
    } else {
      bullets = gptFindings;
    }
  } else if (section.sectionId.includes("wikipedia")) {
    const kpis = themeSet ? (region === "RU" ? themeSet.ru : themeSet.uae) : null;
    const fromInventory = wikipediaBullets(inventory, region, subjectName);
    if (kpis) {
      bullets =
        fromInventory.length > 0
          ? fromInventory
          : [wikipediaStatusLine(kpis)];
    } else {
      bullets = fromInventory;
    }
  } else if (section.sectionId.includes("search_links")) {
    const cards = themeSet ? buildAnnotatedLinkCards(themeSet, region, 10) : [];
    const fromInventory = searchLinkBullets(inventory, region);
    bullets =
      cards.length > 0
        ? cards
        : gptFindings.length > 0
          ? [...gptFindings, ...fromInventory.slice(0, 6)]
          : fromInventory.slice(0, 12);
  } else {
    bullets = gptFindings;
    if (bullets.length === 0 && sectionNarrative) {
      bullets = [truncateAtWordBoundary(sectionNarrative, 520)];
    }
  }

  bullets = sanitizeClassicBullets(bullets, 280);

  let narrativeOut = truncateAtWordBoundary(sectionNarrative, 900);
  if (section.sectionId.includes("wikipedia")) {
    const kpis = themeSet ? (region === "RU" ? themeSet.ru : themeSet.uae) : null;
    if (kpis) {
      narrativeOut = wikipediaClientNarrative(kpis);
      if (bullets.length === 0) bullets = [wikipediaStatusLine(kpis)];
    } else {
      narrativeOut =
        bullets.length > 0
          ? "Проверка справочного профиля Wikipedia."
          : "В Википедии устойчивая статья о персоне не подтверждена — энциклопедический якорь цифрового профиля не используется.";
    }
  }
  if (section.sectionId === "53_recommendations") {
    narrativeOut =
      "Для разработки эффективной стратегии необходимо обсудить контекст задачи и сформулировать конкретные цели. Рекомендуемые следующие шаги:";
    if (bullets.length === 0 && themeSet) {
      bullets = sanitizeClassicBullets(
        [
          themeSet.nextStep,
          "Получить полные профили LexisNexis, Dow Jones и World-Check и сверить идентификацию с первоисточниками.",
          "Провести верификацию санкционного и PEP/RCA-контекста перед комплаенс-решением.",
          "Сформировать целевой цифровой профиль и план вытеснения нежелательных ссылок из TOP выдачи.",
        ],
        320
      );
    }
  }
  if (isComplianceOverviewSection(section.sectionId) && themeSet) {
    const overview = buildComplianceOverviewBullets(themeSet);
    narrativeOut = overview.narrative;
    bullets = overview.bullets;
  }
  if (section.sectionId.includes("undesirable_theme") && themeSet) {
    narrativeOut =
      "Краткий указатель тематических кластеров региона (полные формулировки — в резюме).";
    bullets = sanitizeClassicBullets(
      orionStyleRiskMatrixRows(themeSet)
        .filter((r) => r.theme !== "Международные базы")
        .map((r) => `${r.theme} — ${r.level}`),
      180
    ).slice(0, 6);
  }
  if (
    (section.sectionId.includes("world_check") ||
      section.sectionId.includes("dow_jones") ||
      section.sectionId.includes("lexisnexis")) &&
    themeSet
  ) {
    const hint = section.sectionId.includes("dow")
      ? "dow"
      : section.sectionId.includes("world")
        ? "world"
        : "lexis";
    const signal = themeSet.complianceSignals.find((c) =>
      hint === "dow"
        ? /dow/i.test(c.provider)
        : hint === "world"
          ? /world/i.test(c.provider)
          : /lexis/i.test(c.provider)
    );
    const sDat = shortSubjectDative(themeSet.subjectName);
    if (signal) {
      narrativeOut = complianceToClientClaim(signal, themeSet.subjectName);
      bullets = sanitizeClassicBullets(
        buildComplianceProviderBullets(signal, themeSet.subjectName),
        320
      );
    } else {
      const claim =
        hint === "dow"
          ? `В Dow Jones — предварительное совпадение по ${sDat}; требуется сверка полного профиля`
          : hint === "world"
            ? "По World-Check доступен предварительный сигнал совпадения по имени; требуется сверка полного профиля."
            : "По LexisNexis доступен предварительный сигнал совпадения по имени; требуется сверка полного профиля.";
      narrativeOut = claim;
      bullets = sanitizeClassicBullets(
        [
          hint === "dow"
            ? "Имя-совпадение зафиксировано; полный профиль и категория риска требуют лицензионной выгрузки."
            : hint === "world"
              ? "Совпадение по полному имени без раскрытой категории риска в текущем контуре отчёта."
              : "Медиа- и профильную карточку нужно сверить с первоисточниками до риск-решения.",
          "Сигнал предварительный: без полной карточки не считается подтверждённым риском.",
        ],
        320
      );
    }
  }
  if (section.sectionId === "03_digital_profile_overview" && themeSet) {
    const matrixRows = orionStyleRiskMatrixRows(themeSet).slice(0, 5);
    narrativeOut = truncateAtWordBoundary(
      [
        "Короткий указатель цифрового профиля по регионам и темам.",
        `Россия — ${themeSet.ru.overallBadge}; ОАЭ — ${themeSet.uae.overallBadge}.`,
        "Полные формулировки — в резюме и матрице комплаенс-рисков.",
      ].join(" "),
      500
    );
    bullets = sanitizeClassicBullets(
      [
        ...matrixRows.map((r) => `${r.theme} — ${r.level}`),
        `Россия: ${themeSet.ru.linksAdversePct}% · ${themeSet.ru.overallBadge}`,
        `ОАЭ: ${themeSet.uae.linksAdversePct}% · ${themeSet.uae.overallBadge}`,
      ],
      200
    ).slice(0, 7);
  }

  // Heat-grid bullets replace dense position tables when ThemeSet path is active
  const tables =
    section.sectionId.includes("serp_position") && !(inventory && bullets.some((b) => /\[Н\]|\[·\]/.test(b)))
      ? serpPositionTable(inventory, region)
      : [];

  const slideSpecs: SectionBlock["slideSpecs"] = [];
  // Prefer GPT-led bullets; only emit one compact SERP table slide when no GPT findings
  if (tables.length > 0 && gptFindings.length === 0) {
    const table = tables[0];
    const rowBullets = table.rows.slice(0, perSlide).map((row) => {
      const [pos, domain, titleText, url] = row;
      return `#${pos} ${domain} — ${titleText}${url && url !== "—" ? ` · ${url}` : ""}`;
    });
    slideSpecs.push({
      slideKey: `${section.sectionId}-table-1`,
      template,
      title,
      bullets: rowBullets,
    });
  } else {
    const maxSlides = maxSlidesForSection(section.sectionId);
    const chunks = chunkItems(bullets, perSlide).slice(0, maxSlides);
    if (chunks.length === 0) {
      slideSpecs.push({
        slideKey: `${section.sectionId}-1`,
        template,
        title,
        bullets: sectionNarrative ? [truncateAtWordBoundary(sectionNarrative, 520)] : [],
      });
    } else {
      for (const [idx, chunk] of chunks.entries()) {
        slideSpecs.push({
          slideKey: `${section.sectionId}-${idx + 1}`,
          template,
          title: chunks.length > 1 ? `${title} (${idx + 1}/${chunks.length})` : title,
          bullets: chunk,
        });
      }
    }
  }

  return {
    sectionTitle: title,
    metrics: {
      findings: section.keyFindings.length,
      status: section.status,
      tables: tables.length,
    },
    narrative: narrativeOut,
    tables,
    evidenceCards: section.keyFindings.slice(0, 20).map((f) => ({
      title: sanitizeOrionGoldenClientText(stripNumberedClientPrefix(f.title)),
      summary: truncateAtWordBoundary(scrubClientFacingProse(f.summary), 280),
    })),
    visualAssets: [],
    slideSpecs,
    sourceRefs: section.evidenceRefs.slice(0, 40),
    qaMetadata: { sectionKey: section.sectionId },
  };
}

function riskMatrixFromInventory(inventory?: FullEvidenceInventory): Array<{
  theme: string;
  level: string;
  summary: string;
}> {
  const themes = adverseThemeRows(inventory);
  return themes.slice(0, 8).map((t) => ({
    theme: t.theme,
    level: t.count >= 8 ? "Высокий уровень" : t.count >= 3 ? "Средний уровень" : "Требует ручной проверки",
    summary: `По сохранённым материалам: ${t.count} сигнал(ов). Требуется подтверждение первоисточников.`,
  }));
}

function riskMatrixBlockFromExecutive(
  executive: OrionGoldenReportSpec["executiveSummary"],
  inventory?: FullEvidenceInventory,
  themeSet?: OrionThemeSet | null
): SectionBlock {
  // Prefer ThemeSet ORION prose rows when available (not GPT/label matrix).
  let matrix = themeSet
    ? orionStyleRiskMatrixRows(themeSet).map((r) => humanizeClientRiskMatrixRow(r))
    : (executive.riskMatrix ?? []).map((r) =>
        humanizeClientRiskMatrixRow({ theme: r.theme, level: r.level, summary: r.summary })
      );
  if (matrix.length === 0) {
    matrix = (executive.riskMatrix ?? []).map((r) =>
      humanizeClientRiskMatrixRow({ theme: r.theme, level: r.level, summary: r.summary })
    );
  }
  // Drop gate/queue rows from client matrix — they are process meta, not risk themes.
  matrix = matrix.filter(
    (r) =>
      !/очеред(ь|и)\s+ручн|недостаточно доказатель|исключённ|слабая идентификация|материал\(ов\)/i.test(
        `${r.theme} ${r.summary}`
      )
  );
  if (matrix.length === 0) {
    matrix = riskMatrixFromInventory(inventory).map((r) =>
      humanizeClientRiskMatrixRow(r)
    );
  }
  // Dedupe near-identical summaries (e.g. repeated TAdviser rows)
  const seen = new Set<string>();
  matrix = matrix.filter((r) => {
    const key = `${r.theme}::${r.summary.slice(0, 80).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);

  const slideSpecs: SectionBlock["slideSpecs"] = [];
  for (const [idx, chunk] of chunkItems(matrix, 6).entries()) {
    slideSpecs.push({
      slideKey: `risk-matrix-${idx + 1}`,
      template: "orion_golden_risk_matrix",
      title: matrix.length > 6 ? `Матрица комплаенс-рисков (${idx + 1})` : "Матрица комплаенс-рисков",
      // Claim-first (ORION prose), then level — not «Тема — Уровень: …».
      bullets: chunk.map((r) =>
        truncateAtWordBoundary(
          r.summary.length > 40 ? `${r.summary} — ${r.level}` : `${r.theme} — ${r.level}: ${r.summary}`,
          380
        )
      ),
    });
  }
  if (slideSpecs.length === 0) {
    slideSpecs.push({
      slideKey: "risk-matrix-empty",
      template: "orion_golden_risk_matrix",
      title: "Матрица комплаенс-рисков",
      bullets: ["Существенных подтверждённых тем риска не выявлено на текущем этапе."],
    });
  }
  return {
    sectionTitle: "Матрица комплаенс-рисков",
    metrics: { themes: matrix.length },
    narrative: themeSet
      ? "Compliance-риски: требуются действия. Ниже — темы цифрового профиля и сигналы международных баз."
      : "",
    tables: [],
    evidenceCards: matrix.map((r) => ({ title: r.theme, summary: r.summary })),
    visualAssets: [],
    slideSpecs,
    sourceRefs: [],
    qaMetadata: { sectionKey: "02_compliance_risk_matrix" },
  };
}

function emptyLegacy(sectionKey: string): SectionBlock {
  return {
    sectionTitle: sectionKey,
    metrics: { status: "empty" },
    narrative: "",
    tables: [],
    evidenceCards: [],
    visualAssets: [],
    slideSpecs: [],
    sourceRefs: [],
    qaMetadata: { sectionKey },
  };
}

/** Classic client appendix: one limitations slide — no DATA POOR / cluster counts / evidence dump. */
function buildClassicClientAppendixBlock(client: OrionClientContent): SectionBlock {
  const defaults = [
    "Анализ основан на открытых источниках и предварительных сигналах комплаенс-баз.",
    "Предварительные совпадения в базах данных требуют сверки полного профиля и не являются юридическим заключением.",
    "Материалы с неоднозначной идентификацией не используются как ключевые выводы.",
  ];
  const rawLimitations = (client.limitations ?? [])
    .map((l) => scrubClientFacingProse(sanitizeOrionGoldenClientText(l)))
    .filter((l) => l.length >= 20)
    .filter(
      (l) =>
        !/DATA\s*POOR|сжато\s+пустых|материал\(ов\)|кластер\(ов\)|дедупликац|очеред(ь|и)\s+ручн|исключено\s+\d+|найденных\s+материал|расхождени[ея]\s+по\s+отчеству|\(\d+\)/i.test(
          l
        )
    );
  const safeBullets = sanitizeClassicBullets(
    rawLimitations.length > 0 ? rawLimitations.slice(0, 3) : defaults,
    220
  ).slice(0, 5);
  const bullets = safeBullets.length > 0 ? safeBullets : defaults;

  return {
    sectionTitle: "Ограничения анализа",
    metrics: { limitations: bullets.length },
    narrative:
      "Кратко о границах проверки: открытые источники и предварительные сигналы; без подтверждения первоисточников выводы не считаются установленным фактом.",
    tables: [],
    evidenceCards: [],
    visualAssets: [],
    slideSpecs: [
      {
        slideKey: "appendix-limitations",
        template: "orion_golden_appendix",
        title: "Ограничения анализа",
        bullets,
      },
    ],
    sourceRefs: [],
    qaMetadata: { sectionKey: "appendix" },
  };
}

/**
 * Only fill an empty risk matrix from inventory themes.
 * Never rewrite executiveSummary with meta-counts / SERP tallies — that kills ORION résumé genre.
 */
function enrichExecutiveWithInventory(
  executive: OrionGoldenReportSpec["executiveSummary"],
  _client: OrionClientContent,
  inventory?: FullEvidenceInventory
): OrionGoldenReportSpec["executiveSummary"] {
  if (executive.riskMatrix.length > 0) {
    return {
      ...executive,
      executiveSummary: sanitizeExecutiveClientText(executive.executiveSummary, 2200),
      mainRisks: sanitizeClassicBullets(executive.mainRisks, 280).slice(0, 6),
      finalRecommendations: sanitizeClassicBullets(
        executive.finalRecommendations.filter(isClientActionRecommendation),
        280
      ).slice(0, 6),
    };
  }

  const matrix = riskMatrixFromInventory(inventory).map((r) => ({
    theme: r.theme,
    level: r.level,
    summary: r.summary,
  }));

  const themeBullets =
    executive.mainRisks.length > 0
      ? executive.mainRisks
      : matrix.slice(0, 6).map((r) => `${r.theme}: ${r.summary}`);

  return {
    ...executive,
    executiveSummary: sanitizeExecutiveClientText(executive.executiveSummary, 2200),
    mainRisks: sanitizeClassicBullets(themeBullets, 280).slice(0, 6),
    finalRecommendations: sanitizeClassicBullets(
      executive.finalRecommendations.filter(isClientActionRecommendation),
      280
    ).slice(0, 6),
    riskMatrix: matrix,
  };
}

export type ClassicReportSpecInput = ClientContentToReportSpecInput & {
  inventory?: FullEvidenceInventory;
};

export function buildOrionClassicReportSpecFromClientContent(
  input: ClassicReportSpecInput
): OrionClassicAuditReportSpec {
  const { clientContent: client } = input;
  const subjectName = client.subject.displayName;
  const themeSet = input.inventory
    ? buildOrionThemeSet({
        inventory: input.inventory,
        subjectName,
        caseId: client.caseId,
        clientContent: client,
        executiveSynthesis: input.executiveSynthesis,
      })
    : null;

  let executive = buildExecutiveFromClient(
    client,
    input.executiveSynthesis,
    input.riskMatrix ?? client.riskMatrixSummary
  );
  if (themeSet) {
    executive = applyThemeSetToExecutive(executive, themeSet);
  } else {
    executive = enrichExecutiveWithInventory(executive, client, input.inventory);
  }
  const commercial = buildOrionClassicCommercialPack();

  const sectionById = new Map((client.sections ?? []).map((s) => [s.sectionId, s]));
  const registrySections: OrionClassicAuditReportSpec["registrySections"] = [];

  for (const reg of getClientAuditSections()) {
    // ORION audit keeps identity/manual-review out of the client storyboard (appendix-only noise).
    if (reg.sectionId === "00_case_identity") continue;
    if (reg.sectionId === "50_manual_review_required") continue;
    if (reg.sectionId === "51_excluded_noise_summary") continue;
    if (reg.sectionId === "52_limitations") continue; // replaced by slim classic appendix below
    if (reg.sectionId === "54_evidence_appendix") continue;

    if (reg.sectionId === "01_executive_summary") {
      const slideSpecs = themeSet
        ? buildOrionExecutiveSlides(executive, themeSet)
        : (() => {
            const narrativeChunks = splitCompleteChunks(executive.executiveSummary, 1100);
            const themeBullets = sanitizeClassicBullets(executive.mainRisks, 280).slice(0, 6);
            const consequenceBullets = sanitizeClassicBullets(executive.possibleConsequences, 280).slice(0, 2);
            const nextStepBullets = sanitizeClassicBullets(
              executive.nextSteps.slice(0, 1).map((s) => (s.startsWith("Следующий") ? s : `Следующий шаг: ${s}`)),
              280
            );
            const specs: SectionBlock["slideSpecs"] = [];
            if (narrativeChunks.length <= 1) {
              specs.push({
                slideKey: "executive-1",
                template: "orion_golden_executive_card",
                title: "Резюме",
                narrative: narrativeChunks[0] ?? executive.executiveSummary,
                bullets: [...themeBullets, ...consequenceBullets, ...nextStepBullets].slice(0, 7),
              });
            } else {
              specs.push({
                slideKey: "executive-1",
                template: "orion_golden_executive_card",
                title: "Резюме",
                narrative: narrativeChunks[0],
                bullets: [],
              });
              specs.push({
                slideKey: "executive-2",
                template: "orion_golden_executive_card",
                title: "Резюме — ключевые темы",
                narrative: narrativeChunks.slice(1).join("\n\n"),
                bullets: [...themeBullets, ...consequenceBullets, ...nextStepBullets].slice(0, 7),
              });
            }
            return specs;
          })();

      registrySections.push({
        sectionId: reg.sectionId,
        order: reg.order,
        block: {
          sectionTitle: "Резюме",
          metrics: { mode: "executive" },
          narrative: executive.executiveSummary,
          tables: [],
          evidenceCards: [],
          visualAssets: [],
          slideSpecs,
          sourceRefs: [],
          qaMetadata: { sectionKey: "01_executive_summary" },
        },
      });
      continue;
    }
    if (reg.sectionId === "02_compliance_risk_matrix") {
      registrySections.push({
        sectionId: reg.sectionId,
        order: reg.order,
        block: riskMatrixBlockFromExecutive(executive, input.inventory, themeSet),
      });
      continue;
    }
    if (reg.sectionId === "10_ru_audit_summary" && themeSet) {
      registrySections.push({
        sectionId: reg.sectionId,
        order: reg.order,
        block: buildRegionalAuditSummaryBlock(themeSet, "RU", reg.titleRu),
      });
      continue;
    }
    if (reg.sectionId === "30_uae_audit_summary" && themeSet) {
      registrySections.push({
        sectionId: reg.sectionId,
        order: reg.order,
        block: buildRegionalAuditSummaryBlock(themeSet, "UAE", reg.titleRu),
      });
      continue;
    }
    if (reg.sectionId === "50_manual_review_required") {
      continue;
    }
    if (reg.sectionId === "54_evidence_appendix") continue;

    // Classic ORION: one compliance overview + per-provider slides (avoid identical sanctions/media clones).
    if (
      themeSet &&
      (reg.sectionId === "41_sanctions_watchlists" ||
        reg.sectionId === "45_compliance_media_check" ||
        reg.sectionId === "46_other_public_databases")
    ) {
      continue;
    }

    // Images / videos / knowledge: never emit text-only GPT pages.
    // Real visual slides are injected by the deck composer only when stored assets exist.
    if (
      /_images$|_videos$|knowledge_panel/.test(reg.sectionId) ||
      reg.sectionId.includes("_yandex_images") ||
      reg.sectionId.includes("_google_images") ||
      reg.sectionId.includes("_videos") ||
      reg.sectionId.includes("knowledge_panel")
    ) {
      continue;
    }

    const sec = sectionById.get(reg.sectionId);
    if (sec) {
      const block = blockFromClientSection(sec, subjectName, input.inventory, themeSet);
      if (block) {
        registrySections.push({ sectionId: reg.sectionId, order: reg.order, block });
        continue;
      }
    }

    const fallback = inventoryFallbackBlock(
      reg.sectionId,
      reg.titleRu,
      subjectName,
      input.inventory,
      themeSet
    );
    if (fallback) {
      registrySections.push({ sectionId: reg.sectionId, order: reg.order, block: fallback });
    }
  }

  const appendixBlock = buildClassicClientAppendixBlock(client);
  registrySections.push({
    sectionId: "52_limitations",
    order: 52,
    block: appendixBlock,
  });

  // Dedupe: registry already starts with «Резюме» / risk matrix — don't prepend clones.
  const tocTitles: string[] = [];
  const tocSeen = new Set<string>();
  const pushToc = (title: string) => {
    const key = title.trim().toLowerCase();
    if (!key || tocSeen.has(key)) return;
    tocSeen.add(key);
    tocTitles.push(title);
  };
  pushToc("Резюме");
  pushToc("Матрица рисков");
  for (const s of registrySections) {
    pushToc(s.block.sectionTitle);
    if (tocTitles.length >= 26) break;
  }
  pushToc("Наше предложение");
  pushToc("О нас");

  const now = new Date().toISOString().slice(0, 10);
  const pick = (id: string) => registrySections.find((s) => s.sectionId === id)?.block;

  return {
    version: "orion-golden-report-spec-v1",
    reportMode: "classic_orion_audit",
    registrySections,
    subject: {
      displayName: sanitizeOrionGoldenClientText(subjectName),
      locale: "ru",
      auditDate: now,
      reportTitle: "ORION Digital Profile — аудит цифрового профиля",
    },
    globalToc: tocTitles.map((title) => ({ title: sanitizeOrionGoldenClientText(title) })),
    executiveSummary: executive,
    riskMatrix: executive.riskMatrix,
    ruDigitalProfile: pick("03_digital_profile_overview") ?? emptyLegacy("ru_digital_profile"),
    ruAuditSummary: pick("10_ru_audit_summary") ?? emptyLegacy("ru_audit_summary"),
    ruSearchResults: pick("11_ru_search_links") ?? emptyLegacy("ru_search_results"),
    ruWikipedia: pick("16_ru_wikipedia") ?? emptyLegacy("ru_wikipedia"),
    uaeDigitalProfile: pick("30_uae_audit_summary") ?? emptyLegacy("uae_digital_profile"),
    uaeAuditSummary: pick("30_uae_audit_summary") ?? emptyLegacy("uae_audit_summary"),
    uaeSearchResults: pick("31_uae_google_search_links") ?? emptyLegacy("uae_search_results"),
    uaeWikipedia: pick("35_uae_wikipedia") ?? emptyLegacy("uae_wikipedia"),
    complianceDatabases: pick("40_compliance_database_summary") ?? emptyLegacy("compliance_databases"),
    lexisNexis: pick("44_lexisnexis_profile") ?? emptyLegacy("lexisnexis"),
    dowJones: pick("42_dow_jones_profile") ?? emptyLegacy("dow_jones"),
    worldCheck: pick("43_world_check_profile") ?? emptyLegacy("world_check"),
    offer: commercial.offer,
    productOverview: commercial.productOverview,
    solutionDigitalProfile: commercial.solutionDigitalProfile,
    solutionComplianceDatabases: commercial.solutionComplianceDatabases,
    solutionWikipedia: commercial.solutionWikipedia,
    about: commercial.about,
    appendix: appendixBlock,
    assets: input.assets ?? [],
    qaMetadata: {
      generatedBy: "gpt-5.5",
      architectureVersion: "r10-12-orion-theme-packaging-v1",
      inventoryCounts: input.inventoryCounts ?? input.inventory?.counts ?? {
        searchResults: 0,
        searchSurfaces: 0,
        databaseProfiles: 0,
        riskFindings: 0,
        wikiChecks: 0,
        screenshots: 0,
      },
      warnings: [
        ...(input.warnings ?? []),
        "classic_orion_audit_mode",
        "theme_set_driven_audit",
        "commercial_pack_included",
        "commercial_pack_capped",
        client.mode === "post_review"
          ? "source:orion-client-content.post-review"
          : "source:orion-client-content.pre-review",
        !(client.sections?.length)
          ? "inventory_fallback_sections"
          : "section_analyses_present",
      ],
    },
  };
}
