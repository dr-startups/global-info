/**
 * Phase A.2 (PDF_REVIEW_31_ANALYSIS) — Russian meta-speak from the LLM
 * pipeline («черновик», «переданный фрагмент», scoped/findings echoes)
 * must be rejected by the client-text contract, so GPT slide copy falls
 * back to the deterministic draft instead of leaking prompt language.
 *
 * Real leaks reproduced from rendered-client (31).pdf pp. 13, 19, 20, 22, 32.
 */

import { describe, expect, it } from "vitest";
import { scanOrionGoldenClientTextForForbiddenTokens } from "../../src/modules/digital-profile/orion-golden/client/client-text-sanitizer";
import { getClientTextContract } from "../../src/modules/digital-profile/orion-golden/client/load-client-text-contract";

const LEAKED_FROM_REPORT_31 = [
  // p32 — prompt instruction echoed verbatim to the client
  "Для страницы метрик покрытия в переданном черновике не приведены отдельные показатели, график или расшифровка визуального блока.",
  // p13
  "В переданном фрагменте присутствуют deripaska.ru и journal.sovcombank.ru.",
  // p19
  "На первой странице российской выдачи изображений заметен деловой визуальный слой: в черновике указаны ru.wikipedia.org, forbes.ru и rbc.ru.",
  // p20
  "На второй странице российской выдачи изображений появляется судебно-криминальный контур: в черновике указан материал на secrets.tbank.ru.",
  // generic echoes
  "Черновой вариант страницы не содержит данных.",
  "Опираясь на scoped findings, можно сделать вывод о рисках.",
];

describe("client-text contract bans LLM meta-speak (A.2)", () => {
  it("contract lists the Russian meta tokens", () => {
    const c = getClientTextContract();
    for (const token of ["черновик", "черновой", "переданный фрагмент", "scoped", "findings"]) {
      expect(c.forbiddenRawTokens).toContain(token);
    }
  });

  it("flags every meta-speak leak observed in report 31", () => {
    for (const text of LEAKED_FROM_REPORT_31) {
      const issues = scanOrionGoldenClientTextForForbiddenTokens(text);
      expect(issues.length, `expected rejection for: "${text}"`).toBeGreaterThan(0);
    }
  });

  it("keeps normal client copy clean", () => {
    const clean = [
      "Итоговая оценка по субъекту — критический уровень репутационного и комплаенс-риска.",
      "«Криминальные / судебные материалы» — 21 публикация, из них с негативным содержанием — 21.",
      "Сверить судебные, санкционные и финансовые упоминания с официальными источниками.",
      "Поверхность не собиралась в этом прогоне. Это не результат проверки «материалов нет».",
      "Подсказки отражают частотные запросы пользователей и формируют первое впечатление о субъекте.",
    ];
    for (const text of clean) {
      const issues = scanOrionGoldenClientTextForForbiddenTokens(text);
      expect(issues, `unexpected issues for: "${text}" → ${issues.join(", ")}`).toEqual([]);
    }
  });
});
