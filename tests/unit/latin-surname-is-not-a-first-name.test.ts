/**
 * Латиница фамилии выводится из фамилии, а не угадывается по транслитерациям.
 *
 * Раскладка личности искала латинское написание фамилии косвенно — как слово,
 * общее для всех строк `transliterations` профиля. В этих строках лежат и
 * транслитерации псевдонимов, поэтому у первого же субъекта с псевдонимом
 * общих слов не остаётся вовсе: латинская фамилия уезжает в список имён, и
 * одно слово начинает удовлетворять сразу и «фамилия названа», и «имя
 * названо».
 *
 * Входы живые: ФИО и псевдонимы кейса прогона DPA-2026-0046 (транслитерации
 * этой цепочки побайтово совпадают с профилем прогона) и субъект золотого
 * кейса из его же фикстуры.
 *
 * Утверждение здесь ровно одно и оно узкое: **написание фамилии, выводимое из
 * самой фамилии, именем не становится**. Написание, приехавшее в профиль
 * псевдонимом («Ivan Iakovlev» при фамилии «Яковлев»), формой фамилии не
 * является ни для одной таблицы, и опознать его можно только догадкой — а
 * догадку этот шаг удаляет, а не заводит. Путь для такого написания в профиле
 * есть, и он проверен ниже: оператор добавляет его в `familyNames`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  matchesToken,
  subjectIdentityFromProfile,
  type ClassifierSubjectProfile,
  type SubjectIdentity,
} from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import { buildSubjectIdentityProfile } from "@/modules/digital-profile/orion-golden/identity/subject-identity-profile-builder";
import { classifierProfileFromIdentityProfile } from "@/modules/digital-profile/services/job-subject-profile";

/**
 * Личность собирается настоящей цепочкой — построитель профиля, адаптер,
 * раскладка. Тесты, собирающие `SubjectIdentity` руками, раскладку не
 * измеряют вовсе: ровно поэтому дефект и жил.
 */
function identityOfCase(subjectName: string, aliases: string[] = []): SubjectIdentity {
  const profile = buildSubjectIdentityProfile({
    caseId: "case-unit-latin-surname",
    subjectName,
    aliases,
  });
  return subjectIdentityFromProfile(classifierProfileFromIdentityProfile(profile));
}

const BORISOV_ALIASES = ["Толя Вайлдвей", "Толя Wildways", "Анатолий Wildways"];

function goldenCaseIdentity(): SubjectIdentity {
  const profile = JSON.parse(
    readFileSync(join(process.cwd(), "fixtures/golden-case/subject-profile.json"), "utf8")
  ) as ClassifierSubjectProfile;
  return subjectIdentityFromProfile(profile);
}

describe("латинское написание фамилии остаётся фамилией", () => {
  it("латиница фамилии субъекта с псевдонимами лежит среди фамилий, а не среди имён", () => {
    const subject = identityOfCase("Борисов Анатолий Анатольевич", BORISOV_ALIASES);

    expect(subject.lastNameVariants).toContain("borisov");
    expect(subject.firstNames).not.toContain("borisov");
  });

  it.each([
    {
      name: "кириллическое ФИО с псевдонимами (живой кейс)",
      subject: () => identityOfCase("Борисов Анатолий Анатольевич", BORISOV_ALIASES),
      // Написания фамилии, которые встречаются в материалах кейса.
      spellings: ["Борисов", "borisov"],
    },
    {
      name: "латинское ФИО (золотой кейс)",
      subject: goldenCaseIdentity,
      spellings: ["Holmström", "Holmstrom"],
    },
    {
      name: "фамилия и имя от одного корня",
      subject: () => identityOfCase("Иванов Иван Иванович"),
      /*
       * Только латиница. Кириллическая пара «Иванов»/«Иван» сталкивается в
       * таблице падежных форм: родительный падеж множественного числа имени
       * «Иван» — это и есть «иванов», поэтому `matchesToken("иванов", "Иван")`
       * истинно и до этого шага, и после. Свойство раскладки этим не
       * измеряется, а морфология здесь не чинится.
       */
      spellings: ["ivanov"],
    },
  ])("написание фамилии, выводимое из фамилии, не является кандидатом в имена: $name", ({ subject, spellings }) => {
    const identity = subject();
    // Материал приходит в классификатор нормализованным (`itemText`), и
    // `matchesToken` рассчитывает именно на такой текст.
    const asText = (spelling: string): string => spelling.toLowerCase().replace(/ё/gu, "е");

    for (const spelling of spellings) {
      const asFirstName = identity.firstNames.filter((n) => matchesToken(asText(spelling), n));
      expect(asFirstName).toEqual([]);

      const asSurname = [identity.lastName, ...identity.lastNameVariants].filter((s) =>
        matchesToken(asText(spelling), s)
      );
      expect(asSurname.length).toBeGreaterThan(0);
    }
  });

  it("транслитерация без псевдонимов не ломается", () => {
    const subject = identityOfCase("Борисов Анатолий Анатольевич");

    expect(subject.lastNameVariants).toContain("borisov");
    expect(subject.firstNames).toContain("anatoliy");
    expect(subject.firstNames).not.toContain("borisov");
  });

  it("псевдонимы без ФИО не порождают фамилию", () => {
    // Субъект-мононим: фамилии профилю неизвестны, и выдумывать её нельзя —
    // удалённую догадку нельзя заменять новой.
    const subject = identityOfCase("Wildways", BORISOV_ALIASES.slice(1));

    expect(subject.lastNameVariants).toEqual([]);
  });

  it("фамилия с «ё» опознаётся в обеих школах транслитерации", () => {
    /*
     * Школ в проекте две, и расходятся они как раз на «ё»: `transliterateRuToLat`
     * (ею профиль порождает свои транслитерации) даёт «fedorov»,
     * `transliterateRuToEn` (ею строятся поисковые запросы) — «fyodorov».
     * В материалах встречаются обе, поэтому обе — формы фамилии; выбрать одну
     * значит оставить половину собственных материалов субъекта без фамилии.
     */
    const subject = identityOfCase("Фёдоров Иван Петрович");

    expect(subject.lastNameVariants).toContain("fedorov");
    expect(subject.lastNameVariants).toContain("fyodorov");
    expect(subject.firstNames).not.toContain("fedorov");
    expect(subject.firstNames).not.toContain("fyodorov");
  });

  it("собственное имя не выпадает из имён, когда начинается на те же буквы, что фамилия", () => {
    /*
     * Сито фамилии сравнивало первые четыре буквы, и у субъекта, чья фамилия
     * произведена от его же имени, оно вычищало из `firstNames` собственное
     * латинское имя. Материал о самом клиенте («Ivan Ivanov charged with
     * fraud») становился «одной фамилией» и уезжал из аудита в приложение.
     * Имена здесь уцелели не потому, что их куда-то добавили: сито сужено до
     * равенства по норме, и «ivan» просто перестал считаться формой фамилии
     * «ivanov». Латинские формы имён по-прежнему приходят единственным путём —
     * из `transliterations` профиля.
     */
    const subject = identityOfCase("Иванов Иван Иванович");

    expect(subject.firstNames).toContain("ivan");
    expect(subject.firstNames).toContain("ivanovich");
    expect(subject.lastNameVariants).toContain("ivanov");
  });

  it("склонённая фамилия из псевдонима остаётся фамилией", () => {
    /*
     * Псевдонимы вводит оператор, и в них фамилия стоит в косвенном падеже
     * («Фонд Борисова»). Кириллическую сторону это не задевало никогда:
     * `matchesToken` порождает падежные формы сама. Латинская же «borisova»
     * приезжала в транслитерациях псевдонима и становилась «именем» — и тогда
     * однофамилица Анна Борисова получала полное совпадение. Формы фамилии
     * выводятся той же таблицей падежей, которой пользуется сопоставление
     * текста, и потом транслитерируются обеими школами.
     */
    const subject = identityOfCase("Борисов Анатолий Анатольевич", [
      ...BORISOV_ALIASES,
      "Фонд Борисова",
    ]);

    expect(subject.firstNames).not.toContain("borisova");
    expect(subject.lastNameVariants).toContain("borisova");
  });

  it("в списке фамилий нет двух написаний, различающихся только регистром", () => {
    // Склейка: регистр и «ё»/«е» различиями не считаются (построитель профиля
    // склеивает только по регистру). Мёртвый дубль — лишняя работа и
    // повод для следующего читателя решить, что различие значимо.
    const variants = goldenCaseIdentity().lastNameVariants;

    const lowered = variants.map((v) => v.toLowerCase());
    expect(lowered).toEqual([...new Set(lowered)]);
  });

  it("чужое написание фамилии становится фамилией, когда его вписали в профиль", () => {
    /*
     * Единственный честный путь для написания, которое не выводится ни одной
     * таблицей: оператор добавляет его в `familyNames` панелью профиля. Пока
     * оно лежит только в псевдонимах, оно остаётся кандидатом в имена —
     * инвариант шага этого не обещает (см. доктекст файла).
     */
    const withSpelling = subjectIdentityFromProfile({
      displayName: "Яковлев Иван Петрович",
      fullNameRu: { lastName: "Яковлев", firstName: "Иван", patronymic: "Петрович" },
      givenNames: ["Иван"],
      familyNames: ["Яковлев", "Iakovlev"],
      patronymics: ["Петрович"],
      aliases: ["Ivan Iakovlev"],
      transliterations: ["yakovlev ivan petrovich", "ivan iakovlev"],
    });

    expect(withSpelling.firstNames).not.toContain("iakovlev");
    expect(withSpelling.lastNameVariants.map((v) => v.toLowerCase())).toContain("iakovlev");
  });
});
