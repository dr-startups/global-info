/**
 * Контракты второй версии и замороженный артефакт первой.
 *
 * Сюжет — не претензия: у него нет ни канонической темы из словаря, ни степени
 * существенности (степень — понятие мира претензий, и выдумывать её сюжету
 * нельзя). Поэтому контракты пакета и составленного резюме перешли на v2, и
 * первое, что обязано быть верным, — новая схема разбирает собственный выход
 * конвейера.
 *
 * Второе: замороженные прогоны с артефактом v1 продолжают собираться. Дека
 * читает `composed-client-summary.json` как есть, без схемной проверки, и
 * эталон 72 живёт именно так.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClientSummaryPack } from "@/modules/digital-profile/orion-golden/analytics/client-summary-pack-builder";
import { composeClientSummary } from "@/modules/digital-profile/orion-golden/analytics/client-summary-composer";
import { validateStage1Contract } from "@/modules/digital-profile/orion-golden/contracts";
import { loadDeckInputsFromAnalyticsDir } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import {
  buildExecutiveSummaryFromComposed,
  fragmentScope,
} from "@/modules/digital-profile/orion-golden/deck-sections";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { CanonicalClaimsBundle } from "@/modules/digital-profile/orion-golden/contracts/canonical-claim";
import type { ComposedClientSummary } from "@/modules/digital-profile/orion-golden/contracts/composed-client-summary";
import type { LinkVerdict } from "@/modules/digital-profile/orion-golden/contracts/link-verdict";
import type { RepresentativeEvidenceSelection } from "@/modules/digital-profile/orion-golden/contracts/representative-evidence";

const NO_CLAIMS = { claims: [] } as unknown as CanonicalClaimsBundle;
const NO_SELECTION = {
  materialThemeIds: [],
  selectedByTheme: {},
  isolatedSignificantItems: [],
  p1p2Account: [],
} as unknown as RepresentativeEvidenceSelection;

const VERDICT = {
  schemaVersion: "link-verdict-v1",
  evidenceRef: "inventory:obs-01",
  url: "https://affarsposten.se/probe",
  domain: "affarsposten.se",
  rank: 1,
  subjectMatch: "subject",
  tone: "adverse",
  theme: "Уголовное дело о налоговом мошенничестве в Стокгольме",
  quotes: [
    {
      text: "Anders Holmström, founder of Nordkap Capital, faces tax-fraud probe in Stockholm",
    },
  ],
  readAt: "2026-08-17T12:00:00.000Z",
} as LinkVerdict;

const SCOPED = {
  subject: { displayName: "Anders Holmström", aliases: [] },
  findings: [],
  surfaceUnits: [],
  metricSnapshot: {
    metricSnapshotId: "m",
    datasetId: "d",
    reportRunId: "r",
    baseCount: 20,
    enrichmentCount: 0,
    compositeCount: 20,
    subjectMatchCount: 12,
    likelySubjectCount: 1,
    ambiguousCount: 0,
    otherSubjectCount: 1,
    adverseFindingCount: 4,
    perRegionCounts: { RU: 10, UAE: 10 },
  },
  scope: fragmentScope("EXECUTIVE_SUMMARY"),
  evidenceIndex: {},
} as unknown as ScopedFragmentInput;

/** Составленное резюме прошлого поколения: тема словаря, степень, без вида блока. */
const FROZEN_V1 = {
  schemaVersion: "composed-client-summary-v1",
  caseId: "case-72",
  datasetId: "ds-72",
  sourceHashes: ["sha256:frozen"],
  evidenceRefs: ["inventory:obs-frozen"],
  subjectId: "Глинка Сергей",
  fullText: "Итоговая оценка: высокий риск.",
  sections: {
    scope: "Исследованы результаты поиска (ТОП-20) по регионам RU, UAE.",
    overallAssessment: "Итоговая оценка: высокий риск.",
    auditShortHeading: "Коротко по итогам аудита",
    themes: [
      {
        themeId: "criminal_judicial",
        heading: "Криминальные и судебные материалы",
        body: "Найдены конкретные материалы в открытых источниках.",
        materialityLevel: "HIGH",
        evidenceRefs: ["inventory:obs-frozen"],
        articleTitles: ["Материал о судебном споре"],
        articleDomains: ["audit-it.ru"],
      },
    ],
    isolatedItems: "",
    internationalDatabases: "",
    changesSinceBaseline: "",
    nextSteps: "Следующие проверки. 1) Сверить первоисточники.",
  },
  continuationThemeIds: [],
  gates: {
    SUMMARY_MATERIAL_THEME_COVERAGE: 100,
    SUMMARY_CONCRETE_EXAMPLES_PRESENT: true,
    SUMMARY_UNSUPPORTED_ASSERTIONS: 0,
    SUMMARY_TECHNICAL_COPY_TOKENS: 0,
    SUMMARY_INCOMPLETE_SENTENCES: 0,
  },
};

/** Каталог аналитики: только то, что читает загрузчик входов деки. */
function analyticsDirWithComposedV1(): string {
  const dir = mkdtempSync(join(tmpdir(), "composed-v1-"));
  const write = (name: string, value: unknown): void => {
    writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };
  write("verified-finding-bundle.json", { findings: [] });
  write("ambiguous-findings.json", []);
  write("surface-analysis.json", {});
  write("executive-summary.json", {});
  write("report-data-binding.json", {
    baseReportRunId: "run-72",
    datasetId: "ds-72",
    caseId: "case-72",
  });
  write("provider-delta.json", { baseCount: 1, arsenkinObservationCount: 0 });
  write("composite-serp-observations.json", { observations: [], baseCount: 0, compositeCount: 0 });
  write("subject-resolution.json", { items: [] });
  write("composed-client-summary.json", FROZEN_V1);
  return dir;
}

describe("контракты резюме", () => {
  it("v2-схемы разбирают собственный выход конвейера", () => {
    const pack = buildClientSummaryPack({
      caseId: "case-contracts",
      datasetId: "ds-contracts",
      subjectId: "Anders Holmström",
      sourceHashes: ["sha256:test"],
      claimsBundle: NO_CLAIMS,
      representative: NO_SELECTION,
      overallVerdict: "HIGH",
      linkVerdicts: {
        themes: [
          {
            theme: "Уголовное дело о налоговом мошенничестве в Стокгольме",
            count: 1,
            adverseCount: 1,
            evidenceRefs: ["inventory:obs-01"],
            examples: [],
          },
        ],
        verdicts: [VERDICT],
      },
    });
    expect(pack.schemaVersion).toBe("client-summary-pack-v2");
    expect(validateStage1Contract("ClientSummaryPack", pack).success).toBe(true);

    const composed = composeClientSummary({ pack });
    expect(composed.schemaVersion).toBe("composed-client-summary-v2");
    expect(validateStage1Contract("ComposedClientSummary", composed).success).toBe(true);
  });

  it("замороженный артефакт v1 по-прежнему собирает резюме", () => {
    const inputs = loadDeckInputsFromAnalyticsDir(analyticsDirWithComposedV1());
    const composed = inputs.composedClientSummary as unknown as ComposedClientSummary;
    expect(composed.schemaVersion).toBe("composed-client-summary-v1");
    const out = buildExecutiveSummaryFromComposed(
      "EXECUTIVE" as never,
      SCOPED,
      { composedClientSummary: composed } as never,
      composed
    );
    expect(out.status).toBe("READY");
    const bullets = out.slides.flatMap((s) => s.content.bullets ?? []);
    expect(bullets.some((b) => b.startsWith("Криминальные и судебные материалы."))).toBe(true);
  });
});
