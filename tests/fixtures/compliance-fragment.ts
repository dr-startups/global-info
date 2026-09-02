/**
 * Вход построителя комплаенса для юнитов: записи, слайды и признаки страниц.
 *
 * Ёмкость страниц раздела проверяют три файла тестов, и все три собирают один и
 * тот же вход — состав записи, полосы страниц, потолки. Пока каждый строил его
 * сам, «предельная законная запись» существовала в трёх редакциях, и правка
 * состава карточки двигала одну из них.
 */

import { buildComplianceFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/compliance";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const METRIC_SNAPSHOT = {
  metricSnapshotId: "m-1",
  datasetId: "d-1",
  reportRunId: "r-1",
  baseCount: 40,
  enrichmentCount: 0,
  compositeCount: 40,
  subjectMatchCount: 12,
  likelySubjectCount: 0,
  ambiguousCount: 0,
  otherSubjectCount: 0,
  adverseFindingCount: 0,
  perRegionCounts: { RU: 24, UAE: 16 },
};

/**
 * Запись со всеми восемью строками карточки — предельный законный случай.
 *
 * Заголовок инвентаря у записей разный: по нему инвентарь сводит дубли, и
 * одинаковый склеил бы фикстуру в одну запись.
 */
export function fullRecord(provider: string, n: number): Record<string, unknown> {
  return {
    kind: "compliance_hit",
    providerLabel: provider,
    matchCategory: "SANCTION_LINKED",
    reviewStatus: "PENDING",
    title: `Йохан Хольмстрём ${n} (${provider})`,
    matchedName: `Йохан Хольмстрём ${n}`,
    aliases: ["Holmstroem Johan", "Хольмстрем Йохан", `Alias ${n}`],
    countries: ["se", "ch", "cy"],
    datesOfBirth: ["1965-04-12", "12.04.1965"],
    summary: `Запись ${n}: связь с санкционным лицом через совместное владение компанией.`,
    url: `https://opensanctions.org/entities/NK-${provider}-${n}/`,
  };
}

/**
 * Запись из одних обязательных полей — три строки, самая дешёвая законная.
 *
 * Полей сверх обязательных у неё нет, поэтому своей карточки она не получает:
 * в отчёте от неё остаётся только строка сводной таблицы.
 */
export function minimalRecord(provider: string, n: number): Record<string, unknown> {
  return {
    kind: "compliance_hit",
    providerLabel: provider,
    matchCategory: "PEP",
    reviewStatus: "CONFIRMED",
    title: `Кирилл Кулебакин ${n} (${provider})`,
    matchedName: `Кирилл Кулебакин ${n}`,
  };
}

/** Слайды комплаенс-раздела на этом наборе записей. */
export function complianceSlides(
  records: Array<Record<string, unknown>>
): SlideContentContract[] {
  const evidenceIndex: Record<string, unknown> = {};
  records.forEach((r, i) => {
    evidenceIndex[`hit-${i + 1}`] = r;
  });
  const scoped = {
    subject: { displayName: "Йохан Хольмстрём", aliases: [] },
    findings: [],
    surfaceUnits: [
      {
        surface: "compliance",
        region: "GLOBAL",
        metrics: [{ key: "totalCount", value: records.length }],
        claims: [],
        evidenceRefs: Object.keys(evidenceIndex),
      },
    ],
    metricSnapshot: METRIC_SNAPSHOT,
    scope: { regions: null, surfaces: ["compliance"], subjectMatch: null, findingIds: null },
    evidenceIndex,
  };
  return buildComplianceFragment("COMPLIANCE" as never, scoped as never, {} as never).slides;
}

/** Все листы одного слота: основа и её продолжения. */
export function pagesOfSlot(
  slides: SlideContentContract[],
  baseSlotId: string
): SlideContentContract[] {
  return slides.filter((s) => s.slideId === baseSlotId || s.continuationOf === baseSlotId);
}

// Тип страницы узнаётся по колонкам её таблицы, а не по номеру продолжения:
// на слоте сводки стоят листы обеих таблиц.
export const isCardPage = (s: SlideContentContract): boolean =>
  s.content.table?.headers?.[0] === "Параметр";
export const isSummaryPage = (s: SlideContentContract): boolean =>
  s.content.table?.headers?.[0] === "База данных";

/** Слоты листа карточек: строки таблицы плюс полосы-заголовки. */
export function pageSlots(s: SlideContentContract): number {
  const table = s.content.table;
  return (table?.rows.length ?? 0) + (table?.groups?.length ?? 0);
}
