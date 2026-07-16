/**
 * EXECUTIVE_SUMMARY stage — deterministic offline composer.
 * Serves as the NETWORK_CALLS=0 model implementation: same input always
 * yields byte-identical output. A live GPT caller may replace it later via
 * the injectable SummaryModelCaller in run-stage.ts; guards apply either way.
 */

import type { Finding } from "../contracts/finding";
import { EXECUTIVE_SUMMARY_PROMPT_VERSION } from "./prompt-version";
import {
  EXECUTIVE_SUMMARY_STAGE_OUTPUT_SCHEMA_VERSION,
  type BasisKind,
  type ExecutiveKeyFinding,
  type ExecutiveSummaryStageInput,
  type ExecutiveSummaryStageOutput,
  type ExecutiveVerdict,
} from "./stage-contracts";

const RISK_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };
const MIN_KEY_FINDINGS = 4;
const MAX_KEY_FINDINGS = 7;

function fitText(text: string, max: number): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max);
  const lastSentence = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  if (lastSentence >= Math.floor(max * 0.5)) return slice.slice(0, lastSentence + 1);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > Math.floor(max * 0.5) ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[,;:\s]+$/u, "")}.`.slice(0, max);
}

function basisKindFor(finding: Finding, conflictedDomains: Set<string>): BasisKind {
  const conflicted = finding.sourceDomains.some((d) => conflictedDomains.has(d));
  if (conflicted) return "PRELIMINARY_SIGNAL";
  if (finding.confidence >= 0.75) return "CONFIRMED_FACT";
  if (finding.confidence >= 0.45) return "PRELIMINARY_SIGNAL";
  return "HYPOTHESIS";
}

function basisKindLabel(kind: BasisKind): string {
  if (kind === "CONFIRMED_FACT") return "Подтверждённый факт";
  if (kind === "PRELIMINARY_SIGNAL") return "Предварительный сигнал";
  return "Гипотеза, требующая проверки";
}

function verdictFor(eligible: Finding[], conflictedDomains: Set<string>): ExecutiveVerdict {
  let hasConfirmedCritical = false;
  let hasHigh = false;
  let hasMediumOrSignal = false;
  for (const f of eligible) {
    const kind = basisKindFor(f, conflictedDomains);
    if (f.riskLevel === "critical" && kind === "CONFIRMED_FACT") hasConfirmedCritical = true;
    if (f.riskLevel === "critical" || f.riskLevel === "high") hasHigh = true;
    if (f.riskLevel === "medium") hasMediumOrSignal = true;
  }
  if (hasConfirmedCritical) return "HIGH";
  if (hasHigh) return "ELEVATED";
  if (hasMediumOrSignal) return "MIXED";
  return "LOW";
}

function verdictWording(verdict: ExecutiveVerdict): string {
  switch (verdict) {
    case "HIGH":
      return "выявлены подтверждённые существенные репутационные риски";
    case "ELEVATED":
      return "выявлены значимые репутационные риски, требующие внимания";
    case "MIXED":
      return "картина смешанная: наряду с нейтральным фоном есть отдельные негативные сигналы";
    case "LOW":
      return "существенных репутационных рисков по проверяемому лицу не выявлено";
    default:
      return "объём подтверждённых данных недостаточен для вывода";
  }
}

function isMandatoryPromotion(f: Finding): boolean {
  // Adverse P1/P2 findings must never silently remain only in deep sections.
  return (
    (f.promotionPriority === "P1" || f.promotionPriority === "P2") &&
    (RISK_ORDER[f.riskLevel] ?? 0) >= 2
  );
}

function selectKeyFindings(eligible: Finding[], conflictedDomains: Set<string>): Finding[] {
  const sorted = [...eligible].sort((a, b) => {
    const risk = (RISK_ORDER[b.riskLevel] ?? 0) - (RISK_ORDER[a.riskLevel] ?? 0);
    if (risk !== 0) return risk;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.findingId.localeCompare(b.findingId);
  });
  // Mandatory first: adverse P1/P2 can only be displaced by other P1/P2.
  const mandatory = sorted.filter(isMandatoryPromotion).slice(0, MAX_KEY_FINDINGS);
  const picked = [...mandatory];
  for (const f of sorted) {
    if (picked.length >= MAX_KEY_FINDINGS) break;
    if (!picked.includes(f)) picked.push(f);
  }
  // Adverse and neutral signals must be shown simultaneously: if the slice is
  // all-adverse, swap the last non-mandatory slot for the strongest neutral.
  const hasNeutral = picked.some((f) => (RISK_ORDER[f.riskLevel] ?? 0) <= 1);
  if (!hasNeutral && picked.length >= MIN_KEY_FINDINGS) {
    const neutral = sorted.find((f) => (RISK_ORDER[f.riskLevel] ?? 0) <= 1);
    if (neutral) {
      for (let i = picked.length - 1; i >= 0; i -= 1) {
        if (!isMandatoryPromotion(picked[i])) {
          picked[i] = neutral;
          break;
        }
      }
    }
  }
  void conflictedDomains;
  return picked;
}

function toKeyFinding(finding: Finding, conflictedDomains: Set<string>): ExecutiveKeyFinding {
  const kind = basisKindFor(finding, conflictedDomains);
  const regions = finding.regions.length > 0 ? ` Регионы: ${finding.regions.join(", ")}.` : "";
  const domains =
    finding.sourceDomains.length > 0
      ? ` Источники: ${finding.sourceDomains.slice(0, 3).join(", ")}.`
      : "";
  return {
    findingId: finding.findingId,
    title: fitText(finding.theme, 140),
    basisKind: kind,
    factualBasis: fitText(`${basisKindLabel(kind)}: ${finding.claim}${regions}${domains}`, 320),
    clientImpact: fitText(clientImpactFor(finding, kind), 220),
    confidence: finding.confidence,
    recommendedAction: fitText(finding.recommendedAction, 180),
  };
}

function clientImpactFor(finding: Finding, kind: BasisKind): string {
  const severity = RISK_ORDER[finding.riskLevel] ?? 0;
  if (severity >= 3) {
    return kind === "CONFIRMED_FACT"
      ? "Материал доступен в открытой выдаче и может напрямую влиять на решения контрагентов, банков и партнёров при проверке."
      : "Сигнал виден в открытой выдаче; до подтверждения он создаёт риск неверной трактовки при проверках контрагентами.";
  }
  if (severity === 2) {
    return "Тема заметна в выдаче и формирует контекст восприятия; при развитии сюжета возможно усиление негативного фона.";
  }
  return "Материал формирует нейтральный или положительный фон и снижает долю нежелательного контента в выдаче.";
}

function buildConclusion(
  input: ExecutiveSummaryStageInput,
  verdict: ExecutiveVerdict,
  keyFindings: ExecutiveKeyFinding[]
): string {
  const subject = input.subject.displayName;
  const confirmed = keyFindings.filter((f) => f.basisKind === "CONFIRMED_FACT").length;
  const signals = keyFindings.filter((f) => f.basisKind === "PRELIMINARY_SIGNAL").length;
  const hypotheses = keyFindings.filter((f) => f.basisKind === "HYPOTHESIS").length;
  const regions = [...new Set(input.regionalMetrics.map((r) => r.region))];
  const sentences: string[] = [];
  sentences.push(`По итогам проверки открытых источников в отношении ${subject} ${verdictWording(verdict)}.`);
  sentences.push(
    `В сводку включены ${keyFindings.length} ключевых наблюдений: подтверждённых фактов — ${confirmed}, предварительных сигналов — ${signals}, гипотез — ${hypotheses}.`
  );
  if (regions.length > 0) {
    sentences.push(`Оценка охватывает регионы: ${regions.join(", ")}.`);
  }
  if (input.identityPollution.otherSubjectCount > 0) {
    const dom = input.identityPollution.dominantOtherSubject;
    sentences.push(
      `Часть материалов в выдаче относится к другому лицу${dom ? ` (${dom})` : ""} и исключена из выводов о проверяемом субъекте.`
    );
  }
  if (input.dataGaps.length > 0) {
    sentences.push(`По отдельным направлениям данные собраны не полностью; ограничения перечислены ниже.`);
  }
  let text = sentences.join(" ");
  if (text.length < 300) {
    text = `${text} Каждое утверждение сводки опирается на конкретное наблюдение с идентификатором и списком источников; выводы применимы без изучения остальных разделов отчёта.`;
  }
  return fitText(text, 600);
}

function buildInsufficientConclusion(input: ExecutiveSummaryStageInput): string {
  const subject = input.subject.displayName;
  const gaps = input.dataGaps.map((g) => g.area).slice(0, 4);
  const pollution =
    input.identityPollution.otherSubjectCount > 0
      ? " Значительная часть найденных материалов относится к другому лицу и не может использоваться в выводах."
      : "";
  return fitText(
    `Собранных подтверждённых данных по ${subject} недостаточно для доказательного вывода о репутационных рисках.${pollution}${
      gaps.length > 0 ? ` Не закрыты направления: ${gaps.join(", ")}.` : ""
    } Рекомендуется расширить проверку перед принятием решений.`,
    600
  );
}

export function composeExecutiveSummaryDeterministic(
  input: ExecutiveSummaryStageInput,
  inputHash: string
): ExecutiveSummaryStageOutput {
  const excluded = new Set(input.verifiedFindings.excludedFindingIds);
  const eligible = input.verifiedFindings.findings.filter(
    (f) => f.subjectMatch === "SUBJECT_MATCH" && !excluded.has(f.findingId)
  );
  const conflictedDomains = new Set<string>();
  for (const sq of input.sourceQuality) {
    if ((sq.conflictsWithDomains ?? []).length > 0 || sq.reliability === "UNVERIFIED") {
      conflictedDomains.add(sq.domain);
    }
  }

  const identityCaveats: string[] = [];
  if (input.identityPollution.otherSubjectCount > 0) {
    const dom = input.identityPollution.dominantOtherSubject;
    identityCaveats.push(
      fitText(
        `В выдаче присутствуют материалы о другом лице${dom ? ` — ${dom}` : ""} (${input.identityPollution.otherSubjectCount} набл.); они исключены из выводов о проверяемом субъекте.`,
        320
      )
    );
  }
  if (input.identityPollution.ambiguousCount > 0) {
    identityCaveats.push(
      fitText(
        `${input.identityPollution.ambiguousCount} наблюдений не удалось однозначно отнести к проверяемому лицу; они не учитывались как факты.`,
        320
      )
    );
  }
  for (const note of input.identityPollution.notes) identityCaveats.push(fitText(note, 320));

  const dataLimitations: string[] = input.dataGaps.map((g) =>
    fitText(`${g.area}: ${g.detail}`, 320)
  );
  for (const sq of input.sourceQuality) {
    if ((sq.conflictsWithDomains ?? []).length > 0) {
      dataLimitations.push(
        fitText(
          `Источник ${sq.domain} противоречит данным ${sq.conflictsWithDomains!.join(", ")}; связанные наблюдения учтены как предварительные сигналы.`,
          320
        )
      );
    }
  }

  const regionalOverview = input.regionalMetrics.map((r) => {
    const share = r.totalCount > 0 ? r.adverseSharePercent : null;
    const oneLiner =
      r.totalCount === 0
        ? `По региону ${r.region} данные не собраны; доля негатива не рассчитывается.`
        : `Регион ${r.region}: негативные материалы — ${r.adverseCount} из ${r.totalCount} (${share ?? 0}%).`;
    return {
      region: r.region,
      adverseSharePercent: share,
      adverseCount: r.totalCount > 0 ? r.adverseCount : null,
      totalCount: r.totalCount > 0 ? r.totalCount : null,
      oneLiner: fitText(oneLiner, 220),
    };
  });

  const methodologyNote = fitText(
    "Сводка построена только на проверенных наблюдениях с привязкой к конкретным источникам. Материалы о других лицах с совпадающим именем исключены. Подтверждённые факты, предварительные сигналы и гипотезы помечены раздельно.",
    400
  );

  const base = {
    schemaVersion: EXECUTIVE_SUMMARY_STAGE_OUTPUT_SCHEMA_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    sourceHashes: input.sourceHashes,
    evidenceRefs: [] as string[],
    promptVersion: EXECUTIVE_SUMMARY_PROMPT_VERSION,
    inputHash,
    regionalOverview,
    identityCaveats,
    dataLimitations,
    methodologyNote,
  };

  if (eligible.length < MIN_KEY_FINDINGS) {
    return {
      ...base,
      verdict: "INSUFFICIENT_DATA",
      executiveConclusion: buildInsufficientConclusion(input),
      keyFindings: [],
      priorityActions: [
        fitText("Расширить проверку по незакрытым направлениям до принятия решений.", 180),
        ...input.recommendedActions.slice(0, 2).map((a) => fitText(a, 180)),
      ],
      evidenceRefs: [],
    };
  }

  const picked = selectKeyFindings(eligible, conflictedDomains);
  const keyFindings = picked.map((f) => toKeyFinding(f, conflictedDomains));
  const verdict = verdictFor(eligible, conflictedDomains);

  const priorityActions = [...new Set([
    ...keyFindings
      .filter((f) => f.basisKind !== "HYPOTHESIS")
      .slice(0, 4)
      .map((f) => f.recommendedAction),
    ...input.recommendedActions.map((a) => fitText(a, 180)),
  ])].slice(0, 6);

  return {
    ...base,
    verdict,
    executiveConclusion: buildConclusion(input, verdict, keyFindings),
    keyFindings,
    priorityActions: priorityActions.length > 0 ? priorityActions : [fitText("Мониторить выдачу по ключевым темам.", 180)],
    evidenceRefs: picked.flatMap((f) => f.evidenceRefs),
  };
}
