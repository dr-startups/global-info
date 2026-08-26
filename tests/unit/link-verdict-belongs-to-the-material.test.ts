/**
 * Решение по прочитанной странице принадлежит материалу, а не наблюдению.
 *
 * Ключ наблюдения включает запрос, поэтому одна и та же страница, найденная
 * двумя запросами, — два наблюдения с разными ссылками. На отчёте Кремлёва
 * `opensanctions.org/entities/Q55102113` был прочитан и признан нежелательным
 * с тремя цитатами, но решение легло на ссылку RU-запроса, а строка таблицы
 * ОАЭ собрана из своих одиннадцати ссылок — и напечаталась «Нейтральной».
 * Двумя листами дальше тот же адрес нёс красную рамку.
 */

import { describe, expect, it } from "vitest";
import { applyLinkVerdictsToEvidence } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

type Index = ScopedFragmentInput["evidenceIndex"];

const URL = "https://www.opensanctions.org/entities/Q55102113/";
const TITLE = "Umar Nazarovich Kremlev";

/** Два наблюдения одного материала: разные запросы, один адрес и заголовок. */
function twoObservations(): Index {
  return {
    "inventory:ru-query": { url: URL, domain: "opensanctions.org", title: TITLE, region: "RU" },
    "inventory:uae-query": { url: URL, domain: "opensanctions.org", title: TITLE, region: "UAE" },
  } as unknown as Index;
}

describe("вердикт виден всем наблюдениям своего материала", () => {
  it("нежелательный вывод с цитатой доезжает до ссылки другого запроса", () => {
    const index = twoObservations();
    applyLinkVerdictsToEvidence(index, [
      {
        evidenceRef: "inventory:ru-query",
        tone: "adverse",
        subjectMatch: "subject",
        theme: "Санкционный контур",
        quotes: [{ text: "Запись значится в санкционном реестре с 2023 года." }],
      },
    ]);
    expect(index["inventory:uae-query"]!.readVerdictTone).toBe("adverse");
    expect(index["inventory:uae-query"]!.adverse).toBe(true);
    expect(index["inventory:uae-query"]!.verdictTheme).toBe("Санкционный контур");
    expect(index["inventory:uae-query"]!.pageQuote).toBe(
      "Запись значится в санкционном реестре с 2023 года."
    );
  });

  it("причина непрочтения тоже принадлежит материалу", () => {
    const index = twoObservations();
    applyLinkVerdictsToEvidence(index, [
      { evidenceRef: "inventory:ru-query", readFailure: "blocked" },
    ]);
    expect(index["inventory:uae-query"]!.readFailure).toBe("blocked");
    expect(index["inventory:uae-query"]!.readVerdictTone).toBeUndefined();
  });

  it("прочитанная страница сильнее отказа чтения на другом наблюдении", () => {
    const index = twoObservations();
    applyLinkVerdictsToEvidence(index, [
      { evidenceRef: "inventory:ru-query", readFailure: "blocked" },
      {
        evidenceRef: "inventory:uae-query",
        tone: "supportive",
        subjectMatch: "subject",
        quotes: [{ text: "Организация подтвердила статус лицензии." }],
      },
    ]);
    expect(index["inventory:ru-query"]!.readVerdictTone).toBe("supportive");
    expect(index["inventory:ru-query"]!.adverse).toBe(false);
    expect(index["inventory:uae-query"]!.readVerdictTone).toBe("supportive");
  });
});

describe("разные материалы решение не делят", () => {
  it("две статьи одного сайта остаются разными материалами", () => {
    const index = {
      "inventory:a": {
        url: "https://news-example.ru/a",
        domain: "news-example.ru",
        title: "Первая статья",
      },
      "inventory:b": {
        url: "https://news-example.ru/b",
        domain: "news-example.ru",
        title: "Вторая статья",
      },
    } as unknown as Index;
    applyLinkVerdictsToEvidence(index, [
      {
        evidenceRef: "inventory:a",
        tone: "adverse",
        subjectMatch: "subject",
        quotes: [{ text: "Компания подтвердила факт обыска в офисе." }],
      },
    ]);
    expect(index["inventory:a"]!.adverse).toBe(true);
    expect(index["inventory:b"]!.adverse).toBeUndefined();
    expect(index["inventory:b"]!.readVerdictTone).toBeUndefined();
  });

  it("записи без адреса и домена не склеиваются по одному заголовку", () => {
    // В индексе доказательств живёт не только выдача: у записи комплаенс-базы
    // нет ни адреса, ни домена, а заголовок — имя субъекта, одинаковое у трёх
    // баз. На корпусе report-72 это буквально Dow Jones, LexisNexis и
    // World-Check под одним ключом. Решение по прочитанной странице не вправе
    // снять совпадение сразу у всех трёх.
    const index = {
      "databaseProfile:dj": { title: "Глинка Сергей Михайлович", kind: "compliance_hit" },
      "databaseProfile:lexis": { title: "Глинка Сергей Михайлович", kind: "compliance_hit" },
      "databaseProfile:wc": { title: "Глинка Сергей Михайлович", kind: "compliance_hit" },
    } as unknown as Index;
    applyLinkVerdictsToEvidence(index, [
      {
        evidenceRef: "databaseProfile:dj",
        tone: "neutral",
        subjectMatch: "other",
        quotes: [{ text: "Речь о полном тёзке из другого региона." }],
      },
    ]);
    expect(index["databaseProfile:dj"]!.subjectDecision).toBe("OTHER_SUBJECT");
    expect(index["databaseProfile:lexis"]!.subjectDecision).toBeUndefined();
    expect(index["databaseProfile:wc"]!.subjectDecision).toBeUndefined();
  });

  it("строки без адреса, домена и заголовка не склеиваются в один материал", () => {
    const index = {
      "inventory:blank-1": {},
      "inventory:blank-2": {},
    } as unknown as Index;
    applyLinkVerdictsToEvidence(index, [
      {
        evidenceRef: "inventory:blank-1",
        tone: "adverse",
        subjectMatch: "subject",
        quotes: [{ text: "Суд признал требования обоснованными." }],
      },
    ]);
    expect(index["inventory:blank-1"]!.adverse).toBe(true);
    expect(index["inventory:blank-2"]!.adverse).toBeUndefined();
  });
});

describe("у материала побеждает сильнейшее решение", () => {
  it("нежелательный вывод с цитатой сильнее нейтрального, даже если пришёл вторым", () => {
    const index = twoObservations();
    applyLinkVerdictsToEvidence(index, [
      { evidenceRef: "inventory:ru-query", tone: "neutral", subjectMatch: "subject" },
      {
        evidenceRef: "inventory:uae-query",
        tone: "adverse",
        subjectMatch: "subject",
        theme: "Отмывание средств",
        quotes: [{ text: "Обвиняется в отмывании средств через подставные компании." }],
      },
    ]);
    for (const ref of ["inventory:ru-query", "inventory:uae-query"]) {
      expect(index[ref]!.readVerdictTone).toBe("adverse");
      expect(index[ref]!.adverse).toBe(true);
      expect(index[ref]!.verdictTheme).toBe("Отмывание средств");
    }
  });
});

describe("цитата не переезжает на чужой адрес", () => {
  it("оценка материала общая, а дословная цитата остаётся у своего наблюдения", () => {
    const index = {
      "inventory:read": {
        url: "https://www.opensanctions.org/entities/Q55102113/",
        domain: "opensanctions.org",
        title: TITLE,
      },
      "inventory:other-url": {
        url: "https://www.opensanctions.org/entities/Q99999999/",
        domain: "opensanctions.org",
        title: TITLE,
      },
    } as unknown as Index;
    applyLinkVerdictsToEvidence(index, [
      {
        evidenceRef: "inventory:read",
        tone: "adverse",
        subjectMatch: "subject",
        theme: "Санкционный контур",
        quotes: [{ text: "Запись значится в санкционном реестре с 2023 года." }],
      },
    ]);
    expect(index["inventory:read"]!.pageQuote).toBe(
      "Запись значится в санкционном реестре с 2023 года."
    );
    // Оценка и тема — свойство материала, цитата — свойство прочитанной страницы.
    expect(index["inventory:other-url"]!.readVerdictTone).toBe("adverse");
    expect(index["inventory:other-url"]!.verdictTheme).toBe("Санкционный контур");
    expect(index["inventory:other-url"]!.pageQuote).toBeUndefined();
  });

  it("тот же адрес с трекинг-параметром цитату получает", () => {
    const index = {
      "inventory:read": { url: `${URL}?srsltid=abc`, domain: "opensanctions.org", title: TITLE },
      "inventory:same": { url: URL, domain: "opensanctions.org", title: TITLE },
    } as unknown as Index;
    applyLinkVerdictsToEvidence(index, [
      {
        evidenceRef: "inventory:read",
        tone: "adverse",
        subjectMatch: "subject",
        quotes: [{ text: "Запись значится в санкционном реестре с 2023 года." }],
      },
    ]);
    expect(index["inventory:same"]!.pageQuote).toBe(
      "Запись значится в санкционном реестре с 2023 года."
    );
  });
});
