/**
 * Сводка о совпадении в комплаенс-базе написана словами, а не кодами провайдера.
 *
 * Боевой отчёт 28.07 (Тиньков), страница 54, приложение:
 *
 *     «PEP / RCA / watchlist-сигналы»
 *     Найдены материалы, связывающие субъекта с санкционными и мониторинговыми
 *     списками (PEP/RCA): «Темы: sanction, role.oligarch, role.pep, poi.
 *
 * `role.oligarch`, `role.pep`, `poi` — внутренние коды тем OpenSanctions.
 * Клиент видит их дословно, хотя в том же файле лежит таблица, переводящая эти
 * коды в типы риска отчёта (`TOPIC_PREFIX_TO_RISK`). Один вопрос — «что означает
 * эта тема» — и два ответа: таблица перевода и сырой код, вываленный в отчёт.
 *
 * Для документа, который показывают банку, это заметнее прочего: строка
 * машинного вида посреди клиентского текста обесценивает всё остальное.
 *
 * Свойство: в сводке нет кодов провайдера, а смысл темы сохранён.
 */

import { describe, expect, it } from "vitest";
import { summarizeEntity } from "../../src/modules/digital-profile/compliance-providers/open-sanctions-mapping";

/** Коды тем OpenSanctions в том виде, в каком провайдер их отдаёт. */
const RAW_TOPICS = ["sanction", "role.oligarch", "role.pep", "poi"];

/** Форма сущности OpenSanctions: свойства лежат под `properties`. */
function entity(properties: Record<string, string[]>): Record<string, unknown> {
  return { properties };
}

describe("сводка совпадения в комплаенс-базе", () => {
  it("наблюдавшийся случай: коды тем не попадают в текст", () => {
    const text = summarizeEntity(entity({ topics: RAW_TOPICS }));
    for (const code of RAW_TOPICS) {
      expect(text, `код «${code}» остался в клиентском тексте`).not.toContain(code);
    }
  });

  it("смысл темы сохранён словами", () => {
    const text = summarizeEntity(entity({ topics: RAW_TOPICS })).toLowerCase();
    expect(text).toContain("санкцион");
    expect(text).toMatch(/pep|должностн/u);
  });

  it("неизвестный код провайдера не выдаётся за тему", () => {
    // Новая тема провайдера не должна протечь дословно: лучше общая
    // формулировка, чем машинный код в отчёте.
    const text = summarizeEntity(entity({ topics: ["fresh.unknown.topic"] }));
    expect(text).not.toContain("fresh.unknown.topic");
  });

  it("должность называется, а списки считаются", () => {
    const text = summarizeEntity({
      ...entity({ topics: ["role.pep"], position: ["Сенатор"] }),
      datasets: ["us_ofac_sdn", "eu_fsf"],
    });
    expect(text).toContain("Сенатор");
    // Имя набора данных — такой же машинный код, как код темы.
    expect(text).not.toContain("us_ofac_sdn");
    expect(text).toContain("источника в записи: 2");
  });

  it("запись без сведений описывается словами", () => {
    expect(summarizeEntity(entity({}))).toContain("OpenSanctions");
  });
});
