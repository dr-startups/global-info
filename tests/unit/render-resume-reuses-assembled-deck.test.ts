/**
 * «Возобновить с рендера» стоит один рендер, а не полную пересборку.
 *
 * Замысел пути `resumeFrom: "render"` — переиспользовать собранную деку и
 * заново только отрисовать. Пока идентификатор набора чеканился в двух местах,
 * реюз отбивался всегда, и возобновление проваливалось в блок полной сборки:
 * заново прогонялась аналитика, заново собирались секции и платились обе стадии
 * GPT (`forceGptCopy` внутри этого блока стоит безусловно и остаётся таким).
 *
 * Здесь закреплена цена: 0 сборок, 0 вызовов GPT, ровно один рендер. Проверять
 * только `assemblyCount` нельзя — он остался бы зелёным, если бы GPT позвали
 * мимо сборки; проверять только счётчик GPT нельзя — он зелен и при пропущенном
 * рендере.
 *
 * Фолбэк в полную сборку остаётся законным (дека может быть инвалидирована,
 * бита или от другого набора), но перестаёт быть немым: причина отказа
 * приезжает в предупреждения прогона.
 */

import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCanonicalReportPrepare,
  type CanonicalPrepareResult,
} from "@/modules/digital-profile/services/canonical-report-prepare";
import { warningsSurvivingSuccessfulPrepare } from "@/modules/digital-profile/services/unified-orion-collection-orchestrator";
import {
  ASSEMBLED_DECK_ARTIFACT,
  staleMarkerFileName,
} from "@/modules/digital-profile/services/unified-downstream-invalidation";
import type { GptJsonCaller } from "@/modules/digital-profile/orion-golden/gpt/gpt-case-analysis";
import type { DeckRenderAdapter } from "@/modules/digital-profile/services/render-deck-artifacts";
import {
  CLEAN_TELEMETRY_ENTRY,
  renderAdapterWithTelemetry,
  tinyPrepareInput,
} from "../fixtures/tiny-canonical-prepare";

/** Счётчик обращений к модели: сам ответ негоден, слой GPT падает безопасно. */
function gptSpy(): { caller: GptJsonCaller; calls: () => number } {
  let calls = 0;
  return {
    caller: async () => {
      calls += 1;
      return {};
    },
    calls: () => calls,
  };
}

const deckPath = (root: string) => join(root, "deck", "assembled-deck.json");
const staleMarkerPath = (root: string) =>
  join(root, staleMarkerFileName(ASSEMBLED_DECK_ARTIFACT));

/** Стоп-маркер инвалидации: его пишет дозагрузка наблюдений. */
function writeStaleMarker(root: string): void {
  writeFileSync(
    staleMarkerPath(root),
    JSON.stringify({
      version: "downstream-stale-marker-v1",
      artifact: "assembled-deck.json",
      reason: "arsenkin-ingest-recovery",
      doNotReuse: true,
    }),
    "utf8"
  );
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Прогон, доехавший до готового документа: дека собрана, рендер принят. */
async function seedRenderedRun(root: string): Promise<number> {
  const gpt = gptSpy();
  const { adapter } = renderAdapterWithTelemetry([CLEAN_TELEMETRY_ENTRY]);
  const res = await runCanonicalReportPrepare(
    await tinyPrepareInput(root, { render: adapter, gptCaller: gpt.caller })
  );
  expect(res.ok).toBe(true);
  expect(res.assemblyCount).toBe(1);
  return gpt.calls();
}

async function resumeFromRender(root: string): Promise<{
  res: CanonicalPrepareResult;
  renders: number;
  gptCalls: number;
}> {
  const gpt = gptSpy();
  const render = renderAdapterWithTelemetry([CLEAN_TELEMETRY_ENTRY]);
  const res = await runCanonicalReportPrepare(
    await tinyPrepareInput(root, {
      render: render.adapter,
      gptCaller: gpt.caller,
      resumeFrom: "render",
    })
  );
  return { res, renders: render.calls(), gptCalls: gpt.calls() };
}

describe("возобновление с рендера на целых артефактах", () => {
  it("не собирает деку, не зовёт GPT и рендерит один раз", async () => {
    const root = mkdtempSync(join(tmpdir(), "render-resume-cheap-"));
    const seedGptCalls = await seedRenderedRun(root);
    // Контроль к «0 вызовов GPT»: в полной подготовке модель зовут, иначе
    // ноль на возобновлении не значил бы ничего.
    expect(seedGptCalls).toBeGreaterThan(0);

    const { res, renders, gptCalls } = await resumeFromRender(root);

    expect(res.ok).toBe(true);
    expect(res.assemblyCount).toBe(0);
    expect(res.renderCount).toBe(1);
    expect(renders).toBe(1);
    expect(gptCalls).toBe(0);
    expect(res.qualityWarnings ?? []).not.toContainEqual(
      expect.stringContaining("render-resume-reassembly:")
    );
  });

  it("дека другого набора: пересборка с названной причиной", async () => {
    const root = mkdtempSync(join(tmpdir(), "render-resume-foreign-"));
    await seedRenderedRun(root);
    // Каталог прогона, собранного до сведения форм: дека несёт идентификатор
    // аналитики, привязка джобы — свой.
    const foreign = "composite-case-tiny-prepare-b6b26bb3cb03";
    const deck = readJson<Record<string, unknown>>(deckPath(root));
    writeFileSync(
      deckPath(root),
      JSON.stringify({ ...deck, datasetId: foreign, sourceDatasetId: foreign }),
      "utf8"
    );

    const { res, gptCalls } = await resumeFromRender(root);

    expect(res.ok).toBe(true);
    expect(res.assemblyCount).toBe(1);
    expect(gptCalls).toBeGreaterThan(0);
    const warning = (res.qualityWarnings ?? []).find((w) =>
      w.startsWith("render-resume-reassembly:")
    );
    expect(warning).toBeDefined();
    expect(warning).toContain("dataset-mismatch");
    expect(warning).toContain(foreign);
    expect(warning).toContain("composite-unified-tiny-prepare");
  });

  it("стоп-маркер инвалидации отбивает реюз, а пересборка его снимает", async () => {
    const root = mkdtempSync(join(tmpdir(), "render-resume-stale-"));
    await seedRenderedRun(root);
    writeStaleMarker(root);

    const first = await resumeFromRender(root);
    expect(first.res.assemblyCount).toBe(1);
    expect(first.res.qualityWarnings ?? []).toContain("render-resume-reassembly:stale-marker");

    // Маркер говорил о деке, которой больше нет: пересборка на него и была
    // ответом. Иначе одна дозагрузка наблюдений закрывала бы дешёвый повторный
    // рендер этому прогону навсегда.
    const second = await resumeFromRender(root);
    expect(second.res.assemblyCount).toBe(0);
    expect(second.renders).toBe(1);
    expect(second.gptCalls).toBe(0);
  });

  it("урезанная дека не выдаётся за полный отчёт", async () => {
    /*
     * Сценарий, который проезжал молча: файл деки урезан (прогон умер между
     * записью манифеста и записью деки, файл побит), а манифест по-прежнему
     * обещает 36 слотов. Реюз принимал такую пару и рапортовал полное покрытие
     * — отчёт из одной страницы уезжал как полный.
     */
    const root = mkdtempSync(join(tmpdir(), "render-resume-truncated-"));
    await seedRenderedRun(root);
    const deck = readJson<{ slides: unknown[] }>(deckPath(root));
    expect(deck.slides.length).toBeGreaterThan(1);
    writeFileSync(
      deckPath(root),
      JSON.stringify({ ...deck, slides: deck.slides.slice(0, 1) }),
      "utf8"
    );

    const { res } = await resumeFromRender(root);

    expect(res.assemblyCount).toBe(1);
    expect(res.qualityWarnings ?? []).toContain(
      "render-resume-reassembly:deck-manifest-mismatch"
    );
    expect(res.baseSlotCoverage).toBe(36);
    expect(res.pageCount).toBeGreaterThan(1);
  });

  it("резюме gpt-copy стоп-маркер не снимает", async () => {
    /*
     * Маркер снимает пересборка, которая прочла наблюдения заново. Повтор
     * стадии 2 читает аналитику с диска и новых наблюдений не видел — ответом
     * на маркер он не является, и снимать его ему нечем.
     */
    const root = mkdtempSync(join(tmpdir(), "render-resume-gpt-copy-marker-"));
    await seedRenderedRun(root);
    writeStaleMarker(root);

    const gpt = gptSpy();
    const render = renderAdapterWithTelemetry([CLEAN_TELEMETRY_ENTRY]);
    const res = await runCanonicalReportPrepare(
      await tinyPrepareInput(root, {
        render: render.adapter,
        gptCaller: gpt.caller,
        resumeFrom: "gpt-copy",
      })
    );
    expect(res.ok).toBe(true);
    expect(existsSync(staleMarkerPath(root))).toBe(true);

    const after = await resumeFromRender(root);
    expect(after.res.assemblyCount).toBe(1);
    expect(after.res.qualityWarnings ?? []).toContain(
      "render-resume-reassembly:stale-marker"
    );
  });

  it("причина прошлой попытки нынешнюю не переживает", async () => {
    // Чекпоинт отвечает о последней попытке. Причина, пережившая её, читалась
    // бы как жалоба на удачный повтор — тот же класс, что застревавшие
    // предупреждения прогона.
    const root = mkdtempSync(join(tmpdir(), "render-resume-reason-reset-"));
    await seedRenderedRun(root);
    const deck = readJson<Record<string, unknown>>(deckPath(root));
    const foreign = "composite-case-tiny-prepare-b6b26bb3cb03";
    writeFileSync(
      deckPath(root),
      JSON.stringify({ ...deck, datasetId: foreign, sourceDatasetId: foreign }),
      "utf8"
    );

    const fallback = await resumeFromRender(root);
    expect(fallback.res.assemblyCount).toBe(1);
    expect(
      readJson<{ reuseRefusedReason?: string | null }>(join(root, "render-checkpoint.json"))
        .reuseRefusedReason
    ).toContain("dataset-mismatch");

    const reuse = await resumeFromRender(root);
    expect(reuse.res.assemblyCount).toBe(0);
    expect(
      readJson<{ reuseRefusedReason?: string | null }>(join(root, "render-checkpoint.json"))
        .reuseRefusedReason ?? null
    ).toBeNull();
  });

  it("причина отказа реюза остаётся в чекпоинте упавшей попытки", async () => {
    /*
     * Из результата причину возвращают `qualityWarnings`, но у попытки,
     * которая до результата не дошла, результата нет: подготовка бросает, а
     * оркестратор пишет отказ. Чекпоинт — единственное, что от такой попытки
     * остаётся, и причина фолбэка обязана быть в нём.
     */
    const root = mkdtempSync(join(tmpdir(), "render-resume-failed-attempt-"));
    await seedRenderedRun(root);
    const foreign = "composite-case-tiny-prepare-b6b26bb3cb03";
    const deck = readJson<Record<string, unknown>>(deckPath(root));
    writeFileSync(
      deckPath(root),
      JSON.stringify({ ...deck, datasetId: foreign, sourceDatasetId: foreign }),
      "utf8"
    );

    const failingRender: DeckRenderAdapter = async () => {
      throw new Error("renderer unavailable");
    };
    await expect(
      runCanonicalReportPrepare(
        await tinyPrepareInput(root, {
          render: failingRender,
          gptCaller: gptSpy().caller,
          resumeFrom: "render",
        })
      )
    ).rejects.toMatchObject({ code: "RENDER_FAILED" });

    const checkpoint = readJson<{ reuseRefusedReason?: string | null }>(
      join(root, "render-checkpoint.json")
    );
    expect(checkpoint.reuseRefusedReason).toContain("dataset-mismatch");
    expect(checkpoint.reuseRefusedReason).toContain(foreign);
  });
});

describe("предупреждение о фолбэке живёт одну попытку", () => {
  const survivors = (jobWarnings: string[], qualityWarnings: string[]) =>
    warningsSurvivingSuccessfulPrepare({
      jobWarnings,
      qualityWarnings,
      enrichmentComplete: true,
      failedAgentCount: 0,
    });

  it("причина нынешней подготовки доезжает до прогона", () => {
    expect(survivors([], ["render-resume-reassembly:stale-marker"])).toContain(
      "render-resume-reassembly:stale-marker"
    );
  });

  it("причина прошлой попытки после успешной подготовки не висит", () => {
    // Иначе на готовом отчёте остаётся жалоба, которой больше нет, — тот же
    // класс, что и застревавшие `arsenkin-failed:*`.
    expect(survivors(["render-resume-reassembly:stale-marker"], [])).toEqual([]);
  });

  it("новая причина заменяет прежнюю, а не копится рядом", () => {
    expect(
      survivors(
        ["render-resume-reassembly:stale-marker"],
        ["render-resume-reassembly:dataset-missing"]
      )
    ).toEqual(["render-resume-reassembly:dataset-missing"]);
  });
});
