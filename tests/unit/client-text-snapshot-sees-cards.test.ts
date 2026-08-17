/**
 * Снимок клиентского текста закрепляет и карточки.
 *
 * Матрица рисков и исполнительный дашборд приходят в рендерер полем
 * `keyFindings`: заголовок темы, степень и текст карточки. В снимок попадала
 * только таблица-провод, поэтому текст карточек не был закреплён эталоном
 * вовсе — переписать его можно было молча. Для шага, который переписывает
 * карточку матрицы, это неприемлемо.
 */

import { describe, expect, it } from "vitest";
import {
  CLIENT_TEXT_SNAPSHOT_VERSION,
  extractClientText,
} from "../../scripts/lib/client-text-snapshot";

describe("снимок клиентского текста видит карточки", () => {
  it("захватывает заголовок, степень и текст карточки", () => {
    const snapshot = extractClientText({
      slides: [
        {
          slideKey: "p04_risk_dashboard",
          template: "orion_golden_risk_matrix_grid",
          title: "Матрица комплаенс-рисков",
          keyFindings: [
            {
              headline: "Криминальные / судебные материалы",
              status: "Критический",
              detail: "7 свидетельств (5 негативных).\nЧто делать: Проверить статусы дел.",
              tone: "risk",
            },
          ],
        },
      ],
    });
    expect(snapshot.slides[0]!.keyFindings).toEqual([
      {
        headline: "Криминальные / судебные материалы",
        status: "Критический",
        detail: "7 свидетельств (5 негативных). Что делать: Проверить статусы дел.",
      },
    ]);
  });

  it("слайд без карточек поля не заводит", () => {
    const snapshot = extractClientText({
      slides: [{ slideKey: "p01_cover", title: "Обложка" }],
    });
    expect(snapshot.slides[0]!.keyFindings).toBeUndefined();
  });

  it("текст карточек считается в общем объёме клиентского текста", () => {
    const snapshot = extractClientText({
      slides: [{ slideKey: "p1", keyFindings: [{ headline: "Тема", status: "Низкий", detail: "Текст" }] }],
    });
    expect(snapshot.totalChars).toBe("Тема".length + "Низкий".length + "Текст".length);
  });

  it("версия снимка поднята — эталон без карточек считается устаревшим", () => {
    expect(CLIENT_TEXT_SNAPSHOT_VERSION).toBe("client-text-snapshot-v2");
  });
});
