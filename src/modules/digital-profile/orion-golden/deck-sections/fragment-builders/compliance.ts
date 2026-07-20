/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { FragmentKey, SectionType, SlideBody, SlideContentContract } from "../contracts";
import { SLIDE_CONTENT_SCHEMA_VERSION } from "../contracts";
import type { ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import { pickComplianceClientMatchTitle } from "../../../services/compliance-inventory-adapter";
import type { FragmentBuildOutput, FragmentExtras } from "./shared";
import {
  VISUAL_ASSET_UNAVAILABLE,
  clampClientText,
  coverageContent,
  emptyStatusForReason,
  fitClientSentences,
  makeSlotSlide,
  sourceLine,
  splitClientParagraphs,
  uniqueRefs,
  withContinuations,
} from "./shared";

const COMPLIANCE_PROVIDER_LABELS: Record<string, string> = {
  DOW_JONES: "Dow Jones",
  LEXISNEXIS: "LexisNexis",
  WORLD_CHECK: "World-Check",
};
const COMPLIANCE_CATEGORY_LABELS: Record<string, string> = {
  PEP: "PEP (политически значимое лицо)",
  POLITICAL_EXPOSURE: "Политическая аффилированность",
  ADVERSE_MEDIA: "Негативные публикации",
  SANCTIONS: "Санкционные списки",
  WATCHLIST: "Сторожевые списки",
  LEGAL: "Правовые и регуляторные риски",
  LAW_ENFORCEMENT: "Правоохранительные сигналы",
  OTHER: "Требует ручной классификации",
  /** Internal persist tokens — never show raw to the client. */
  LEXISNEXIS_SIGNAL: "Сигнал LexisNexis",
  LEXISNEXIS_IMPORTED_REPORT: "Импортированный отчёт LexisNexis",
};
const COMPLIANCE_STATUS_LABELS: Record<string, string> = {
  PENDING: "Требует ручной проверки",
  NEEDS_REVIEW: "Требует ручной проверки",
  CONFIRMED: "Подтверждено",
  MATCH_CONFIRMED: "Подтверждено",
  DISMISSED: "Отклонено",
  FALSE_POSITIVE: "Ложное срабатывание",
};

function humanizeComplianceMatchName(
  name: string | undefined,
  subjectDisplayName?: string
): string {
  return pickComplianceClientMatchTitle({
    matchedName: name,
    subjectName: subjectDisplayName,
    fallback: subjectDisplayName,
  });
}

function humanizeComplianceCategory(category: string | undefined): string {
  const key = String(category ?? "")
    .trim()
    .toUpperCase();
  if (!key || key === "—" || key === "-") return "—";
  if (COMPLIANCE_CATEGORY_LABELS[key]) return COMPLIANCE_CATEGORY_LABELS[key]!;
  // Never leak SCREAMING_SNAKE enums into the PDF.
  if (/^[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(key)) return "Сигнал комплаенс-базы";
  return String(category).replace(/_/g, " ").trim() || "—";
}

type ComplianceHitEntry = [string, ScopedFragmentInput["evidenceIndex"][string]];

/** Collapse duplicate Lexis/Dow rows (same provider+category+score+name). */
export function dedupeComplianceHits(
  hits: ComplianceHitEntry[],
  subjectDisplayName?: string
): ComplianceHitEntry[] {
  const seen = new Set<string>();
  const out: ComplianceHitEntry[] = [];
  for (const h of hits) {
    const [, e] = h;
    const key = [
      String(e.providerLabel ?? "").toUpperCase(),
      humanizeComplianceCategory(e.matchCategory),
      e.matchScore ?? "",
      humanizeComplianceMatchName(e.title, subjectDisplayName).toLowerCase(),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

export function buildComplianceFragment(
  sectionId: SectionType,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const slots = slotsForFragment("COMPLIANCE_MAIN");
  const [summarySlot, dowSlot, lexisSlot] = slots;
  // p36_lexis_visual_2 is covered via EXPLICIT_SLOT_MERGES → p35_lexis_visual:
  // its v72 content does not justify a standalone page in this dataset.
  const complianceUnits = scoped.surfaceUnits.filter((u) => u.surface === "compliance");
  const refs = complianceUnits.flatMap((u) => u.evidenceRefs);
  const narrative = extras.complianceNarrative ?? [];
  const subjectName = scoped.subject.displayName;
  const hits = dedupeComplianceHits(
    Object.entries(scoped.evidenceIndex).filter(([, e]) => e.kind === "compliance_hit"),
    subjectName
  );
  const checkedCount = complianceUnits
    .flatMap((u) => u.metrics)
    .find((m) => m.key === "totalCount")?.value;

  const hitLabel = ([, e]: ComplianceHitEntry) => ({
    provider: COMPLIANCE_PROVIDER_LABELS[e.providerLabel ?? ""] ?? e.providerLabel ?? "База данных",
    category: humanizeComplianceCategory(e.matchCategory),
    score: e.matchScore != null ? `${e.matchScore}/100` : "—",
    status: COMPLIANCE_STATUS_LABELS[e.reviewStatus ?? ""] ?? e.reviewStatus ?? "—",
    name: humanizeComplianceMatchName(e.title, subjectName) || "Совпадение в базе",
  });

  const summaryRows = hits.map((h) => {
    const l = hitLabel(h);
    return [l.provider, l.category, l.score, l.status];
  });

  const dowHits = hits.filter(([, e]) => (e.providerLabel ?? "").toUpperCase() === "DOW_JONES");
  const lexisHits = hits.filter(([, e]) => (e.providerLabel ?? "").toUpperCase() === "LEXISNEXIS");

  const slides: SlideContentContract[] = [
    makeSlotSlide({
      slot: summarySlot,
      sectionId,
      templateId: "serp-table",
      content: {
        narrative:
          narrative.join(" ") ||
          `Проверено записей комплаенс-контура: ${String(checkedCount ?? refs.length)}. Потенциальных совпадений в базах: ${hits.length}; подтверждённых совпадений нет — каждое требует ручной верификации.`,
        table: {
          headers: ["База данных", "Тип совпадения", "Оценка совпадения", "Статус проверки"],
          rows: summaryRows,
        },
        whatToCheck:
          "Верифицировать каждое потенциальное совпадение вручную: сопоставить идентификаторы субъекта с записью базы.",
        sourceNote: "Источник: комплаенс-базы (существующий контур, без расширения источников).",
      },
      evidenceRefs: [...refs, ...hits.map(([r]) => r)],
      findingIds: scoped.findings.map((f) => f.findingId),
      metrics: { complianceItems: refs.length, hits: hits.length },
    }),
    makeSlotSlide({
      slot: dowSlot,
      sectionId,
      templateId: "serp-table",
      content: {
        narrative:
          "Профиль по данным Dow Jones: существующий комплаенс-контент, источники не расширялись.",
        table: {
          headers: ["Параметр", "Значение"],
          rows: [
            ...dowHits.flatMap((h) => {
              const l = hitLabel(h);
              return [
                ["Совпадение по имени", l.name],
                ["Категория", l.category],
                ["Оценка совпадения", l.score],
                ["Статус", l.status],
              ];
            }),
            [
              "Почему важно",
              "Категория PEP влияет на уровень комплаенс-контроля при онбординге и мониторинге клиента.",
            ],
            ["Что сделать", "Запросить полную запись Dow Jones и сверить идентификаторы субъекта."],
          ],
        },
        whatWasFound: dowHits.length
          ? clampClientText(
              `Потенциальное совпадение категории «${hitLabel(dowHits[0]).category}» с оценкой ${hitLabel(dowHits[0]).score}; совпадение не подтверждено и требует ручной проверки.`,
              400
            )
          : "Совпадений в базе Dow Jones не зафиксировано.",
        whyItMatters:
          "Категория PEP влияет на уровень комплаенс-контроля при онбординге и мониторинге клиента.",
        whatToCheck: "Запросить полную запись Dow Jones и сверить идентификаторы субъекта.",
        sourceNote: "Источник: Dow Jones (существующий контур).",
      },
      evidenceRefs: dowHits.map(([r]) => r),
      findingIds: [],
      metrics: { hits: dowHits.length },
    }),
    makeSlotSlide({
      slot: lexisSlot,
      sectionId,
      templateId: "serp-table",
      content: {
        narrative:
          "Страница профиля LexisNexis. Визуальный экспорт страницы в текущем наборе недоступен; содержимое записи приведено в текстовом виде без потерь. Вторая страница профиля из отчёта v72 объединена с этой: отдельного содержимого у неё нет.",
        table: {
          headers: ["Параметр", "Значение"],
          rows: [
            ...lexisHits.flatMap((h) => {
              const l = hitLabel(h);
              return [
                ["Совпадение по имени", l.name],
                ["Категория", l.category],
                ["Оценка совпадения", l.score],
                ["Статус", l.status],
              ];
            }),
            [
              "Почему важно",
              "Негативные публикации в базе увеличивают репутационный риск и требуют проверки первоисточников.",
            ],
            ["Что сделать", "Запросить полную запись LexisNexis и проверить первоисточники публикаций."],
            [
              "Визуальный экспорт",
              "Недоступен в текущем наборе; данные приведены в текстовом виде без потерь.",
            ],
          ],
        },
        whatWasFound: lexisHits.length
          ? clampClientText(
              `Потенциальное совпадение категории «${hitLabel(lexisHits[0]).category}» с оценкой ${hitLabel(lexisHits[0]).score}; совпадение не подтверждено и требует ручной проверки.`,
              400
            )
          : "Совпадений в базе LexisNexis не зафиксировано.",
        whyItMatters:
          "Негативные публикации в базе увеличивают репутационный риск и требуют проверки первоисточников.",
        whatToCheck: "Запросить полную запись LexisNexis и проверить первоисточники публикаций.",
        sourceNote: "Источник: LexisNexis (существующий контур).",
      },
      evidenceRefs: lexisHits.map(([r]) => r),
      findingIds: [],
      metrics: { hits: lexisHits.length },
      emptyStateReason: VISUAL_ASSET_UNAVAILABLE,
    }),
  ];
  return { slides, status: "READY" };
}

// ---------------------------------------------------------------------------
// APPENDIX (non-canonical, optional)
// ---------------------------------------------------------------------------
