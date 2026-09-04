import { describe, expect, it } from "vitest";
import {
  undeclaredClientTextDomainHits,
  undeclaredClientTextDomains,
} from "@/modules/digital-profile/orion-golden/deck-sections/section-validation";

/**
 * Отказ ворот называет текст, а не только домен.
 *
 * Прогон DPA-2026-0053 остановился на «sidebar domain not derived from page
 * evidence: xn--80ankme.ru», и по этой строке было **не найти**, откуда домен
 * взялся: в клиентском тексте он печатается читаемым («закон.ru»), а полей у
 * слайда четыре. Две правки подряд чинили не то место — потому что отказ
 * называл следствие и молчал о причине.
 *
 * Теперь он несёт написание, каким домен стоит в тексте, и окно вокруг него.
 */

const ALLOWED = new Set(["pravo.ru"]);

describe("находка ворот несёт своё написание и окружение", () => {
  it("читаемая запись домена названа вместе с машинной", () => {
    const hits = undeclaredClientTextDomainHits(
      "«Закон.ru: судью назначили председателем» — pravo.ru",
      ALLOWED
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.domain).toBe("xn--80ankme.ru");
    expect(hits[0]?.raw).toBe("закон.ru");
    expect(hits[0]?.context).toContain("судью назначили");
  });

  it("окно обрезается, а не печатает весь абзац", () => {
    const long = `${"а".repeat(300)} chuzhoy.com ${"б".repeat(300)}`;
    const hits = undeclaredClientTextDomainHits(long, ALLOWED);
    expect(hits[0]?.context.length).toBeLessThanOrEqual(120);
    expect(hits[0]?.context).toContain("chuzhoy.com");
  });

  it("прежний ответ не изменился: список доменов тот же", () => {
    const text = "«Закон.ru» и chuzhoy.com — pravo.ru";
    expect(undeclaredClientTextDomains(text, ALLOWED)).toEqual(
      undeclaredClientTextDomainHits(text, ALLOWED).map((h) => h.domain)
    );
    expect(undeclaredClientTextDomains(text, ALLOWED)).toEqual([
      "xn--80ankme.ru",
      "chuzhoy.com",
    ]);
  });

  it("домен из улик страницы находкой не становится", () => {
    expect(undeclaredClientTextDomainHits("Источники — pravo.ru.", ALLOWED)).toEqual([]);
  });
});

/**
 * Домен внутри дословной цитаты материала — выведен из улик страницы.
 *
 * Прогон DPA-2026-0053 упёрся в это дважды: заголовок «Закон.ru: судью
 * назначили…» и фрагмент описания «…Court.Read more…». Отчёт печатает их в
 * кавычках как слова самого материала, а не как имя источника — источник он
 * называет отдельно, за кавычками. Ворота же читали любую доменоподобную
 * строку как утверждение об источнике и останавливали сборку всей деки.
 */
describe("цитата материала не выдаёт себя за имя источника", () => {
  const allowed = new Set(["pravo.ru"]);
  const quoted = new Set([
    "закон.ru: судью назначили председателем арбитражного суда",
    "read the decision of the dubai court.read more on the portal",
  ]);

  it("домен из заголовка материала находкой не становится", () => {
    const text = "«Закон.ru: судью назначили председателем арбитражного суда» — pravo.ru: по выдаче.";
    expect(undeclaredClientTextDomainHits(text, allowed, new Set(), quoted)).toEqual([]);
  });

  it("обрывок из описания — тоже", () => {
    const text = "«Материал» — pravo.ru: по заголовку и описанию («Court.Read more on the portal»).";
    expect(undeclaredClientTextDomainHits(text, allowed, new Set(), quoted)).toEqual([]);
  });

  it("домен вне цитаты по-прежнему находка", () => {
    const text = "«Закон.ru: судью назначили председателем арбитражного суда» — chuzhoy.com: по выдаче.";
    expect(
      undeclaredClientTextDomainHits(text, allowed, new Set(), quoted).map((h) => h.domain)
    ).toEqual(["chuzhoy.com"]);
  });

  it("выдуманный моделью домен в кавычках цитатой не считается", () => {
    // Улики такой строки не несут: кавычки сами по себе ничего не разрешают.
    const text = "«Источник: vydumka.example» — pravo.ru.";
    expect(
      undeclaredClientTextDomainHits(text, allowed, new Set(), quoted).map((h) => h.domain)
    ).toEqual(["vydumka.example"]);
  });
});
