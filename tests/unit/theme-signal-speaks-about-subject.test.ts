/**
 * Слово словаря — сигнал темы, только если сказано о субъекте (шаг 0122).
 *
 * Живые отчёты 20.09.2026: образование Шойгу («политехнический институт»)
 * стояло под «Политическими связями», туда же попала «Денежно-кредитная
 * политика центрального банка» Потанина; под «Корпоративным владением» —
 * «Снимки с премии появились в Instagram (владелец компания Meta признана в
 * России экстремистской и запрещена)», где «владелец» относится к Meta; под
 * политической темой — «По словам депутата, женился Потанин рано…», где
 * депутат это говорящий.
 */

import { describe, expect, it } from "vitest";
import { resolveExampleQuote } from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import { carriesThemeSignal } from "@/modules/digital-profile/orion-golden/analytics/theme-quote";
import { pickDistinctTitles } from "@/modules/digital-profile/orion-golden/analytics/distinct-stories";
import { getFindingThemes } from "@/modules/digital-profile/config/finding-themes";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

const POLITICAL = getFindingThemes().find((t) => t.themeId === "political_exposure")!;
const OWNERSHIP = getFindingThemes().find((t) => t.themeId === "corporate_ownership")!;

function item(partial: Partial<RawInventoryItem> & { inventoryId: string }): RawInventoryItem {
  return {
    caseId: "case-0122",
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "topvisor-yandex",
    region: "RU",
    collectedAt: "2026-09-20T12:00:00.000Z",
    evidenceType: "search_result",
    title: "",
    snippet: "",
    ...partial,
  } as RawInventoryItem;
}

describe("слово с другим значением сигналом не является", () => {
  it("Д1: «политехнический» — не политическая тема, «политическая партия» — да", () => {
    expect(
      carriesThemeSignal(
        "В 1977 году окончил Красноярский политехнический институт, специальность — инженер-строитель.",
        POLITICAL
      )
    ).toBe(false);
    expect(
      carriesThemeSignal("Член Высшего совета политической партии «Единая Россия».", POLITICAL)
    ).toBe(true);
  });

  it("Д2: отраслевая политика — не публичная роль; слово «правительство» сигналом остаётся", () => {
    expect(carriesThemeSignal("Денежно-кредитная политика центрального банка.", POLITICAL)).toBe(false);
    expect(carriesThemeSignal("Кадровая политика компании обсуждалась на совете.", POLITICAL)).toBe(false);
    expect(
      carriesThemeSignal("Налоговая политика правительства обсуждалась с участием субъекта.", POLITICAL)
    ).toBe(true);
  });
});

describe("сигнал внутри чужих слов не считается", () => {
  it("Д3: «владелец» внутри юридической приписки о Meta", () => {
    const disclaimer = item({
      inventoryId: "meta",
      title: "Фёдор Бондарчук на премии",
      snippet:
        "Снимки с премии появились в Instagram (владелец компания Meta признана в России экстремистской и запрещена).",
      sourceUrl: "https://www.gazeta.ru/style/news/2025/06/06/25972742.shtml",
    });
    expect(
      resolveExampleQuote(disclaimer, OWNERSHIP, null, { subjectNames: ["Бондарчук Фёдор Сергеевич"] })
    ).toBeNull();

    const real = item({
      inventoryId: "real",
      title: "Владелец «Интерроса» продал долю в банке",
      snippet: "",
      sourceUrl: "https://www.rbc.ru/potanin",
    });
    expect(
      resolveExampleQuote(real, OWNERSHIP, null, { subjectNames: ["Потанин Владимир Олегович"] })?.title
    ).toContain("Владелец");
  });

  it("Д4: «депутат» в ссылке на говорящего", () => {
    const quoted = item({
      inventoryId: "flb",
      title: "Потанин: биография",
      snippet:
        "По словам депутата, женился Потанин рано, чтобы по окончании МГИМО распределиться за рубеж.",
      sourceUrl: "https://flb.ru/info/36622.html",
    });
    expect(
      resolveExampleQuote(quoted, POLITICAL, null, { subjectNames: ["Потанин Владимир Олегович"] })
    ).toBeNull();

    const own = item({
      inventoryId: "duma",
      title: "Депутат Потанин выступил в Думе по вопросу приватизации",
      snippet: "",
      sourceUrl: "https://duma.example/news",
    });
    expect(
      resolveExampleQuote(own, POLITICAL, null, { subjectNames: ["Потанин Владимир Олегович"] })?.title
    ).toContain("Депутат Потанин");
  });
});

describe("зеркальные цитаты одного факта сводятся", () => {
  it("Д5: точка в конце короткой не мешает опознать её началом длинной", () => {
    const picked = pickDistinctTitles(
      [
        {
          title: "Член Высшего совета политической партии «Единая Россия» в 2009—2021 годах.",
          domain: "ru.wikipedia.org",
        },
        { title: "Член Высшего совета политической партии «Единая Россия».", domain: "руни.рф" },
      ],
      2
    );
    expect(picked).toHaveLength(1);
    expect(picked[0]!.domain).toBe("ru.wikipedia.org");
  });
});
