/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import { createHash } from "node:crypto";
import type { SlideBody, SlideContentContract, SectionType } from "../contracts";
import { SLIDE_CONTENT_SCHEMA_VERSION } from "../contracts";
import { DECK_TEMPLATE_REGISTRY } from "../template-registry";
import type { ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import type { Finding } from "../../contracts/finding";
import { pluralRu } from "../../analytics/finding-synthesizer";
import {
  freshnessFootnote,
  reportDiffClientLine,
} from "../../../services/report-material-freshness";
import type {
  ExecutiveSummaryExtras,
  FragmentBuildOutput,
  FragmentExtras,
  GptCaseAnalysisExtras,
} from "./shared";
import {
  RISK_ORDER,
  VISUAL_ASSET_UNAVAILABLE,
  bulletWithFindingId,
  changeSinceLastReportLine,
  chunk,
  claimBodyWithoutTheme,
  clampClientText,
  fitClientSentences,
  fitStructuredBullet,
  isAdverse,
  makeSlotSlide,
  matchGptKeyRisk,
  riskLabel,
  sourceLine,
  splitClientParagraphs,
  themedClaim,
  uniqueRefs,
  verdictClientLabel,
} from "./shared";

/**
 * §7.2 — compact freshness + change line for surfaces that render narrative/bullets
 * but not sourceNote (executive dashboard).
 */
export function executiveFreshnessChangeVisibleLine(
  extras?: FragmentExtras
): string | undefined {
  const fresh =
    extras?.materialFreshness != null
      ? freshnessFootnote(extras.materialFreshness)
      : undefined;
  const change = changeSinceLastReportLine(extras);
  const parts = [
    fresh ? `${fresh.charAt(0).toUpperCase()}${fresh.slice(1)}` : undefined,
    change,
  ].filter((x): x is string => Boolean(x));
  if (parts.length === 0) return undefined;
  const joined = parts.join(". ");
  return joined.endsWith(".") ? joined : `${joined}.`;
}

const EXEC_FRESHNESS_CHANGE_RE =
  /данные собраны|самый свежий материал|Новых материалов с прошлого отчёта/i;

/** Drop §7.2 sentences so they can be re-placed as their own short paragraph. */
function stripExecutiveFreshnessChangeSentences(text: string): string {
  return text
    .replace(/[^.?!\n]*данные собраны[^.?!\n]*[.?!]?/giu, " ")
    .replace(/[^.?!\n]*самый свежий материал[^.?!\n]*[.?!]?/giu, " ")
    .replace(/[^.?!\n]*Новых материалов с прошлого отчёта[^.?!\n]*[.?!]?/giu, " ")
    .replace(/\s+/gu, " ")
    .replace(/\s+([,;:.])/gu, "$1")
    .trim();
}

/** Must stay ≤ client-text-contract narrative budget (900). */
const EXEC_NARRATIVE_BUDGET = 900;

/**
 * Ensure §7.2 copy is present as its own short narrative paragraph.
 * The executive dashboard clips long cards (~420 chars / height) — folding into
 * the lead paragraph (PDF 28) hid the line; a dedicated short card stays visible.
 * Total narrative is clamped to the section-QA budget so «Дожать GPT» cannot
 * fail ASSEMBLY with EXECUTIVE_SUMMARY:FAILED (over-budget).
 */
export function ensureExecutiveFreshnessChangeInNarrative(
  narrative: string,
  extras?: FragmentExtras
): string {
  const line = executiveFreshnessChangeVisibleLine(extras);
  if (!line) return narrative;
  const shortLine = clampClientText(line, 220);
  const paras = narrative
    .split("\n")
    .map((p) => stripExecutiveFreshnessChangeSentences(p))
    .filter(Boolean);
  if (paras.length === 0) return shortLine;
  // Reserve room for §7.2 paragraph + newlines inside the 900-char budget.
  // Prefer lead + §7.2; keep a trailing para only when it is a real sentence
  // (tiny clamps produced garbage like "07. 07.2026.").
  const leadBudget = Math.max(120, EXEC_NARRATIVE_BUDGET - shortLine.length - 2);
  const lead = clampClientText(paras[0]!, leadBudget);
  const restBudget =
    EXEC_NARRATIVE_BUDGET - lead.length - shortLine.length - 2;
  const rest: string[] = [];
  if (restBudget >= 40) {
    for (const p of paras.slice(1)) {
      const piece = clampClientText(p, restBudget);
      if (isMeaningfulExecNarrativePara(piece)) rest.push(piece);
      break;
    }
  }
  // Slot 1: short §7.2 card between lead conclusion and portrait/coverage.
  return [lead, shortLine, ...rest].filter(Boolean).join("\n");
}

/** Reject clamp leftovers (date stubs / digit soup) that are not a real card. */
function isMeaningfulExecNarrativePara(text: string): boolean {
  const t = text.trim();
  if (t.length < 40) return false;
  if (/^\d{1,2}\.\s*\d{1,2}\.\d{2,4}/u.test(t)) return false;
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  return letters >= 24;
}

/**
 * Post-pass after GPT/cache: re-assert §7.2 on EXECUTIVE_SUMMARY slides.
 * Stage-2 / SKIPPED_CACHED can replace narrative with one long paragraph and
 * drop the dedicated short card (PDF 29).
 */
export function applyExecutiveFreshnessChangeToPacks<
  T extends {
    fragmentKey: string;
    contentHash?: string;
    slides: Array<{
      isContinuation?: boolean;
      content: {
        narrative?: string;
        bullets?: string[];
        sourceNote?: string;
      };
    }>;
  },
>(packs: T[], extras?: FragmentExtras): T[] {
  const line = executiveFreshnessChangeVisibleLine(extras);
  if (!line) return packs;
  return packs.map((pack) => {
    if (pack.fragmentKey !== "EXECUTIVE_SUMMARY") return pack;
    const slides = pack.slides.map((slide) => {
      if (slide.isContinuation) {
        // PDF-36 D.5 — §7.2 lives ONCE in the p03 narrative card; repeating
        // it as the first continuation bullet duplicated the line on p04.
        const bullets = (slide.content.bullets ?? []).filter(
          (b) => !EXEC_FRESHNESS_CHANGE_RE.test(b)
        );
        return {
          ...slide,
          content: { ...slide.content, bullets },
        };
      }
      return {
        ...slide,
        content: {
          ...slide.content,
          narrative: ensureExecutiveFreshnessChangeInNarrative(
            String(slide.content.narrative ?? ""),
            extras
          ),
        },
      };
    });
    const contentHash = `sha256:${createHash("sha256")
      .update(JSON.stringify(slides))
      .digest("hex")}`;
    return { ...pack, slides, contentHash };
  });
}

const EXEC_SURFACE_LABELS: Record<string, string> = {
  organic: "поиск",
  suggestions: "подсказки",
  paa_related: "связанные запросы",
  images: "изображения",
  wikipedia: "Википедия",
  ai_answers: "ИИ-ответы",
  compliance: "комплаенс-базы",
  url_audit: "проверка URL",
};

const EXEC_REGION_LABELS: Record<string, string> = {
  RU: "Россия",
  UAE: "ОАЭ",
  INTERNATIONAL: "международный контур",
  GLOBAL: "глобальный контур",
};

/** REMEDIATION §7.3 — structured executive page blocks (вывод → факты → действия). */
export type ExecutivePageStructure = {
  /** Left-column cards on the dashboard (≤3 paragraphs). */
  narrativeParagraphs: string[];
  /** Bottom «факт» cards mapped to renderer keyFindings (≤2). */
  factCards: string[];
  /** Bottom «Следующий шаг» action. */
  recommendations: string;
};

/**
 * Build coverage / LIKELY-AMBIGUOUS / namesake / recommendations blocks so a
 * sparse executive page never collapses to a single empty-looking paragraph.
 */
export function composeExecutivePageStructure(
  scoped: ScopedFragmentInput,
  es: ExecutiveSummaryExtras,
  opts?: { gptRecommendations?: string[]; extras?: FragmentExtras }
): ExecutivePageStructure {
  const ms = scoped.metricSnapshot;
  const materialWord = pluralRu(ms.compositeCount, "материал", "материала", "материалов");
  const regionBits = Object.entries(ms.perRegionCounts ?? {})
    .filter(([, n]) => typeof n === "number" && n > 0)
    .map(([r, n]) => `${EXEC_REGION_LABELS[String(r).toUpperCase()] ?? r} — ${n}`);
  const overviewBits = (es.regionalOverview ?? [])
    .filter((r) => (r.totalCount ?? 0) > 0 || /собра|материал|негатив/i.test(r.oneLiner))
    .map((r) => r.oneLiner)
    .slice(0, 2);
  const surfaces = [
    ...new Set(
      scoped.surfaceUnits
        .map((u) => EXEC_SURFACE_LABELS[u.surface])
        .filter((x): x is string => Boolean(x))
    ),
  ];
  const fresh =
    opts?.extras?.materialFreshness != null
      ? freshnessFootnote(opts.extras.materialFreshness)
      : undefined;
  const changeLine = changeSinceLastReportLine(opts?.extras);
  // PDF-40 G.3 — coverage as a client sentence, not an internal «карта покрытия».
  const coverage = clampClientText(
    [
      `По собранным источникам: ${ms.compositeCount} ${materialWord}, из них уверенно об этом лице — ${ms.subjectMatchCount}`,
      regionBits.length > 0 ? ` (${regionBits.join("; ")})` : "",
      surfaces.length > 0 ? `. Смотрели: ${surfaces.slice(0, 7).join(", ")}` : "",
      overviewBits.length > 0 ? `. ${overviewBits.join(" ")}` : "",
      fresh ? `. ${fresh.charAt(0).toUpperCase()}${fresh.slice(1)}` : "",
      changeLine ? `. ${changeLine}` : "",
      ".",
    ].join(""),
    450
  );

  const likelyN = ms.likelySubjectCount ?? 0;
  const ambN = ms.ambiguousCount ?? 0;
  const caveatLikely = (es.identityCaveats ?? []).find((c) =>
    /не удалось однозначно|неоднознач|вероятн|требуют подтвержд/i.test(c)
  );
  const likelyBlock =
    likelyN > 0 || ambN > 0 || caveatLikely
      ? clampClientText(
          caveatLikely ??
            [
              likelyN > 0
                ? `Материалы, требующие подтверждения: ${likelyN} — см. матрицу рисков и приложение.`
                : "",
              ambN > 0
                ? `Неоднозначная атрибуция: ${ambN} ${pluralRu(ambN, "наблюдение", "наблюдения", "наблюдений")} — не учтены как факты о субъекте.`
                : "",
            ]
              .filter(Boolean)
              .join(" "),
          380
        )
      : undefined;

  const otherN = ms.otherSubjectCount ?? 0;
  const caveatOther = (es.identityCaveats ?? []).find((c) =>
    /другом лице|тёз|тезк|однофамил/i.test(c)
  );
  const namesakeBlock =
    otherN > 0 || caveatOther
      ? clampClientText(
          caveatOther ??
            `Значимая часть выдачи относится к другому лицу (${otherN} ${pluralRu(
              otherN,
              "наблюдение",
              "наблюдения",
              "наблюдений"
            )}) и исключена из выводов о проверяемом субъекте.`,
          380
        )
      : undefined;

  // One complete imperative for the narrow «Следующий шаг» card — never a
  // mid-phrase stub like «…и карту ключевых» (PDF review p03).
  const recommendations = fitClientSentences(
    [
      opts?.gptRecommendations?.[0] ||
        (es.priorityActions ?? [])[0] ||
        "Расширить проверку по незакрытым направлениям; не интерпретировать отсутствие подтверждённых находок как отсутствие риска.",
    ],
    180
  );

  const conclusion = clampClientText(
    es.executiveConclusion ||
      "Подтверждённых adverse-находок по собранным источникам недостаточно для риск-выводов. Выводы не выдуманы.",
    600
  );

  const narrativeParagraphs = [conclusion, coverage];
  const identityCombined = [likelyBlock, namesakeBlock].filter(Boolean).join(" ");
  if (identityCombined) {
    narrativeParagraphs.push(clampClientText(identityCombined, 400));
  } else if ((es.dataLimitations ?? [])[0]) {
    narrativeParagraphs.push(
      clampClientText(`Ограничения данных: ${es.dataLimitations[0]}`, 400)
    );
  }

  const factCards: string[] = [];
  if (likelyBlock) factCards.push(likelyBlock);
  if (namesakeBlock && namesakeBlock !== likelyBlock) factCards.push(namesakeBlock);
  for (const lim of es.dataLimitations ?? []) {
    if (factCards.length >= 2) break;
    const text = clampClientText(`Ограничения: ${lim}`, 340);
    if (!factCards.includes(text)) factCards.push(text);
  }
  if (factCards.length === 0) {
    factCards.push(
      clampClientText(
        "Подтверждённых наблюдений с привязкой к источникам нет — сводные риск-карточки не заполняются предположениями.",
        340
      )
    );
  }
  if (factCards.length < 2) {
    factCards.push(clampClientText(coverage, 340));
  }

  return {
    narrativeParagraphs: narrativeParagraphs.slice(0, 3),
    factCards: factCards.slice(0, 2),
    recommendations,
  };
}

export function buildExecutiveSummaryFragment(
  sectionId: SectionType,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const es = extras.executiveSummary;
  if (!es) {
    // Missing artifact is a technical defect — not an honest sparse-data page.
    return { slides: [], status: "INSUFFICIENT_DATA", emptyStateReason: "executive-summary-artifact-missing" };
  }
  const [slot] = slotsForFragment("EXECUTIVE_SUMMARY");
  const gpt = extras.gptCaseAnalysis;
  // Each key finding: factual basis + (when the GPT case analysis knows this
  // theme) a client-language explanation of WHY it is risky and what to do
  // about it — instead of a bare publication count. Top cards are narrow, so
  // they lead with the first factual sentence and the explanation; the
  // continuation page carries the full detail.
  // PDF-40 G.2b/G.3 — concrete evidence first (quotes + источник); GPT advice
  // is a short trailing line, never a replacement for the factual basis.
  const cardTexts = es.keyFindings.map((k) => {
    const finding = scoped.findings.find((f) => f.findingId === k.findingId);
    const concrete = finding
      ? claimBodyWithoutTheme(finding)
      : String(k.factualBasis ?? "")
          .replace(/^Подтверждённый факт:\s*/iu, "")
          .trim();
    const risk = matchGptKeyRisk(k.title, gpt?.keyRisks);
    // Keep framing + up to 2 quote lines (+ scale); drop a long why-tail if tight.
    const core = concrete
      .split("\n")
      .filter((ln) => ln.trim().length > 0)
      .slice(0, 4)
      .join("\n");
    const lines = [`«${k.title}»`, core];
    if (risk?.advice) lines.push(`Что делать: ${risk.advice}`);
    return bulletWithFindingId(lines.filter(Boolean).join("\n"), k.findingId, 900);
  });
  const bullets = es.keyFindings.map((k) => {
    const finding = scoped.findings.find((f) => f.findingId === k.findingId);
    const concrete = finding
      ? claimBodyWithoutTheme(finding)
      : String(k.factualBasis ?? "")
          .replace(/^Подтверждённый факт:\s*/iu, "")
          .trim();
    const risk = matchGptKeyRisk(k.title, gpt?.keyRisks);
    const lines = [`«${k.title}»`, concrete];
    if (risk?.advice) lines.push(`Что делать: ${risk.advice}`);
    return bulletWithFindingId(lines.filter(Boolean).join("\n"), k.findingId, 900);
  });
  // Sparse but complete collection: keep a client-safe page that states
  // there are no confirmed findings — never invent risks. Still show
  // coverage / LIKELY / namesake / recommendations (§7.3).
  const sparse =
    es.keyFindings.length === 0 ||
    /INSUFFICIENT|недостат/i.test(es.verdict) ||
    /недостат|insufficient|no confirmed/i.test(es.executiveConclusion);
  const structure = composeExecutivePageStructure(scoped, es, {
    gptRecommendations: gpt?.recommendations,
    extras,
  });
  const ms = scoped.metricSnapshot;
  // Narrative: prefer the holistic GPT conclusion + digital portrait. The
  // renderer draws one card per paragraph (up to 3 incl. the subtitle line),
  // clipping each at ~420 chars — split on sentence boundaries to never lose
  // mid-sentence text.
  const gptParagraphs =
    !sparse && gpt
      ? gpt.digitalPortrait
        ? [
            ...splitClientParagraphs(gpt.executiveConclusion, 400, 1),
            ...splitClientParagraphs(gpt.digitalPortrait, 400, 1),
          ]
        : splitClientParagraphs(gpt.executiveConclusion, 400, 2)
      : [];
  let narrative: string;
  if (sparse) {
    narrative = structure.narrativeParagraphs.join("\n");
  } else if (gptParagraphs.length > 0) {
    const paras = [...gptParagraphs];
    // Dense path: still surface identity pollution / LIKELY when GPT omitted them.
    const needsIdentity =
      ((ms.otherSubjectCount ?? 0) > 0 || (ms.likelySubjectCount ?? 0) > 0) &&
      !/другом лице|требуют подтвержд|тёз|однофамил/i.test(paras.join(" "));
    if (needsIdentity && paras.length < 3) {
      const identityBits = [structure.factCards[0], structure.factCards[1]]
        .filter(Boolean)
        .filter((t) => /другом лице|требуют подтвержд|неоднознач|тёз|однофамил/i.test(t));
      if (identityBits[0]) paras.push(clampClientText(identityBits[0], 400));
    }
    narrative = paras.slice(0, 3).join("\n");
  } else {
    narrative = es.executiveConclusion;
  }
  // Dense GPT path often omits coverage; sourceNote is not drawn on the
  // executive dashboard — fold §7.2 into the visible narrative card.
  narrative = ensureExecutiveFreshnessChangeInNarrative(narrative, extras);
  // Base slide feeds the executive dashboard layout (conclusion + top risk
  // cards); the remaining key findings continue on an adjacent slide so no
  // finding is lost visually.
  const TOP_CARDS = 2;
  const base = makeSlotSlide({
    slot,
    sectionId,
    subtitle: `Итоговая оценка: ${verdictClientLabel(es.verdict)}`,
    content: {
      narrative,
      // Right-column KPI cards on the executive dashboard: the headline
      // numbers of the whole audit at a glance (short labels — narrow cards).
      kpis: [
        { label: "Материалов", value: String(ms.compositeCount), tone: "neutral" },
        { label: "О субъекте", value: String(ms.subjectMatchCount), tone: "good" },
        {
          label: "Вероятно о субъекте",
          value: String(ms.likelySubjectCount ?? 0),
          tone: "warn",
        },
        { label: "Тем риска", value: String(ms.adverseFindingCount), tone: "risk" },
        { label: "Ключевых тем", value: String(es.keyFindings.length), tone: "accent" },
      ],
      bullets: sparse
        ? structure.factCards.slice(0, TOP_CARDS)
        : cardTexts.length > 0
          ? cardTexts.slice(0, TOP_CARDS)
          : structure.factCards.slice(0, TOP_CARDS),
      whatToCheck: structure.recommendations,
      sourceNote: sourceLine(scoped, extras),
    },
    evidenceRefs: uniqueRefs(scoped),
    findingIds: es.keyFindings.map((k) => k.findingId),
    metrics: {
      keyFindings: es.keyFindings.length,
      sparse: sparse ? 1 : 0,
      structureBlocks: structure.narrativeParagraphs.length + structure.factCards.length + 1,
    },
  });
  const slides: SlideContentContract[] = [base];
  const contBullets = sparse
    ? [
        ...structure.narrativeParagraphs.slice(1),
        ...(es.identityCaveats ?? []).slice(0, 3).map((c) => clampClientText(c, 380)),
        ...(es.dataLimitations ?? []).slice(0, 2).map((c) => clampClientText(`Ограничения: ${c}`, 380)),
      ].filter((b, i, arr) => arr.indexOf(b) === i)
    : bullets.slice(TOP_CARDS);
  // PDF-36 D.5 — §7.2 already lives in the p03 narrative card (see
  // ensureExecutiveFreshnessChangeInNarrative above); no duplicate bullet.
  if (gpt && !sparse && gpt.positiveSignals.length > 0) {
    contBullets.push(
      clampClientText(
        `Позитивный фон: ${gpt.positiveSignals.slice(0, 3).join(" ")}`,
        380
      )
    );
  }
  if (contBullets.length > 0) {
    // PDF-46 I.3 — 3 theme blocks per continuation page (block-first; more pages OK).
    const THEME_PER_PAGE = 3;
    const totalPages = Math.ceil(contBullets.length / THEME_PER_PAGE);
    for (let pageIdx = 0; pageIdx < totalPages; pageIdx += 1) {
      const chunk = contBullets.slice(pageIdx * THEME_PER_PAGE, (pageIdx + 1) * THEME_PER_PAGE);
      const baseTitle = sparse
        ? "Резюме — покрытие и ограничения"
        : "Резюме — темы риска";
      slides.push({
        ...base,
        slideId: pageIdx === 0 ? `${base.slideId}__cont1` : `${base.slideId}__cont${pageIdx + 1}`,
        isContinuation: true,
        continuationOf: base.slideId,
        continuationIndex: pageIdx + 1,
        templateId: "continuation",
        title:
          totalPages > 1
            ? `${baseTitle} (продолжение ${pageIdx + 1}/${totalPages})`
            : baseTitle,
        subtitle: undefined,
        content: {
          bullets: chunk,
          whatToCheck: undefined,
          sourceNote: pageIdx === 0 ? sourceLine(scoped, extras) : undefined,
        },
      });
    }
  }
  return { slides, status: "READY" };
}

/**
 * Cards that fit on one risk-matrix page with typical GPT detail length.
 * PDF-46 I.3 — three full cards above the footer; overflow → continuations.
 */
const RISK_MATRIX_PAGE_CAPACITY = 3;
/** Always keep ≥1 first-page slot for LIKELY when any exist (§2.1 visibility). */
const RISK_MATRIX_LIKELY_RESERVED = 1;
/**
 * Synthetic matrix card when KPI shows LIKELY materials but themed findings
 * are absent. Not a bundle findingId — must not enter slide.findingIds / QA.
 */
export const RISK_MATRIX_LIKELY_AGGREGATE_ID = "finding-likely-aggregate";

function riskMatrixDetail(f: Finding, extras?: FragmentExtras): string {
  // PDF-40 G.1b / PDF-46 I.4 — headline shows theme; keep structured lines whole.
  const claim = claimBodyWithoutTheme(f);
  if (f.subjectMatch === "LIKELY_SUBJECT") {
    return fitStructuredBullet(
      [
        claim,
        "Принадлежность пока не подтверждена — до уточнения идентификации материал не включаем в итог «об этом лице».",
      ].join("\n"),
      900
    );
  }
  const risk = matchGptKeyRisk(f.theme, extras?.gptCaseAnalysis?.keyRisks);
  if (risk) {
    return fitStructuredBullet(
      [claim, risk.explanation, `Что делать: ${risk.advice}`].join("\n"),
      900
    );
  }
  return fitStructuredBullet([claim, `Что делать: ${f.recommendedAction}`].join("\n"), 900);
}

function riskMatrixRow(f: Finding): string[] {
  return [
    f.theme,
    f.subjectMatch === "LIKELY_SUBJECT" ? "Требует подтверждения" : riskLabel(f.riskLevel),
    f.promotionPriority,
    f.findingId === RISK_MATRIX_LIKELY_AGGREGATE_ID ? "сводка" : f.findingId,
  ];
}

function riskMatrixSlideFindingIds(findings: Finding[]): string[] {
  return findings
    .map((f) => f.findingId)
    .filter((id) => id !== RISK_MATRIX_LIKELY_AGGREGATE_ID);
}

/**
 * Pack confirmed + LIKELY findings into page-sized groups. When LIKELY exists,
 * page 1 always reserves a slot so «Требует подтверждения» is not clipped by
 * five full-height confirmed cards.
 */
export function packRiskMatrixPages(
  confirmed: Finding[],
  likely: Finding[],
  pageCapacity = RISK_MATRIX_PAGE_CAPACITY,
  likelyReserved = RISK_MATRIX_LIKELY_RESERVED
): Finding[][] {
  const conf = [...confirmed].sort(
    (a, b) => (RISK_ORDER[b.riskLevel] ?? 0) - (RISK_ORDER[a.riskLevel] ?? 0)
  );
  const lik = [...likely].sort(
    (a, b) => (RISK_ORDER[b.riskLevel] ?? 0) - (RISK_ORDER[a.riskLevel] ?? 0)
  );
  if (conf.length === 0 && lik.length === 0) return [];
  if (lik.length === 0) {
    const pages: Finding[][] = [];
    for (let i = 0; i < conf.length; i += pageCapacity) pages.push(conf.slice(i, i + pageCapacity));
    return pages;
  }
  const reserve = Math.min(likelyReserved, lik.length, pageCapacity);
  const confOnFirst = Math.max(0, pageCapacity - reserve);
  const first = [...conf.slice(0, confOnFirst), ...lik.slice(0, reserve)];
  const rest = [...conf.slice(confOnFirst), ...lik.slice(reserve)];
  const pages: Finding[][] = [first];
  for (let i = 0; i < rest.length; i += pageCapacity) pages.push(rest.slice(i, i + pageCapacity));
  return pages.filter((p) => p.length > 0);
}

export function buildRiskMatrixFragment(
  sectionId: SectionType,
  scoped: ScopedFragmentInput,
  extras?: FragmentExtras
): FragmentBuildOutput {
  const [slot] = slotsForFragment("RISK_MATRIX");
  const confirmed = scoped.findings.filter((f) => f.subjectMatch === "SUBJECT_MATCH");
  let likely = scoped.findings.filter((f) => f.subjectMatch === "LIKELY_SUBJECT");
  const likelyMaterialCount = scoped.metricSnapshot.likelySubjectCount ?? 0;
  // Identity KPI can show LIKELY materials before themed findings exist (or
  // when packs were cached). Still surface an honest «Требует подтверждения»
  // card so the matrix matches the executive KPI.
  if (likely.length === 0 && likelyMaterialCount > 0) {
    likely = [
      {
        findingId: RISK_MATRIX_LIKELY_AGGREGATE_ID,
        theme: "Материалы с вероятной принадлежностью",
        claim: `${likelyMaterialCount} ${pluralRu(
          likelyMaterialCount,
          "материал",
          "материала",
          "материалов"
        )} пока отнесены к уровню «вероятно об этом лице» по фамилии и контексту — до уточнения идентификации не включаем их в подтверждённый итог.`,
        subjectMatch: "LIKELY_SUBJECT",
        riskLevel: "low",
        promotionPriority: "APPENDIX",
        evidenceRefs: [],
        recommendedAction:
          "Проверить принадлежность материалов с оценкой «Вероятно» в выдаче и приложении; при подтверждении — включить в выводы следующего прогона.",
      } as unknown as Finding,
    ];
  }
  if (confirmed.length === 0 && likely.length === 0) {
    // Honest empty-valid page after completed collection — not a lost required section.
    const base = makeSlotSlide({
      slot,
      sectionId,
      subtitle: "Недостаточно подтверждённых данных",
      content: {
        narrative:
          "Подтверждённых adverse findings с evidenceRefs нет. Матрица рисков не заполняется предположениями или OTHER_SUBJECT сигналами.",
        table: {
          headers: ["Тема", "Уровень", "Приоритет", "Идентификатор"],
          rows: [["Нет подтверждённых тем", "Нет данных", "—", "—"]],
        },
        sourceNote: sourceLine(scoped),
      },
      evidenceRefs: uniqueRefs(scoped),
      findingIds: [],
      metrics: { themes: 0, adverse: 0, sparse: 1 },
    });
    return { slides: [base], status: "READY", emptyStateReason: "no-verified-findings" };
  }

  const pages = packRiskMatrixPages(confirmed, likely);
  const headers = ["Тема", "Уровень", "Приоритет", "Идентификатор"];
  const baseSlide = makeSlotSlide({
    slot,
    sectionId,
    content: {
      table: { headers, rows: pages[0]!.map(riskMatrixRow) },
      bullets: pages[0]!.map((f) => riskMatrixDetail(f, extras)),
      sourceNote: sourceLine(scoped),
    },
    evidenceRefs: uniqueRefs(scoped),
    findingIds: riskMatrixSlideFindingIds(pages[0]!),
    metrics: {
      themes: confirmed.length,
      likelyThemes: likely.length,
      page: 1,
      pages: pages.length,
      adverse: confirmed.filter(isAdverse).length,
    },
  });
  const slides: SlideContentContract[] = [baseSlide];
  for (let pageIdx = 1; pageIdx < pages.length; pageIdx += 1) {
    const pageFindings = pages[pageIdx]!;
    slides.push({
      ...baseSlide,
      slideId: `${baseSlide.slideId}__cont${pageIdx}`,
      isContinuation: true,
      continuationOf: baseSlide.slideId,
      continuationIndex: pageIdx,
      title: `${baseSlide.title} (продолжение ${pageIdx + 1}/${pages.length})`,
      content: {
        table: { headers, rows: pageFindings.map(riskMatrixRow) },
        bullets: pageFindings.map((f) => riskMatrixDetail(f, extras)),
      },
      findingIds: riskMatrixSlideFindingIds(pageFindings),
      metrics: {
        themes: confirmed.length,
        likelyThemes: likely.length,
        page: pageIdx + 1,
        pages: pages.length,
      },
    });
  }

  return { slides, status: "READY" };
}

export function buildDigitalProfileOverviewFragment(
  sectionId: SectionType,
  scoped: ScopedFragmentInput
): FragmentBuildOutput {
  const [slot] = slotsForFragment("DIGITAL_PROFILE_OVERVIEW");
  const s = scoped.metricSnapshot;
  const regions = Object.entries(s.perRegionCounts);
  const adverseThemes = scoped.findings
    .filter(isAdverse)
    .sort((a, b) => (RISK_ORDER[b.riskLevel] ?? 0) - (RISK_ORDER[a.riskLevel] ?? 0))
    .slice(0, 4)
    .map((f) => {
      const body = themedClaim(f);
      const marker = ` [${f.findingId}]`;
      return body.length + marker.length <= 520
        ? body + marker
        : clampClientText(body.replace(/\n/gu, " "), 480) + marker;
    });
  return {
    slides: [
      makeSlotSlide({
        slot,
        sectionId,
        content: {
          narrative: `По собранным источникам: ${s.compositeCount} материалов из ${regions.length} региональных контуров (${regions
            .map(([r, n]) => `${r}: ${n}`)
            .join(", ")}). Принадлежность каждого материала к проверяемому лицу проверена.`,
          // Labels fit the KPI card budget (28 chars) without clipping.
          kpis: [
            { label: "Материалов проанализировано", value: String(s.compositeCount), tone: "neutral" },
            { label: "Связаны с проверяемым лицом", value: String(s.subjectMatchCount), tone: "good" },
            {
              label: "Вероятно о субъекте",
              value: String(s.likelySubjectCount ?? 0),
              tone: "warn",
            },
            { label: "Требуют идентификации", value: String(s.ambiguousCount), tone: "warn" },
            { label: "Относятся к другим лицам", value: String(s.otherSubjectCount), tone: "warn" },
            { label: "Тем повышенного внимания", value: String(s.adverseFindingCount), tone: "risk" },
            { label: "Региональные контуры", value: regions.map(([r]) => r).join(" · "), tone: "accent" },
          ],
          bullets: adverseThemes,
          whatToCheck:
            "Детализация каждой темы повышенного внимания приведена в матрице рисков и региональных разделах.",
          sourceNote: sourceLine(scoped),
        },
        evidenceRefs: [],
        findingIds: scoped.findings.map((f) => f.findingId),
        metrics: {
          compositeCount: s.compositeCount,
          subjectMatchCount: s.subjectMatchCount,
          likelySubjectCount: s.likelySubjectCount ?? 0,
          adverseFindingCount: s.adverseFindingCount,
        },
      }),
    ],
    status: "READY",
  };
}
