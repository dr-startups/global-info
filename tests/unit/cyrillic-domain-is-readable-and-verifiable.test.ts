/**
 * Домен в кириллической зоне и читается человеком, и проходит сверку.
 *
 * Боевой отчёт 28.07 (Тиньков), страница 20, таблица позиций:
 *
 *     3  xn--h1ajim.xn--p1ai  Тиньков, Олег Юрьевич — Энциклопедия Руниверсалис
 *
 * Клиент читает машинную запись вместо `руни.рф`. Формально верно, но отчёт
 * показывают человеку, а не резолверу.
 *
 * Сложность здесь в том, что домен участвует в двух ролях сразу. Он печатается
 * клиенту — и он же сверяется с доказательствами страницы: проверка
 * `sidebar domain not derived from page evidence` берёт домены из индекса
 * доказательств, а там они в punycode. Стоит показать кириллицу, не тронув
 * сверку, — и обязательная секция снова отвергнет страницу, как это уже
 * случилось с `xn--h1ajim.xn` (deb9d23), а дека выйдет пустой.
 *
 * Поэтому свойство проверяется целиком: показываем читаемое, сверяем
 * нормализованное, и обе формы обозначают один домен.
 */

import { describe, expect, it } from "vitest";
import { domainToASCII } from "node:url";
import {
  clientReadableDomain,
  clientSafeDomain,
} from "../../src/modules/digital-profile/services/composite-serp-merge";
import { DOMAIN_TOKEN_RE } from "../../src/modules/digital-profile/orion-golden/deck-sections/section-validation";

const PUNYCODE = "xn--h1ajim.xn--p1ai";
const READABLE = "руни.рф";

function tokens(text: string): string[] {
  return [...text.matchAll(new RegExp(DOMAIN_TOKEN_RE.source, DOMAIN_TOKEN_RE.flags))].map(
    (m) => m[0]
  );
}

describe("кириллический домен в отчёте", () => {
  it("клиенту показывается читаемая запись", () => {
    expect(clientReadableDomain(PUNYCODE)).toBe(READABLE);
  });

  it("латинский домен не трогается", () => {
    expect(clientReadableDomain("forbes.ru")).toBe("forbes.ru");
    expect(clientReadableDomain("ru.wikipedia.org")).toBe("ru.wikipedia.org");
  });

  it("демо-домен по-прежнему не называется", () => {
    expect(clientReadableDomain("demo.example")).toBeNull();
    expect(clientSafeDomain("demo.example")).toBeNull();
  });

  it("читаемая запись опознаётся как домен в клиентском тексте", () => {
    // Иначе сверка «домен из доказательств страницы» его просто не увидит.
    const found = tokens(`Источники — ru.wikipedia.org, ${READABLE}, rbc.ru.`);
    expect(found).toContain(READABLE);
    expect(found).toContain("rbc.ru");
  });

  it("обе формы сводятся к одной для сверки", () => {
    // На этом и держится совместимость с индексом доказательств, где домены
    // хранятся в punycode.
    expect(domainToASCII(READABLE)).toBe(PUNYCODE);
    expect(domainToASCII(PUNYCODE)).toBe(PUNYCODE);
  });

  it("даты и числа доменами не становятся", () => {
    expect(tokens("28.07.2026 и 3.14")).toEqual([]);
  });
});
