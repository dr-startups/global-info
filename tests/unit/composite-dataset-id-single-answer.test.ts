/**
 * У составного набора один идентификатор, и чеканится он один раз.
 *
 * Ответов было два: слияние выдавало `composite-<unifiedJobId>` и клало его в
 * привязку джобы, а построитель композита в аналитике чеканил свой —
 * `composite-<caseId>-<хэш ключей>` — и уводил его во все артефакты аналитики и
 * деки. Формы совпасть не могли, поэтому реюз собранной деки отбивался всегда,
 * и «повторный рендер» платил за полную пересборку с обоими проходами GPT.
 *
 * Здесь закреплено, что чеканка одна (слияние), а аналитика идентификатор
 * получает и наследует. Содержательный отпечаток набора при этом никуда не
 * делся: он живёт отдельным полем `sourceHashes` — это данные, а не
 * идентичность.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCanonicalReportPrepare } from "@/modules/digital-profile/services/canonical-report-prepare";
import { buildAnalyticsCompositeDataset } from "@/modules/digital-profile/orion-golden/analytics/composite-dataset-builder";
import {
  TINY_JOB_ID,
  tinyInventory,
  tinyPrepareInput,
} from "../fixtures/tiny-canonical-prepare";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

describe("идентификатор набора наследуется от слияния до деки", () => {
  let root = "";
  let expectedId = "";

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "dataset-id-inherited-"));
    const input = await tinyPrepareInput(root);
    expectedId = input.binding.compositeDatasetId;
    const res = await runCanonicalReportPrepare(input);
    expect(res.ok).toBe(true);
  });

  it("чеканка слияния — форма джобы", () => {
    expect(expectedId).toBe(`composite-${TINY_JOB_ID}`);
  });

  it("привязка артефактов аналитики несёт тот же идентификатор", () => {
    const binding = readJson<{ datasetId: string }>(
      join(root, "analytics", "report-data-binding.json")
    );
    expect(binding.datasetId).toBe(expectedId);
  });

  it("собранная дека несёт тот же идентификатор", () => {
    const deck = readJson<{ datasetId: string; sourceDatasetId: string }>(
      join(root, "deck", "assembled-deck.json")
    );
    expect(deck.datasetId).toBe(expectedId);
    expect(deck.sourceDatasetId).toBe(expectedId);
  });

  it("сводка подготовки называет идентификатор ровно один раз", () => {
    const summary = readJson<Record<string, unknown>>(
      join(root, "canonical-prepare-summary.json")
    );
    expect(summary.prepareDatasetId).toBe(expectedId);
    // Поле `analyticsDatasetId` жило рядом и обязано было совпадать с
    // `prepareDatasetId`. Два поля, обязанные быть равными, — это два ответа на
    // один вопрос: пока формы расходились, сводка молча показывала оба.
    expect(Object.keys(summary)).not.toContain("analyticsDatasetId");
  });
});

describe("построитель композита идентификатор не чеканит", () => {
  const build = (datasetId: string, items = tinyInventory()) =>
    buildAnalyticsCompositeDataset({
      caseId: "case-dataset-id",
      datasetId,
      baseItems: items,
      enrichmentItems: [],
      binding: null,
      coverageRows: [],
      baseReportRunId: "run-base",
    });

  it("возвращает переданный идентификатор", () => {
    const built = build("composite-unified-passed-in");
    expect(built.dataset.datasetId).toBe("composite-unified-passed-in");
    expect(built.provenance.datasetId).toBe("composite-unified-passed-in");
  });

  it("отпечаток набора зависит от состава, а не от идентификатора", () => {
    const a = build("composite-unified-a");
    const b = build("composite-unified-b");
    expect(b.dataset.sourceHashes).toEqual(a.dataset.sourceHashes);

    const shorter = build("composite-unified-a", tinyInventory().slice(0, 1));
    expect(shorter.dataset.sourceHashes).not.toEqual(a.dataset.sourceHashes);
  });
});

describe("сквозной сверки «аналитика \u2261 привязка» на путях чтения с диска нет", () => {
  it("резюме gpt-copy на каталоге старой формы завершается", async () => {
    /*
     * Страж от лишней строгости. Каталоги прогонов, собранных до сведения форм,
     * законно несут другой идентификатор, чем привязка джобы: он внутренне
     * согласован — аналитика, паки и дека там одной формы. Сквозной assert
     * «id аналитики равен id привязки» сломал бы им и резюме gpt-copy, и
     * пересборку; лишняя строгость здесь страшнее недостаточной.
     *
     * Каталог засевается именно старой формой, а не подменяется привязкой
     * задним числом: проверяется чтение с диска, а читают там артефакты.
     */
    const root = mkdtempSync(join(tmpdir(), "dataset-id-legacy-dir-"));
    const legacyId = "composite-cmreamy2t0002o30f29urzcog-59139ee6683b";
    const seedInput = await tinyPrepareInput(root);
    const seeded = await runCanonicalReportPrepare({
      ...seedInput,
      binding: { ...seedInput.binding, compositeDatasetId: legacyId },
      merge: { ...seedInput.merge, compositeDatasetId: legacyId },
    });
    expect(seeded.ok).toBe(true);
    expect(
      readJson<{ datasetId: string }>(join(root, "analytics", "report-data-binding.json")).datasetId
    ).toBe(legacyId);

    // Привязка джобы — нынешней формы, каталог — старой: ровно застрявший прогон.
    const res = await runCanonicalReportPrepare(
      await tinyPrepareInput(root, { resumeFrom: "gpt-copy", gptCaller: async () => ({}) })
    );

    expect(res.ok).toBe(true);
    expect(res.prepareDatasetId).toBe(`composite-${TINY_JOB_ID}`);
    // Каталог остался при своём: и привязка аналитики, и пересобранная дека
    // несут форму каталога, а не форму привязки джобы.
    expect(
      readJson<{ datasetId: string }>(join(root, "analytics", "report-data-binding.json")).datasetId
    ).toBe(legacyId);
    expect(
      readJson<{ datasetId: string }>(join(root, "deck", "assembled-deck.json")).datasetId
    ).toBe(legacyId);
  });
});
