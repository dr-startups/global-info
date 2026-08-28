/**
 * Опровержение рядом со словом снимает совпадение у обоих потребителей.
 *
 * Предикат снятия в проекте один, и спрашивают его двое: тема материала
 * (`themesFor` в синтезе находок) и оценка строки (`resolveRowAdverse`). До
 * этой работы о нём знала только тема, а строка судилась голым словарём — и
 * заголовок «Уголовное дело прекращено» получал бы «Нежелательный».
 *
 * Отчёт читает сам субъект: ложный «Нежелательный» на опровержении предлагает
 * ему убирать материал, который его оправдывает.
 *
 * Здесь же — второй потребитель списка опровержений: `detectContradictions`
 * читает тот же `denialPatterns`, и его пополнение обязано доезжать до строки
 * противоречия. Одна причина, две поверхности.
 */

import { describe, expect, it } from "vitest";
import { resolveRowAdverse } from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";
import { synthesizeFindings } from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import {
  buildSubjectResolution,
  type SubjectIdentity,
} from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

const CASE_ID = "case-unit-denial";

let seq = 0;
function item(title: string, sourceUrl: string): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `den-${seq}`,
    caseId: CASE_ID,
    reportRunId: "base-run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-08-28T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: "",
    title,
    sourceUrl,
  };
}

const SUBJECT: SubjectIdentity = {
  displayName: "Глинка Сергей Михайлович",
  lastName: "Глинка",
  lastNameVariants: ["glinka"],
  firstNames: ["Сергей", "sergey"],
  patronymics: ["Михайлович"],
  aliases: ["Глинка Сергей Михайлович"],
  strongIdentifiers: ["773800015809"],
  contextIdentifiers: ["бизнесмен"],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [],
  namesakeNoise: [],
};

/** Все материалы считаем принадлежащими субъекту: проверяется не разбор личности. */
function findingsFor(items: RawInventoryItem[]) {
  const resolution = buildSubjectResolution({
    caseId: CASE_ID,
    datasetId: "ds-denial",
    subject: SUBJECT,
    items,
    sourceHashes: ["sha256:test"],
  });
  const byRef = new Map(
    resolution.items.map((i) => [i.evidenceRef, { ...i, decision: "SUBJECT_MATCH" as const }])
  );
  return synthesizeFindings({
    caseId: CASE_ID,
    datasetId: "ds-denial",
    items,
    resolutionByRef: byRef,
    sourceHashes: ["sha256:test"],
  });
}

describe("оценка строки знает об опровержении", () => {
  it("опровержение следом за словом снимает совпадение обычной площадки", () => {
    expect(
      resolveRowAdverse({
        url: "https://news-example.ru/a1",
        domain: "news-example.ru",
        title: "Санкции против компании сняты",
      })
    ).toBe(false);
  });

  it("опровержение снимает совпадение и на мягкой площадке", () => {
    // Мягкая площадка судится сильным подмножеством словаря — ветка другая, а
    // предикат снятия обязан быть тем же.
    expect(
      resolveRowAdverse({
        url: "https://x.com/someone/status/1",
        domain: "x.com",
        title: "Уголовное дело прекращено",
      })
    ).toBe(false);
  });

  it("без опровержения метка остаётся", () => {
    expect(
      resolveRowAdverse({
        url: "https://news-example.ru/a2",
        domain: "news-example.ru",
        title: "Уголовное дело возбуждено",
      })
    ).toBe(true);
  });

  it("список негативных площадок опровержением не снимается", () => {
    // Агрегатор компромата негативен по самому факту публикации: снять метку с
    // такой строки может только человек, а не оборот в её заголовке.
    expect(
      resolveRowAdverse({
        url: "https://rucriminal.info/dosje/1",
        domain: "rucriminal.info",
        title: "Обвинения сняты",
      })
    ).toBe(true);
  });
});

describe("голый квантор метку со строки не снимает", () => {
  /**
   * «нет», «без», «no» — кванторы, а не опровержение факта: в заголовке они
   * относятся к чему угодно («комментариев нет», «без понятых»), и окно в обе
   * стороны отдало бы им соседнее слово словаря. Ошибка здесь той же природы,
   * ради которой работа делается, только в другую сторону: строка про обыск с
   * нарушением перестаёт быть нежелательной.
   */
  const QUANTIFIER_ROWS = [
    "Уголовное дело: комментариев нет",
    "Арест имущества: залога нет",
    "Суд без адвоката: как это было",
    "Обыск в офисе прошёл без понятых",
    "Sanctions review: no comment from the founder",
  ];

  it.each(QUANTIFIER_ROWS)("«%s» остаётся нежелательной", (title) => {
    expect(
      resolveRowAdverse({ url: "https://news-example.ru/q", domain: "news-example.ru", title })
    ).toBe(true);
  });
});

describe("у слов опровержения есть правая граница", () => {
  /**
   * У словаря есть левая граница и нет правой, и на новых формах это стоило бы
   * метки в чужом смысле: «оправдание» — не оправдание кого-то, «отказался» —
   * не отказ суда, «снятое» видео — не снятые обвинения.
   */
  const WRONG_SENSE = [
    "Оправдание коррупции в региональной прессе",
    "Банк отказался комментировать уголовное дело",
    "Снятое при обыске видео",
    "Прекращение расследования вызвало вопросы",
  ];

  it.each(WRONG_SENSE)("«%s» остаётся нежелательной", (title) => {
    expect(
      resolveRowAdverse({ url: "https://news-example.ru/b", domain: "news-example.ru", title })
    ).toBe(true);
  });

  it("законные формы опровержения метку снимают", () => {
    for (const title of ["Уголовные дела прекращены", "Обвиняемый оправдан", "Санкции сняты"]) {
      expect(
        resolveRowAdverse({ url: "https://news-example.ru/c", domain: "news-example.ru", title })
      ).toBe(false);
    }
  });

  it("оборот не переходит через противительный союз", () => {
    // Источник прямо говорит, что негативное продолжается, — метку снимать
    // нечему.
    expect(
      resolveRowAdverse({
        url: "https://news-example.ru/d",
        domain: "news-example.ru",
        title: "Санкции сняты, но расследование продолжается",
      })
    ).toBe(true);
  });
});

describe("тема материала знает об опровержении", () => {
  it("материал с опровержением темы не даёт", () => {
    const cleared = item("Уголовное дело прекращено за отсутствием состава", "https://news-example.ru/b1");
    const result = findingsFor([cleared]);
    const refs = [
      ...result.bundle.findings,
      ...result.ambiguousFindings,
    ].flatMap((f) => f.evidenceRefs);
    expect(refs).not.toContain(`inventory:${cleared.inventoryId}`);
    expect(result.uncategorized.allEvidenceRefs).toContain(`inventory:${cleared.inventoryId}`);
  });

  it("материал без опровержения тему сохраняет", () => {
    const kept = item("Уголовное дело возбуждено", "https://news-example.ru/b2");
    const result = findingsFor([kept]);
    const criminal = result.bundle.findings.find((f) => f.findingId.includes("criminal_legal"));
    expect(criminal?.evidenceRefs).toContain(`inventory:${kept.inventoryId}`);
  });
});

describe("пополнение списка опровержений доезжает до противоречий", () => {
  it("утверждение против «суд отказал» даёт строку противоречия", () => {
    const asserting = item("Установлено, что уголовное дело возбуждено", "https://a-example.ru/1");
    const denying = item(
      "Суд отказал в иске о защите чести; уголовное дело против бизнесмена продолжается",
      "https://b-example.ru/2"
    );
    const result = findingsFor([asserting, denying]);
    const criminal = result.bundle.findings.find((f) => f.findingId.includes("criminal_legal"));
    expect(criminal?.contradictions.map((c) => c.description)).toContain(
      "Источники противоречат друг другу по существу: одни утверждают факт, другие его опровергают."
    );
  });
});
