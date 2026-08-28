/**
 * Stage O1–O3 — ORION search profile orchestrator.
 *
 * Runs multi-query organic search (Yandex RU + Google Serper) and collects
 * additional Serper surfaces (suggestions, related, images, videos, knowledge)
 * — all of them read from the responses to the subject and media queries, never
 * requested by surface name (see orion-query-plan.ts).
 * Classifies evidence deterministically (R1.1.3 rules). No LLM, no scraping.
 */

import { Prisma, SearchEngine } from "@prisma/client";
import { prisma } from "@/server/prisma/client";
import { externalGoogleSerpProvider } from "../providers/external-google-serp-provider";
import { providerConfig } from "../providers/config";
import { organicSearchDepth, type OrganicSearchProvider } from "../providers/search-depth";
/**
 * Глубина аудита выдачи. Одно число на весь конвейер: столько же обещает
 * клиенту таблица ТОП-20 (`SERP_TABLE_TOP_N`). Импортировать саму константу
 * деки отсюда нельзя — сервис сбора не должен зависеть от слоя отчёта, — но
 * тест сверяет оба числа между собой.
 */
export const SERP_AUDIT_DEPTH = 20;
import {
  SUBJECT_QUERY_LIMIT,
  buildSubjectQuerySet,
  type SubjectQuerySet,
} from "../search-surfaces/subject-query-set";
import { serperAutocomplete } from "../providers/serper-surfaces";
import { yandexSearchProvider } from "../providers/yandex-search-provider";
import type {
  ProviderRunResult,
  SearchProviderRequest,
  SearchProviderResult,
  SerpDepthAudit,
} from "../providers/types";
import { normalizeUrl } from "./evidence-service";
import { searchResultDedupHash } from "./search-result-identity";
import { createManySearchSurfaceItems } from "./search-surface-service";
import {
  buildOrionQueryPlanDetailed,
  hasCyrillic,
  queriesForRegionPurpose,
  transliterateRuToEn,
  type OrionQuerySpec,
  type OrionRegionCode,
} from "../search-surfaces/orion-query-plan";
import { resolveRuntimeStrategy } from "../agents/runtime-strategy";
import { regionProfile, type RegionCollectionStatus } from "../search-surfaces/region-profiles";
import {
  serperAllSurfacesForQuery,
  type SerperSurfaceItem,
} from "../providers/serper-surfaces";
import {
  classifySearchResultRecord,
  isRiskyResultClass,
} from "../risk-classifier/result-classifier";
import {
  assessIdentityMatch,
  parseSubjectName,
} from "../risk-classifier/entity-disambiguation";
import type { SearchSurfaceInput, SearchSurfaceType } from "../search-surfaces/types";
import { loadCaseSubject, type CaseSubjectInfo } from "../agents/mock/mock-utils";
import type { ProviderRuntimeMode } from "../types";

export interface OrionProfileRunOptions {
  regions?: OrionRegionCode[];
  includeRiskProbes?: boolean;
  maxPrimaryPerRegion?: number;
  /** When set, only run these surface kinds (default: all). */
  surfacesOnly?: boolean;
  /** Skip organic matrix — surfaces collection only. */
  surfacesOnlyMode?: boolean;
  /** Optional runtime selection mode for provider assignment safety. */
  runtimeMode?: ProviderRuntimeMode;
}

export interface OrionRegionRunSummary {
  region: OrionRegionCode;
  collectionStatus: RegionCollectionStatus;
  statusMessage: string;
  queriesRun: number;
  organicRows: number;
  surfaceRows: number;
  googleStatus: string;
  yandexStatus: string;
}

export interface OrionProfileRunResult {
  plan: OrionQuerySpec[];
  queryPlanId: string;
  /**
   * Набор запросов аудита по каждому региональному контуру — что именно
   * спрашивали у поисковика и откуда взялся каждый запрос. Отчёт печатает
   * этот набор клиенту: без него доля и глубина висят без знаменателя.
   */
  querySets: SubjectQuerySet[];
  regions: OrionRegionRunSummary[];
  organicInserted: number;
  surfacesInserted: number;
  warnings: string[];
}

function allowsNegativeQueries(subject: CaseSubjectInfo): boolean {
  const basis = (subject.lawfulBasis ?? "").toUpperCase();
  if (!basis) return false;
  if (basis === "CONSENT") return (subject.consentStatus ?? "").toUpperCase() === "GRANTED";
  return ["LEGITIMATE_INTEREST", "LEGAL_OBLIGATION", "PUBLIC_INTEREST", "CONTRACT"].includes(basis);
}

function googleReady(): boolean {
  return externalGoogleSerpProvider.status().state === "READY";
}

function yandexReady(): boolean {
  return yandexSearchProvider.availability().status === "ENABLED";
}

function surfaceTypeForKind(kind: SerperSurfaceItem["kind"]): SearchSurfaceType {
  switch (kind) {
    case "autocomplete":
      return "SUGGESTION";
    case "relatedQueries":
      return "RELATED_QUERY";
    case "images":
      return "IMAGE_RESULT";
    case "videos":
      return "VIDEO_RESULT";
    case "knowledgePanel":
      return "KNOWLEDGE_BLOCK";
    default:
      return "ORGANIC_RESULT";
  }
}

function classifySurfaceText(
  subjectFullName: string,
  title: string,
  snippet: string,
  url: string | null,
  kind: SerperSurfaceItem["kind"]
) {
  const text = `${title} ${snippet}`.trim();
  const subject = parseSubjectName(subjectFullName);

  if (kind === "knowledgePanel") {
    const identity = assessIdentityMatch(text, subject);
    if (identity === "LOW") {
      return {
        classification: "ENTITY_CONFUSION",
        riskTheme: null as string | null,
        identityConfidence: identity,
      };
    }
  }

  const result = classifySearchResultRecord({
    title,
    snippet,
    url: url ?? "",
    subjectFullName,
  });

  return {
    classification: result.classification,
    riskTheme: result.riskTheme ?? null,
    identityConfidence: result.identityConfidence ?? assessIdentityMatch(text, subject),
  };
}

function serperItemToSurfaceInput(
  item: SerperSurfaceItem,
  subjectFullName: string
): SearchSurfaceInput {
  const cls = classifySurfaceText(
    subjectFullName,
    item.title,
    item.snippet,
    item.url,
    item.kind
  );
  return {
    type: surfaceTypeForKind(item.kind),
    source: "REAL_GOOGLE",
    provider: "GOOGLE",
    query: item.kind === "autocomplete" || item.kind === "relatedQueries" ? item.title : item.query,
    region: item.region,
    language: item.language,
    title: item.title,
    snippet: item.snippet || null,
    url: item.url,
    domain: item.domain,
    imageUrl: item.imageUrl,
    thumbnailUrl: item.thumbnailUrl,
    videoUrl: item.videoUrl,
    rank: item.rank,
    classification: cls.classification,
    riskTheme: cls.riskTheme,
    demo: false,
    rawMetadata: {
      ...item.rawMetadataSafe,
      orionRegion: item.region,
      parentQuery: item.query,
      identityConfidence: cls.identityConfidence,
      providerAdapter: "serper",
    },
  };
}

/**
 * `rawMetadata` строки органической выдачи — собирается в одном месте.
 *
 * Учёт глубины едет сюда потому, что смотреть на него будут по собранному
 * кейсу: внутри адаптера он никому не виден, а по нему отличают «глубже ничего
 * нет» от «провайдер параметр страницы проигнорировал и мы заплатили за дубли».
 */
export function organicRowMetadata(input: {
  engine: SearchEngine;
  orionRegion: OrionRegionCode;
  querySpec: OrionQuerySpec;
  result: SearchProviderResult;
  depthAudit?: SerpDepthAudit;
}): Record<string, unknown> {
  const { engine, orionRegion, querySpec, result, depthAudit } = input;
  return {
    demo: false,
    provider: result.provider,
    query: querySpec.query,
    orionQuery: querySpec.query,
    queryId: querySpec.queryId,
    queryPlanId: querySpec.queryPlanId,
    queryPurpose: querySpec.purpose,
    providerPreference: querySpec.providerPreference,
    identityStrictness: querySpec.identityStrictness,
    orionRegion,
    region: orionRegion,
    // Глубина, которую просили у провайдера по этому запросу: настройка
    // сама по себе её больше не определяет.
    providerLimit:
      organicSearchDepth({
        provider: engine === "GOOGLE" ? "serper" : "yandex",
        purpose: querySpec.purpose,
        auditDepth: SERP_AUDIT_DEPTH,
      }) ??
      (engine === "GOOGLE"
        ? providerConfig.google.resultsPerQuery
        : providerConfig.yandex.resultsPerQuery),
    ...(depthAudit ? { depthAudit } : {}),
    ...(result.rawMetadata as object),
  };
}

/**
 * Пишет строки органической выдачи и уносит в каждую учёт глубины прогона.
 *
 * Экспортируется ради шва «учёт из адаптера → `rawMetadata` строки»: это
 * единственное место, где одно соединяется с другим, и без проверки его можно
 * было убрать, не покраснев ни одним тестом.
 */
export async function persistOrganicResults(
  caseId: string,
  engine: SearchEngine,
  run: ProviderRunResult,
  orionRegion: OrionRegionCode,
  querySpec: OrionQuerySpec
): Promise<number> {
  const source = engine === "GOOGLE" ? "real:GOOGLE" : "real:YANDEX";
  const rows = run.results.map((r) => {
    const normUrl = normalizeUrl(r.url);
    return {
      caseId,
      engine,
      url: r.url,
      normalizedUrl: normUrl,
      // Движок — часть идентичности строки: без него Яндекс, отработав по
      // запросу первым, вычёркивал строки Google того же адреса.
      dedupHash: searchResultDedupHash({
        engine,
        normalizedUrl: normUrl,
        query: querySpec.query,
        region: orionRegion,
      }),
      title: r.title || null,
      snippet: r.snippet || null,
      rank: r.rank,
      source,
      rawMetadata: organicRowMetadata({
        engine,
        orionRegion,
        querySpec,
        result: r,
        depthAudit: run.depthAudit,
      }) as Prisma.InputJsonValue,
    };
  });
  const inserted = await prisma.searchResult.createMany({ data: rows, skipDuplicates: true });
  return inserted.count;
}

async function runRegionOrganic(
  caseId: string,
  subject: CaseSubjectInfo,
  queries: OrionQuerySpec[],
  region: OrionRegionCode,
  runtimeMode?: ProviderRuntimeMode
): Promise<{ organic: number; googleStatus: string; yandexStatus: string }> {
  let organic = 0;
  let googleStatus = "NOT_QUERIED";
  let yandexStatus = "NOT_QUERIED";
  const profile = regionProfile(region);
  const runtime = resolveRuntimeStrategy({ mode: runtimeMode, requestedBy: runtimeMode ? "request" : "default" });
  const allowYandex = runtime.mode !== "mock_only" && runtime.steps.some((s) => s.providerId === "yandex");
  const allowGoogle = runtime.mode !== "mock_only" && runtime.steps.some((s) => s.providerId === "google");
  const organicPurposes = new Set([
    "subject_lookup",
    "adverse_lookup",
    "business_lookup",
    "media_lookup",
  ]);

  for (const spec of queries) {
    if (!organicPurposes.has(spec.purpose)) continue;
    // Глубина заказывается на каждый провайдер отдельно: у одного она стоит
    // денег, у другого нет (`organicSearchDepth`).
    const withDepth = (
      base: SearchProviderRequest,
      provider: OrganicSearchProvider
    ): SearchProviderRequest => {
      const depth = organicSearchDepth({
        provider,
        purpose: spec.purpose,
        auditDepth: SERP_AUDIT_DEPTH,
      });
      return depth === undefined ? base : { ...base, limit: depth };
    };
    const req: SearchProviderRequest = {
      caseId,
      subjectFullName: subject.fullName,
      aliases: subject.aliases ?? [],
      query: spec.query,
      language: spec.language,
      region: profile.googleGl,
    };

    const wantsYandex = spec.providerPreference.includes("yandex");
    if (wantsYandex && allowYandex && profile.yandexSupported && yandexReady()) {
      const run = await yandexSearchProvider.search(withDepth(req, "yandex"));
      if (run.status === "SUCCESS") {
        yandexStatus = "COLLECTED";
        organic += await persistOrganicResults(caseId, "YANDEX", run, region, spec);
      } else if (run.status === "NOT_CONFIGURED" || run.status === "DISABLED") {
        yandexStatus = run.status === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "NOT_SUPPORTED";
      } else if (yandexStatus !== "COLLECTED") {
        yandexStatus = "FAILED";
      }
    } else if (wantsYandex && profile.yandexSupported) {
      yandexStatus = "NOT_CONFIGURED";
    } else {
      yandexStatus = "NOT_SUPPORTED";
    }

    const wantsGoogle = spec.providerPreference.includes("google") || spec.providerPreference.includes("serper");
    if (wantsGoogle && allowGoogle && googleReady()) {
      const run = await externalGoogleSerpProvider.search(
        withDepth({ ...req, region: profile.googleGl, language: profile.googleHl }, "serper")
      );
      if (run.status === "SUCCESS") {
        googleStatus = "COLLECTED";
        organic += await persistOrganicResults(caseId, "GOOGLE", run, region, spec);
      } else if (run.status === "NOT_CONFIGURED" || run.status === "DISABLED") {
        googleStatus = run.status === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "NOT_QUERIED";
      } else if (googleStatus !== "COLLECTED") {
        googleStatus = "FAILED";
      }
    } else if (wantsGoogle) {
      googleStatus = "NOT_CONFIGURED";
    }
  }

  return { organic, googleStatus, yandexStatus };
}

async function runRegionSurfaces(
  caseId: string,
  subject: CaseSubjectInfo,
  region: OrionRegionCode,
  queryRows: OrionQuerySpec[],
  runtimeMode?: ProviderRuntimeMode
): Promise<{ surfaces: SearchSurfaceInput[]; googleStatus: string }> {
  const runtime = resolveRuntimeStrategy({ mode: runtimeMode, requestedBy: runtimeMode ? "request" : "default" });
  const allowSurfaces =
    runtime.mode !== "mock_only" &&
    (runtime.steps.some((s) => s.providerId === "surfaces") ||
      runtime.steps.some((s) => s.providerId === "google"));
  if (!allowSurfaces || !googleReady()) {
    return { surfaces: [], googleStatus: "NOT_CONFIGURED" };
  }

  /*
   * Глубина аудита — не настройка провайдера.
   *
   * Здесь стояло `min(20, resultsPerQuery)`: при умолчании в десять результатов
   * Serper собирал ТОП-10, и обе Google-таблицы отчёта — Россия и ОАЭ —
   * показывали десять строк там, где аудит обещает двадцать. Дыру закрывал
   * Arsenkin со своей нумерацией, и в таблице появлялись чужие позиции.
   *
   * Аудит обещает ТОП-20, значит запрос обязан просить не меньше двадцати:
   * `resultsPerQuery` остаётся способом попросить БОЛЬШЕ, но не меньше.
   */
  const limit = Math.max(SERP_AUDIT_DEPTH, providerConfig.google.resultsPerQuery);
  const all: SearchSurfaceInput[] = [];
  let anySuccess = false;

  // Каждая строка здесь — четыре платных вызова Serper (organic + images +
  // videos + autocomplete). Поверхности читаются из ответов на эти запросы,
  // отдельных «запросов за поверхностью» в плане больше нет (шаг 10).
  const surfacePurposes = new Set(["subject_lookup", "media_lookup"]);
  for (const spec of queryRows) {
    if (!surfacePurposes.has(spec.purpose)) continue;
    if (!spec.providerPreference.includes("serper") && !spec.providerPreference.includes("google")) continue;
    const req: SearchProviderRequest = {
      caseId,
      subjectFullName: subject.fullName,
      aliases: subject.aliases ?? [],
      query: spec.query,
      language: spec.language,
      region: regionProfile(region).googleGl,
      limit,
    };
    const batch = await serperAllSurfacesForQuery(req, region, limit);
    for (const key of ["organic", "images", "videos", "autocomplete"] as const) {
      const result = batch[key];
      if (result.status === "SUCCESS" && result.items.length > 0) {
        anySuccess = true;
        for (const item of result.items) {
          if (item.kind === "organic") continue; // organic stored in search_results
          all.push(serperItemToSurfaceInput(item, subject.fullName));
        }
      }
      // related + knowledge come from organic batch
      if (key === "organic" && result.status === "SUCCESS") {
        for (const item of result.items) {
          if (item.kind === "relatedQueries" || item.kind === "knowledgePanel") {
            all.push(serperItemToSurfaceInput(item, subject.fullName));
          }
        }
      }
    }
  }

  return {
    surfaces: all,
    googleStatus: anySuccess ? "COLLECTED" : googleReady() ? "NOT_QUERIED" : "NOT_CONFIGURED",
  };
}

function deriveCollectionStatus(
  organic: number,
  surfaces: number,
  googleStatus: string,
  yandexStatus: string,
  region: OrionRegionCode
): { status: RegionCollectionStatus; message: string } {
  if (organic + surfaces > 0) {
    return { status: "COLLECTED", message: "Search data collected for this region." };
  }
  const profile = regionProfile(region);
  if (!profile.yandexSupported && googleStatus === "NOT_CONFIGURED") {
    return {
      status: "NOT_CONFIGURED",
      message: "Google/Serper provider not configured — region not queried.",
    };
  }
  if (profile.yandexSupported && yandexStatus === "NOT_CONFIGURED" && googleStatus === "NOT_CONFIGURED") {
    return {
      status: "NOT_CONFIGURED",
      message: "Search providers not configured — region not queried.",
    };
  }
  if (googleStatus === "NOT_SUPPORTED" || (profile.yandexSupported && yandexStatus === "NOT_SUPPORTED")) {
    return { status: "NOT_SUPPORTED", message: "Provider not supported for this region." };
  }
  if (googleStatus === "FAILED" || yandexStatus === "FAILED") {
    return { status: "PARTIAL", message: "Provider errors — no complete data collected." };
  }
  return { status: "NOT_QUERIED", message: "Region not queried in this run." };
}

/**
 * Набор запросов аудита по региону: имя субъекта плюс самые популярные
 * производные от него.
 *
 * Популярность спрашиваем у самого поисковика — одним вызовом автодополнения
 * по имени. Это один платный запрос на контур, и он определяет, что вообще
 * будет предметом аудита: остальные запросы плана (деловой, медийный,
 * негативный) остаются источником тем риска, но метрику и таблицу позиций
 * задаёт этот набор.
 *
 * Отказ автодополнения не ломает прогон: набор достраивается перестановками
 * ФИО, и в артефакте видно, что подсказок не было.
 */
async function buildRegionQuerySet(
  subject: CaseSubjectInfo,
  region: OrionRegionCode,
  capturedAt: string
): Promise<SubjectQuerySet> {
  const profile = regionProfile(region);
  /*
   * В зарубежном контуре субъекта ищут латиницей.
   *
   * Набор строился от кириллического ФИО во всех контурах, и в ОАЭ уходили
   * запросы вида «киркоров филипп бедросович дети». Google с параметрами ОАЭ
   * отвечал на них теми же русскими страницами, что и российский контур:
   * раздел про ОАЭ повторял российский, а то, что о субъекте видно за
   * рубежом, в отчёт не попадало.
   */
  const latinContour = profile.language !== "ru";
  const searchName = latinContour ? latinNameOf(subject) : subject.fullName;
  const variants = (subject.aliases ?? []).filter((a) => !latinContour || !hasCyrillic(a));
  const parsed = parseSubjectName(searchName);
  const suggestions: Array<{ text: string; engine: string; region: string; rank: number }> = [];
  try {
    const run = await serperAutocomplete(
      {
        caseId: subject.caseId ?? "",
        subjectFullName: subject.fullName,
        aliases: subject.aliases ?? [],
        query: searchName,
        language: profile.language,
        region: profile.googleGl,
        limit: SUBJECT_QUERY_LIMIT * 4,
      },
      region
    );
    if (run.status === "SUCCESS") {
      for (const item of run.items) {
        suggestions.push({
          text: String(item.title ?? ""),
          engine: "GOOGLE",
          region,
          rank: item.rank ?? suggestions.length + 1,
        });
      }
    }
  } catch {
    // Подсказки — удобство, а не условие сбора: молча падаем на перестановки.
  }
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
 * Латинское написание имени: готовое из псевдонимов, иначе транслитерация.
 * Псевдоним предпочтительнее — его написал человек, знающий, как субъекта
 * пишут в зарубежных источниках.
 */
function latinNameOf(subject: CaseSubjectInfo): string {
  const alias = (subject.aliases ?? [])
    .map((a) => String(a ?? "").trim())
    .find((a) => a.length > 0 && !hasCyrillic(a));
  if (alias) return alias;
  return hasCyrillic(subject.fullName)
    ? transliterateRuToEn(subject.fullName)
    : subject.fullName;
}

export async function runOrionSearchProfile(
  caseId: string,
  options: OrionProfileRunOptions = {}
): Promise<OrionProfileRunResult> {
  const subject = await loadCaseSubject(caseId);
  // Набор запросов собирается до плана: именно он определяет, выдачу по чему
  // мы аудируем. Дата фиксации общая для всех контуров — это дата прогона.
  const capturedAt = new Date().toISOString();
  const plannedRegions =
    options.regions ??
    (
      buildOrionQueryPlanDetailed(
        {
          fullName: subject.fullName,
          aliases: subject.aliases,
          targetRegions: subject.targetRegions,
          location: subject.location,
        },
        { maxPrimaryPerRegion: 1, includeRiskProbes: false }
      ).plan.map((q) => q.region)
    ).filter((r, i, all) => all.indexOf(r) === i);
  const querySets: SubjectQuerySet[] = [];
  for (const region of plannedRegions) {
    querySets.push(await buildRegionQuerySet(subject, region, capturedAt));
  }
  const primaryQueriesByRegion = Object.fromEntries(
    querySets.map((set) => [set.region, set.queries.map((q) => q.query)])
  ) as Partial<Record<OrionRegionCode, string[]>>;

  const detailedPlan = buildOrionQueryPlanDetailed(
    {
      fullName: subject.fullName,
      aliases: subject.aliases,
      targetRegions: subject.targetRegions,
      location: subject.location,
    },
    {
      primaryQueriesByRegion,
      maxPrimaryPerRegion: options.maxPrimaryPerRegion ?? providerConfig.orion.maxPrimaryQueriesPerRegion,
      includeRiskProbes:
        options.includeRiskProbes ??
        (providerConfig.orion.includeRiskProbes && allowsNegativeQueries(subject)),
      regions: options.regions,
    }
  );
  const plan = detailedPlan.plan;

  const regionsToRun = options.regions ?? [...new Set(plan.map((q) => q.region))];
  const regionSummaries: OrionRegionRunSummary[] = [];
  let organicInserted = 0;
  let surfacesInserted = 0;
  const warnings: string[] = [];

  // Store generated queries scoped to orion agent
  await prisma.searchQuery.deleteMany({
    where: { caseId, source: "GENERATED", createdBy: "REAL_ORION_SEARCH_PROFILE" },
  });
  await prisma.searchQuery.createMany({
    data: plan.map((q) => ({
      caseId,
      engine: q.region === "RU" ? ("YANDEX" as const) : ("GOOGLE" as const),
      queryText: q.query,
      source: "GENERATED" as const,
      createdBy: "REAL_ORION_SEARCH_PROFILE",
    })),
  });

  for (const region of regionsToRun) {
    const regionQueries = plan.filter((q) => q.region === region);
    let organic = 0;
    let googleStatus = "NOT_QUERIED";
    let yandexStatus = "NOT_QUERIED";
    let surfaceInputs: SearchSurfaceInput[] = [];

    if (!options.surfacesOnlyMode) {
      const organicRuntimeRun = await runRegionOrganic(
        caseId,
        subject,
        regionQueries,
        region,
        options.runtimeMode
      );
      organic = organicRuntimeRun.organic;
      googleStatus = organicRuntimeRun.googleStatus;
      yandexStatus = organicRuntimeRun.yandexStatus;
      organicInserted += organic;
    }

    if (!options.surfacesOnly) {
      const surfaceQueries = queriesForRegionPurpose(plan, region, ["subject_lookup", "media_lookup"]);
      const surfaceRun = await runRegionSurfaces(caseId, subject, region, surfaceQueries, options.runtimeMode);
      surfaceInputs = surfaceRun.surfaces;
      if (surfaceRun.googleStatus === "COLLECTED") googleStatus = "COLLECTED";
    }

    if (surfaceInputs.length > 0) {
      const { created } = await createManySearchSurfaceItems(caseId, surfaceInputs, {
        actorId: "real:ORION_SEARCH_PROFILE",
      });
      surfacesInserted += created;
    }

    const derived = deriveCollectionStatus(
      organic,
      surfaceInputs.length,
      googleStatus,
      yandexStatus,
      region
    );

    regionSummaries.push({
      region,
      collectionStatus: derived.status,
      statusMessage: derived.message,
      queriesRun: regionQueries.length,
      organicRows: organic,
      surfaceRows: surfaceInputs.length,
      googleStatus,
      yandexStatus,
    });
  }

  warnings.push(...detailedPlan.warnings);
  return {
    queryPlanId: detailedPlan.queryPlanId,
    querySets,
    plan,
    regions: regionSummaries,
    organicInserted,
    surfacesInserted,
    warnings,
  };
}

/** Count adverse surface items from classification. */
export function isAdverseSurface(classification: string | null | undefined): boolean {
  if (!classification) return false;
  if (classification === "ENTITY_CONFUSION" || classification === "CAPABILITY_NOTE") return false;
  return isRiskyResultClass(classification as Parameters<typeof isRiskyResultClass>[0]);
}
