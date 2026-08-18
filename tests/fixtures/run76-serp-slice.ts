/**
 * Срез выдачи прогона 76 — ОАЭ, Google — и минимальный каталог аналитики.
 *
 * Строки восстановлены по замерам разбора живого прогона 76: серперные позиции
 * 3 (opensanctions.org), 4 (bloomberg.com) и 10 (wikidata.org) по запросу
 * «viktor rashnikov»; арсенкинские позиции 4 (metalinfo.ru), 10 (ko.ru) и
 * весь хвост 11–20 по тому же запросу в нижнем регистре. Позиции, чьи домены
 * разбор не называет, заполнены нейтральными адресами того же вида — важна
 * форма среза (кто чью нумерацию несёт), а не конкретный сайт.
 *
 * Три серперные строки перечислены и в примерах «прочих материалов»: именно
 * этой ингестией у них стирались rank/query, и №3 выдачи исчезал из таблицы.
 *
 * Публичные метаданные выдачи (адрес, заголовок, позиция, запрос) — никакого
 * содержимого страниц и ничего из `/storage/`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SerpObservationRow = {
  observationKey: string;
  provider: string;
  providers: string[];
  engine: string;
  surface: string;
  region: string;
  url?: string;
  title?: string;
  domain?: string;
  rank?: number;
  rankSource?: string;
  query?: string;
  queryPurpose?: string;
  evidenceRefs: string[];
  provenanceOwner: "base" | "enrichment" | "legacy";
};

/** Запрос, по которому построена таблица ОАЭ прогона 76. */
export const UAE_QUERY = "viktor rashnikov";

/** Ссылки на три серперные строки, перезаписанные примерами «прочих материалов». */
export const UAE_UNCATEGORIZED_REFS = [
  "inventory:obs-8e0aa21765b2b67e",
  "inventory:obs-a3efa0d9f3689b44",
  "inventory:obs-c1c6ba53c7d42a45",
];

function row(input: {
  ref: string;
  provider: "serper" | "arsenkin";
  rank: number;
  domain: string;
  path?: string;
  title: string;
  query?: string;
}): SerpObservationRow {
  const query = input.query ?? UAE_QUERY;
  const url = `https://${input.domain}/${input.path ?? "viktor-rashnikov"}`;
  return {
    observationKey: `${query}|GOOGLE|UAE|organic|${input.domain}|${input.provider}`,
    provider: input.provider,
    providers: [input.provider],
    // Обогатитель нумерует ту же выдачу Google — движок у его строк тот же,
    // и по одному только `engine` его позицию от серперной не отличить.
    engine: "GOOGLE",
    surface: "organic",
    region: "UAE",
    url,
    title: input.title,
    domain: input.domain,
    rank: input.rank,
    rankSource: input.provider,
    query,
    queryPurpose: "subject_lookup",
    evidenceRefs: [input.ref],
    provenanceOwner: input.provider === "serper" ? "base" : "enrichment",
  };
}

/** Строки выдачи Serper: настоящие позиции таблицы ОАЭ. */
export function run76SerperRows(): SerpObservationRow[] {
  return [
    row({ ref: "inventory:obs-uae-serper-1", provider: "serper", rank: 1, domain: "mmk.ru", title: "Viktor Rashnikov — MMK" }),
    row({ ref: "inventory:obs-uae-serper-2", provider: "serper", rank: 2, domain: "forbes.com", title: "Viktor Rashnikov profile" }),
    row({ ref: UAE_UNCATEGORIZED_REFS[0]!, provider: "serper", rank: 3, domain: "opensanctions.org", title: "Viktor Filippovich Rashnikov — OpenSanctions" }),
    row({ ref: UAE_UNCATEGORIZED_REFS[1]!, provider: "serper", rank: 4, domain: "bloomberg.com", title: "Viktor Rashnikov — Bloomberg" }),
    row({ ref: "inventory:obs-uae-serper-5", provider: "serper", rank: 5, domain: "reuters.com", title: "Viktor Rashnikov — Reuters" }),
    row({ ref: "inventory:obs-uae-serper-6", provider: "serper", rank: 6, domain: "ft.com", title: "Viktor Rashnikov — FT" }),
    row({ ref: "inventory:obs-uae-serper-7", provider: "serper", rank: 7, domain: "gulfnews.com", title: "Viktor Rashnikov — Gulf News" }),
    row({ ref: "inventory:obs-uae-serper-8", provider: "serper", rank: 8, domain: "thenationalnews.com", title: "Viktor Rashnikov — The National" }),
    row({ ref: "inventory:obs-uae-serper-9", provider: "serper", rank: 9, domain: "arabianbusiness.com", title: "Viktor Rashnikov — Arabian Business" }),
    row({ ref: UAE_UNCATEGORIZED_REFS[2]!, provider: "serper", rank: 10, domain: "wikidata.org", title: "Viktor Rashnikov — Wikidata" }),
  ];
}

/** Строки обогатителя: их нумерация и заполнила половину печатной таблицы. */
export function run76ArsenkinRows(): SerpObservationRow[] {
  const tail = [
    "kommersant.ru",
    "rbc.ru",
    "vedomosti.ru",
    "interfax.ru",
    "tass.ru",
    "lenta.ru",
    "ria.ru",
    "banki.ru",
    "finam.ru",
    "expert.ru",
  ];
  return [
    row({ ref: "inventory:obs-uae-ars-4", provider: "arsenkin", rank: 4, domain: "metalinfo.ru", title: "Виктор Рашников — Metalinfo" }),
    row({ ref: "inventory:obs-uae-ars-10", provider: "arsenkin", rank: 10, domain: "ko.ru", title: "Виктор Рашников — Компания" }),
    ...tail.map((domain, i) =>
      row({
        ref: `inventory:obs-uae-ars-${11 + i}`,
        provider: "arsenkin",
        rank: 11 + i,
        domain,
        title: `Виктор Рашников — ${domain}`,
      })
    ),
  ];
}

export function run76UaeObservations(): SerpObservationRow[] {
  return [...run76SerperRows(), ...run76ArsenkinRows()];
}

/**
 * Минимальный каталог аналитики: ровно те файлы, которые читает загрузчик.
 *
 * Строится руками, а не копированием эталона, чтобы срез отвечал за себя сам:
 * в таблице оказываются те строки, которые здесь перечислены, и никакие другие.
 */
export function writeSerpAnalyticsDir(
  dir: string,
  input: {
    observations: SerpObservationRow[];
    /** Примеры «прочих материалов» по регионам — вторичная ингестия индекса. */
    uncategorizedRefs?: string[];
    region?: string;
  }
): string {
  mkdirSync(dir, { recursive: true });
  const write = (name: string, value: unknown): void => {
    writeFileSync(join(dir, name), JSON.stringify(value, null, 2), "utf8");
  };
  const region = input.region ?? "UAE";
  const refs = input.observations.flatMap((o) => o.evidenceRefs);
  write("verified-finding-bundle.json", {
    schemaVersion: "verified-finding-bundle-v1",
    caseId: "case-run76-slice",
    datasetId: "dataset-run76-slice",
    generatedAt: "2026-08-01T00:00:00.000Z",
    sourceHashes: [],
    evidenceRefs: refs,
    kpiEligibleSubjectMatches: ["SUBJECT_MATCH"],
    findings: [],
    excludedFindingIds: [],
    exclusionReasons: {},
  });
  write("ambiguous-findings.json", []);
  write("surface-analysis.json", {
    [`${region}|GOOGLE|organic`]: {
      schemaVersion: "surface-analysis-v2",
      caseId: "case-run76-slice",
      datasetId: "dataset-run76-slice",
      generatedAt: "2026-08-01T00:00:00.000Z",
      sourceHashes: [],
      evidenceRefs: refs,
      units: [
        {
          surface: "organic",
          region,
          engine: "GOOGLE",
          metrics: [],
          claims: [],
          evidenceRefs: refs,
        },
      ],
    },
  });
  write("executive-summary.json", { headline: "срез прогона 76", blocks: [] });
  write("report-data-binding.json", {
    caseId: "case-run76-slice",
    baseReportRunId: "run76-slice-base",
    datasetId: "dataset-run76-slice",
  });
  write("provider-delta.json", { baseCount: input.observations.length, arsenkinObservationCount: 0 });
  write("composite-serp-observations.json", {
    schemaVersion: "composite-dataset-v1",
    caseId: "case-run76-slice",
    datasetId: "dataset-run76-slice",
    generatedAt: "2026-08-01T00:00:00.000Z",
    sourceHashes: [],
    evidenceRefs: refs,
    baseReportRunId: "run76-slice-base",
    enrichmentRunIds: [],
    baseCount: input.observations.length,
    enrichmentCount: 0,
    compositeCount: input.observations.length,
    duplicateCount: 0,
    observations: input.observations,
  });
  write("subject-resolution.json", {
    schemaVersion: "subject-resolution-v1",
    caseId: "case-run76-slice",
    datasetId: "dataset-run76-slice",
    generatedAt: "2026-08-01T00:00:00.000Z",
    sourceHashes: [],
    evidenceRefs: refs,
    items: refs.map((ref) => ({ evidenceRef: ref, decision: "SUBJECT_MATCH", confidence: 0.9 })),
  });
  if (input.uncategorizedRefs && input.uncategorizedRefs.length > 0) {
    const byRef = new Map(input.observations.map((o) => [o.evidenceRefs[0]!, o]));
    write("uncategorized-materials.json", {
      count: input.uncategorizedRefs.length,
      byRegion: {
        [region]: {
          count: input.uncategorizedRefs.length,
          examples: input.uncategorizedRefs.map((ref) => ({
            evidenceRef: ref,
            title: byRef.get(ref)?.title ?? "(без заголовка)",
            domain: byRef.get(ref)?.domain,
          })),
        },
      },
      topExamples: [],
    });
  }
  return dir;
}
