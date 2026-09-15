/**
 * Фикстуры лёгкого прогона: строки базового сбора, сводка аудита, состояние
 * ворот персоны и материалы вердикта.
 *
 * Материалы строятся теми же адаптерами, что у подготовки отчёта: вердикт
 * обязан отвечать на «негатив ли это» тем же ответом, и фикстура, собранная
 * руками, проверяла бы не его.
 */

import type { FullAuditResultDTO } from "@/modules/digital-profile/services/agent-run-service";
import { compositeObservationsToInventory } from "@/modules/digital-profile/services/canonical-report-prepare";
import type { CompositeObservation } from "@/modules/digital-profile/services/composite-serp-merge";
import { adaptDatabaseProfileToInventoryItem } from "@/modules/digital-profile/services/compliance-inventory-adapter";
import { adaptWikipediaCheckToInventoryItem } from "@/modules/digital-profile/services/evidence-supplement-adapter";
import type { PersonaGateInput } from "@/modules/digital-profile/services/subject-persona-check";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

export const FIXTURE_BASE_ROWS: CompositeObservation[] = [
  {
    key: "organic|ru|yandex|fio|https://a.ru/1",
    kind: "organic",
    region: "RU",
    engine: "YANDEX",
    query: "fio",
    url: "https://a.ru/1",
    providers: ["yandex"],
    primaryProvider: "yandex",
    evidenceRefs: ["searchResult:sr1"],
    baseSearchResultId: "sr1",
  },
];

/** Сводка аудита, в которой оба поисковика отработали по-настоящему. */
export function realFullAudit(): FullAuditResultDTO {
  return {
    outcome: "SUCCESS",
    runs: [],
    runSummary: [
      { providerId: "yandex", phase: "collection", status: "completed", runtime: "real", agentName: "REAL_YANDEX_SEARCH", reason: "ok" },
      { providerId: "google", phase: "collection", status: "completed", runtime: "real", agentName: "REAL_GOOGLE_SEARCH", reason: "ok" },
      { providerId: "orion_profile", phase: "collection", status: "completed", runtime: "real", agentName: "REAL_ORION_SEARCH_PROFILE", reason: "ok" },
    ],
    runtimeStrategy: {
      mode: "real_first_with_fallback",
      selectedOrder: [],
      fallbackPolicy: "allow_mock_fallback",
      realProvidersAvailable: 3,
      mockProvidersAvailable: 0,
      fallbackEvents: [],
      warnings: [],
      decisions: [],
    },
  };
}

/**
 * Решение по персоне принято. Подмена — не обход ворот: у сценария нет ни
 * строки `Case`, ни базы, спросить состояние ему не у кого.
 */
export const personaDecided = {
  loadPersonaGateInput: async (): Promise<PersonaGateInput> => ({
    isFixture: false,
    subjectInputHash: "subject-hash",
    decidedHashes: ["subject-hash"],
  }),
};

// ---------------------------------------------------------------------------
// Материалы вердикта
// ---------------------------------------------------------------------------

let seq = 0;

export function observation(
  title: string,
  url: string,
  over: Partial<CompositeObservation> = {}
): CompositeObservation {
  seq += 1;
  return {
    key: `organic|ru|yandex|q${seq}|${url}`,
    kind: "organic",
    region: "RU",
    engine: "YANDEX",
    query: "Иванов Иван Иванович",
    url,
    title,
    snippet: "",
    providers: ["yandex"],
    primaryProvider: "yandex",
    evidenceRefs: [`searchResult:sr-${seq}`],
    ...over,
  };
}

/** Материалы выдачи — тем же переводом, что у подготовки отчёта. */
export function serpItems(...observations: CompositeObservation[]): RawInventoryItem[] {
  return compositeObservationsToInventory({
    caseId: "case-1",
    baseReportRunId: "base-1",
    enrichmentRunId: null,
    observations,
  });
}

export function complianceItem(
  over: Partial<Parameters<typeof adaptDatabaseProfileToInventoryItem>[0]["row"]> = {}
): RawInventoryItem {
  const item = adaptDatabaseProfileToInventoryItem({
    row: {
      id: "db-1",
      provider: "OPENSANCTIONS",
      matchedName: "Иванов Иван Иванович",
      reviewStatus: "PENDING",
      riskTypes: ["SANCTIONS"],
      profileUrl: "https://www.opensanctions.org/entities/Q1/",
      ...over,
    },
    caseId: "case-1",
    reportRunId: "base-1",
  });
  if (!item) throw new Error("адаптер комплаенса не принял строку фикстуры");
  return item;
}

export function wikipediaAbsentItem(): RawInventoryItem {
  return adaptWikipediaCheckToInventoryItem({
    row: {
      id: "wiki-1",
      exists: false,
      url: null,
      language: "ru",
      pageTitle: null,
      lastChecked: new Date("2026-09-15T10:00:00Z"),
    } as Parameters<typeof adaptWikipediaCheckToInventoryItem>[0]["row"],
    caseId: "case-1",
    reportRunId: "base-1",
  });
}

export const NEUTRAL = observation(
  "Иванов Иван Иванович — генеральный директор ООО «Ромашка»",
  "https://romashka.ru/team"
);
export const BUSINESS = observation(
  "Иванов Иван Иванович: предприниматель и инвестор",
  "https://vc.ru/people/ivanov"
);
export const CRIMINAL = observation(
  "Возбуждено уголовное дело против Ивана Иванова",
  "https://lenta.ru/news/2025/03/12/ivanov/"
);
export const COURT_BANKRUPTCY = observation(
  "Арбитражный суд признал Иванова И. И. банкротом",
  "https://kommersant.ru/doc/7000001"
);
export const POLITICS = observation(
  "Депутата Иванова обвинили в коррупции",
  "https://ria.ru/20250312/ivanov.html"
);
export const UNTHEMED_ADVERSE = observation(
  "Скандал вокруг Иванова",
  "https://ria.ru/20250313/skandal.html"
);

/** Все провайдеры базового сбора ответили. */
export const ALL_ANSWERED = [
  "yandex",
  "google",
  "orion_profile",
  "surfaces",
  "orion_google_surfaces",
  "wikipedia",
].map((providerId) => ({ providerId, status: "completed" }));

export const SCREENED = [{ provider: "OPENSANCTIONS", status: "SUCCESS" }];
