/**
 * Домен в кириллической зоне опознаётся целиком, а не обрезком.
 *
 * Поймано боевым прогоном 28.07 (Тиньков, полный аудит). Обязательная секция
 * `RU_SERP` не прошла проверку:
 *
 *     sidebar domain not derived from page evidence
 *     on p09_ru_serp_table: xn--h1ajim.xn
 *
 * В тексте страницы стояло «Источники — ru.wikipedia.org, rbc.ru,
 * xn--h1ajim.xn--p1ai, news.mail.ru и ещё 1», то есть домен в зоне `.рф`
 * (punycode `xn--p1ai`). Он **есть** среди доказательств страницы, но проверка
 * вырезала из него `xn--h1ajim.xn` — такого домена не существует, в
 * доказательствах его, разумеется, нет, и секция была отвергнута.
 *
 * Дека при этом не собралась вовсе: `pageCount: 0`. То есть любой отчёт, где
 * среди источников попался сайт в зоне `.рф`, клиенту не доходил.
 *
 * Причина: выражение требовало, чтобы последняя метка домена состояла только
 * из букв (`\.[a-z]{2,}`), а у punycode-зоны она выглядит как `xn--p1ai` — с
 * цифрами и дефисами. Рядом, в том же файле, домен вырезается другим
 * выражением, которое punycode понимает: на вопрос «что такое домен» отвечали
 * двое, и ответы разошлись.
 *
 * Свойство: домен опознаётся целиком — и в латинской зоне, и в кириллической.
 */

import { describe, expect, it } from "vitest";
import { DOMAIN_TOKEN_RE } from "../../src/modules/digital-profile/orion-golden/deck-sections/section-validation";

function tokens(text: string): string[] {
  return [...text.matchAll(new RegExp(DOMAIN_TOKEN_RE.source, DOMAIN_TOKEN_RE.flags))].map(
    (m) => m[0]
  );
}

/** Ровно та строка, что стояла на странице боевого прогона. */
const SOURCE_NOTE =
  "Источники — ru.wikipedia.org, rbc.ru, xn--h1ajim.xn--p1ai, news.mail.ru и ещё 1.";

describe("опознание домена в клиентском тексте", () => {
  it("наблюдавшийся случай: punycode-зона не режется пополам", () => {
    const found = tokens(SOURCE_NOTE);
    expect(found).toContain("xn--h1ajim.xn--p1ai");
    // Обрезок не должен появляться вовсе: именно он и не находился среди
    // доказательств страницы.
    expect(found).not.toContain("xn--h1ajim.xn");
  });

  it("обычные домены опознаются как прежде", () => {
    const found = tokens(SOURCE_NOTE);
    expect(found).toContain("ru.wikipedia.org");
    expect(found).toContain("rbc.ru");
    expect(found).toContain("news.mail.ru");
  });

  it("punycode-домен целиком и сам по себе", () => {
    expect(tokens("см. xn--80aswg.xn--p1ai")).toEqual(["xn--80aswg.xn--p1ai"]);
  });

  it("даты и числа доменами не считаются", () => {
    // Ради этого выражение и требовало буквенную зону — свойство сохраняем.
    expect(tokens("28.07.2026 и 3.14")).toEqual([]);
  });

  it("слово с точкой в конце предложения доменом не становится", () => {
    expect(tokens("Проверить статусы дел.")).toEqual([]);
  });
});
