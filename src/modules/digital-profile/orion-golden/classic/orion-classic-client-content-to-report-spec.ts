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
  buildAppendixBlock,
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
  sanitizeClassicBullets,
  sanitizeExecutiveClientText,
  splitCompleteChunks,
  stripNumberedClientPrefix,
  truncateAtWordBoundary,
} from "./orion-classic-text-utils";
import {
  buildAnnotatedLinkCards,
  buildComplianceDbSlides,
  buildDecisionConsequences,
  buildOrionThemeSet,
  buildSerpHeatGridBullets,
  orionStyleRiskMatrixRows,
  regionalAuditDashboardBlock,
  themeSetBullets,
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

function isNoiseSuggestion(query: string): boolean {
  const q = query.toLowerCase();
  return (
    /related queries|autocomplete lyrics|image gallery|images free|profile (linkedin|facebook)|video live|videos youtube|news today|news article|uaeraine|uaeu|russkov|russo\b/.test(
      q
    ) || /^(deripaska|oleg)\s+(oleg\s+)?(vladimirovich\s+)?(related|image|video|news|profile|interview\s+\d{4})/i.test(q)
  );
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
    mainRisks: sanitizeClassicBullets(themeSet.executiveBullets, 280).slice(0, 6),
    possibleConsequences: sanitizeClassicBullets(decision.consequences, 280),
    nextSteps: sanitizeClassicBullets([decision.recommendation, themeSet.nextStep], 280),
    riskMatrix: matrixRows.length > 0 ? matrixRows : executive.riskMatrix,
  };
}

function buildOrionExecutiveSlides(
  executive: OrionGoldenReportSpec["executiveSummary"],
  themeSet: OrionThemeSet
): SectionBlock["slideSpecs"] {
  const decision = buildDecisionConsequences(themeSet);
  // GSM-style decision matrix: theme — level — consequence (not Проблема:/Последствие: checklist).
  const matrixRows = orionStyleRiskMatrixRows(themeSet).slice(0, 6);
  const decisionBullets =
    matrixRows.length > 0
      ? matrixRows.map((r) =>
          truncateAtWordBoundary(`${r.theme} — ${r.level}: ${r.summary}`, 260)
        )
      : [
          ...decision.problems.slice(0, 4),
          ...decision.consequences.slice(0, 3),
        ];
  return [
    {
      slideKey: "executive-1",
      template: "orion_golden_executive_card",
      title: "Резюме",
      narrative: executive.executiveSummary || themeSet.executiveNarrative,
      bullets: [],
    },
    {
      slideKey: "executive-decision",
      template: "orion_golden_risk_matrix",
      title: `${themeSet.subjectName} — ${decision.headline}`,
      narrative: `Уровень риска: ${decision.riskLevel}. ${decision.recommendation}`,
      bullets: sanitizeClassicBullets(decisionBullets, 260).slice(0, 8),
    },
    {
      slideKey: "executive-visual",
      template: "orion_golden_executive_card",
      title: "Ключевые темы и базы данных",
      narrative: [
        `Россия: ${themeSet.ru.linksAdversePct}% потенциально нежелательных ссылок · оценка: ${themeSet.ru.overallBadge}.`,
        `ОАЭ: ${themeSet.uae.linksAdversePct}% потенциально нежелательных ссылок · оценка: ${themeSet.uae.overallBadge}.`,
      ].join("\n"),
      bullets: sanitizeClassicBullets(
        [
          ...themeSetBullets(themeSet).slice(0, 6),
          ...themeSet.complianceSignals.map((c) => c.statusLine),
        ],
        280
      ).slice(0, 8),
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
    narrative: truncateAtWordBoundary(`${dash.narrative} Оценка: ${dash.badge}.`, 700),
    tables: [],
    evidenceCards: dash.bullets.map((b) => ({ title: "Тема", summary: b })),
    visualAssets: [],
    slideSpecs: [
      {
        slideKey: `${region.toLowerCase()}-audit-dashboard`,
        template: "orion_golden_audit_dashboard",
        title,
        narrative: truncateAtWordBoundary(`${dash.narrative} Оценка: ${dash.badge}.`, 500),
        bullets: sanitizeClassicBullets([...dash.bullets, ...dash.kpiLines], 220).slice(0, 14),
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
      return true;
    })
    .map((item) => {
      const query = (item.query || item.title || "").trim();
      const cls = classifyAutocompleteQuery(query, subjectName);
      const noise = isNoiseSuggestion(query);
      const riskBoost = cls === "RISK_QUERY" ? 100 : 0;
      const noisePenalty = noise ? -50 : 0;
      return { query, cls, noise, score: riskBoost + noisePenalty + query.length };
    })
    .filter((row) => row.query.length >= 3)
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
    if (row.noise) continue;
    out.push(row.query);
    if (out.length >= 14) break;
  }
  return out;
}

function wikipediaBullets(inventory: FullEvidenceInventory | undefined, region: RegionBucket): string[] {
  if (!inventory) return [];
  const langPrefer = region === "RU" ? ["RU", "RUSSIAN"] : ["EN", "AE", "UAE", "AR"];
  const items = inventory.items.filter((i) => {
    if (i.evidenceType !== "wikipedia") return false;
    const blob = `${i.title} ${i.snippet ?? ""} ${i.sourceUrl ?? ""}`;
    if (isDemoOrPlaceholderClientText(blob)) return false;
    if (/отсутств|not\s+found|no\s+article|не\s+найден|page not found/i.test(blob)) return false;
    return Boolean(i.sourceUrl && /wikipedia\.org/i.test(i.sourceUrl)) || /статья найдена|article found/i.test(blob);
  });
  const preferred = items.filter((i) => langPrefer.includes(normalizeRegion(i.region)));
  const pool = preferred.length > 0 ? preferred : items;
  return pool.slice(0, 8).map((i) => {
    const url = i.sourceUrl ? ` — ${i.sourceUrl}` : "";
    return `${i.title}: ${i.snippet ?? "проверка страницы"}${url}`;
  });
}

function complianceBullets(
  inventory: FullEvidenceInventory | undefined,
  providerHint?: string
): string[] {
  if (!inventory) return [];
  return inventory.items
    .filter((item) => {
      const et = item.evidenceType.toLowerCase();
      if (et !== "compliance_hit" && et !== "risk_finding") return false;
      const blob = `${item.title} ${item.snippet ?? ""} ${item.provider ?? ""}`;
      if (isDemoOrPlaceholderClientText(blob)) return false;
      if (!providerHint) return true;
      return String(item.provider).toLowerCase().includes(providerHint.toLowerCase())
        || String(item.title).toLowerCase().includes(providerHint.toLowerCase())
        || riskClassificationBlob(item).includes(providerHint.toLowerCase());
    })
    .slice(0, 16)
    .map((item) =>
      truncateAtWordBoundary(
        `${item.title}${item.snippet ? ` — ${item.snippet}` : ""}`,
        200
      )
    );
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
    const themes = adverseThemeRows(inventory, region, themeSet);
    bullets = themes.map((t) => t.theme);
    narrative =
      "Кластеры потенциально нежелательных тем (канонический ThemeSet). Повторяют сюжет резюме.";
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
    bullets = wikipediaBullets(inventory, region);
    const present = themeSet
      ? region === "RU"
        ? themeSet.ru.wikipediaPresent
        : themeSet.uae.wikipediaPresent
      : bullets.length > 0;
    narrative = present
      ? "Проверка справочного профиля Wikipedia."
      : "В Википедии устойчивая статья о персоне не подтверждена — энциклопедический якорь цифрового профиля не используется.";
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
      bullets = sanitizeClassicBullets(fromTheme[0].bullets, 240);
    } else {
      bullets = complianceBullets(inventory, hint);
      narrative =
        hint === "dow"
          ? "Материалы Dow Jones / RCA по субъекту."
          : hint === "world"
            ? "Материалы World-Check по субъекту."
            : "Материалы LexisNexis по субъекту.";
    }
  } else if (sectionId.includes("sanctions") || sectionId.includes("compliance_media") || sectionId.includes("compliance_database")) {
    if (themeSet && themeSet.complianceSignals.length > 0) {
      bullets = themeSet.complianceSignals.flatMap((c) => [c.statusLine, c.detail]);
      narrative = "Сводка предварительных сигналов международных комплаенс-баз.";
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
    const themes = adverseThemeRows(inventory, region === "UAE" ? "UAE" : undefined, themeSet);
    bullets = [
      ...themes.slice(0, 5).map((t) => t.theme),
      ...searchLinkBullets(inventory, region).slice(0, 4),
    ];
    narrative = `Сводка цифрового следа (${region}) на основе ThemeSet / inventory.`;
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

  let bullets: string[] = [];
  const gptFindings = section.keyFindings
    .slice(0, 5)
    .map((f) => {
      const title = stripNumberedClientPrefix(String(f.title ?? "").trim());
      const summary = String(f.summary ?? "").trim();
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
    if (bullets.length === 0 && section.narrative) {
      bullets = [truncateAtWordBoundary(section.narrative, 520)];
    }
  }

  bullets = sanitizeClassicBullets(bullets, 280);
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
        bullets: [truncateAtWordBoundary(section.narrative, 520)],
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
    narrative: truncateAtWordBoundary(section.narrative, 900),
    tables,
    evidenceCards: section.keyFindings.slice(0, 20).map((f) => ({
      title: sanitizeOrionGoldenClientText(stripNumberedClientPrefix(f.title)),
      summary: truncateAtWordBoundary(f.summary, 280),
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
  let matrix = (executive.riskMatrix ?? []).map((r) =>
    humanizeClientRiskMatrixRow({ theme: r.theme, level: r.level, summary: r.summary })
  );
  if (themeSet && matrix.length === 0) {
    matrix = orionStyleRiskMatrixRows(themeSet).map((r) => humanizeClientRiskMatrixRow(r));
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
  }).slice(0, 10);

  const slideSpecs: SectionBlock["slideSpecs"] = [];
  for (const [idx, chunk] of chunkItems(matrix, 5).entries()) {
    slideSpecs.push({
      slideKey: `risk-matrix-${idx + 1}`,
      template: "orion_golden_risk_matrix",
      title: matrix.length > 5 ? `Матрица комплаенс-рисков (${idx + 1})` : "Матрица комплаенс-рисков",
      bullets: chunk.map((r) =>
        truncateAtWordBoundary(`${r.theme} — ${r.level}: ${r.summary}`, 280)
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

  const appendixBlock = buildAppendixBlock(client);
  registrySections.push({
    sectionId: "52_limitations",
    order: 52,
    block: appendixBlock,
  });

  const tocTitles = [
    "Резюме",
    "Матрица рисков",
    ...registrySections.map((s) => s.block.sectionTitle).slice(0, 24),
    "Наше предложение",
    "О нас",
  ];

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
