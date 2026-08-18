/**
 * Живой путь подготовки отчёта судит телеметрию рендерера.
 *
 * Раньше `runCanonicalReportPrepare` рендерил и отдавал отчёт, ни разу не
 * взглянув на телеметрию: прогон с молча потерянными карточками рисков дошёл
 * до готового документа, и потерю нашли глазами. Теперь после успешного
 * рендера её судит тот же классификатор, что и TS-инспектор геометрии:
 *
 *   · потеря целых блоков — отчёт не выдаётся (`CONTENT_DROPPED_BY_RENDERER`);
 *   · клип — отчёт выдаётся, но предупреждение доезжает до прогона;
 *   · нет телеметрии после настоящего рендера — отказ, а не пропуск;
 *   · офлайн-фейк без файлов на диске не судится: терять было нечего.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CanonicalPrepareBlockedError,
  runCanonicalReportPrepare,
  type CanonicalPrepareInput,
} from "@/modules/digital-profile/services/canonical-report-prepare";
import type { DeckRenderAdapter } from "@/modules/digital-profile/services/render-deck-artifacts";
import { runTinyAnalytics, tinyPrepareInput } from "../fixtures/tiny-canonical-prepare";

const CLEAN_ENTRY = {
  page: 1,
  name: "orion_text_body_p1",
  role: "text",
  requiredHeight: 197_815,
  availableHeight: 1_100_000,
  clipped: false,
  measurementUncertain: false,
};

const CLIPPED_ENTRY = {
  page: 12,
  name: "orion_text_body_p12",
  role: "text",
  requiredHeight: 1_400_000,
  availableHeight: 1_100_000,
  clipped: true,
  measurementUncertain: false,
};

const DROPPED_ENTRY = {
  page: 6,
  name: "orion_risk_matrix_cards_p6",
  role: "cards",
  requiredHeight: 5_500_000,
  availableHeight: 5_025_200,
  clipped: false,
  droppedBullets: 2,
  droppedLines: 0,
};

/** Рендерер, который кладёт клиентские файлы на диск — как настоящий. */
function realShapedAdapter(entries: Array<Record<string, unknown>> | null): {
  adapter: DeckRenderAdapter;
  calls: () => number;
} {
  let calls = 0;
  const adapter: DeckRenderAdapter = async (input) => {
    calls += 1;
    mkdirSync(input.outputRoot, { recursive: true });
    const pptx = join(input.outputRoot, "rendered-client.pptx");
    const pdf = join(input.outputRoot, "rendered-client.pdf");
    writeFileSync(pptx, "pptx", "utf8");
    writeFileSync(pdf, "pdf", "utf8");
    const telemetryPath = join(input.outputRoot, "layout-telemetry.json");
    if (entries) {
      writeFileSync(
        telemetryPath,
        JSON.stringify({ version: "orion-layout-telemetry-v1", entries }, null, 2),
        "utf8"
      );
    } else {
      rmSync(telemetryPath, { force: true });
    }
    return {
      pdf,
      pptx,
      pageCount: input.deckManifest.pageCount,
      renderer: "http:orion/render-golden",
    };
  };
  return { adapter, calls: () => calls };
}

function checkpoint(root: string): { status?: string; errorCode?: string } {
  return JSON.parse(readFileSync(join(root, "render-checkpoint.json"), "utf8")) as {
    status?: string;
    errorCode?: string;
  };
}

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("подготовка отчёта и потери рендерера", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("потеря целых блоков останавливает выдачу отчёта", async () => {
    const root = tempRoot("prepare-dropped-");
    const { adapter } = realShapedAdapter([CLEAN_ENTRY, DROPPED_ENTRY]);

    const err = await runCanonicalReportPrepare(
      await tinyPrepareInput(root, { render: adapter })
    ).then(
      () => null,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(CanonicalPrepareBlockedError);
    expect((err as CanonicalPrepareBlockedError).code).toBe("CONTENT_DROPPED_BY_RENDERER");
    expect((err as Error).message).toContain("6");
    const cp = checkpoint(root);
    expect(cp.status).toBe("FAILED");
    expect(cp.errorCode).toBe("CONTENT_DROPPED_BY_RENDERER");
  });

  it("чистая телеметрия — отчёт выдаётся молча", async () => {
    const root = tempRoot("prepare-clean-telemetry-");
    const { adapter } = realShapedAdapter([CLEAN_ENTRY]);
    const res = await runCanonicalReportPrepare(await tinyPrepareInput(root, { render: adapter }));
    expect(res.ok).toBe(true);
    expect((res.qualityWarnings ?? []).filter((w) => w.startsWith("renderer-clip:"))).toEqual([]);
    expect(checkpoint(root).status).toBe("SUCCEEDED");
  });

  it("клип не блокирует, но доезжает предупреждением прогона", async () => {
    const root = tempRoot("prepare-clipped-");
    const { adapter } = realShapedAdapter([CLEAN_ENTRY, CLIPPED_ENTRY]);
    const res = await runCanonicalReportPrepare(await tinyPrepareInput(root, { render: adapter }));
    expect(res.ok).toBe(true);
    expect(res.qualityWarnings ?? []).toContain("renderer-clip:page=12:text-clipping");
  });

  it("настоящий рендер без телеметрии — отказ, а не пропуск", async () => {
    const root = tempRoot("prepare-no-telemetry-");
    const { adapter } = realShapedAdapter(null);

    const err = await runCanonicalReportPrepare(
      await tinyPrepareInput(root, { render: adapter })
    ).then(
      () => null,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(CanonicalPrepareBlockedError);
    expect((err as CanonicalPrepareBlockedError).code).toBe("RENDER_TELEMETRY_MISSING");
    const cp = checkpoint(root);
    expect(cp.status).toBe("FAILED");
    expect(cp.errorCode).toBe("RENDER_TELEMETRY_MISSING");
  });

  it("офлайн-фейк без файлов на диске воротами не судится", async () => {
    // У `fake-tiny` нет ни pptx, ни pdf: рендер не состоялся, терять было
    // нечего, и требовать от него телеметрию значило бы сломать все офлайн-
    // проверки подготовки.
    const root = tempRoot("prepare-fake-render-");
    const res = await runCanonicalReportPrepare(await tinyPrepareInput(root));
    expect(res.ok).toBe(true);
    expect(checkpoint(root).status).toBe("SUCCEEDED");
  });

  it("офлайн-фейк не судится, даже если оставил файлы на диске", async () => {
    // Один ответ на вопрос «состоялся ли настоящий рендер». Пока ответов было
    // два — имя адаптера для требования клиентских файлов и наличие файлов для
    // суда телеметрии, — фейк с файлами попадал под суд, а фейк без файлов нет.
    const root = tempRoot("prepare-fake-with-files-");
    const render: DeckRenderAdapter = async (input) => {
      mkdirSync(input.outputRoot, { recursive: true });
      const pptx = join(input.outputRoot, "rendered-client.pptx");
      const pdf = join(input.outputRoot, "rendered-client.pdf");
      writeFileSync(pptx, "pptx", "utf8");
      writeFileSync(pdf, "pdf", "utf8");
      return { pdf, pptx, pageCount: input.deckManifest.pageCount, renderer: "fake-with-files" };
    };

    const res = await runCanonicalReportPrepare(await tinyPrepareInput(root, { render }));

    expect(res.ok).toBe(true);
    expect(checkpoint(root).status).toBe("SUCCEEDED");
  });

  describe("идемпотентный реюз прежнего рендера", () => {
    /**
     * Ранний возврат по прежнему рендеру требует двух совпадений: чекпоинт
     * `SUCCEEDED` и равенство хэша сборки. Хэш считается по файлам деки, а в
     * манифест деки пишется `generatedAt` — без замороженных часов два прогона
     * дают разные хэши. Замораживается только `Date`, таймеры настоящие.
     *
     * Второе совпадение — идентификатор набора: реюз ищет сборку по
     * `binding.compositeDatasetId`, а дека несёт идентификатор, посчитанный
     * аналитикой (`composite-<caseId>-<хэш наблюдений>`). У фикстуры они
     * разные, поэтому вход подстраивается — иначе ветка реюза недостижима и
     * проверка была бы пустой.
     */
    let deckDatasetId = "";

    beforeAll(async () => {
      const probe = tempRoot("prepare-reuse-probe-");
      const analytics = await runTinyAnalytics(probe);
      deckDatasetId = analytics.reportDataBinding.datasetId;
    });

    async function reusableInput(
      root: string,
      render: DeckRenderAdapter
    ): Promise<CanonicalPrepareInput> {
      const base = await tinyPrepareInput(root, { render });
      return {
        ...base,
        binding: { ...base.binding, compositeDatasetId: deckDatasetId },
        merge: { ...base.merge, compositeDatasetId: deckDatasetId },
      };
    }

    async function seedRenderedRun(root: string): Promise<void> {
      const { adapter } = realShapedAdapter([CLEAN_ENTRY]);
      const first = await runCanonicalReportPrepare(await reusableInput(root, adapter));
      expect(first.ok).toBe(true);
    }

    it("реюз с целой телеметрией остаётся реюзом", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-18T10:00:00.000Z"));
      const root = tempRoot("prepare-reuse-clean-");
      await seedRenderedRun(root);

      const second = realShapedAdapter([CLEAN_ENTRY]);
      const res = await runCanonicalReportPrepare(await reusableInput(root, second.adapter));

      expect(res.ok).toBe(true);
      expect(second.calls()).toBe(0);
    });

    it("реюз без телеметрии не проскальзывает мимо ворот, а перерендеривает", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-18T10:00:00.000Z"));
      const root = tempRoot("prepare-reuse-stale-");
      await seedRenderedRun(root);
      // Прежний рендер сделан до этого шага: файлы на месте, телеметрии нет.
      rmSync(join(root, "render", "layout-telemetry.json"), { force: true });

      const second = realShapedAdapter([CLEAN_ENTRY, DROPPED_ENTRY]);
      const err = await runCanonicalReportPrepare(
        await reusableInput(root, second.adapter)
      ).then(
        () => null,
        (e: unknown) => e
      );

      expect(second.calls()).toBe(1);
      expect(err).toBeInstanceOf(CanonicalPrepareBlockedError);
      expect((err as CanonicalPrepareBlockedError).code).toBe("CONTENT_DROPPED_BY_RENDERER");
    });
  });
});
