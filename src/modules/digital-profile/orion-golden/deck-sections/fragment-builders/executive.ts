/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { SlideContentContract, SectionType } from "../contracts";
import { contentHashOf, SLIDE_CONTENT_SCHEMA_VERSION } from "../contracts";
import { DECK_TEMPLATE_REGISTRY } from "../template-registry";
import type { MetricSnapshot, ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import type { Finding } from "../../contracts/finding";
import { pluralRu } from "../../../report/i18n/plural-ru";
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
  auditScopeLine,
  bulletWithFindingId,
  changeSinceLastReportLine,
  chunk,
  claimBodyWithoutTheme,
  clampClientText,
  fitClientSentences,
  fitStructuredBullet,
  isAdverse,
  makeSlotSlide,
  packBulletPages,
  matchGptKeyRisk,
  readShareExecutiveLine,
  regionClientLabel,
  riskLabel,
  sourceLine,
  splitClientParagraphs,
  themedClaim,
  uniqueRefs,
  withContinuations,
  verdictClientLabel,
} from "./shared";
import {
  assertSemanticSummaryGatesPass,
  paginateComposedClientSummary,
  renderSemanticBlock,
  type SemanticBlock,
} from "../semantic-summary-pagination";
import { legacyRiskWordPlate } from "../../client/risk-scale";
import type { ComposedClientSummary } from "../../contracts/composed-client-summary";
import { continuationTitle } from "../continuation-slide";

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
  /данные собраны|самый свежий материал|Новых материалов с прошлого отчёта|Негатив среди прочитанных/i;

/** Drop §7.2 sentences so they can be re-placed as their own short paragraph. */
function stripExecutiveFreshnessChangeSentences(text: string): string {
  return text
    .replace(/[^.?!\n]*данные собраны[^.?!\n]*[.?!]?/giu, " ")
    .replace(/[^.?!\n]*самый свежий материал[^.?!\n]*[.?!]?/giu, " ")
    .replace(/[^.?!\n]*Новых материалов с прошлого отчёта[^.?!\n]*[.?!]?/giu, " ")
    // Строка доли зачищается тем же проходом: пост-проход применяется дважды
    // (после стадии 2 и после кэша), и без этого она удвоилась бы.
    .replace(/[^.?!\n]*Негатив среди прочитанных[^.?!\n]*[.?!]?/giu, " ")
    .replace(/\s+/gu, " ")
    .replace(/\s+([,;:.])/gu, "$1")
    .trim();
}

/** §7.2 умещается в карточку резюме; строка доли к этому бюджету не относится. */
const EXEC_FRESHNESS_CARD_BUDGET = 220;

/**
 * Короткая карточка видимых фактов резюме: §7.2 и доля негатива среди
 * прочитанных страниц.
 *
 * Строка доли не клампится никогда — обрезанное число это не сокращение, а
 * ложь. Тесниться в общем бюджете приходится части §7.2, у которой смысл
 * сохраняется и в укороченном виде.
 */
function executiveVisibleFactsLine(
  extras?: FragmentExtras,
  ms?: MetricSnapshot
): string | undefined {
  const fresh = executiveFreshnessChangeVisibleLine(extras);
  const share = ms ? readShareExecutiveLine(ms) : undefined;
  const parts = [
    fresh ? clampClientText(fresh, EXEC_FRESHNESS_CARD_BUDGET) : undefined,
    share,
  ].filter((x): x is string => Boolean(x));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Must stay ≤ client-text-contract narrative budget (900). */
const EXEC_NARRATIVE_BUDGET = 900;

/**
 * Ensure the visible-facts card (§7.2 + доля негатива среди прочитанных
 * страниц) is present as its own short narrative paragraph.
 * The executive dashboard clips long cards (~420 chars / height) — folding into
 * the lead paragraph (PDF 28) hid the line; a dedicated short card stays visible.
 * Total narrative is clamped to the section-QA budget so «Дожать GPT» cannot
 * fail ASSEMBLY with EXECUTIVE_SUMMARY:FAILED (over-budget).
 */
export function ensureExecutiveFreshnessChangeInNarrative(
  narrative: string,
  extras?: FragmentExtras,
  ms?: MetricSnapshot
): string {
  const shortLine = executiveVisibleFactsLine(extras, ms);
  if (!shortLine) return narrative;
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
  // Slot 1: short visible-facts card between lead conclusion and portrait/coverage.
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
 * Post-pass after GPT/cache: re-assert the visible-facts card (§7.2 + доля
 * негатива) on EXECUTIVE_SUMMARY slides. Stage-2 / SKIPPED_CACHED can replace
 * narrative with one long paragraph and drop the dedicated short card (PDF 29).
 */
export function applyExecutiveFreshnessChangeToPacks<
  T extends { fragmentKey: string; contentHash?: string; slides: SlideContentContract[] },
>(packs: T[], extras?: FragmentExtras, ms?: MetricSnapshot): T[] {
  const line = executiveVisibleFactsLine(extras, ms);
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
            extras,
            ms
          ),
        },
      };
    });
    return { ...pack, slides, contentHash: contentHashOf(slides) };
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
    .map(([r, n]) => `${regionClientLabel(String(r))} — ${n}`);
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
  //
  // Первым идёт предмет аудита: читатель должен узнать глубину проверки раньше,
  // чем размер собранного корпуса, иначе большое число «собрано» читается как
  // объём аудита.
  const scopeLine = auditScopeLine(ms, { withRemainder: true });
  const coverage = clampClientText(
    [
      scopeLine ? `${scopeLine} ` : "",
      `По собранным источникам: ${ms.compositeCount} ${materialWord}, из них уверенно об этом лице — ${ms.subjectMatchCount}`,
      regionBits.length > 0 ? ` (${regionBits.join("; ")})` : "",
      surfaces.length > 0 ? `. Смотрели: ${surfaces.slice(0, 7).join(", ")}` : "",
      // Словарный процент `regionalOverview.oneLiner` здесь больше не
      // печатается: он отвечает на тот же вопрос «какая доля негативна» другим
      // определением — по субъектным материалам региона, а не по прочитанным
      // страницам, — и уже расходился с ним (7 % при нуле прочитанных страниц).
      // Доля негатива в резюме одна, и она едет строкой видимых фактов.
      fresh ? `. ${fresh.charAt(0).toUpperCase()}${fresh.slice(1)}` : "",
      changeLine ? `. ${changeLine}` : "",
      ".",
    ].join(""),
    // Бюджет абзаца поднят ровно на длину фразы об области аудита: она
    // добавляется к покрытию, а не вытесняет из него «Смотрели» и свежесть.
    450 + (scopeLine ? scopeLine.length + 1 : 0)
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

function formatSemanticBullet(block: SemanticBlock): string {
  // Склейка заголовка с телом — общая с полным текстом резюме
  // (`themeBlockText`), чтобы дека и артефакт не расходились в том, где
  // называется тема. Своей копии здесь больше нет: тем же вызовом укладка
  // меряет бюджет, поэтому печать и замер разойтись не могут.
  return renderSemanticBlock(block);
}

function adverseFindingIdsForExecutive(
  scoped: ScopedFragmentInput,
  es?: ExecutiveSummaryExtras
): string[] {
  const fromEs = (es?.keyFindings ?? []).map((k) => k.findingId);
  // Assembly gate: every promoted adverse P1/P2 must appear on executive slides.
  const p12 = scoped.findings
    .filter(
      (f) =>
        f.subjectMatch === "SUBJECT_MATCH" &&
        (f.promotionPriority === "P1" || f.promotionPriority === "P2") &&
        (RISK_ORDER[f.riskLevel] ?? 0) >= 2
    )
    .map((f) => f.findingId);
  return [...new Set([...fromEs, ...p12])];
}

/**
 * Stage 6 — executive slides from ComposedClientSummary with semantic pagination.
 * Full theme text is preserved across adjacent continuations; no clamp/slice.
 */
export function buildExecutiveSummaryFromComposed(
  sectionId: SectionType,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras,
  composed: ComposedClientSummary
): FragmentBuildOutput {
  const es = extras.executiveSummary;
  const plan = paginateComposedClientSummary(composed, { leadThemeCount: 3 });
  assertSemanticSummaryGatesPass(plan);

  const [slot] = slotsForFragment("EXECUTIVE_SUMMARY");
  const ms = scoped.metricSnapshot;
  const riskLevel = composed.sections.overallAssessment.match(
    /критический|высокий|средний|низкий/i
  )?.[0];
  // Резюме, составленное до перехода на три ступени, содержит слово
  // «критический»: в плашку оно уехало бы как есть, если не привести.
  const verdictLabel =
    (es ? verdictClientLabel(es.verdict) : riskLevel && legacyRiskWordPlate(riskLevel)) ||
    "по открытым источникам";

  // Do not clamp composed narrative (§6: CLIENT_TEXT_TRUNCATIONS=0). Fold the
  // visible-facts card (§7.2 + доля негатива) into the packed overview when it
  // fits; the post-pass re-asserts it on the pack in any case.
  const factsLine = executiveVisibleFactsLine(extras, ms);
  let narrative = plan.overviewNarrative.join("\n");
  if (factsLine) {
    const trial = narrative ? `${narrative}\n${factsLine}` : factsLine;
    if (trial.length <= EXEC_NARRATIVE_BUDGET) {
      narrative = trial;
    }
  }

  const overviewBullets = plan.overviewBlocks.map(formatSemanticBullet);
  const findingIds = adverseFindingIdsForExecutive(scoped, es);
  const themeCount = composed.sections.themes.length;

  const base = makeSlotSlide({
    slot,
    sectionId,
    subtitle: `Итоговая оценка: ${verdictLabel}`,
    content: {
      narrative,
      kpis: [
        { label: "Материалов собрано", value: String(ms.compositeCount), tone: "neutral" },
        { label: "О субъекте", value: String(ms.subjectMatchCount), tone: "good" },
        {
          label: "Вероятно о субъекте",
          value: String(ms.likelySubjectCount ?? 0),
          tone: "warn",
        },
        { label: "Тем риска", value: String(ms.adverseFindingCount), tone: "risk" },
        { label: "Ключевых тем", value: String(themeCount), tone: "accent" },
      ],
      bullets: overviewBullets,
      // Full next-steps text lives in semantic blocks (overview or continuation).
      // Do not clamp a short card copy — that would be CLIENT_TEXT_TRUNCATIONS.
      whatToCheck: undefined,
      sourceNote: sourceLine(scoped, extras),
    },
    evidenceRefs: uniqueRefs(scoped),
    findingIds,
    metrics: {
      keyFindings: themeCount,
      sparse: themeCount === 0 ? 1 : 0,
      composedSummary: 1,
      CLIENT_TEXT_TRUNCATIONS: plan.gates.CLIENT_TEXT_TRUNCATIONS,
      CONTINUATION_PAGES: plan.continuationPages.length,
    },
  });

  const slides: SlideContentContract[] = [base];
  const totalPages = plan.continuationPages.length;
  for (let pageIdx = 0; pageIdx < totalPages; pageIdx += 1) {
    const pageBlocks = plan.continuationPages[pageIdx]!;
    const kinds = new Set(pageBlocks.map((b) => b.kind));
    const themeOnly = [...kinds].every((k) => k === "theme");
    // «Резюме — продолжение (продолжение 3/4)» — слово дважды в одном
    // заголовке (шаг 13, D5). Нумерация продолжений добавляется ниже, поэтому
    // базовый заголовок её не повторяет.
    const baseTitle = themeOnly ? "Резюме — темы риска" : "Резюме";
    slides.push({
      ...base,
      slideId: pageIdx === 0 ? `${base.slideId}__cont1` : `${base.slideId}__cont${pageIdx + 1}`,
      isContinuation: true,
      continuationOf: base.slideId,
      continuationIndex: pageIdx + 1,
      templateId: "continuation",
      title:
        totalPages > 1 ? continuationTitle(baseTitle, pageIdx + 1, totalPages) : baseTitle,
      subtitle: undefined,
      content: {
        bullets: pageBlocks.map(formatSemanticBullet),
        whatToCheck: undefined,
        sourceNote: pageIdx === 0 ? sourceLine(scoped, extras) : undefined,
      },
      metrics: {
        ...base.metrics,
        continuationBlocks: pageBlocks.length,
        CLIENT_TEXT_TRUNCATIONS: plan.gates.CLIENT_TEXT_TRUNCATIONS,
      },
    });
  }

  return { slides, status: "READY" };
}

export function buildExecutiveSummaryFragment(
  sectionId: SectionType,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  if (extras.composedClientSummary) {
    return buildExecutiveSummaryFromComposed(
      sectionId,
      scoped,
      extras,
      extras.composedClientSummary
    );
  }
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
  /**
   * Тематический блок резюме: тема, фактура, объяснение риска, «Что делать».
   *
   * `factLines` ограничивает фактуру для узких карточек первой страницы;
   * страница-продолжение берёт её целиком. Объяснение риска от модели живёт
   * только здесь: карточка матрицы стала сводкой, и без этой строки
   * `keyRisks[].explanation` не печатался бы в отчёте вовсе.
   */
  const themeBullet = (k: ExecutiveSummaryExtras["keyFindings"][number], factLines?: number) => {
    const finding = scoped.findings.find((f) => f.findingId === k.findingId);
    const concrete = finding
      ? claimBodyWithoutTheme(finding)
      : String(k.factualBasis ?? "")
          .replace(/^Подтверждённый факт:\s*/iu, "")
          .trim();
    const risk = matchGptKeyRisk(k.title, gpt?.keyRisks);
    // Keep framing + up to 2 quote lines (+ scale); drop a long why-tail if tight.
    const core = factLines
      ? concrete
          .split("\n")
          .filter((ln) => ln.trim().length > 0)
          .slice(0, factLines)
          .join("\n")
      : concrete;
    const lines = [`«${k.title}»`, core];
    if (risk?.explanation) lines.push(risk.explanation);
    if (risk?.advice) lines.push(`Что делать: ${risk.advice}`);
    return bulletWithFindingId(lines.filter(Boolean).join("\n"), k.findingId, 900);
  };
  const cardTexts = es.keyFindings.map((k) => themeBullet(k, 4));
  const bullets = es.keyFindings.map((k) => themeBullet(k));
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
  narrative = ensureExecutiveFreshnessChangeInNarrative(narrative, extras, ms);
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
        { label: "Материалов собрано", value: String(ms.compositeCount), tone: "neutral" },
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
    // Раскладка общая с остальными страницами буллетов, а не своя.
    //
    // Здесь стояла нарезка `slice` по три подряд: четыре блока давали
    // `ceil(4/3) = 2` страницы вида [3, 1], и последняя уходила под один блок.
    // На эталонной деке это была страница 5 — «Резюме — темы риска
    // (продолжение 2/2)» со 175 знаками на целом листе, 24% заполнения.
    //
    // `packBulletPages` умеет ровно это: он же добирает хвост из предыдущей
    // страницы (`balanceTailPage`), чтобы последний лист не остался с
    // одиноким блоком. Правило было написано дважды — в пагинаторе резюме и
    // в раскладке буллетов, — а этот третий участник о нём не знал.
    const pages = packBulletPages(
      contBullets,
      THEME_PER_PAGE,
      THEME_PER_PAGE,
      DECK_TEMPLATE_REGISTRY["continuation"].layout.itemCharBudget
    );
    const totalPages = pages.length;
    for (let pageIdx = 0; pageIdx < totalPages; pageIdx += 1) {
      const chunk = pages[pageIdx]!;
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
          totalPages > 1 ? continuationTitle(baseTitle, pageIdx + 1, totalPages) : baseTitle,
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

/** Always keep ≥1 first-page slot for LIKELY when any exist (§2.1 visibility). */
const RISK_MATRIX_LIKELY_RESERVED = 1;
/**
 * Synthetic matrix card when KPI shows LIKELY materials but themed findings
 * are absent. Not a bundle findingId — must not enter slide.findingIds / QA.
 */
export const RISK_MATRIX_LIKELY_AGGREGATE_ID = "finding-likely-aggregate";

/** Ёмкость и текстовый бюджет карточек матрицы объявлены только реестром. */
const RISK_MATRIX_TEMPLATE = DECK_TEMPLATE_REGISTRY["risk-matrix"];
/**
 * Сколько знаков даётся строке «в чём проблема».
 *
 * Две нарисованных строки тела карточки при ширине текстовой колонки: столько
 * помещается, не поднимая карточку выше расчётной высоты, по которой считалась
 * ёмкость страницы.
 */
const RISK_MATRIX_PROBLEM_CHARS = 160;
/** Подпись строки действия — она же считается в бюджете, поэтому объявлена раз. */
const RISK_MATRIX_ACTION_PREFIX = "Что делать: ";
/**
 * Суффикс заголовка строки с неподтверждённой принадлежностью.
 *
 * Тема словаря у неподтверждённой строки та же, что у подтверждённой, поэтому
 * в матрице выходили две карточки с одинаковым заголовком и разными вердиктами
 * — на живом отчёте 21.08 это читалось как повтор (пункт CQ). Различие вынесено
 * в заголовок: читатель просматривает их, а не чипы уровня.
 */
const UNCONFIRMED_TITLE_SUFFIX = " — принадлежность не подтверждена";
/**
 * Что остаётся в теле карточки.
 *
 * Только следствие статуса: сам статус теперь сказан заголовком и чипом
 * уровня, и повторять его третий раз незачем.
 */
const LIKELY_CAVEAT =
  "До уточнения идентификации материал не включён в итог «об этом лице».";

/** Строка, которой заголовок обязан назвать неподтверждённую принадлежность. */
function isUnconfirmedRow(f: Finding): boolean {
  return f.subjectMatch === "LIKELY_SUBJECT" && f.findingId !== RISK_MATRIX_LIKELY_AGGREGATE_ID;
}

/**
 * Тело карточки матрицы: сводка, а не выписка.
 *
 * Строка статистики синтезатора идёт дословно — числа остаются с одним
 * источником правды. Цитаты, «Примеры: …» и «Где видно: …» в карточку не
 * попадают никогда: они уже напечатаны в тематических блоках региональных
 * резюме, и матрица их дублировала, раздувая карточку до 575 знаков.
 *
 * Объяснение риска от модели (`risk.explanation`) печатается в резюме, а не
 * здесь: карточке нужна одна строка «в чём проблема», а не две.
 */
function riskMatrixDetail(f: Finding, extras?: FragmentExtras): string {
  // PDF-40 G.1b — headline уже показывает тему, поэтому строка темы снимается.
  const claimLines = claimBodyWithoutTheme(f).split("\n").map((l) => l.trim());
  let head = claimLines[0] ?? "";
  if (head.endsWith(":")) {
    // Первой строкой претензии бывает не статистика, а ввод к цитатам
    // («Найдены публикации по теме:»). Цитат в сводке нет — значит, нет и
    // обещания: строкой «в чём проблема» становится масштаб темы, он из той же
    // претензии и несёт числа. Нет и его — двоеточие просто снимается.
    const scale = claimLines.find((l) => /^(Всего по теме|В корпусе):/u.test(l));
    head = scale ?? `${head.slice(0, -1)}.`;
  }
  const problem = clampClientText(head, RISK_MATRIX_PROBLEM_CHARS);
  const lines = [problem];
  if (isUnconfirmedRow(f)) {
    // У темы с неподтверждённой принадлежностью действие одно — уточнить её,
    // и оговорка говорит об этом полнее рекомендации. У агрегата претензия
    // сама объясняет статус, второй раз повторять его незачем.
    lines.push(LIKELY_CAVEAT);
  } else {
    const advice = matchGptKeyRisk(f.theme, extras?.gptCaseAnalysis?.keyRisks)?.advice;
    // Что осталось от бюджета реестра после строки «в чём проблема» и переноса.
    const budget =
      RISK_MATRIX_TEMPLATE.layout.itemCharBudget -
      problem.length -
      RISK_MATRIX_ACTION_PREFIX.length -
      "\n".length;
    const action = clampClientText((advice ?? f.recommendedAction ?? "").trim(), budget);
    if (action) lines.push(`${RISK_MATRIX_ACTION_PREFIX}${action}`);
  }
  return fitStructuredBullet(lines.join("\n"), RISK_MATRIX_TEMPLATE.layout.itemCharBudget);
}

function riskMatrixRow(f: Finding): string[] {
  return [
    isUnconfirmedRow(f) ? `${f.theme}${UNCONFIRMED_TITLE_SUFFIX}` : f.theme,
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
  pageCapacity = RISK_MATRIX_TEMPLATE.maxTableRowsPerSlide,
  likelyReserved = RISK_MATRIX_LIKELY_RESERVED
): Finding[][] {
  const conf = [...confirmed].sort(
    (a, b) => (RISK_ORDER[b.riskLevel] ?? 0) - (RISK_ORDER[a.riskLevel] ?? 0)
  );
  const lik = [...likely].sort(
    (a, b) => (RISK_ORDER[b.riskLevel] ?? 0) - (RISK_ORDER[a.riskLevel] ?? 0)
  );
  if (conf.length === 0 && lik.length === 0) return [];
  const reserve = Math.min(likelyReserved, lik.length, pageCapacity);
  const confOnFirst = Math.min(conf.length, Math.max(0, pageCapacity - reserve));
  /*
   * Остаток первой страницы добирается вероятными: резерв — это минимум под
   * «Требует подтверждения», а не потолок листа.
   *
   * Отсюда же следует, что помещающийся целиком набор не делится: при
   * `conf + lik ≤ ёмкости` на первую страницу уходят все подтверждённые и все
   * вероятные. Пока добора не было, резерв резал лист по `ёмкость − резерв`, и
   * одна подтверждённая тема с двумя вероятными раскладывалась в [1, 2] — две
   * страницы под три карточки.
   */
  const likOnFirst = Math.min(lik.length, pageCapacity - confOnFirst);
  const first = [...conf.slice(0, confOnFirst), ...lik.slice(0, likOnFirst)];
  const rest = [...conf.slice(confOnFirst), ...lik.slice(likOnFirst)];
  const pages: Finding[][] = [first];
  for (let i = 0; i < rest.length; i += pageCapacity) pages.push(rest.slice(i, i + pageCapacity));
  return unlonelyTail(pages.filter((p) => p.length > 0));
}

/**
 * Последняя страница матрицы не остаётся с одной карточкой.
 *
 * Пять тем при ёмкости четыре давали [4, 1]: лист под одну карточку читается
 * как брошенный. С предыдущей страницы переносится ровно одна тема.
 *
 * Две оговорки, обе — из разбора составов с вероятными темами:
 *
 * 1. С двухкарточной страницы не переносим ничего: одинокий хвост сменился бы
 *    одинокой предыдущей страницей, то есть правило сработало бы против себя.
 *    Если при такой ёмкости хвост неизбежен, он остаётся — это честнее.
 * 2. Первая страница не отдаёт **единственную** вероятную тему: резерв держит
 *    «Требует подтверждения» на виду. Когда вероятных на ней несколько (или
 *    переносим не с первой страницы), ограничения нет — видимость сохраняется
 *    и без него.
 *
 * `balanceTailPage` здесь намеренно не переиспользуется: он выравнивает
 * страницы до почти равных ([4, 1] → [2, 3]) и отменил бы само сжатие матрицы.
 * Вопрос тут другой — «не одинокий хвост», а не «равные страницы».
 */
function unlonelyTail(pages: Finding[][]): Finding[][] {
  const last = pages.at(-1);
  const prev = pages.at(-2);
  if (!last || !prev || last.length !== 1 || prev.length < 3) return pages;
  const isOnlyLikelyOnFirstPage = (idx: number): boolean =>
    pages.length === 2 &&
    prev[idx]!.subjectMatch === "LIKELY_SUBJECT" &&
    !prev.some((f, j) => j !== idx && f.subjectMatch === "LIKELY_SUBJECT");
  for (let i = prev.length - 1; i >= 0; i -= 1) {
    if (isOnlyLikelyOnFirstPage(i)) continue;
    last.unshift(...prev.splice(i, 1));
    return pages;
  }
  return pages;
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
      title: continuationTitle(baseSlide.title, pageIdx + 1, pages.length),
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
    // Подгонка та же, что у остальных тематических буллетов: сбрасываются
    // целые строки в известном порядке (зачем-важно → где видно → масштаб →
    // вторая цитата), а не режется хвост по знакам. Прежний рез плющил буллет
    // в одну строку и отрезал по 480 знакам — с полными адресами это уносило
    // вторую цитату раньше, чем служебные строки, ради сохранения которых
    // порядок сброса и заведён.
    .map((f) => bulletWithFindingId(themedClaim(f), f.findingId, 520));
  // Страница отдавала четыре темы риска одним слайдом и никогда не делилась.
  // На финальном прогоне до клиента дошла **одна**: под шестью KPI-плитками,
  // нарративом и карточкой «Действие» больше не помещалось, а лишнее рендерер
  // выбрасывал молча (шаг 16, 07.6). Три темы повышенного внимания из отчёта
  // просто исчезали.
  //
  // `firstPageBullets: 1` — по замеру этой страницы: обвязка оставляет под
  // блоки около 29 % листа, один тематический блок занимает ~19 %.
  /*
   * Заголовок обзора — вывод, а не название страницы.
   *
   * «Обзор цифрового профиля» не сообщает читателю ничего; эталон отрасли на
   * этом месте пишет итог, который видно, не читая страницу целиком.
   */
  const adverseCount = scoped.findings.filter(isAdverse).length;
  const overviewTitle =
    adverseCount > 0
      ? `Цифровой профиль: ${adverseCount} ${pluralRu(
          adverseCount,
          "тема",
          "темы",
          "тем"
        )} повышенного внимания`
      : "Цифровой профиль: тем повышенного внимания не выявлено";
  return {
    slides: withContinuations(
      makeSlotSlide({
        slot,
        sectionId,
        title: overviewTitle,
        content: {
          // «Проанализировано» относится к предмету аудита, а собрано всегда
          // шире: смешивать эти два числа под одной подписью нельзя.
          narrative: [
            auditScopeLine(s),
            `По собранным источникам: ${s.compositeCount} ${pluralRu(
              s.compositeCount,
              "материал",
              "материала",
              "материалов"
            )} из ${regions.length} ${pluralRu(
              regions.length,
              "регионального контура",
              "региональных контуров",
              "региональных контуров"
            )} (${regions
              .map(([r, n]) => `${regionClientLabel(r)}: ${n}`)
              .join(", ")}). Принадлежность каждого материала к проверяемому лицу проверена.`,
          ]
            .filter(Boolean)
            .join(" "),
          // Labels fit the KPI card budget (28 chars) without clipping.
          kpis: [
            { label: "Материалов собрано", value: String(s.compositeCount), tone: "neutral" },
            { label: "Связаны с проверяемым лицом", value: String(s.subjectMatchCount), tone: "good" },
            {
              label: "Вероятно о субъекте",
              value: String(s.likelySubjectCount ?? 0),
              tone: "warn",
            },
            { label: "Требуют идентификации", value: String(s.ambiguousCount), tone: "warn" },
            { label: "Относятся к другим лицам", value: String(s.otherSubjectCount), tone: "warn" },
            { label: "Тем повышенного внимания", value: String(s.adverseFindingCount), tone: "risk" },
            {
              label: "Региональные контуры",
              value: regions.map(([r]) => regionClientLabel(r)).join(" · "),
              tone: "accent",
            },
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
      "regional-summary",
      { firstPageBullets: 1 }
    ),
    status: "READY",
  };
}
