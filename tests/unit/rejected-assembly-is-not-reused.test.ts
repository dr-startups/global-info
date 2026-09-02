/**
 * Деку, которую забраковали ворота сборки, повторный рендер не переиспользует.
 *
 * `runDeckBuild` пишет `assembled-deck.json` и манифест на диск **до** того,
 * как подготовка судит сборку: `ASSEMBLY_QA_FAILED`, `REQUIRED_SECTION_FAILED`
 * и неполное покрытие бросают уже после записи. Забракованная дека остаётся
 * лежать целой, с непустыми слайдами и полным покрытием в манифесте — от
 * принятой её не отличить, измеряя файлы: ворота качества текста говорят о
 * словах на структурно безупречных страницах.
 *
 * Живая цепочка: попытка A падает на рендере и ставит чекпоинт `RENDER`;
 * попытка B пересобирает и падает на воротах качества, чекпоинт при этом
 * остаётся `RENDER`; попытка C приходит как «повтор рендера» — и до этой
 * правки принимала забракованную деку, рапортуя полное покрытие. Тот же вход
 * доступен вручную кнопкой «Повторить рендер».
 *
 * Отдельный случай той же цепочки: пересборка B меняет **слова**, а не
 * раскладку страниц. Отпечаток укладки при этом тот же, и штамп приёмки,
 * ключённый им, достался бы забракованной деке от принятой — вердикт ворот
 * обязан быть привязан к тому, что ворота судили.
 *
 * Вердикт ворот инъецируется на границе сборки: файлы пишет настоящий
 * построитель, забракован результат так же, как его бракует живой прогон.
 */

import { CANONICAL_SLOT_IDS } from "@/modules/digital-profile/orion-golden/deck-sections/canonical-slots";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCanonicalReportPrepare } from "@/modules/digital-profile/services/canonical-report-prepare";
import {
  ASSEMBLED_DECK_ARTIFACT,
  staleMarkerFileName,
} from "@/modules/digital-profile/services/unified-downstream-invalidation";
import type { DeckRenderAdapter } from "@/modules/digital-profile/services/render-deck-artifacts";
import {
  CLEAN_TELEMETRY_ENTRY,
  renderAdapterWithTelemetry,
  tinyPrepareInput,
} from "../fixtures/tiny-canonical-prepare";

const QA_BLOCKER = "цитаты разорваны на 3 страницах: s1, s2, s3";
const REJECTED_TEXT = "ЗАБРАКОВАННЫЙ ТЕКСТ B";

/**
 * Чем отвечает построитель на этой попытке: `null` — как есть, строка — тем же
 * набором страниц с этими словами и вердиктом «забраковано».
 */
const { gate } = vi.hoisted(() => ({ gate: { rejectWithText: null as string | null } }));

vi.mock("@/modules/digital-profile/orion-golden/deck-sections/gpt-enhanced-deck-build", async (
  importOriginal
) => {
  const actual =
    await importOriginal<
      typeof import("@/modules/digital-profile/orion-golden/deck-sections/gpt-enhanced-deck-build")
    >();
  return {
    ...actual,
    runDeckBuildWithGptCopy: async (
      input: Parameters<typeof actual.runDeckBuildWithGptCopy>[0]
    ) => {
      const deck = await actual.runDeckBuildWithGptCopy(input);
      if (!gate.rejectWithText) return deck;
      // Слова на диске другие, раскладка та же: правятся только текстовые поля
      // слайдов, `slideKey` и номера страниц остаются как были.
      const path = join(input.outputRoot, ASSEMBLED_DECK_ARTIFACT);
      const onDisk = JSON.parse(readFileSync(path, "utf8")) as {
        slides: Array<Record<string, unknown>>;
      };
      onDisk.slides = onDisk.slides.map((slide) => ({
        ...slide,
        narrative: gate.rejectWithText,
      }));
      writeFileSync(path, JSON.stringify(onDisk, null, 2), "utf8");
      return {
        ...deck,
        assemblyValidation: {
          passed: false,
          issues: [],
          checks: {},
          skipped: [],
          ...(deck.assemblyValidation ?? {}),
          blocking: [QA_BLOCKER],
        },
      };
    },
  };
});

const deckFile = (root: string, name: string) => join(root, "deck", name);
const staleMarkerPath = (root: string) =>
  join(root, staleMarkerFileName(ASSEMBLED_DECK_ARTIFACT));

/** Рендерер, запоминающий, что именно ему отдали на отрисовку. */
function capturingRender(): {
  adapter: DeckRenderAdapter;
  calls: () => number;
  rendered: () => string;
} {
  const base = renderAdapterWithTelemetry([CLEAN_TELEMETRY_ENTRY]);
  const seen: string[] = [];
  const adapter: DeckRenderAdapter = async (input) => {
    seen.push(JSON.stringify(input.rendererSlides));
    return base.adapter(input);
  };
  return { adapter, calls: base.calls, rendered: () => seen.join("\n") };
}

function writeStaleMarker(root: string): void {
  writeFileSync(
    staleMarkerPath(root),
    JSON.stringify({
      version: "downstream-stale-marker-v1",
      artifact: ASSEMBLED_DECK_ARTIFACT,
      reason: "arsenkin-ingest-recovery",
      doNotReuse: true,
    }),
    "utf8"
  );
}

beforeEach(() => {
  gate.rejectWithText = null;
});

describe("забракованная воротами сборка", () => {
  it("остаётся на диске, но повтором рендера не переиспользуется", async () => {
    const root = mkdtempSync(join(tmpdir(), "rejected-assembly-"));
    gate.rejectWithText = REJECTED_TEXT;

    const first = renderAdapterWithTelemetry([CLEAN_TELEMETRY_ENTRY]);
    await expect(
      runCanonicalReportPrepare(await tinyPrepareInput(root, { render: first.adapter }))
    ).rejects.toMatchObject({ code: "ASSEMBLY_QA_FAILED" });
    expect(first.calls()).toBe(0);

    // Предусловие сценария: дека на диске цела и внешне годна.
    const deck = JSON.parse(readFileSync(deckFile(root, ASSEMBLED_DECK_ARTIFACT), "utf8")) as {
      slides: unknown[];
    };
    expect(deck.slides.length).toBeGreaterThan(1);
    const manifest = JSON.parse(
      readFileSync(deckFile(root, "report-deck-manifest.json"), "utf8")
    ) as { baseSlotCoverage: number };
    expect(manifest.baseSlotCoverage).toBe(CANONICAL_SLOT_IDS.length);
    // Штампа приёмки на ней нет: ворота её не приняли.
    expect(existsSync(deckFile(root, "assembly-accepted.json"))).toBe(false);

    const second = renderAdapterWithTelemetry([CLEAN_TELEMETRY_ENTRY]);
    await expect(
      runCanonicalReportPrepare(
        await tinyPrepareInput(root, { render: second.adapter, resumeFrom: "render" })
      )
    ).rejects.toMatchObject({ code: "ASSEMBLY_QA_FAILED" });
    // Отчёт из забракованной сборки не отрисован и клиенту не уехал.
    expect(second.calls()).toBe(0);
  });

  it("не наследует штамп принятой, если сменились только слова", async () => {
    /*
     * A принята и проштампована; B пересобирает тот же набор страниц с другими
     * словами и бракуется воротами качества. Отпечаток укладки у A и B один и
     * тот же — слов он не видит, — поэтому штамп, ключённый им, объявил бы
     * забракованную деку принятой, и C отрисовал бы клиенту её текст.
     */
    const root = mkdtempSync(join(tmpdir(), "rejected-assembly-same-layout-"));
    const accepted = capturingRender();
    const a = await runCanonicalReportPrepare(
      await tinyPrepareInput(root, { render: accepted.adapter })
    );
    expect(a.ok).toBe(true);
    expect(existsSync(deckFile(root, "assembly-accepted.json"))).toBe(true);

    gate.rejectWithText = REJECTED_TEXT;
    await expect(
      runCanonicalReportPrepare(await tinyPrepareInput(root))
    ).rejects.toMatchObject({ code: "ASSEMBLY_QA_FAILED" });
    // Предусловие: забракованные слова лежат на диске.
    expect(readFileSync(deckFile(root, ASSEMBLED_DECK_ARTIFACT), "utf8")).toContain(
      REJECTED_TEXT
    );

    gate.rejectWithText = null;
    const resumed = capturingRender();
    const c = await runCanonicalReportPrepare(
      await tinyPrepareInput(root, { render: resumed.adapter, resumeFrom: "render" })
    );

    expect(c.ok).toBe(true);
    expect(c.assemblyCount).toBe(1);
    expect(c.qualityWarnings ?? []).toContain("render-resume-reassembly:not-accepted");
    expect(resumed.calls()).toBe(1);
    expect(resumed.rendered()).not.toContain(REJECTED_TEXT);
  });

  it("не гасит стоп-маркер инвалидации", async () => {
    /*
     * Маркер говорит «дека на диске старше новых наблюдений». Погасить его
     * вправе только пересборка, которую приняли: провалившаяся не заменила
     * защиту ничем, и следующая попытка переиспользовала бы доингестную деку.
     */
    const root = mkdtempSync(join(tmpdir(), "rejected-assembly-marker-"));
    const seeded = await runCanonicalReportPrepare(await tinyPrepareInput(root));
    expect(seeded.ok).toBe(true);
    writeStaleMarker(root);

    gate.rejectWithText = REJECTED_TEXT;
    await expect(
      runCanonicalReportPrepare(await tinyPrepareInput(root, { resumeFrom: "render" }))
    ).rejects.toMatchObject({ code: "ASSEMBLY_QA_FAILED" });
    expect(existsSync(staleMarkerPath(root))).toBe(true);

    gate.rejectWithText = null;
    const res = await runCanonicalReportPrepare(
      await tinyPrepareInput(root, { resumeFrom: "render" })
    );
    expect(res.ok).toBe(true);
    expect(res.assemblyCount).toBe(1);
    expect(res.qualityWarnings ?? []).toContain("render-resume-reassembly:stale-marker");
    // Принятая пересборка на маркер ответила — и только она его сняла.
    expect(existsSync(staleMarkerPath(root))).toBe(false);
  });
});
