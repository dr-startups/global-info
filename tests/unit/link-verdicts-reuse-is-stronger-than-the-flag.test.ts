/**
 * Пересборка не уничтожает и не покупает заново оплаченное чтение страниц.
 *
 * У вердиктов нет базы: `link-verdicts.json` — единственное место, где живёт
 * результат чтения чужих страниц и решений модели. Пересборка отчёта
 * («Пересобрать отчёт» и «Golden Prepare») запускает аналитику целиком, и до
 * этого шага шаг чтения отвечал только на вопрос «включён ли флаг»: при
 * выключенном — затирал купленное пустым артефактом, при включённом — молча
 * читал страницы и платил второй раз.
 *
 * Поэтому реюз сильнее флага: `DIGITAL_PROFILE_LINK_READING` разрешает только
 * **первую** покупку, а купленный артефакт живёт до конца каталога джобы.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boughtLinkVerdictsArtifact,
  linkVerdict,
} from "../fixtures/link-verdict-artifact";
import {
  TINY_ADVERSE_URL,
  TINY_CASE_ID,
  runTinyAnalytics,
  tinyInventory,
} from "../fixtures/tiny-canonical-prepare";

const THEME = "Налоговое разбирательство в Стокгольме";

/** Артефакт прошлого прогона с решениями по реальным наблюдениям этого корпуса. */
function seedBoughtVerdicts(dir: string) {
  const items = tinyInventory();
  const adverse = items.find((i) => i.sourceUrl === TINY_ADVERSE_URL)!;
  const second = items.find((i) => i.sourceUrl === "https://forbes.com/holmstrom")!;
  const verdicts = [
    linkVerdict({
      evidenceRef: `inventory:${adverse.inventoryId}`,
      url: TINY_ADVERSE_URL,
      theme: THEME,
      rank: 1,
    }),
    linkVerdict({
      evidenceRef: `inventory:${second.inventoryId}`,
      url: "https://forbes.com/holmstrom",
      domain: "forbes.com",
      theme: THEME,
      rank: 2,
      quotes: [
        {
          text: "Расследование о неуплате налогов затронуло и вторую компанию предпринимателя в Стокгольме.",
        },
      ],
    }),
  ];
  const artifact = boughtLinkVerdictsArtifact({ caseId: TINY_CASE_ID, verdicts });
  writeFileSync(
    join(dir, "link-verdicts.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8"
  );
  return artifact;
}

function readArtifact(dir: string) {
  return JSON.parse(readFileSync(join(dir, "link-verdicts.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "link-verdicts-reuse-run-"));
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DIGITAL_PROFILE_LINK_READING;
});

describe("повторная сборка отчёта и купленные вердикты", () => {
  it("при выключенном чтении купленное не затирается пустым артефактом", async () => {
    const dir = tmpDir();
    const before = seedBoughtVerdicts(dir);

    await runTinyAnalytics(dir);

    const after = readArtifact(dir);
    expect(after.verdicts).toEqual(before.verdicts);
    expect(after.summary).toEqual(before.summary);
    expect(after.themesByRegion).toEqual(before.themesByRegion);
    // Отчёт обязан показывать, что решения достались от прежнего прогона.
    expect(after.reuse).toMatchObject({ previousDatasetId: "composite-previous" });
    expect(typeof (after.reuse as { reusedAt?: unknown }).reusedAt).toBe("string");
    expect(after.skippedReason).toBeUndefined();
  });

  it("при включённом чтении страницы не перечитываются: реюз сильнее флага", async () => {
    process.env.DIGITAL_PROFILE_LINK_READING = "1";
    const fetchSpy = vi.fn(async () => {
      throw new Error("страницы читаются один раз за сбор");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const dir = tmpDir();
    const before = seedBoughtVerdicts(dir);

    await runTinyAnalytics(dir);

    const after = readArtifact(dir);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(after.verdicts).toEqual(before.verdicts);
    expect(after.reading).toEqual(before.reading);
    expect(after.reuse).toBeTruthy();
  });

  it("переиспользованные решения кормят резюме, а не только файл", async () => {
    const dir = tmpDir();
    seedBoughtVerdicts(dir);

    const res = await runTinyAnalytics(dir);

    expect(res.clientSummaryPack.readPlots.map((p) => p.title)).toContain(THEME);
    const plotSections = res.composedClientSummary.sections.themes.filter(
      (s) => s.kind === "read_plot"
    );
    expect(plotSections.map((s) => s.heading)).toContain(THEME);
  });

  it("первый прогон без артефакта и без разрешения по-прежнему честно пуст", async () => {
    const dir = tmpDir();

    await runTinyAnalytics(dir);

    const artifact = readArtifact(dir);
    expect(artifact.verdicts).toEqual([]);
    expect(artifact.skippedReason).toBe("disabled");
    expect(artifact.reuse).toBeUndefined();
    expect(artifact.superseded).toBeUndefined();
  });
});
