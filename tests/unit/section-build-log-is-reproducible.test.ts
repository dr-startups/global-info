/**
 * Журнал сборки эталонной деки коммитится в воспроизводимом состоянии.
 *
 * `section-build-log.json` пишется прогоном ворот и говорит, что случилось с
 * каждым из 22 фрагментов: `REGENERATED` — пакет пересобран (так бывает после
 * подъёма `DECK_CONTENT_VERSION`), `REUSED_CACHE` — взят из готового пакета.
 * Первый прогон после подъёма версии даёт `REGENERATED` по всем фрагментам,
 * второй — `REUSED_CACHE`; коммитить надо журнал второго, иначе следующий
 * прогон на любой машине выдаёт дифф из двадцати двух строк, который дважды
 * приходилось объяснять в ревью как «так и должно быть».
 *
 * Держалось это практикой. Практику видно только тому, кто о ней знает, —
 * поэтому её держит проверка.
 *
 * Свойство: в закоммиченном журнале нет ни одной записи `REGENERATED`, а текст
 * отказа называет файл и говорит, что сделать.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LOG_PATH = join(
  process.cwd(),
  "baselines/report-72/artifacts/deck-sections/section-build-log.json"
);

type BuildLogEntry = { fragmentKey?: string; action?: string };

/**
 * Претензия к журналу либо `null`. Текст — часть проверяемого поведения:
 * отказ, не говорящий что делать, стоит следующему читателю получаса.
 */
function buildLogComplaint(entries: BuildLogEntry[]): string | null {
  const regenerated = entries.filter((e) => e.action !== "REUSED_CACHE");
  if (regenerated.length === 0) return null;
  const named = regenerated.map((e) => `${e.fragmentKey ?? "?"}: ${e.action ?? "?"}`);
  return (
    `baselines/report-72/artifacts/deck-sections/section-build-log.json ` +
    `содержит записи не из кэша (${regenerated.length}): ` +
    `${named.slice(0, 5).join(", ")}. ` +
    `Прогнать ворота второй раз и закоммитить журнал второго прогона.`
  );
}

function committedEntries(): BuildLogEntry[] {
  // Отсутствие журнала — отказ, а не пропуск: пропуск неотличим от проверки,
  // которой не было.
  expect(existsSync(LOG_PATH), `нет ${LOG_PATH}`).toBe(true);
  const parsed = JSON.parse(readFileSync(LOG_PATH, "utf8")) as BuildLogEntry[];
  expect(Array.isArray(parsed), "журнал сборки — список записей").toBe(true);
  return parsed;
}

describe("журнал сборки эталона", () => {
  it("не пуст — иначе проверять нечего", () => {
    expect(committedEntries().length).toBeGreaterThan(0);
  });

  it("каждая запись взята из кэша", () => {
    const entries = committedEntries();
    expect(buildLogComplaint(entries)).toBeNull();
  });

  it("отказ называет файл и говорит, что сделать", () => {
    // Отрицательный контроль: проверка, не умеющая дать не-ноль, — не проверка.
    const complaint = buildLogComplaint([
      { fragmentKey: "FRONT_MATTER_MAIN", action: "REGENERATED" },
    ]);
    expect(complaint).toContain("section-build-log.json");
    expect(complaint).toContain("FRONT_MATTER_MAIN");
    expect(complaint).toMatch(/второй раз/u);
  });
});
