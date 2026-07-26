import { describe, expect, it } from "vitest";
import {
  dropGluedSecondFragment,
  isQuotableEvidence,
  looksLikeSearchQuery,
  stripPromotionalTail,
} from "../../src/modules/digital-profile/orion-golden/analytics/client-quote-hygiene";
import {
  isPublicUrl,
  publicDomainOf,
} from "../../src/modules/digital-profile/orion-golden/analytics/public-domain";

/**
 * Шаг 13, этап 2.
 *
 * Отчёт читает живой человек. В него попадали рекламная обвязка YouTube,
 * голые адреса и строки поискового автодополнения, поданные как материалы с
 * источником «suggestion».
 */

describe("рекламная обвязка не является содержанием", () => {
  it("режет призыв подписаться, оставляя суть", () => {
    // Ровно фрагмент из живого прогона, стоявший в разделе о финансовой
    // прозрачности.
    const raw =
      "Pavel Durov Co-founder, CEO, Telegram at Oslo Freedom Forum 2026: " +
      "Join this channel to get access to perks: https://www.youtube.com/channel";
    expect(stripPromotionalTail(raw)).toBe(
      "Pavel Durov Co-founder, CEO, Telegram at Oslo Freedom Forum 2026"
    );
  });

  it("убирает голый адрес из клиентской прозы", () => {
    expect(stripPromotionalTail("Смотрите разбор https://example.com/x подробнее")).toBe(
      "Смотрите разбор подробнее"
    );
  });

  it("срезает хвост из хештегов", () => {
    expect(stripPromotionalTail("Интервью основателя #telegram #durov #crypto")).toBe(
      "Интервью основателя"
    );
  });

  it("русскую обвязку тоже узнаёт", () => {
    expect(stripPromotionalTail("Дуров о будущем Telegram. Подписывайтесь на канал!")).toBe(
      "Дуров о будущем Telegram."
    );
  });

  it("отбрасывает второй фрагмент, приклеенный через многоточие", () => {
    // Двуязычный дубль одного ролика: читателю это выглядит как сбой.
    const raw =
      "Павел Дуров СЛУЧАЙНО сделал экосистему для онлайн казино ... " +
      "Pavel Durov ACCIDENTALLY created an ecosystem for online casinos on Telegram.";
    expect(dropGluedSecondFragment(raw)).toBe(
      "Павел Дуров СЛУЧАЙНО сделал экосистему для онлайн казино"
    );
  });

  it("обычную обрезку в конце не трогает", () => {
    const raw = "Павел Дуров: биография, дети и личная жизнь... - Новости Mail";
    expect(dropGluedSecondFragment(raw)).toBe(raw);
    const tail = "Интервью Павла Дурова 2025 - Об аресте и тюрьме во ...";
    expect(dropGluedSecondFragment(tail)).toBe(tail);
  });

  it("короткие куски склейкой не считает", () => {
    expect(dropGluedSecondFragment("Дуров ... суд")).toBe("Дуров ... суд");
  });

  it("содержательный текст не трогает", () => {
    const text = "Французские власти предъявили Павлу Дурову предварительные обвинения.";
    expect(stripPromotionalTail(text)).toBe(text);
  });

  it("пустое и мусорное цитировать нельзя", () => {
    expect(isQuotableEvidence("Join this channel to get access to perks")).toBe(false);
    expect(isQuotableEvidence("https://youtube.com/channel")).toBe(false);
    expect(isQuotableEvidence("")).toBe(false);
    expect(isQuotableEvidence("12345 67890 12345")).toBe(false);
  });

  it("содержательное цитировать можно", () => {
    expect(
      isQuotableEvidence("Французские власти предъявили Павлу Дурову обвинения.")
    ).toBe(true);
  });
});

describe("поисковый запрос отличается от заголовка публикации", () => {
  it("узнаёт строку автодополнения", () => {
    expect(looksLikeSearchQuery("pavel valeryevich durov arrested")).toBe(true);
    expect(looksLikeSearchQuery("дуров павел за что арестовали")).toBe(true);
    expect(looksLikeSearchQuery("дуров суд сегодня")).toBe(true);
  });

  it("заголовок публикации запросом не считает", () => {
    // Заглавная буква, кавычки или конечная пунктуация — признаки заголовка.
    expect(looksLikeSearchQuery("Кто такой Павел Дуров, и чем его арест грозит Казахстану")).toBe(
      false
    );
    expect(looksLikeSearchQuery("Дуров покинул здание суда.")).toBe(false);
    expect(looksLikeSearchQuery("Статья про «ВКонтакте»")).toBe(false);
  });

  it("длинный текст запросом не считает", () => {
    expect(looksLikeSearchQuery("a".repeat(120))).toBe(false);
  });

  it("пустое и бессловесное запросом не считает", () => {
    expect(looksLikeSearchQuery("")).toBe(false);
    expect(looksLikeSearchQuery("12345")).toBe(false);
  });
});

describe("домен публикации", () => {
  it("служебная схема доменом не является", () => {
    // Отсюда бралось «(suggestion)» и «— источник suggestion».
    expect(publicDomainOf("arsenkin://suggestion/obs-123")).toBe("");
    expect(publicDomainOf("arsenkin://other/obs-1")).toBe("");
    expect(isPublicUrl("arsenkin://suggestion/obs-123")).toBe(false);
  });

  it("публичный адрес даёт домен без www", () => {
    expect(publicDomainOf("https://www.Kommersant.ru/doc/1")).toBe("kommersant.ru");
    expect(isPublicUrl("http://tass.ru/x")).toBe(true);
  });

  it("хост без точки доменом не считается", () => {
    expect(publicDomainOf("http://localhost:3000/x")).toBe("");
  });

  it("пустое и битое не роняет", () => {
    expect(publicDomainOf(undefined)).toBe("");
    expect(publicDomainOf("не адрес")).toBe("");
    expect(publicDomainOf("https://")).toBe("");
  });
});
