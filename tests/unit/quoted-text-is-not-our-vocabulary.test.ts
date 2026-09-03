/**
 * Цитируемый чужой текст не судится словарём наших внутренних слов.
 *
 * Живой прогон 03.09.2026 (кейс DPA-2026-0050): сборка деки упала на страницах
 * AI-ответов — сторож внутренних кодов нашёл в буллете «внутренний токен».
 * Токеном оказалось слово «Audit» из названия сайта Audit-it, которое Google
 * цитирует в своём ответе о регистрации ИП. Шаблон `\baudit\b` стоял в списке
 * потому, что «audit» — наше внутреннее слово (audit summary, audit run); но
 * оно же — обычное английское слово и часть чужого названия, и в цитируемом
 * тексте ему быть можно. То же — «pipeline» (газопровод) и «arsenkin»
 * (фамилия). Любой субъект, чьи источники их упоминают, клал сборку.
 *
 * Правило: **машинные идентификаторы** (`reportRunId`, `datasetId`,
 * `serp_obs`, …) не могут появиться ни в каком клиентском тексте, включая
 * цитаты. **Слова нашего словаря** проверяются только в тексте, который
 * пишем мы (заголовки, абзацы, объяснения, текст модели). Буллеты и ячейки
 * таблиц несут материал источников — их судят по первому списку.
 */

import { describe, expect, it } from "vitest";
import {
  evaluateClientText,
  matchInternalClientToken,
} from "@/modules/digital-profile/orion-golden/client/load-client-text-contract";
import { validateSectionPack } from "@/modules/digital-profile/orion-golden/deck-sections/section-validation";
import {
  SECTION_PACK_SCHEMA_VERSION,
  SLIDE_CONTENT_SCHEMA_VERSION,
} from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { SectionPackV2 } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { VerifiedFindingBundle } from "@/modules/digital-profile/orion-golden/contracts/verified-finding-bundle";

/** Дословные фрагменты ответов Google из живого прогона 03.09.2026. */
const QUOTED_RU =
  "Ответ поискового ИИ Google, зафиксированный в выдаче. Запрос: «кремлев умар назарович ип». " +
  "Является учредителем 28 организаций. Регионом ... • Audit-it. Кремлёв Умар Назарович (ИНН 504308697890).";
const QUOTED_EN =
  "According to Russian corporate registries (such as Audit-It), he is listed as a founder or head of several entities.";

describe("словарь наших слов и машинные идентификаторы", () => {
  it("«Audit-it» в цитате — не внутренний токен", () => {
    expect(matchInternalClientToken(QUOTED_RU, undefined, { quoted: true })).toBe(false);
    expect(matchInternalClientToken(QUOTED_EN, undefined, { quoted: true })).toBe(false);
  });

  it("«audit» в нашем тексте — по-прежнему находка", () => {
    expect(matchInternalClientToken("Audit summary for the subject", undefined, { quoted: false })).toBe(true);
    expect(matchInternalClientToken("Audit summary for the subject")).toBe(true);
  });

  it("машинный идентификатор в цитате — находка всегда", () => {
    for (const token of ["reportRunId", "datasetId", "serp_obs", "inventoryId", "schemaVersion", "report_run"]) {
      expect(matchInternalClientToken(`Источник пишет: ${token}=42`, undefined, { quoted: true })).toBe(true);
    }
  });

  it("вердикт по тексту принимает тот же признак", () => {
    expect(evaluateClientText(QUOTED_EN, { quoted: true }).ok).toBe(true);
    expect(evaluateClientText(QUOTED_EN).ok).toBe(false);
    expect(evaluateClientText("см. datasetId", { quoted: true }).ok).toBe(false);
  });
});

describe("секционная проверка", () => {
  const bundle = {
    schemaVersion: "verified-finding-bundle-v1",
    caseId: "c1",
    datasetId: "d1",
    reportRunId: "r1",
    findings: [],
    excludedFindingIds: [],
  } as unknown as VerifiedFindingBundle;

  function pack(bullets: string[], rows: string[][] = [], title = "Россия — ИИ-ответы поисковых систем"): SectionPackV2 {
    return {
      schemaVersion: SECTION_PACK_SCHEMA_VERSION,
      sectionId: "RU_PROFILE",
      sectionType: "RU_PROFILE",
      fragmentKey: "RU_KNOWLEDGE_AI",
      caseId: "c1",
      datasetId: "d1",
      reportRunId: "r1",
      sourceDatasetId: "d1",
      contentVersion: "deck-sections-test",
      promptVersion: "deterministic",
      contentHash: "sha256:x",
      inputHash: "h1",
      generatedAt: "2026-09-03T00:00:00.000Z",
      required: true,
      status: "READY",
      sourceFindingIds: [],
      evidenceRefs: [],
      inputs: { findingIds: [], evidenceRefs: [], metricSnapshotId: "m1" },
      slides: [
        {
          schemaVersion: SLIDE_CONTENT_SCHEMA_VERSION,
          slideId: "p19_ru_knowledge_2",
          baseSlotId: "p19_ru_knowledge_2",
          sectionId: "RU_PROFILE",
          templateId: "ai-overview",
          title,
          isContinuation: false,
          continuationOf: null,
          continuationIndex: null,
          content: {
            narrative: "Что отвечает поисковый ИИ о субъекте.",
            bullets,
            ...(rows.length ? { table: { headers: ["№", "Ссылка"], rows } } : {}),
          },
          evidenceRefs: [],
          findingIds: [],
          metrics: {},
          visualAssetRefs: [],
        },
      ],
      metrics: { datasetCount: 0, displayedCount: 0, adverseDatasetCount: 0, adverseDisplayedCount: 0 },
      provenance: { providers: [], reportRunIds: ["r1"], evidenceRefs: [] },
      validation: { passed: true, issues: [] },
    } as unknown as SectionPackV2;
  }

  const run = (p: SectionPackV2) =>
    validateSectionPack({
      pack: p,
      expectedCaseId: "c1",
      expectedReportRunId: "r1",
      expectedDatasetId: "d1",
      bundle,
      knownEvidenceRefs: new Set<string>(),
    });
  const tokenIssues = (p: SectionPackV2) => run(p).issues.filter((i) => /internal token/.test(i));

  it("буллет с цитатой про Audit-it проходит", () => {
    expect(tokenIssues(pack([QUOTED_RU, QUOTED_EN]))).toEqual([]);
  });

  it("буллет с машинным идентификатором — находка", () => {
    expect(tokenIssues(pack(["Ответ поискового ИИ: см. datasetId d1."])).join(" | ")).toContain(
      "internal token in bullet"
    );
  });

  it("ячейка таблицы с «Audit-it» проходит, с идентификатором — нет", () => {
    expect(tokenIssues(pack([], [["1", "Audit-it: Кремлёв Умар Назарович"]]))).toEqual([]);
    expect(tokenIssues(pack([], [["1", "reportRunId r1"]])).join(" | ")).toContain("internal token in table cell");
  });

  it("заголовок с нашим словом — находка, как и прежде", () => {
    expect(tokenIssues(pack([], [], "Audit of the subject")).join(" | ")).toContain("internal token in title");
  });
});
