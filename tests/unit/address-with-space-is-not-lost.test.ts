/**
 * Адрес с пробелом доезжает до клиента целиком.
 *
 * `parseClientAddress` раскодирует путь, поэтому `%20` превращается в пробел:
 * `interfax.ru/tags/%D0%A2%D0%B0%D1%82%D1%8C%D1%8F%D0%BD%D0%B0%20%D0%9A%D0%B8%D0%BC`
 * читается как `interfax.ru/tags/Татьяна Ким`. Пробел в адресе — прямое
 * следствие раскодирования, а не редкость.
 *
 * `SOURCE_ATTRIBUTION_SOURCE` описывал хвост адреса как «непробельные знаки и
 * скобка», поэтому совпадение обрывалось на хосте. `reflowThemeBullet`
 * пересобирает буллет из совпадений и всё, что между ними, выбрасывал молча —
 * на живом отчёте 21.08 клиент читал `— источник (interfax.ru «Глава…`:
 * незакрытая скобка и минус 18 знаков адреса.
 */

import { describe, expect, it } from "vitest";
import {
  SOURCE_ATTRIBUTION_SOURCE,
  sourceAttribution,
  sourceHostFromMatch,
} from "@/modules/digital-profile/orion-golden/client/client-address";
import { reflowThemeBullet } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

/** Форма живого буллета прогона 21.08; лицо и тема заменены. */
const BULLET_WITH_SPACED_ADDRESS =
  "Деловые связи, владение и контрагенты. Найдены публикации о связях: " +
  "«Суд отказал заявителю во взыскании с контрагента по договору поставки» — " +
  "источник (example-news.ru/tags/Иван Иванов) " +
  "«Компания обратилась за компенсацией в профильное министерство и получила отказ.» — " +
  "источник (other-news.ru/news/kompensacii-2026-07-26) " +
  "В материале сообщается о связанных обстоятельствах.";

const BULLET_WITH_NESTED_PARENS =
  "Профиль в справочнике. Найдены публикации о профиле: " +
  "«Карточка персоны в отраслевой энциклопедии заведена и дополняется» — " +
  "источник (tadviser.com/index.php/Person:Ivan_Ivanov_(formerly_Petrov)) " +
  "«Вторая карточка ведёт на тот же профиль и повторяет сведения.» — " +
  "источник (tadviser.ru/index.php/Персона:Иванов) " +
  "Сведения требуют проверки.";

describe("адрес источника с пробелом", () => {
  it("целиком входит в совпадение выражения", () => {
    const re = new RegExp(SOURCE_ATTRIBUTION_SOURCE, "gu");
    const m = [...`— источник (example-news.ru/tags/Иван Иванов) дальше`.matchAll(re)];
    expect(m).toHaveLength(1);
    expect(m[0]![0]).toBe("— источник (example-news.ru/tags/Иван Иванов)");
    expect(sourceHostFromMatch(m[0]!)).toBe("example-news.ru");
  });

  it("не теряется при пересборке буллета", () => {
    const out = reflowThemeBullet(BULLET_WITH_SPACED_ADDRESS);
    expect(out).toContain("(example-news.ru/tags/Иван Иванов)");
    // Ничего не выброшено: пересборка только расставляет переносы.
    for (const piece of ["Иван Иванов", "kompensacii-2026-07-26", "связанных обстоятельствах"]) {
      expect(out).toContain(piece);
    }
  });

  it("вложенная скобка внутри адреса не рвёт строку", () => {
    const out = reflowThemeBullet(BULLET_WITH_NESTED_PARENS);
    expect(out).toContain("(tadviser.com/index.php/Person:Ivan_Ivanov_(formerly_Petrov))");
    expect(out).toContain("(tadviser.ru/index.php/Персона:Иванов)");
  });

  it("голая форма без скобок не захватывает чужую скобку дальше по тексту", () => {
    const re = new RegExp(SOURCE_ATTRIBUTION_SOURCE, "gu");
    const m = [...`— источник bizfiles.org. Всего по теме: 2 материала (см. приложение)`.matchAll(re)];
    expect(m).toHaveLength(1);
    // Хвостовая точка — знак препинания предложения; в имя площадки она не входит.
    expect(m[0]![0]).toBe("— источник bizfiles.org.");
    expect(sourceHostFromMatch(m[0]!)).toBe("bizfiles.org");
    expect(m[0]![0]).not.toContain("приложение");
  });
});

describe("знак препинания после адреса", () => {
  /*
   * Цитата с вложенными кавычками под `«[^»]{8,}»` не подходит, поэтому
   * остаток уходит в хвост — и точка предыдущего предложения начинала собой
   * новую строку. В абзаце это читается как «(адрес) . «Цитата…».
   */
  const BULLET_WITH_NESTED_GUILLEMETS =
    "Долги и регистрационные сведения. Найдены публикации о долгах: " +
    "«Арбитражные дела с участием предпринимателя» — источник (registry.example/ip/1234567890). " +
    "«Партнёры в прошлом году выводили ликвидность, оставляя компанию с «пустыми карманами».» — " +
    "источник (explainer.example/materials/dengi) Процитированы 2 публикации сюжета из 4 прочитанных.";

  it("остаётся на строке своего предложения", () => {
    const out = reflowThemeBullet(BULLET_WITH_NESTED_GUILLEMETS);
    const lines = out.split("\n");
    expect(lines.some((l) => /^[.,;:]/u.test(l.trim()))).toBe(false);
    expect(out).toContain("(registry.example/ip/1234567890).");
  });
});

describe("текст между цитатами", () => {
  /*
   * Буллет пересобирается из совпадений, поэтому всё, что стоит между ними,
   * держится только тем, что кто-то его назвал. Пока названа была одна строка
   * «О чём: …», остальное исчезало молча — и это дороже, чем выглядит: молча
   * пропавшее клиентское предложение не поднимает ни одних ворот.
   */
  const BULLET_WITH_PROSE_BETWEEN_QUOTES =
    "Судебные споры. Найдены публикации по теме: " +
    "«Суд первой инстанции отказал заявителю в удовлетворении требований» — источник (one.example/case/1) " +
    "Обе публикации описывают один эпизод и расходятся в сумме требований. " +
    "«Апелляция оставила решение без изменения и подтвердила выводы суда» — источник (two.example/case/2) " +
    "Сведения требуют проверки.";

  it("не пропадает при пересборке", () => {
    const out = reflowThemeBullet(BULLET_WITH_PROSE_BETWEEN_QUOTES);
    expect(out).toContain("Обе публикации описывают один эпизод и расходятся в сумме требований.");
    expect(out).toContain("(one.example/case/1)");
    expect(out).toContain("(two.example/case/2)");
  });

  it("«О чём:» остаётся частным случаем общего правила, а не веткой", () => {
    const out = reflowThemeBullet(
      BULLET_WITH_PROSE_BETWEEN_QUOTES.replace(
        "Обе публикации описывают один эпизод и расходятся в сумме требований.",
        "О чём: обе публикации описывают один эпизод."
      )
    );
    expect(out).toContain("О чём: обе публикации описывают один эпизод.");
  });
});

describe("пробел в адресе приходит из раскодирования", () => {
  it("%20 в ссылке становится пробелом в напечатанном источнике", () => {
    // Именно так выглядит живая ссылка тега: пробел в адресе — следствие
    // `decodeURIComponent`, а не редкий случай.
    const printed = sourceAttribution({
      url: "https://www.interfax.ru/tags/%D0%A2%D0%B0%D1%82%D1%8C%D1%8F%D0%BD%D0%B0%20%D0%9A%D0%B8%D0%BC/",
      domain: "interfax.ru",
    });
    expect(printed).toBe(" — источник (interfax.ru/tags/Татьяна Ким)");

    const re = new RegExp(SOURCE_ATTRIBUTION_SOURCE, "gu");
    const m = [...printed.matchAll(re)];
    expect(m).toHaveLength(1);
    expect(m[0]![0].trim()).toBe(printed.trim());
    expect(sourceHostFromMatch(m[0]!)).toBe("interfax.ru");
  });
});
