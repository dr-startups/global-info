import type { OrionRealCaseContext } from "../orion-section-pipeline/real-case-data-adapter";

const FIXTURE_MARKERS = [
  "ivan petrov",
  "иван петров",
  "example.com",
  "example.ru",
  "video.example.com",
  "qa-r98a-fixture",
  "qa-r98a-fixture-case",
];

export interface RealCaseDataInspection {
  version: "r910-real-case-data-inspection-v1";
  inspectedAt: string;
  caseId: string;
  passed: boolean;
  rejectionReasons: string[];
  subject: {
    fullName: string;
    isFixtureLike: boolean;
  };
  counts: {
    searchResults: number;
    searchSurfaces: number;
    databaseProfiles: number;
    riskFindings: number;
  };
  providers: {
    used: string[];
    unavailable: string[];
  };
  mediaAvailability: {
    images: number;
    videos: number;
    knowledgePanels: number;
  };
  lexisNexis: {
    uploadExists: boolean;
    latestReady: boolean;
    visualPageCount: number;
    parsedSignals: number;
    status: "ready" | "parsed_only" | "uploaded" | "unavailable";
    clientWording: string;
  };
  fixtureEvidenceDetected: boolean;
}

function isFixtureLike(text: string, caseId: string): boolean {
  const lower = `${text} ${caseId}`.toLowerCase();
  return FIXTURE_MARKERS.some((m) => lower.includes(m));
}

export function inspectRealCaseData(caseId: string, ctx: OrionRealCaseContext): RealCaseDataInspection {
  const rejectionReasons: string[] = [];
  const name = ctx.subject.fullName;
  const fixtureLike = isFixtureLike(name, caseId);

  if (fixtureLike) rejectionReasons.push("fixture-subject-or-id");
  if (ctx.searchResults.length === 0) rejectionReasons.push("no-search-results");

  const images = ctx.searchSurfaces.filter((s) => s.type === "IMAGE_RESULT").length;
  const videos = ctx.searchSurfaces.filter((s) => s.type === "VIDEO_RESULT").length;
  const knowledge = ctx.searchSurfaces.filter((s) => s.type === "KNOWLEDGE_BLOCK").length;

  const lexisReady = Boolean(ctx.lexis.latestReady);
  const lexisAny = Boolean(ctx.lexis.latestAny);
  let lexisStatus: RealCaseDataInspection["lexisNexis"]["status"] = "unavailable";
  let lexisWording =
    "Загруженный отчёт LexisNexis для данного прогона недоступен или не был успешно обработан.";
  if (lexisReady && ctx.lexis.visualPageCount > 0) {
    lexisStatus = "ready";
    lexisWording = "Импорт LexisNexis обработан; доступны аналитика и визуальные страницы.";
  } else if (lexisReady) {
    lexisStatus = "parsed_only";
    lexisWording = "Импорт LexisNexis обработан; визуальные страницы ограничены.";
  } else if (lexisAny || ctx.lexis.uploadExists) {
    lexisStatus = "uploaded";
    lexisWording =
      "Документ LexisNexis загружен, но полная клиентская визуализация для этого прогона недоступна.";
  }

  const fixtureUrls = ctx.searchResults.some((r) =>
    /example\.(com|ru)|video\.example\.com/i.test(r.url)
  );
  if (fixtureUrls) rejectionReasons.push("fixture-urls-in-search-results");

  const passed = rejectionReasons.length === 0;

  return {
    version: "r910-real-case-data-inspection-v1",
    inspectedAt: new Date().toISOString(),
    caseId,
    passed,
    rejectionReasons,
    subject: { fullName: name, isFixtureLike: fixtureLike },
    counts: {
      searchResults: ctx.searchResults.length,
      searchSurfaces: ctx.searchSurfaces.length,
      databaseProfiles: ctx.databaseProfiles.length,
      riskFindings: ctx.riskFindings.length,
    },
    providers: ctx.providerAvailability,
    mediaAvailability: { images, videos, knowledgePanels: knowledge },
    lexisNexis: {
      uploadExists: ctx.lexis.uploadExists,
      latestReady: lexisReady,
      visualPageCount: ctx.lexis.visualPageCount,
      parsedSignals: ctx.lexis.parsedSignals,
      status: lexisStatus,
      clientWording: lexisWording,
    },
    fixtureEvidenceDetected: fixtureLike || fixtureUrls,
  };
}
