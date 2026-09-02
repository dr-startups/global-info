/**
 * Порядок частей ФИО определяется отчеством, а не позицией.
 *
 * На живом прогоне имя «Умар Назарович Кремлев» разобралось как
 * `lastName: "Умар", firstName: "Назарович", patronymic: "Кремлев"` — это
 * дословное содержимое `subject-identity-profile.json` того прогона. Дальше
 * фамилией весь сбор считал слово «Умар»: по нему строились платные запросы и
 * им же проверялась принадлежность 971 наблюдения.
 */

import { describe, expect, it } from "vitest";
import {
  buildNormalizedSubjectIdentity,
  evaluateEntityMatch,
  parseSubjectName,
} from "@/modules/digital-profile/risk-classifier/entity-disambiguation";
import { parseRuFullName } from "@/modules/digital-profile/orion-golden/identity/subject-identity-profile-builder";

describe("разбор ФИО опирается на отчество", () => {
  it("«Имя Отчество Фамилия»: у «Умар Назарович Кремлев» фамилия — Кремлев", () => {
    const parsed = parseSubjectName("Умар Назарович Кремлев");

    expect(parsed.surname).toBe("Кремлев");
    expect(parsed.givenName).toBe("Умар");
    expect(parsed.patronymic).toBe("Назарович");
  });

  it("профиль субъекта пишет ту же фамилию, что и общий разбор", () => {
    // Ровно то поле, которое в живом прогоне оказалось равно «Умар».
    expect(parseRuFullName("Умар Назарович Кремлев")).toMatchObject({
      lastName: "Кремлев",
      firstName: "Умар",
      patronymic: "Назарович",
    });
  });

  it("оба порядка записи одного имени дают один разбор", () => {
    const fio = parseSubjectName("Кремлев Умар Назарович");
    const ipf = parseSubjectName("Умар Назарович Кремлев");

    expect(ipf.surname).toBe(fio.surname);
    expect(ipf.givenName).toBe(fio.givenName);
    expect(ipf.patronymic).toBe(fio.patronymic);
  });

  it("«Фамилия Имя Отчество» разбирается как прежде", () => {
    expect(parseSubjectName("Рашников Виктор Филиппович")).toMatchObject({
      surname: "Рашников",
      givenName: "Виктор",
      patronymic: "Филиппович",
    });
    expect(parseSubjectName("Тиньков Олег Юрьевич")).toMatchObject({
      surname: "Тиньков",
      givenName: "Олег",
      patronymic: "Юрьевич",
    });
  });

  it("поля разбора несут по одному токену, а хвост имени в них не заходит", () => {
    // Строка с пробелом в поле сравнивается с текстом подстрокой, а с токенами
    // подсказки — вообще никогда: «Кремлев Оглы» не найдётся ни там, ни там.
    const four = parseSubjectName("Иванов Иван Иванович Оглы");
    expect(four.surname).toBe("Иванов");
    expect(four.givenName).toBe("Иван");
    expect(four.patronymic).toBe("Иванович");

    const fourGivenFirst = parseSubjectName("Умар Назарович Кремлев Оглы");
    expect(fourGivenFirst.surname).toBe("Кремлев");
    expect(fourGivenFirst.givenName).toBe("Умар");
    expect(fourGivenFirst.patronymic).toBe("Назарович");

    for (const field of [four.surname, four.givenName, four.patronymic]) {
      expect(field).not.toContain(" ");
    }
  });

  it("материалы субъекта с четырёхсловным именем не становятся однофамильцем", () => {
    const subject = buildNormalizedSubjectIdentity({ fullName: "Иванов Иван Иванович Оглы" });
    expect(subject.expectedPatronymic).toBe("иванович");

    const match = evaluateEntityMatch({
      text: "Иванов Иван Иванович — предприниматель, владелец сети магазинов",
      subject,
      region: "RU",
    });
    expect(match.decision).toBe("strict_subject");
    expect(match.patronymicStatus).toBe("match");
  });

  it("многословное имя не мешает узнать фамилию в тексте", () => {
    const subject = buildNormalizedSubjectIdentity({ fullName: "Умар Назарович Кремлев Оглы" });

    const match = evaluateEntityMatch({
      text: "Умар Назарович Кремлев — президент федерации бокса",
      subject,
      region: "RU",
    });
    expect(match.missingCriticalTokens).not.toContain("last_name");
    expect(match.decision).toBe("strict_subject");
  });

  it("фамилия на -ич не принимается за отчество", () => {
    // Узкий список суффиксов существует ровно для этого: голый «ич» ловит
    // балканские фамилии, и «Джокович» стал бы отчеством на первой позиции.
    expect(parseSubjectName("Джокович Новак Иванович")).toMatchObject({
      surname: "Джокович",
      givenName: "Новак",
      patronymic: "Иванович",
    });
    expect(parseSubjectName("Петров Иван Ивич")).toMatchObject({
      surname: "Петров",
      givenName: "Иван",
      patronymic: "Ивич",
    });
  });

  it("латинское двухсловное имя: фамилия впереди тоже узнаётся по суффиксу", () => {
    // Латинский алиас предпочтительнее транслитерации, а он приходит в порядке
    // «Фамилия Имя»; на нём дефект шага воспроизводился целиком.
    expect(parseSubjectName("Tinkov Oleg")).toMatchObject({
      surname: "Tinkov",
      givenName: "Oleg",
    });
    expect(parseSubjectName("Kremlev Umar")).toMatchObject({
      surname: "Kremlev",
      givenName: "Umar",
    });
    // Западные имена при этом остаются именем-фамилией: «-in» в списке нет,
    // а «Eva» короче порога — иначе фамилией стало бы имя.
    expect(parseSubjectName("Kevin Martin").surname).toBe("Martin");
    expect(parseSubjectName("Eva Green").surname).toBe("Green");
    expect(parseSubjectName("Anders Holmström").surname).toBe("Holmström");
  });

  it("двухтокенное имя: фамилия узнаётся по суффиксу, а не по месту", () => {
    expect(parseSubjectName("Anders Holmström")).toMatchObject({
      surname: "Holmström",
      givenName: "Anders",
    });
    expect(parseSubjectName("Умар Кремлев")).toMatchObject({
      surname: "Кремлев",
      givenName: "Умар",
    });
    expect(parseSubjectName("Тиньков Олег")).toMatchObject({
      surname: "Тиньков",
      givenName: "Олег",
    });
  });

  it("отчество субъекта попадает в expectedPatronymic, а не фамилия", () => {
    const identity = buildNormalizedSubjectIdentity({ fullName: "Умар Назарович Кремлев" });

    expect(identity.expectedPatronymic).toBe("назарович");
    expect(identity.ruLastName).toBe("Кремлев");
    expect(identity.ruFirstName).toBe("Умар");
  });
});
