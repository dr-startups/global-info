/**
 * Решения принимаются в одном месте, и это вкладка проверки.
 *
 * Классическая очередь ручной проверки писала решения в файл на томе, новая
 * вкладка — в таблицу `dp_review_decisions`. Пока писали оба, у продукта было
 * два ответа на «что решил аналитик», и расходиться они начали бы в первый же
 * день: правки в файле и в таблице живут по разным правилам — у файла нет ни
 * истории, ни автора, ни отпечатка набора.
 *
 * Отказ громкий и с названной причиной, а не тихий 404: аналитик, нажавший
 * кнопку в старом интерфейсе, обязан узнать, где принимать решение.
 *
 * Читать очередь при этом можно: прежние решения остаются записью того, что
 * действительно решали, и канонический конвейер продолжает их применять.
 */

import { describe, expect, it } from "vitest";
import {
  CLASSIC_QUEUE_DECISIONS_CLOSED,
  classicQueueDecisionRefusal,
} from "@/modules/digital-profile/orion-golden/services/admin-review-workflow-service";

describe("классическая очередь больше не принимает решений", () => {
  it("причина названа словами и указывает, где решать", () => {
    expect(CLASSIC_QUEUE_DECISIONS_CLOSED).toMatch(/Проверка перед выпуском/u);
    // Ни кода, ни ссылки на файл: читателю нужно место, а не устройство.
    expect(CLASSIC_QUEUE_DECISIONS_CLOSED).not.toMatch(/json|dp_review_decisions/iu);
  });

  it("отказ — конфликт состояния, а не «не найдено»", () => {
    const err = classicQueueDecisionRefusal();
    expect(err.status).toBe(409);
    expect(err.message).toBe(CLASSIC_QUEUE_DECISIONS_CLOSED);
  });
});
