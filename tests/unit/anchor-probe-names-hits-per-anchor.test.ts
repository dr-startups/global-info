/**
 * Проба якорей: где именно сработал каждый признак.
 *
 * Панель персон показывала оператору пять карточек Википедии и блок «выдача
 * рядом» без сниппетов — по нему нельзя было ни узнать субъекта, ни выбрать
 * его. Прогон DPA-2026-0049: судья в панель не попал, оператор ответил
 * «различимой персоны нет», и отчёт собрал четырёх разных людей.
 *
 * Проба отвечает на два вопроса по строкам, которые панель и так купила:
 * какой якорь на какой строке найден и на каких строках стоят признаки другого
 * человека. Ответ — адресами, чтобы оператор мог проверить его глазами.
 */

import { describe, expect, it } from "vitest";
import { checkAnchorsInProbe } from "@/modules/digital-profile/services/persona-anchor-probe";
import type { SubjectAnchors } from "@/modules/digital-profile/orion-golden/analytics/subject-anchors";

const ANCHORS: SubjectAnchors = {
  birthDate: "1977-11-30",
  phrases: [
    { kind: "employer", text: "Арбитражный суд Краснодарского края", strong: true },
    { kind: "education", text: "Кубанский государственный аграрный университет", strong: true },
  ],
  inn: [],
  domains: ["krasnodar.arbitr.ru"],
};

const ROWS = [
  {
    title: "Судья Егоров Алексей Евгеньевич на портале Право.ру",
    snippet: "Родился 30.11.1977г. в ст.Красноармейской Краснодарского края",
    url: "https://pravo.ru/arbitr_practice/judge/1465/",
    domain: "pravo.ru",
    engine: "GOOGLE" as const,
  },
  {
    title: "Егоров Алексей Евгеньевич Председатель суда",
    snippet: "Арбитражный суд Краснодарского края — официальный сайт",
    url: "https://krasnodar.arbitr.ru/about/mode/judges",
    domain: "krasnodar.arbitr.ru",
    engine: "YANDEX" as const,
  },
  {
    title: "Егоров Алексей Евгеньевич, офтальмолог — ПроДокторов",
    snippet: "Приём в Подольске, стаж 31 год",
    url: "https://prodoctorov.ru/podolsk/vrach/380102-egorov/",
    domain: "prodoctorov.ru",
    engine: "YANDEX" as const,
  },
  {
    title: "Егоров Алексей Евгеньевич - Структура городской Думы Краснодара",
    snippet: "Родился: 10 августа 1983 года в п. Чегдомын",
    url: "https://krd.ru/gorodskaya-duma/struktura/",
    domain: "krd.ru",
    engine: "GOOGLE" as const,
  },
  {
    title: "ИП Егоров Алексей Евгеньевич, Опочка",
    snippet: "ИНН 772809603828, выписка из ЕГРИП",
    url: "https://rusprofile.ru/ip/306603112500025",
    domain: "rusprofile.ru",
    engine: "GOOGLE" as const,
  },
];

describe("проба якорей", () => {
  const probe = checkAnchorsInProbe({ anchors: ANCHORS, rows: ROWS });

  it("называет строки, на которых сработал каждый якорь", () => {
    const byAnchor = new Map(probe.hits.map((h) => [h.anchor, h]));
    expect(byAnchor.get("1977-11-30")?.rows.map((r) => r.url)).toEqual([
      "https://pravo.ru/arbitr_practice/judge/1465/",
    ]);
    // Фраза целиком стоит только на сайте суда: у строки Право.ру в сниппете
    // «Краснодарского края» есть, а «арбитражного» нет — и это верно, часть
    // фразы совпадением не является.
    expect(byAnchor.get("Арбитражный суд Краснодарского края")?.rows.map((r) => r.domain)).toEqual([
      "krasnodar.arbitr.ru",
    ]);
    expect(byAnchor.get("krasnodar.arbitr.ru")?.rows).toHaveLength(1);
  });

  it("якорь без единого попадания назван отдельно — его надо переписать", () => {
    expect(probe.missing).toEqual(["Кубанский государственный аграрный университет"]);
  });

  it("строки с признаками другого человека названы с причиной", () => {
    expect(probe.conflicts).toEqual([
      expect.objectContaining({ url: "https://krd.ru/gorodskaya-duma/struktura/", reason: "foreign_birth_date", value: "10 августа 1983" }),
      // Свой ИНН оператор не назвал: строка не «о другом лице», а «нечем сверить».
      expect.objectContaining({
        url: "https://rusprofile.ru/ip/306603112500025",
        reason: "registry_inn_unverified",
        value: "772809603828",
      }),
    ]);
  });

  it("строка без якоря и без конфликта остаётся просто строкой", () => {
    const urls = new Set([
      ...probe.hits.flatMap((h) => h.rows.map((r) => r.url)),
      ...probe.conflicts.map((c) => c.url),
    ]);
    expect(urls.has("https://prodoctorov.ru/podolsk/vrach/380102-egorov/")).toBe(false);
    expect(probe.unmatchedRows.map((r) => r.domain)).toEqual(["prodoctorov.ru"]);
  });

  it("при названном своём ИНН чужой становится признаком другого лица", () => {
    const withInn = checkAnchorsInProbe({
      anchors: { ...ANCHORS, inn: ["231112942662"] },
      rows: ROWS,
    });
    expect(withInn.conflicts).toContainEqual(
      expect.objectContaining({ domain: "rusprofile.ru", reason: "foreign_inn" })
    );
  });

  it("без якорей проба ничего не утверждает", () => {
    const empty = checkAnchorsInProbe({
      anchors: { birthDate: null, phrases: [], inn: [], domains: [] },
      rows: ROWS,
    });
    expect(empty.hits).toEqual([]);
    expect(empty.conflicts).toEqual([]);
    expect(empty.unmatchedRows).toHaveLength(ROWS.length);
  });
});
