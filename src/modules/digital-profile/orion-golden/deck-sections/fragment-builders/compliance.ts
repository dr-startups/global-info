/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { FragmentKey, SectionType, SlideBody, SlideContentContract } from "../contracts";
import { SLIDE_CONTENT_SCHEMA_VERSION } from "../contracts";
import type { ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import { pickComplianceClientMatchTitle } from "../../../services/compliance-inventory-adapter";
import { pluralRu } from "../../analytics/finding-synthesizer";
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

  // C.4 — several records of one provider go into the param table as separate
  // banded blocks («Запись 1 из N — имя»), not one flat list with repeating keys.
  const providerParamTable = (
    provHits: ComplianceHitEntry[],
    infoRows: string[][]
  ): {
    headers: string[];
    rows: string[][];
    groups?: Array<{ rowStart: number; rowCount: number; queryDisplay: string; qTag?: string }>;
  } => {
    const headers = ["Параметр", "Значение"];
    const recordRows = (h: ComplianceHitEntry): string[][] => {
      const l = hitLabel(h);
      return [
        ["Совпадение по имени", l.name],
        ["Категория", l.category],
        ["Оценка совпадения", l.score],
        ["Статус", l.status],
      ];
    };
    if (provHits.length <= 1) {
      return { headers, rows: [...provHits.flatMap(recordRows), ...infoRows] };
    }
    const rows: string[][] = [];
    const groups: Array<{ rowStart: number; rowCount: number; queryDisplay: string; qTag?: string }> = [];
    provHits.forEach((h, i) => {
      const rec = recordRows(h);
      groups.push({
        rowStart: rows.length,
        rowCount: rec.length,
        qTag: `Запись ${i + 1} из ${provHits.length}`,
        queryDisplay: hitLabel(h).name,
      });
      rows.push(...rec);
    });
    if (infoRows.length > 0) {
      groups.push({
        rowStart: rows.length,
        rowCount: infoRows.length,
        qTag: "Справка",
        queryDisplay: "значение раздела и рекомендации",
      });
      rows.push(...infoRows);
    }
    return { headers, rows, groups };
  };

  const dowHits = hits.filter(([, e]) => (e.providerLabel ?? "").toUpperCase() === "DOW_JONES");
  const lexisHits = hits.filter(([, e]) => (e.providerLabel ?? "").toUpperCase() === "LEXISNEXIS");

  /**
   * Страница одной комплаенс-базы.
   *
   * Шаг 13, C13 — при нуле записей страница печатала таблицу «Параметр /
   * Значение», где значениями была проза («Категория PEP влияет на уровень
   * комплаенс-контроля…»), и подавала это как содержание профиля. Утверждать
   * значимость категории PEP, не имея ни одной записи, нельзя: пустая база —
   * это результат проверки, и выглядеть он должен как результат проверки.
   */
  const providerSlide = (input: {
    slot: (typeof slots)[number];
    provider: string;
    hits: ComplianceHitEntry[];
    infoRows: string[][];
    narrative: string;
    whyWithRecords: string;
    whyWithoutRecords: string;
    whatToCheckWithRecords: string;
    sourceNote: string;
    emptyStateReason?: string;
  }): SlideContentContract => {
    if (input.hits.length === 0) {
      return makeSlotSlide({
        slot: input.slot,
        sectionId,
        templateId: "coverage-empty-state",
        content: {
          narrative: `Проверка по базе ${input.provider} выполнена: записей о субъекте не зафиксировано — это результат проверки на дату отчёта, а не вывод об отсутствии рисков.`,
          bullets: [input.whyWithoutRecords],
          whatToCheck: `Повторить сверку по базе ${input.provider} при следующем обновлении данных; при появлении записи запросить полную карточку и сверить идентификаторы субъекта.`,
          sourceNote: input.sourceNote,
        },
        evidenceRefs: [],
        findingIds: [],
        metrics: { hits: 0 },
        emptyStateReason: "no-compliance-records",
      });
    }
    return makeSlotSlide({
      slot: input.slot,
      sectionId,
      templateId: "serp-table",
      content: {
        narrative: input.narrative,
        table: providerParamTable(input.hits, input.infoRows),
        whatWasFound: clampClientText(
          `Потенциальное совпадение категории «${hitLabel(input.hits[0]!).category}» с оценкой ${hitLabel(input.hits[0]!).score}; совпадение не подтверждено и требует ручной проверки.`,
          400
        ),
        whyItMatters: input.whyWithRecords,
        whatToCheck: input.whatToCheckWithRecords,
        sourceNote: input.sourceNote,
      },
      evidenceRefs: input.hits.map(([r]) => r),
      findingIds: [],
      metrics: { hits: input.hits.length },
      ...(input.emptyStateReason ? { emptyStateReason: input.emptyStateReason } : {}),
    });
  };

  const slides: SlideContentContract[] = [
    makeSlotSlide({
      slot: summarySlot,
      sectionId,
      templateId: "serp-table",
      content: {
        // B.2 — the checked counter can exceed the table rows (records without
        // a match are not listed); say so explicitly instead of looking off-by-N.
        narrative: (() => {
          const checkedN = Number(checkedCount ?? refs.length) || 0;
          const noMatchN = Math.max(0, checkedN - hits.length);
          const clarifier =
            noMatchN > 0
              ? ` По ${noMatchN} ${pluralRu(noMatchN, "записи", "записям", "записям")} совпадений не выявлено — в таблицу они не включены.`
              : "";
          const base =
            narrative.join(" ") ||
            `Проверено записей комплаенс-контура: ${String(checkedN)}. Потенциальных совпадений в базах: ${hits.length}; подтверждённых совпадений нет — каждое требует ручной верификации.`;
          return base + clarifier;
        })(),
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
    providerSlide({
      slot: dowSlot!,
      provider: "Dow Jones",
      hits: dowHits,
      narrative:
        "Профиль по данным Dow Jones: существующий комплаенс-контент, источники не расширялись.",
      infoRows: [
        [
          "Почему важно",
          "Категория PEP влияет на уровень комплаенс-контроля при онбординге и мониторинге клиента.",
        ],
        ["Что сделать", "Запросить полную запись Dow Jones и сверить идентификаторы субъекта."],
      ],
      whyWithRecords:
        "Категория PEP влияет на уровень комплаенс-контроля при онбординге и мониторинге клиента.",
      whyWithoutRecords:
        "База Dow Jones отвечает на вопрос о статусе политически значимого лица: запись в ней подняла бы уровень контроля при онбординге и мониторинге. В текущем наборе такой записи по субъекту нет.",
      whatToCheckWithRecords:
        "Запросить полную запись Dow Jones и сверить идентификаторы субъекта.",
      sourceNote: "Источник: Dow Jones (существующий контур).",
    }),
    providerSlide({
      slot: lexisSlot!,
      provider: "LexisNexis",
      hits: lexisHits,
      narrative:
        "Страница профиля LexisNexis. Визуальный экспорт страницы в текущем наборе недоступен; содержимое записи приведено в текстовом виде без потерь. Вторая страница профиля из отчёта v72 объединена с этой: отдельного содержимого у неё нет.",
      infoRows: [
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
      whyWithRecords:
        "Негативные публикации в базе увеличивают репутационный риск и требуют проверки первоисточников.",
      whyWithoutRecords:
        "База LexisNexis собирает негативные публикации и правовые сюжеты: запись в ней потребовала бы проверки первоисточников. В текущем наборе такой записи по субъекту нет.",
      whatToCheckWithRecords:
        "Запросить полную запись LexisNexis и проверить первоисточники публикаций.",
      sourceNote: "Источник: LexisNexis (существующий контур).",
      emptyStateReason: VISUAL_ASSET_UNAVAILABLE,
    }),
  ];
  return { slides, status: "READY" };
}

// ---------------------------------------------------------------------------
// APPENDIX (non-canonical, optional)
// ---------------------------------------------------------------------------
