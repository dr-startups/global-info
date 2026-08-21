/**
 * Источник называется полным адресом, и точка к адресу не приклеивается.
 *
 * Замечания владельца к отчёту Прохорова (20.08):
 *
 * — «источник нужно указывать полной ссылкой, а не только домен. А то логика
 *   такая, что „где-то на сайте есть, ищите сами“»;
 * — «youtube.com/watch.» — строка параметров выброшена, и адрес никуда не
 *   ведёт;
 * — «здесь . детектится как конец предложения, хотя это ссылка».
 *
 * Правило одно на весь отчёт: адрес печатается целиком (хост, путь, параметры,
 * якорь — без протокола) и в круглых скобках; знак препинания стоит снаружи.
 */

import { describe, expect, it } from "vitest";
import {
  clientAddress,
  clientAddressText,
  sourceAttribution,
} from "@/modules/digital-profile/orion-golden/client/client-address";
import { clientLink } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

describe("адрес источника", () => {
  it("сохраняет строку параметров — без неё ссылка никуда не ведёт", () => {
    // Ровно тот случай из отчёта: «youtube.com/watch» без `?v=` открывает не
    // ролик, а пустую страницу проигрывателя.
    expect(clientAddress("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "youtube.com/watch?v=dQw4w9WgXcQ"
    );
  });

  it("сохраняет якорь и путь, но не протокол", () => {
    expect(clientAddress("https://lenta.ru/tags/persons/prohorov-mihail/")).toBe(
      "lenta.ru/tags/persons/prohorov-mihail"
    );
    // Домен настоящий: `example.*` отсеивается как демонстрационный, и это
    // отдельное свойство, проверенное ниже.
    expect(clientAddress("http://snob.ru/a/b?x=1&y=2#part3")).toBe(
      "snob.ru/a/b?x=1&y=2#part3"
    );
  });

  it("кириллическая зона печатается кириллицей", () => {
    expect(clientAddress("https://xn--h1ajim.xn--p1ai/persons/1")).toBe("руни.рф/persons/1");
  });

  it("назвать нечего — undefined, а не сломанный текст", () => {
    expect(clientAddress("")).toBeUndefined();
    expect(clientAddress("arsenkin://suggestion/17")).toBeUndefined();
    expect(clientAddress("не адрес вовсе")).toBeUndefined();
    // Демонстрационный домен в отчёт не попадает ни под каким видом.
    expect(clientAddress("https://example.org/a/b")).toBeUndefined();
  });

  it("в тексте адрес стоит в скобках — точка снаружи читается однозначно", () => {
    expect(clientAddressText("https://lenta.ru/tags/persons/prohorov-mihail")).toBe(
      "(lenta.ru/tags/persons/prohorov-mihail)"
    );
    expect(clientAddressText(undefined)).toBeUndefined();
  });

  it("атрибуция называет адрес, когда он известен", () => {
    expect(
      sourceAttribution({ url: "https://msk1.ru/text/world/2026/02/02/76244926/", domain: "msk1.ru" })
    ).toBe(" — источник (msk1.ru/text/world/2026/02/02/76244926)");
  });

  it("адреса нет — называется домен, и источник не пропадает", () => {
    expect(sourceAttribution({ url: undefined, domain: "bizfiles.org" })).toBe(
      " — источник bizfiles.org"
    );
  });

  it("нечего назвать — пустая строка, а не прочерк", () => {
    expect(sourceAttribution({ url: undefined, domain: undefined })).toBe("");
    expect(sourceAttribution({ url: "arsenkin://suggestion/1", domain: "" })).toBe("");
  });

  it("в колонке таблицы параметры снимаются раньше, чем адрес режется", () => {
    // Обрезанный адрес не открывается вовсе, а тот же адрес без параметров
    // ведёт на ту же страницу. Порядок: сначала снять параметры, потом резать.
    const long =
      "https://tadviser.ru/index.php/Персона:Глинка_Сергей_Михайлович?shem=rbrand_ru&utm=1";
    expect(clientLink(long, "tadviser.ru")).toBe(
      "tadviser.ru/index.php/Персона:Глинка_Сергей_Михайлович"
    );
    // Короткий адрес с параметрами помещается целиком — параметры остаются.
    expect(clientLink("https://youtube.com/watch?v=dQw4w9WgXcQ", "youtube.com")).toBe(
      "youtube.com/watch?v=dQw4w9WgXcQ"
    );
    // Не помещается и без параметров — только тогда многоточие.
    expect(clientLink("https://snob.ru/" + "a".repeat(80), "snob.ru")).toMatch(/…$/u);
  });
});
