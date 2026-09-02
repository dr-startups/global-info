/**
 * Полоса адреса сторожится наравне с остальным клиентским текстом.
 *
 * Пока адрес был колонкой, он попадал во все проверки текста вместе со
 * строками таблицы. Переехав в отдельный ряд данных (`rowAddresses`), он мог
 * тихо выпасть из каждой: ревьюер снял поле во всех трёх местах — и весь
 * `npm test` остался зелёным, а приёмочный скрипт таблицу адресов не смотрел
 * вовсе.
 *
 * Здесь закреплены все четыре потребителя. Идентификатор прогона в пути
 * напечатанного адреса — это утечка к клиенту, и она обязана быть слышна.
 */

import { describe, expect, it } from "vitest";
import {
  clientVisibleStrings,
  scanDeckForLeakedIdentifiers,
} from "@/modules/digital-profile/orion-golden/deck-sections/internal-code-scan";
import { validateSectionPack } from "@/modules/digital-profile/orion-golden/deck-sections/section-validation";
import { buildLinkUsageTrace } from "@/modules/digital-profile/orion-golden/deck-sections/link-usage-trace";
import {
  SECTION_PACK_SCHEMA_VERSION,
  SLIDE_CONTENT_SCHEMA_VERSION,
} from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { SectionPackV2 } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { ScopedEvidenceIndex } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { VerifiedFindingBundle } from "@/modules/digital-profile/orion-golden/contracts/verified-finding-bundle";

const HEADERS = ["№", "Заголовок", "Тип источника", "Оценка"];
const ROWS = [["1", "Материал о предпринимателе", "Новостное СМИ", "Нейтральный"]];

/** Адрес, в путь которого уехал идентификатор наблюдения. */
const LEAKY_ADDRESS = "example.org/materials/obs-9f3a71c2/view";
/** Адрес, в путь которого уехало имя технического поля прогона. */
const TOKEN_ADDRESS = "example.org/export/reportRunId/9f3a71c2";

describe("полоса адреса — часть клиентского текста", () => {
  it("сторож внутренних кодов видит её строки", () => {
    const strings = clientVisibleStrings({
      slideKey: "p09_ru_serp_table",
      table: { headers: HEADERS, rows: ROWS, rowAddresses: [LEAKY_ADDRESS] },
    });
    expect(strings).toContain(LEAKY_ADDRESS);
  });

  it("идентификатор прогона в пути адреса — находка, а не тишина", () => {
    const found = scanDeckForLeakedIdentifiers([
      {
        slideKey: "p09_ru_serp_table",
        title: "Россия — Яндекс: собранная выдача",
        table: { headers: HEADERS, rows: ROWS, rowAddresses: [LEAKY_ADDRESS] },
      },
    ]);
    expect(found.map((f) => f.slide)).toEqual(["p09_ru_serp_table"]);
    expect(found[0]!.code).toContain("obs-9f3a71c2");
  });

  it("здоровая дека находок не даёт", () => {
    expect(
      scanDeckForLeakedIdentifiers([
        {
          slideKey: "p09_ru_serp_table",
          title: "Россия — Яндекс: собранная выдача",
          table: {
            headers: HEADERS,
            rows: ROWS,
            rowAddresses: ["audit-it.ru/contragent/fl/773800015809_glinka-sergei"],
          },
        },
      ])
    ).toEqual([]);
  });

  it("маркер находки в буллете находкой не считается", () => {
    expect(
      scanDeckForLeakedIdentifiers([
        {
          slideKey: "p03_summary",
          bullets: ["Найдены публикации о судебных разбирательствах [finding-criminal_legal-abc123]"],
        },
      ])
    ).toEqual([]);
  });

  it("секционная проверка читает полосу вместе с ячейками", () => {
    const report = validateSectionPack({
      pack: packWithAddresses([TOKEN_ADDRESS]),
      expectedCaseId: "c1",
      expectedReportRunId: "r1",
      expectedDatasetId: "d1",
      bundle: BUNDLE,
      knownEvidenceRefs: new Set<string>(),
    });
    expect(report.issues.join(" | ")).toContain("internal token in table cell");
  });

  it("след ссылок видит материал, названный только полосой", () => {
    const trace = buildLinkUsageTrace({
      evidenceIndex: {
        "inventory:s0": {
          url: "https://kompromat1.online/articles/364300-partner",
          domain: "kompromat1.online",
          readVerdictTone: "adverse",
        },
      } as unknown as ScopedEvidenceIndex,
      slides: [
        {
          slideKey: "p09_ru_serp_table",
          title: "Россия — Яндекс: собранная выдача",
          evidenceRefs: ["inventory:s0"],
          table: {
            rows: [["1", "Заголовок без адреса", "Новостное СМИ", "Нейтральный"]],
            rowAddresses: ["kompromat1.online/articles/364300-partner"],
          },
        },
      ],
    });
    expect(trace.rows[0]!.usage).toBe("без цитаты");
    expect(trace.rows[0]!.slides).toEqual(["p09_ru_serp_table"]);
  });
});

const BUNDLE = {
  schemaVersion: "verified-finding-bundle-v1",
  caseId: "c1",
  datasetId: "d1",
  reportRunId: "r1",
  findings: [],
  excludedFindingIds: [],
} as unknown as VerifiedFindingBundle;

function packWithAddresses(addresses: string[]): SectionPackV2 {
  return {
    schemaVersion: SECTION_PACK_SCHEMA_VERSION,
    sectionId: "RU_PROFILE",
    sectionType: "RU_PROFILE",
    fragmentKey: "RU_SERP",
    caseId: "c1",
    datasetId: "d1",
    reportRunId: "r1",
    sourceDatasetId: "d1",
    contentVersion: "deck-sections-test",
    promptVersion: "deterministic",
    contentHash: "sha256:x",
    inputHash: "h1",
    generatedAt: "2026-08-25T00:00:00.000Z",
    required: true,
    status: "READY",
    sourceFindingIds: [],
    evidenceRefs: [],
    inputs: { findingIds: [], evidenceRefs: [], metricSnapshotId: "m1" },
    slides: [
      {
        schemaVersion: SLIDE_CONTENT_SCHEMA_VERSION,
        slideId: "p09_ru_serp_table",
        baseSlotId: "p09_ru_serp_table",
        sectionId: "RU_PROFILE",
        templateId: "serp-table",
        title: "Россия — Яндекс: собранная выдача",
        isContinuation: false,
        continuationOf: null,
        continuationIndex: null,
        content: { table: { headers: HEADERS, rows: ROWS, rowAddresses: addresses } },
        evidenceRefs: [],
        findingIds: [],
        metrics: {},
        visualAssetRefs: [],
      },
    ],
    metrics: { datasetCount: 1, displayedCount: 1, adverseDatasetCount: 0, adverseDisplayedCount: 0 },
    provenance: { providers: [], reportRunIds: ["r1"], evidenceRefs: [] },
    validation: { passed: true, issues: [] },
  } as unknown as SectionPackV2;
}
