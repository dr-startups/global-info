/**
 * План запросов сбора без сети — лист графа модулей (шаг 0137).
 *
 * Жил в `services/orion-search-profile-service.ts`, но тот импортирует
 * стратегию выполнения, а стратегия — реестр агентов. Агенту, которому план
 * нужен (Google собирает позиции органики), импортировать сервис значило бы
 * замкнуть цикл: `агент → сервис → стратегия → реестр → агент`, и реестр
 * падал на `RealGoogleSearchAgent is not a constructor`.
 *
 * Поэтому план переехал сюда и **не копировался**: сервис его реэкспортирует,
 * и ответ на вопрос «какие запросы у аудита» остаётся один.
 *
 * Модуль чистый: ни сети, ни базы.
 */

import { providerConfig } from "../providers/config";
import { parseSubjectName } from "../risk-classifier/entity-disambiguation";
import { buildSubjectQuerySet, plannedPrimaryQueries, SUBJECT_QUERY_LIMIT } from "./subject-query-set";
import type { SubjectQuerySet } from "./subject-query-set";
import {
  buildOrionQueryPlanDetailed,
  hasCyrillic,
  transliterateRuToEn,
  type OrionQuerySpec,
  type OrionRegionCode,
  type PlannedPrimaryQuery,
} from "./orion-query-plan";
import { regionProfile } from "./region-profiles";
import type { CaseSubjectInfo } from "../agents/mock/mock-utils";

/**
 * Можно ли задавать негативные пробы: зависит от правового основания дела.
 * Переехало сюда вместе с планом — план его и спрашивает.
 */
export function allowsNegativeQueries(subject: OfflinePlanSubject): boolean {
  const basis = (subject.lawfulBasis ?? "").toUpperCase();
  if (!basis) return false;
  if (basis === "CONSENT") return (subject.consentStatus ?? "").toUpperCase() === "GRANTED";
  return ["LEGITIMATE_INTEREST", "LEGAL_OBLIGATION", "PUBLIC_INTEREST", "CONTRACT"].includes(basis);
}

/** Глубина аудита выдачи: ТОП-N, который обещает отчёт. */
export const SERP_AUDIT_DEPTH = 20;

/**
 * Субъект, которого хватает для плана запросов без сети: имя, псевдонимы,
 * регионы, страна. Правовое основание — необязательное: без него план идёт без
 * негативных проб, как для субъекта без согласия.
 */
export type OfflinePlanSubject = Pick<CaseSubjectInfo, "fullName" | "aliases" | "targetRegions" | "location"> &
  Partial<Pick<CaseSubjectInfo, "lawfulBasis" | "consentStatus">>;

/**
 * Имя, которым субъекта ищут в контуре: в зарубежном — латиницей.
 *
 * Набор строился от кириллического ФИО во всех контурах, и в ОАЭ уходили
 * запросы вида «киркоров филипп бедросович дети». Google с параметрами ОАЭ
 * отвечал на них теми же русскими страницами, что и российский контур:
 * раздел про ОАЭ повторял российский, а то, что о субъекте видно за
 * рубежом, в отчёт не попадало.
 */
export function regionSearchName(subject: OfflinePlanSubject, region: OrionRegionCode): string {
  return regionProfile(region).language !== "ru" ? latinNameOf(subject) : subject.fullName;
}

/** Набор запросов контура из уже полученных подсказок — без сети. */
export function regionQuerySet(
  subject: OfflinePlanSubject,
  region: OrionRegionCode,
  capturedAt: string,
  suggestions: Array<{ text: string; engine: string; region: string; rank: number }>
): SubjectQuerySet {
  const profile = regionProfile(region);
  const latinContour = profile.language !== "ru";
  const searchName = regionSearchName(subject, region);
  const variants = (subject.aliases ?? []).filter((a: string) => !latinContour || !hasCyrillic(a));
  const parsed = parseSubjectName(searchName);
  return buildSubjectQuerySet({
    profile: {
      fullName: searchName,
      firstName: parsed.givenName ?? undefined,
      lastName: parsed.surname ?? undefined,
      patronymic: parsed.patronymic ?? undefined,
      variants,
    },
    suggestions,
    region,
    language: profile.language,
    capturedAt,
    limit: SUBJECT_QUERY_LIMIT,
  });
}

/**
 * План запросов сбора, построенный без сети.
 *
 * Тот же построитель и те же настройки, что у живого сбора, только без
 * автодополнения Google: на запрос субъекта оно не влияет (имя кладут в набор
 * первым по происхождению, а не по месту), а производные запросы из подсказок
 * в офлайн-план просто не попадают. Это единственный ответ на вопрос «какой
 * из запросов — само ФИО и с каким назначением» для всех, кто читает
 * `dp_search_queries`: там лежит только текст, и без плана назначение
 * пришлось бы угадывать по строке — так таблица ТОП-20 подписывалась
 * запросом «…инн».
 */
export function offlineOrionQueryPlan(
  subject: OfflinePlanSubject,
  regions?: OrionRegionCode[]
): OrionQuerySpec[] {
  const capturedAt = new Date(0).toISOString();
  const querySubject = {
    fullName: subject.fullName,
    aliases: subject.aliases,
    targetRegions: subject.targetRegions,
    location: subject.location,
  };
  const plannedRegions =
    regions ??
    buildOrionQueryPlanDetailed(querySubject, { maxPrimaryPerRegion: 1, includeRiskProbes: false }).plan
      .map((q) => q.region)
      .filter((r, i, all) => all.indexOf(r) === i);
  const primaryQueriesByRegion = Object.fromEntries(
    plannedRegions.map((region) => [region, plannedPrimaryQueries(regionQuerySet(subject, region, capturedAt, []))])
  ) as Partial<Record<OrionRegionCode, PlannedPrimaryQuery[]>>;
  return buildOrionQueryPlanDetailed(querySubject, {
    primaryQueriesByRegion,
    maxPrimaryPerRegion: providerConfig.orion.maxPrimaryQueriesPerRegion,
    includeRiskProbes: providerConfig.orion.includeRiskProbes && allowsNegativeQueries(subject),
    regions,
  }).plan;
}

/**
 * Латинское написание имени: готовое из псевдонимов, иначе транслитерация.
 * Псевдоним предпочтительнее — его написал человек, знающий, как субъекта
 * пишут в зарубежных источниках.
 */
function latinNameOf(subject: OfflinePlanSubject): string {
  const alias = (subject.aliases ?? [])
    .map((a: string) => String(a ?? "").trim())
    .find((a: string) => a.length > 0 && !hasCyrillic(a));
  if (alias) return alias;
  return hasCyrillic(subject.fullName)
    ? transliterateRuToEn(subject.fullName)
    : subject.fullName;
}

