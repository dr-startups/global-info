/**
 * Страница-список однофамильцев, где назван и субъект, — не страница о другом лице (шаг 0148).
 *
 * Прогон Мельниченко 22.09.2026, стр. 24 (строка 11) и стр. 72: зеркало
 * Википедии со страницей неоднозначности «Мельниченко, Андрей» — «Мельниченко,
 * Андрей Игоревич (род. 1972) — российский предприниматель и промышленник,
 * миллиардер, меценат. · Мельниченко, Андрей Леонидович (род. 1992) — …».
 * Резолвер нашёл чужое отчество в тройке с именем субъекта и решил
 * `OTHER_SUBJECT` (`patronymic_conflict`, 0,9) — а приложение напечатало под
 * ярлыком «о другом лице» цитату ровно о субъекте.
 *
 * Соседнее правило, о чужом имени в тройке, эту границу уже знает: своя тройка
 * в тексте — правило молчит, и решает лестница смешанных признаков. У правила
 * чужого отчества её не было. Одна граница на оба правила.
 */

import { describe, expect, it } from "vitest";
import {
  conflictingPatronymics,
  ownPatronymicTripleInText,
} from "@/modules/digital-profile/orion-golden/analytics/patronymic-conflict";
import {
  classifySubjectRelevance,
  type SubjectIdentity,
} from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

const MELNICHENKO = {
  lastName: "Мельниченко",
  firstNames: ["Андрей", "Andrey", "Andrei"],
  patronymics: ["Игоревич", "Igorevich"],
  aliases: ["Andrey Melnichenko", "Andrei Melnichenko"],
};

const LIST_PAGE =
  "Мельниченко, Андрей Игоревич (род. 1972) — российский предприниматель и промышленник, " +
  "миллиардер, меценат. · Мельниченко, Андрей Леонидович (род. 1992) — ...";

describe("чужое отчество рядом со своей тройкой", () => {
  /*
   * Чужое отчество на странице-списке остаётся сигналом — по нему лестница
   * смешанных признаков и узнаёт страницу о двух людях. Решает своя тройка.
   */
  it("Н1: в списке однофамильцев своя тройка найдена, чужое отчество — сигнал", () => {
    expect(ownPatronymicTripleInText(LIST_PAGE, MELNICHENKO)).toBe(true);
    expect(conflictingPatronymics(LIST_PAGE, MELNICHENKO)).toEqual(["леонидович"]);
  });

  it("Н2: латинский список однофамильцев — своя тройка найдена", () => {
    const text =
      "Melnichenko, Andrey Igorevich (born 1972) — Russian industrialist. " +
      "Melnichenko, Andrey Leonidovich (born 1992) — footballer.";
    expect(ownPatronymicTripleInText(text, MELNICHENKO)).toBe(true);
  });

  it("Н2б: «Григорьевич» — не своё «Игоревич», хоть и в двух правках от него", () => {
    // Живая запись прогона Мельниченко (klerk.ru): допуск вариантов
    // транслитерации принял бы «grigorevich» за «igorevich» и заглушил бы
    // настоящий конфликт — ошибка в эту сторону прячет тёзку.
    expect(
      ownPatronymicTripleInText("ИП Мельниченко Андрей Григорьевич ИНН 246601197642", MELNICHENKO)
    ).toBe(false);
    expect(
      ownPatronymicTripleInText("IE Melnichenko Andrey Grigorevich, INN 246601197642", MELNICHENKO)
    ).toBe(false);
  });

  it("Н2в: своя тройка в косвенном падеже узнаётся", () => {
    expect(
      ownPatronymicTripleInText(
        "Интервью Андрея Игоревича Мельниченко и заметка об Андрее Леонидовиче Мельниченко",
        MELNICHENKO
      )
    ).toBe(true);
  });

  it("Н2г: то же отчество при другом имени — не своя тройка (брат, отец)", () => {
    expect(
      ownPatronymicTripleInText(
        "Мельниченко Андрей Леонидович — футболист; его дядя Мельниченко Сергей Игоревич — тренер",
        MELNICHENKO
      )
    ).toBe(false);
  });

  it("Н2д: своё имя-отчество далеко от фамилии — не своя тройка", () => {
    expect(
      ownPatronymicTripleInText(
        "Андрей Игоревич Петров, тренер сборной, долго рассказывал о новичках команды. " +
          "Мельниченко Андрей Леонидович — футболист",
        MELNICHENKO
      )
    ).toBe(false);
  });

  it("Н2а: страница только о тёзке своей тройки не содержит", () => {
    expect(
      ownPatronymicTripleInText("Мельниченко Андрей Леонидович (род. 1992) — футболист", MELNICHENKO)
    ).toBe(false);
  });

  it("Н3: страница только о тёзке — конфликт остаётся", () => {
    expect(
      conflictingPatronymics("Мельниченко Андрей Леонидович (род. 1992) — футболист", MELNICHENKO)
    ).toEqual(["леонидович"]);
  });

  it("Н4: ИП Дуров Павел Юрьевич при отчестве Валерьевич — конфликт остаётся", () => {
    expect(
      conflictingPatronymics("ИП Дуров Павел Юрьевич — ОГРНИП: 324774600790305", {
        lastName: "Дуров",
        firstNames: ["Павел"],
        patronymics: ["Валерьевич"],
      })
    ).toEqual(["юрьевич"]);
  });
});

const SUBJECT: SubjectIdentity = {
  displayName: "Мельниченко Андрей Игоревич",
  lastName: "Мельниченко",
  lastNameVariants: ["melnichenko"],
  firstNames: ["Андрей", "andrey", "andrei"],
  patronymics: ["Игоревич", "igorevich"],
  aliases: ["Andrey Melnichenko", "Andrei Melnichenko"],
  strongIdentifiers: [],
  contextIdentifiers: [],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [],
  namesakeNoise: [],
};

const item = (title: string, snippet: string): RawInventoryItem => ({
  inventoryId: "it-0148",
  caseId: "case-0148",
  reportRunId: "run-0148",
  source: "serp_observation",
  provider: "serper",
  region: "RU",
  collectedAt: "2026-09-22T00:00:00.000Z",
  evidenceType: "search_result",
  title,
  snippet,
  sourceUrl: "https://wikipedia.akarpov.ru/content/wikipedia/A/Андрей_Мельниченко",
});

describe("решение о принадлежности страницы-списка", () => {
  it("Н5: живая страница неоднозначности — не «о другом лице»", () => {
    const d = classifySubjectRelevance(item("Мельниченко, Андрей", LIST_PAGE), SUBJECT);
    expect(d.decision).not.toBe("OTHER_SUBJECT");
    expect(d.decision).toBe("AMBIGUOUS");
    expect(d.reasonCode).toBe("mixed_identity_signals");
  });

  it("Н7: реестровая карточка тёзки «Андрей Григорьевич» — по-прежнему «о другом лице»", () => {
    const d = classifySubjectRelevance(
      item(
        "ИП Мельниченко Андрей Григорьевич ИНН 246601197642",
        "ИНН 2460093833ОГРН 1162468051723Дата регистрации 19 января 2016 г."
      ),
      SUBJECT
    );
    expect(d.decision).toBe("OTHER_SUBJECT");
  });

  it("Н6: страница только о тёзке — по-прежнему «о другом лице»", () => {
    const d = classifySubjectRelevance(
      item("Мельниченко Андрей Леонидович", "Мельниченко Андрей Леонидович (род. 1992) — футболист"),
      SUBJECT
    );
    expect(d.decision).toBe("OTHER_SUBJECT");
    expect(d.reasonCode).toBe("patronymic_conflict");
  });
});
