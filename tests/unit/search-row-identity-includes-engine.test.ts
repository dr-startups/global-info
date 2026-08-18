/**
 * Движок — часть идентичности строки выдачи.
 *
 * «Страница на месте N у Яндекса» и «она же на месте M у Google» — два разных
 * факта, и оба нужны отчёту. Пока движка в `dedupHash` не было, Яндекс,
 * отработав по запросу первым, вычёркивал строки Google того же URL:
 * `createMany({skipDuplicates})` молча выбрасывал их до всякой аналитики. Дыры
 * 1, 2, 3, 5 в таблице «Россия — Google» прогона 76 — это ненаписанные строки,
 * и пересборкой их не вернуть.
 */

import { describe, expect, it } from "vitest";
import { searchResultDedupHash } from "@/modules/digital-profile/services/search-result-identity";

const URL = "https://ru.wikipedia.org/wiki/Рашников,_Виктор_Филиппович";

describe("хеш строки выдачи", () => {
  it("различает движки на одном URL, запросе и регионе", () => {
    const google = searchResultDedupHash({
      engine: "GOOGLE",
      normalizedUrl: URL,
      query: "Рашников Виктор Филиппович",
      region: "RU",
    });
    const yandex = searchResultDedupHash({
      engine: "YANDEX",
      normalizedUrl: URL,
      query: "Рашников Виктор Филиппович",
      region: "RU",
    });
    expect(google).not.toBe(yandex);
  });

  it("повторный сбор тем же движком даёт тот же хеш", () => {
    // Идемпотентность повторного запуска: тот же движок, запрос и регион —
    // та же строка, и `skipDuplicates` обязан её узнать.
    const args = {
      engine: "GOOGLE" as const,
      normalizedUrl: URL,
      query: "Рашников Виктор Филиппович",
      region: "RU",
    };
    expect(searchResultDedupHash(args)).toBe(searchResultDedupHash(args));
  });

  it("разные запросы по одному URL — разные строки", () => {
    const a = searchResultDedupHash({
      engine: "GOOGLE",
      normalizedUrl: URL,
      query: "Рашников Виктор Филиппович",
      region: "RU",
    });
    const b = searchResultDedupHash({
      engine: "GOOGLE",
      normalizedUrl: URL,
      query: "рашников виктор филиппович состояние",
      region: "RU",
    });
    expect(a).not.toBe(b);
  });

  it("агентская форма без запроса тоже помнит движок", () => {
    // У агентского сборщика запроса в строке нет вовсе, поэтому его хеш —
    // «движок + адрес» на весь кейс; повторный запуск того же агента остаётся
    // идемпотентным.
    const google = searchResultDedupHash({ engine: "GOOGLE", normalizedUrl: URL });
    const yandex = searchResultDedupHash({ engine: "YANDEX", normalizedUrl: URL });
    expect(google).not.toBe(yandex);
    expect(searchResultDedupHash({ engine: "GOOGLE", normalizedUrl: URL })).toBe(google);
  });

  it("хеш без запроса не совпадает с хешем с запросом", () => {
    expect(searchResultDedupHash({ engine: "GOOGLE", normalizedUrl: URL })).not.toBe(
      searchResultDedupHash({
        engine: "GOOGLE",
        normalizedUrl: URL,
        query: "Рашников Виктор Филиппович",
        region: "RU",
      })
    );
  });
});
