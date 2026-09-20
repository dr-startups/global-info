/**
 * Цитата — высказывание, а не навигация, призыв или обрывок площадки (шаг 0121).
 *
 * Живые отчёты 20.09.2026 напечатали: «Биография · Образование» (меню
 * whoiswho.dp.ru, укороченное нашей же чисткой хвоста издания), кучу
 * заголовков с тег-страницы Independent, оканчивающуюся кнопкой
 * «case.Read more», и две кнопки сервисов проверки — «Проверьте физлицо и
 * исключите риски долгов и банкротства» и «Получите информацию о физлице:
 * задолженности, банкротство…». Словарь в них видит свои слова, читатель —
 * ничего о человеке.
 */

import { describe, expect, it } from "vitest";
import {
  looksLikeCardChrome,
  pageQuoteForClient,
} from "@/modules/digital-profile/orion-golden/analytics/client-quote-hygiene";
import { looksLikeWholeStatement } from "@/modules/digital-profile/orion-golden/analytics/theme-quote";
import {
  cleanExampleTitle,
  quoteForClaim,
} from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";

const NAV_MENU = "Биография · Образование · ДП о персоне.";
const HEADLINE_PILE =
  "Vladimir Potanin · London set for largest ever divorce after oligarch's ex wins appeal · " +
  "Russian billionaire asks Supreme Court to stop ex-wife's divorce case.Read more";

describe("навигация площадки высказыванием не считается", () => {
  it("Н1: меню через «·» и куча заголовков с тег-страницы", () => {
    expect(looksLikeWholeStatement(NAV_MENU)).toBe(false);
    expect(looksLikeWholeStatement("Биография · Образование")).toBe(false);
    expect(looksLikeWholeStatement(HEADLINE_PILE)).toBe(false);
    expect(quoteForClaim(NAV_MENU, 220)).toBe("");
  });

  it("Н2: один «·» внутри живой фразы её не портит", () => {
    const whole = "Тимченко Геннадий Николаевич / «Компания» · Биографии предпринимателей России";
    expect(looksLikeWholeStatement(whole)).toBe(true);
  });

  it("Н3: «Read more» после точки — такой же обрыв, как после многоточия", () => {
    expect(
      looksLikeWholeStatement("Russian billionaire asks the Supreme Court to stop the case.Read more")
    ).toBe(false);
    expect(
      pageQuoteForClient("Russian billionaire asks the Supreme Court to stop the case.Read more")
    ).toBe("");
  });
});

describe("призыв интерфейса не цитируется", () => {
  it("Н4: кнопки сервисов проверки", () => {
    for (const call of [
      "Проверьте физлицо и исключите риски долгов и банкротства.",
      "Получите информацию о физлице: задолженности, банкротство, нахождение в розыске, участие в судах и другие данные.",
      "Узнайте о судебных делах и исполнительных производствах по фамилии.",
      "Скачайте выписку из реестра по этому юридическому лицу.",
    ]) {
      expect(looksLikeWholeStatement(call), call).toBe(false);
      expect(pageQuoteForClient(call), call).toBe("");
    }
  });

  it("Н4б: рассказ о проверке призывом не становится", () => {
    const prose =
      "Компания проверила физлицо и опубликовала сведения о его долгах и банкротстве.";
    expect(looksLikeWholeStatement(prose)).toBe(true);
  });

  it("Н5: «Показать историю» — кнопка карточки", () => {
    expect(looksLikeCardChrome("Индивидуальный предприниматель 1 Показать историю.")).toBe(true);
  });
});

describe("приклеенная подпись снимается и у заголовка", () => {
  it("Н6: «…старшегоИсточник: Starface.ru.» печатается без подписи", () => {
    const raw = "Алена Бондарчук — дочь Сергея Бондарчука-старшегоИсточник: Starface.ru.";
    expect(cleanExampleTitle(raw)).toBe("Алена Бондарчук — дочь Сергея Бондарчука-старшего");
    expect(quoteForClaim(raw, 220)).toBe("Алена Бондарчук — дочь Сергея Бондарчука-старшего");
  });
});
