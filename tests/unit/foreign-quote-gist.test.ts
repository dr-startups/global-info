/**
 * Иноязычная цитата остаётся дословной, а рядом идёт короткий вывод по-русски.
 *
 * Переводить цитату нельзя: в кавычках клиенту показали бы слова, которых
 * источник не писал, и неточность перевода стала бы нашим утверждением о факте.
 * Поэтому оригинал не трогаем, а изложение печатаем отдельной строкой «О чём:
 * …» — оно явно наше.
 */

import { describe, expect, it } from "vitest";
import {
  fitStructuredBullet,
  quoteGistLine,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

describe("строка «О чём» под цитатой", () => {
  it("появляется у иноязычной цитаты", () => {
    expect(
      quoteGistLine(
        "Ukraine's Security Service serves Russian rapper Timati with notice of suspicion",
        "Служба безопасности сообщила о подозрении в адрес субъекта"
      )
    ).toBe("О чём: Служба безопасности сообщила о подозрении в адрес субъекта");
  });

  it("у русской цитаты не появляется", () => {
    expect(
      quoteGistLine("Тимати впервые показал новорожденную дочь", "Публикация о рождении дочери")
    ).toBeUndefined();
  });

  it("не появляется, если само изложение не по-русски", () => {
    expect(
      quoteGistLine("Timur Yunusov - IMDb", "Filmography and biography of the subject")
    ).toBeUndefined();
  });

  it("не удваивает цитату, когда «тема» — это её же заголовок", () => {
    // Модель иногда возвращает темой сам заголовок страницы.
    expect(quoteGistLine("Timur Yunusov - IMDb", "Timur Yunusov - IMDb")).toBeUndefined();
    expect(
      quoteGistLine("Timati has been suspected in Ukraine", "Timati has been suspected")
    ).toBeUndefined();
  });

  it("длинное изложение укорачивается, а не выдавливает цитату", () => {
    const line = quoteGistLine("Foreign headline about the subject", "И".repeat(400))!;
    expect(line.length).toBeLessThanOrEqual(170);
    expect(line.startsWith("О чём: ")).toBe(true);
  });
});

describe("пересказ живёт при своей цитате", () => {
  const bullet = [
    "«Криминальные / судебные материалы»",
    "Найдены публикации по теме:",
    "«Ukraine's Security Service serves Russian rapper Timati with notice of suspicion» — источник pravda.com.ua",
    "О чём: служба безопасности сообщила о подозрении в адрес субъекта",
    "«Second foreign headline about the subject» — источник liga.net",
    "О чём: второе издание пишет о том же деле",
    "Где видно: pravda.com.ua, liga.net.",
    "Всего по теме: 2 материала.",
  ].join("\n");

  it("вторую цитату снимают вместе с её пересказом", () => {
    const fitted = fitStructuredBullet(bullet, 260);
    expect(fitted).not.toContain("Second foreign headline");
    expect(fitted).not.toContain("второе издание пишет о том же деле");
  });

  it("осиротевший пересказ не остаётся в блоке", () => {
    const orphan = ["«Тема»", "О чём: пересказ без цитаты выше", "Всего по теме: 1 материал."].join(
      "\n"
    );
    expect(fitStructuredBullet(orphan, 900)).not.toContain("О чём:");
  });

  it("целый блок в бюджете сохраняет и цитату, и её пересказ", () => {
    const fitted = fitStructuredBullet(bullet, 900);
    expect(fitted).toContain("Ukraine's Security Service");
    expect(fitted).toContain("О чём: служба безопасности сообщила");
  });
});
