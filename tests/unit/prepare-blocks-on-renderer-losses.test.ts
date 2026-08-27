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

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CanonicalPrepareBlockedError,
  runCanonicalReportPrepare,
} from "@/modules/digital-profile/services/canonical-report-prepare";
import type { DeckRenderAdapter } from "@/modules/digital-profile/services/render-deck-artifacts";
import { compliancePagesOf } from "@/modules/digital-profile/services/render-telemetry-gate";
import {
  CLEAN_TELEMETRY_ENTRY as CLEAN_ENTRY,
  renderAdapterWithTelemetry as realShapedAdapter,
  tinyPrepareInput,
} from "../fixtures/tiny-canonical-prepare";

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

  it("клип таблицы на странице комплаенса останавливает подготовку", async () => {
    // Проверяется **проводка**: судья узнаёт комплаенсные страницы только от
    // подготовки, и без этой передачи блокер не срабатывает в продакшне ни
    // разу. Номер страницы поэтому берётся из манифеста собранной деки, а не
    // пишется числом: тест не должен знать вёрстку деки лучше, чем её знает
    // сама подготовка.
    const root = tempRoot("prepare-compliance-clip-");
    let clippedPage = 0;
    const render: DeckRenderAdapter = async (input) => {
      clippedPage = compliancePagesOf(input.deckManifest)[0] ?? 0;
      expect(clippedPage, "в собранной деке нет страниц комплаенса").toBeGreaterThan(0);
      const inner = realShapedAdapter([
        CLEAN_ENTRY,
        {
          page: clippedPage,
          name: `orion_search_table_p${clippedPage}`,
          role: "text",
          requiredHeight: 4_627_880,
          availableHeight: 4_602_385,
          measuredLines: 21,
          clipped: true,
          measurementUncertain: false,
        },
      ]);
      return await inner.adapter(input);
    };

    const err = await runCanonicalReportPrepare(
      await tinyPrepareInput(root, { render })
    ).then(
      () => null,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(CanonicalPrepareBlockedError);
    expect((err as CanonicalPrepareBlockedError).code).toBe("COMPLIANCE_CARD_CLIPPED");
    expect((err as Error).message).toContain(String(clippedPage));
    const cp = checkpoint(root);
    expect(cp.status).toBe("FAILED");
    expect(cp.errorCode).toBe("COMPLIANCE_CARD_CLIPPED");
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
     * манифест деки пишется `generatedAt` — без замороженных часов две полные
     * подготовки дают разные хэши. Замораживается только `Date`, таймеры
     * настоящие; живому пути `resumeFrom: "render"` заморозка не нужна — файлы
     * деки там не переписываются.
     */
    async function seedRenderedRun(root: string): Promise<void> {
      const { adapter } = realShapedAdapter([CLEAN_ENTRY]);
      const first = await runCanonicalReportPrepare(await tinyPrepareInput(root, { render: adapter }));
      expect(first.ok).toBe(true);
    }

    it("реюз с целой телеметрией остаётся реюзом", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-18T10:00:00.000Z"));
      const root = tempRoot("prepare-reuse-clean-");
      await seedRenderedRun(root);

      const second = realShapedAdapter([CLEAN_ENTRY]);
      const res = await runCanonicalReportPrepare(
        await tinyPrepareInput(root, { render: second.adapter })
      );

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
        await tinyPrepareInput(root, { render: second.adapter })
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
