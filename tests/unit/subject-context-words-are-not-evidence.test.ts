/**
 * Слова, которыми написан признак субъекта, уликой не являются.
 *
 * Отчёт 85 (председатель Арбитражного суда Краснодарского края): тема
 * «Криминальные / судебные материалы — высокий, 9 из 9 негативных» сложена из
 * слов его собственной должности. В неё вошли карточка самого суда на
 * `checko.ru`, регламент на `consultant.ru` и досье судьи; подсказки «…судья» и
 * «Какая зарплата в арбитражном суде?» помечены «Потенциально негативные
 * публикации». Субъекту предлагали убирать из интернета его же должность.
 *
 * Маска строится только из фраз работодателя и должности: `fact` оператор
 * пишет свободным текстом, и маскировать по нему значило бы дать способ убрать
 * из отчёта настоящий негатив. Семейство слова названо явно — иначе «суд»
 * вышел бы из словаря, а «судья» осталась; «судимость» и «судится» в маску не
 * входят никогда: это событие с человеком, а не название учреждения.
 */

import { describe, expect, it } from "vitest";
import { buildSubjectContextMask } from "@/modules/digital-profile/config/subject-context-words";
import {
  classifyObservationHighlight,
  resolveRowAdverse,
} from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";
import type { SubjectAnchors } from "@/modules/digital-profile/orion-golden/analytics/subject-anchors";
import type { PersistedSerpObservation } from "@/modules/digital-profile/serp-observation/types";

const ANCHORS: SubjectAnchors = {
  birthDate: "1977-11-30",
  phrases: [
    { kind: "employer", text: "Арбитражный Суд Краснодарского края", strong: true },
    { kind: "position", text: "председатель Арбитражного суда Краснодарского края", strong: true },
  ],
  inn: ["231112942662"],
  domains: ["pravo.ru"],
};

const MASK = buildSubjectContextMask(ANCHORS);

const COURT_CARD = {
  url: "https://checko.ru/company/arbitrazhny-sud-krasnodarskogo-kraya-1022301437872",
  domain: "checko.ru",
  title: "АРБИТРАЖНЫЙ СУД КРАСНОДАРСКОГО КРАЯ",
  snippet: "Реквизиты организации, ИНН и ОГРН",
};

const JUDGE_CARD = {
  url: "https://судьироссии.рф/sudii/egorov-aleksey-evgen-evich",
  domain: "судьироссии.рф",
  title: "Судьи России - Егоров Алексей Евгеньевич - Краснодарский край",
  snippet: "Судья арбитражного суда, судебный участок не указан",
};

const SUGGESTION = {
  url: "",
  domain: "",
  title: "какая зарплата в арбитражном суде",
  snippet: "",
};

const REAL_NEGATIVE = {
  url: "https://pravda-mn.com/novosti/item/1145789-arbitrazhnyy-sud-krasnodara-kak-prachechnaya",
  domain: "pravda-mn.com",
  title: "Арбитражный суд Краснодара как прачечная",
  snippet: "Председатель помогает криминалу отмывать миллиарды через банкротства",
};

describe("слова признаков субъекта — не улика", () => {
  it("карточка самого суда без маски негативна, с маской — нет", () => {
    expect(resolveRowAdverse(COURT_CARD)).toBe(true);
    expect(resolveRowAdverse(COURT_CARD, undefined, MASK)).toBe(false);
  });

  it("досье судьи с маской негативным не считается", () => {
    expect(resolveRowAdverse(JUDGE_CARD)).toBe(true);
    expect(resolveRowAdverse(JUDGE_CARD, undefined, MASK)).toBe(false);
  });

  it("подсказка о зарплате в суде с маской негативной не считается", () => {
    expect(resolveRowAdverse(SUGGESTION)).toBe(true);
    expect(resolveRowAdverse(SUGGESTION, undefined, MASK)).toBe(false);
  });

  it("настоящий негатив маской не снимается", () => {
    expect(resolveRowAdverse(REAL_NEGATIVE, undefined, MASK)).toBe(true);
  });

  it("судимость и тяжба в маску не входят", () => {
    const row = {
      url: "https://news-example.ru/a",
      domain: "news-example.ru",
      title: "С Егорова снята судимость",
      snippet: "Решение вступило в силу",
    };
    expect(resolveRowAdverse(row, undefined, MASK)).toBe(true);
  });

  it("без якорей маски нет вовсе", () => {
    expect(buildSubjectContextMask(null)).toBeNull();
    const noPhrases: SubjectAnchors = {
      birthDate: "1977-11-30",
      phrases: [],
      inn: [],
      domains: [],
    };
    expect(buildSubjectContextMask(noPhrases)).toBeNull();
  });

  it("свободный признак оператора маску не расширяет", () => {
    const factAnchors: SubjectAnchors = {
      birthDate: null,
      phrases: [{ kind: "fact", text: "криминал", strong: false }],
      inn: [],
      domains: [],
    };
    const factMask = buildSubjectContextMask(factAnchors);
    expect(factMask).toBeNull();
    const row = {
      url: "https://news-example.ru/b",
      domain: "news-example.ru",
      title: "Криминал в городе",
      snippet: "",
    };
    expect(resolveRowAdverse(row, undefined, factMask)).toBe(true);
  });

  it("тема по словам должности строке не назначается", () => {
    const obs = {
      id: "obs-1",
      ...COURT_CARD,
    } as unknown as PersistedSerpObservation;
    expect(classifyObservationHighlight(obs).riskTheme).toBeTruthy();
    const hl = classifyObservationHighlight(obs, undefined, undefined, MASK);
    expect(hl.isHighlighted).toBe(false);
    expect(hl.riskTheme).toBeNull();
  });
});
