/**
 * Материал о самом субъекте не объявляется материалом об однофамильце.
 *
 * Эвристика «слово после фамилии» считает чужим человеком любую страницу, где
 * следом за фамилией стоит слово длиной от четырёх букв, не равное имени. Пока
 * фамилией субъекта ошибочно было имя («Умар»), она молчала случайно; с верной
 * фамилией «Кремлев» она срабатывает на обычной новостной фразе — «Кремлев
 * рассказал…», «Умар Кремлев возглавил…». Отчёт банку уверенно называл бы
 * материалы о субъекте материалами о другом человеке, а правило проекта прямо
 * обратное: «требует уточнения принадлежности» честнее догадки.
 */

import { describe, expect, it } from "vitest";
import {
  AUTOCOMPLETE_EXPOSURE_GROUPS,
  classifyAutocompleteQuery,
} from "@/modules/digital-profile/evidence-quality/autocomplete-class";
import {
  buildSubjectFingerprint,
  evaluateIdentityDecision,
} from "@/modules/digital-profile/evidence-quality/subject-fingerprint";
import { classifySearchResultRecord } from "@/modules/digital-profile/risk-classifier/result-classifier";

const KREMLEV = buildSubjectFingerprint({ fullName: "Умар Назарович Кремлев" });
const KREMLEV_OGLY = buildSubjectFingerprint({ fullName: "Умар Назарович Кремлев Оглы" });

/** Решения, означающие «это наш субъект». */
const SUBJECT_DECISIONS = ["EXACT_SUBJECT", "LIKELY_SUBJECT", "POSSIBLE_SUBJECT"];

describe("обычная фраза о субъекте не делает его однофамильцем", () => {
  it("глагол после фамилии — не чужое имя", () => {
    for (const text of [
      "Кремлев рассказал о планах федерации",
      "Бизнесмен Кремлев продал долю в компании",
      "Умар Кремлев возглавил федерацию бокса",
      "Президент IBA Умар Кремлев провёл встречу",
    ]) {
      expect(evaluateIdentityDecision(text, KREMLEV).decision).not.toBe("NAMESAKE");
    }
  });

  it("имя субъекта рядом с фамилией даёт решение о субъекте", () => {
    for (const text of [
      "Умар Кремлев возглавил федерацию бокса",
      "Президент IBA Умар Кремлев провёл встречу",
      "Кремлев Умар: интервью о боксе",
    ]) {
      expect(SUBJECT_DECISIONS).toContain(evaluateIdentityDecision(text, KREMLEV).decision);
    }
  });

  it("полное ФИО субъекта с четырёхсловным именем узнаётся точно", () => {
    const decision = evaluateIdentityDecision(
      "Умар Назарович Кремлев — президент федерации бокса",
      KREMLEV_OGLY
    );
    expect(decision.decision).toBe("EXACT_SUBJECT");
  });
});

describe("настоящий однофамилец по-прежнему отсекается", () => {
  it("чужое имя после фамилии остаётся признаком другого человека", () => {
    expect(evaluateIdentityDecision("Кремлев Иван возглавил кооператив", KREMLEV).decision).toBe(
      "NAMESAKE"
    );
    expect(
      evaluateIdentityDecision("Кремлев Ахмед, депутат городского собрания", KREMLEV).decision
    ).toBe("NAMESAKE");
  });

  it("чужое отчество остаётся признаком другого человека", () => {
    const tinkov = buildSubjectFingerprint({ fullName: "Тиньков Олег Юрьевич" });
    expect(
      evaluateIdentityDecision("Тиньков Иван Петрович — фермер из Тверской области", tinkov)
        .decision
    ).toBe("NAMESAKE");
  });

  it("однофамилец без подсказки регистра субъектом всё равно не становится", () => {
    // В сплошном верхнем регистре и в строчном тексте заглавная буква ничего не
    // сообщает, поэтому метка «однофамилец» не ставится — но и субъектом такая
    // строка не признаётся: её отсекает модель принадлежности.
    for (const text of [
      "КРЕМЛЕВ ИВАН ВОЗГЛАВИЛ КООПЕРАТИВ",
      "кремлев иван возглавил кооператив",
    ]) {
      expect(SUBJECT_DECISIONS).not.toContain(evaluateIdentityDecision(text, KREMLEV).decision);
    }
  });
});

describe("подсказка поисковика приходит в нижнем регистре", () => {
  it("чужое отчество распознаётся и без единой заглавной буквы", () => {
    // Признак регистра работает только там, где регистр есть. У подсказок его
    // нет по природе, и держать их обязана ветка отчества — она регистра не
    // читает. Если проверку регистра распространить и на неё, подсказка об
    // однофамильце перестанет называться однофамильной.
    expect(
      classifyAutocompleteQuery("глинка михаил иванович прощание", "Глинка Сергей Михайлович")
    ).toBe("NAMESAKE_QUERY");
    expect(
      classifyAutocompleteQuery(
        "прощание с петербургом михаил иванович глинка",
        "Глинка Сергей Михайлович"
      )
    ).toBe("NAMESAKE_QUERY");
  });

  it("подсказка о другом человеке не переезжает к подсказкам о субъекте", () => {
    for (const [text, subject] of [
      ["кремлев иван биография", "Умар Назарович Кремлев"],
      ["кремлев ахмед депутат", "Умар Назарович Кремлев"],
      ["глинка михаил композитор", "Глинка Сергей Михайлович"],
    ] as Array<[string, string]>) {
      const group = AUTOCOMPLETE_EXPOSURE_GROUPS[classifyAutocompleteQuery(text, subject)];
      expect(group).toBe("adjacent");
    }
  });

  it("подсказка о самом субъекте остаётся подсказкой о субъекте", () => {
    expect(
      AUTOCOMPLETE_EXPOSURE_GROUPS[
        classifyAutocompleteQuery("умар кремлев биография", "Умар Назарович Кремлев")
      ]
    ).toBe("exact");
  });
});

describe("классификатор органической строки отдаёт текст в разбор как есть", () => {
  /**
   * `classifySearchResultRecord` держит рядом две строки: опущенную в нижний
   * регистр (для поиска ключевых слов) и исходную. В разбор личности обязана
   * уходить исходная: признак однофамильца читает заглавную букву, и подмена
   * одной строки на другую выглядит упрощением, а возвращает дефект молча —
   * для каждого органического результата сразу.
   */
  it("новостной заголовок о субъекте не классифицируется как однофамилец", () => {
    for (const title of [
      "Кремлев рассказал о планах федерации бокса",
      "Умар Кремлев возглавил федерацию бокса",
      "Бизнесмен Кремлев продал долю в компании",
    ]) {
      const result = classifySearchResultRecord({
        title,
        snippet: "Материал о президенте федерации бокса.",
        url: "https://example.org/news/1",
        domain: "example.org",
        subjectFullName: "Умар Назарович Кремлев",
      });
      expect(result.classification).not.toBe("NAMESAKE");
    }
  });

  it("заголовок о настоящем однофамильце по-прежнему им и остаётся", () => {
    const result = classifySearchResultRecord({
      title: "Кремлев Иван возглавил кооператив",
      snippet: "Сельхозкооператив в Тверской области.",
      url: "https://example.org/news/2",
      domain: "example.org",
      subjectFullName: "Умар Назарович Кремлев",
    });
    expect(result.classification).toBe("NAMESAKE");
  });
});
