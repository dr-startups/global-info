/**
 * Транспорт «вопрос не задавали» от состояния обогащения до provenance.
 *
 * Хелпер, считающий ячейки, закреплён отдельно; здесь закрепляются два звена,
 * без любого из которых ячейки молча не доезжают до деки, а страница снова
 * печатает «Ответы ИИ-поиска … проверены: материалов нет» при полностью
 * зелёном контуре: врезка чтения состояния в подготовке отчёта и фильтр
 * статусов, записывающий ячейку в `nonOkCoverageCells`.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAnalyticsCompositeDataset } from "@/modules/digital-profile/orion-golden/analytics/composite-dataset-builder";
import { runCanonicalReportPrepare } from "@/modules/digital-profile/services/canonical-report-prepare";
import { tinyPrepareInput } from "../fixtures/tiny-canonical-prepare";

/** Состояние прогона 76: трое отработали, двое выключены составом. */
const RUN76_STATE = {
  version: "arsenkin-enrichment-state-v1",
  enrichmentComplete: true,
  agents: [
    {
      agentName: "ARSENKIN_SEARCH_TOP_REAL",
      enrichmentRunId: "orion-arsenkin-agent-search-top-1",
      terminalKind: "SUCCESS",
      doneTaskCount: 2,
      observationCount: 200,
    },
    {
      agentName: "ARSENKIN_AI_SEARCH_REAL",
      enrichmentRunId: null,
      terminalKind: "DISABLED",
      doneTaskCount: 0,
      observationCount: 0,
    },
    {
      agentName: "ARSENKIN_URL_AUDIT_REAL",
      enrichmentRunId: null,
      terminalKind: "DISABLED",
      doneTaskCount: 0,
      observationCount: 0,
    },
  ],
};

const AI_CELL = {
  region: "RU",
  engine: "YANDEX",
  surface: "ai_answers",
  status: "NOT_COLLECTED",
  provider: "arsenkin",
  errorCode: "DISABLED_BY_TOOLS",
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

type Provenance = {
  nonOkCoverageCells: Array<{ surface: string; status: string; errorCode?: string | null }>;
};

/** Полная подготовка отчёта на крошечном корпусе; состояние — по желанию. */
async function preparedArtifacts(state: unknown): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "disabled-surfaces-"));
  if (state) {
    writeFileSync(join(root, "arsenkin-enrichment-state.json"), JSON.stringify(state), "utf8");
  }
  const res = await runCanonicalReportPrepare(await tinyPrepareInput(root));
  expect(res.ok).toBe(true);
  return join(root, "analytics");
}

describe("ячейки не заданных вопросов доезжают до деки", () => {
  it("сборщик композита записывает NOT_COLLECTED в provenance", () => {
    const built = buildAnalyticsCompositeDataset({
      caseId: "case-1",
      baseItems: [],
      enrichmentItems: [],
      binding: null,
      baseReportRunId: "base-1",
      coverageRows: [
        { region: "RU", engine: "YANDEX", surface: "organic", status: "OK" },
        AI_CELL,
      ],
    });
    expect(built.provenance.nonOkCoverageCells).toEqual([AI_CELL]);
  });

  it("подготовка отчёта берёт их из состояния обогащения", async () => {
    const analyticsDir = await preparedArtifacts(RUN76_STATE);
    const provenance = readJson<Provenance>(join(analyticsDir, "composite-serp-provenance.json"));
    const notCollected = provenance.nonOkCoverageCells.filter((c) => c.status === "NOT_COLLECTED");
    expect(notCollected.map((c) => c.surface).sort()).toEqual([
      "ai_answers",
      "ai_answers",
      "ai_answers",
      "url_audit",
    ]);
    expect(notCollected.every((c) => c.errorCode === "DISABLED_BY_TOOLS")).toBe(true);
  });

  it("без файла состояния ячеек не появляется", async () => {
    const analyticsDir = await preparedArtifacts(null);
    const provenance = readJson<Provenance>(join(analyticsDir, "composite-serp-provenance.json"));
    expect(provenance.nonOkCoverageCells.filter((c) => c.status === "NOT_COLLECTED")).toEqual([]);
  });
});

describe("ограничения покрытия в резюме не повторяются", () => {
  it("одна поверхность одного региона даёт одну запись, а фраза печатается один раз", async () => {
    const analyticsDir = await preparedArtifacts(RUN76_STATE);

    const executiveInput = readJson<{ dataGaps: Array<{ area: string; detail: string }> }>(
      join(analyticsDir, "executive-summary-input.json")
    );
    const areas = executiveInput.dataGaps.map((g) => g.area);
    expect(areas).toEqual([...new Set(areas)]);
    expect(areas.filter((a) => a === "ответы ИИ-поиска (RU)")).toHaveLength(1);

    const pack = readJson<{ scope: { coverageLimitations: string[] } }>(
      join(analyticsDir, "client-summary-pack.json")
    );
    const limits = pack.scope.coverageLimitations;
    expect(limits).toEqual([...new Set(limits)]);

    // Считаем по полю «Область», а не по всему JSON: `fullText` собирается из
    // тех же разделов, и каждая фраза законно встречается в нём второй раз.
    const composed = readJson<{ sections: { scope: string } }>(
      join(analyticsDir, "composed-client-summary.json")
    );
    const repeated =
      composed.sections.scope.match(/поверхность не собрана в текущем прогоне/gu) ?? [];
    expect(repeated).toHaveLength(1);
  });
});

describe("покрытие джобы считается одной функцией", () => {
  it("оркестратор зовёт её, а не повторяет формулу у себя", () => {
    // Второй ответ на «сколько поверхностей спрошено и пусто» — ровно та форма
    // дефекта, из-за которой выключенные агенты попадали в «спрошено, пусто».
    const source = readFileSync(
      join(
        process.cwd(),
        "src/modules/digital-profile/services/unified-orion-collection-orchestrator.ts"
      ),
      "utf8"
    );
    expect(source.includes("surfaceCoverageFromEnrichmentState(state)")).toBe(true);
    expect(source.includes('terminalKind === "EMPTY_VALID"')).toBe(false);
  });
});
