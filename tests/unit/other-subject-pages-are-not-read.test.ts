/**
 * Страницы, которые разметка признала чужими, не читаются платно.
 *
 * Отбор ссылок шёл по позиции в выдаче и не смотрел на решение о
 * принадлежности: на прогоне DPA-2026-0049 из 120 запрошенных страниц десятки
 * были карточками ИП и врача-однофамильца. Это деньги за чтение чужих страниц и
 * вердикты, которые потом строят «сюжеты» отчёта.
 */

import { describe, expect, it } from "vitest";
import { linksToRead } from "@/modules/digital-profile/orion-golden/analytics/run-link-verdicts";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

let seq = 0;
function item(rank: number, url: string): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `link-${seq}`,
    caseId: "case-1",
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-09-04T00:00:00.000Z",
    evidenceType: "search_result",
    title: `Строка ${rank}`,
    snippet: "",
    sourceUrl: url,
    rawMetadata: { rank },
  } as unknown as RawInventoryItem;
}

const other = item(1, "https://prodoctorov.ru/podolsk/vrach/380102-egorov/");
const confirmed = item(9, "https://krasnodar.arbitr.ru/about/mode/judges");
const unknown = item(5, "https://example.org/page");

describe("отбор ссылок на чтение", () => {
  it("страница другого лица не покупается", () => {
    const picked = linksToRead([other, confirmed, unknown], 10, {
      decisionByRef: new Map([
        [`inventory:${other.inventoryId}`, "OTHER_SUBJECT"],
        [`inventory:${confirmed.inventoryId}`, "SUBJECT_MATCH"],
      ]),
    });
    expect(picked.map((p) => p.url)).not.toContain(other.sourceUrl);
  });

  it("подтверждённые страницы читаются первыми, а не по позиции", () => {
    const picked = linksToRead([unknown, confirmed], 10, {
      decisionByRef: new Map([[`inventory:${confirmed.inventoryId}`, "SUBJECT_MATCH"]]),
    });
    expect(picked[0]?.url).toBe(confirmed.sourceUrl);
  });

  it("без разметки порядок прежний — по позиции в выдаче", () => {
    const picked = linksToRead([confirmed, unknown]);
    expect(picked.map((p) => p.url)).toEqual([unknown.sourceUrl, confirmed.sourceUrl]);
  });
});
