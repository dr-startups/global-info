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
import { extractClientText } from "../../scripts/lib/client-text-snapshot";

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
              status: "Высокий",
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
        status: "Высокий",
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

  it("захватывает плитки дашборда — они лежат в нагрузке полем metrics", () => {
    /*
     * Снимок снимается с полезной нагрузки рендерера, а `run-deck-build.ts`
     * переименовывает `kpis` контракта в `metrics` до снятия снимка. Снимок
     * читал `kpis`, поэтому в эталон не попадала ни одна плитка — ноль из 52
     * слайдов, хотя обзор всегда печатает семь. Переформулировать плитку можно
     * было молча, с нулевым диффом эталона.
     */
    const snapshot = extractClientText({
      slides: [
        {
          slideKey: "p05_profile_dashboard",
          template: "orion_golden_metrics_dashboard",
          metrics: [
            { label: "Всего материалов", value: "72", tone: "neutral" },
            { label: "Региональные контуры", value: "Россия · ОАЭ", tone: "accent" },
          ],
        },
      ],
    });
    expect(snapshot.slides[0]!.metrics).toEqual([
      "Всего материалов: 72",
      "Региональные контуры: Россия · ОАЭ",
    ]);
  });

  it("слайд без плиток поля не заводит", () => {
    const snapshot = extractClientText({ slides: [{ slideKey: "p01_cover", title: "Обложка" }] });
    expect(snapshot.slides[0]!.metrics).toBeUndefined();
  });

  it("текст плиток считается в общем объёме клиентского текста", () => {
    const snapshot = extractClientText({
      slides: [{ slideKey: "p1", metrics: [{ label: "Тем", value: "3" }] }],
    });
    expect(snapshot.totalChars).toBe("Тем: 3".length);
  });

  it("текст карточек считается в общем объёме клиентского текста", () => {
    const snapshot = extractClientText({
      slides: [{ slideKey: "p1", keyFindings: [{ headline: "Тема", status: "Низкий", detail: "Текст" }] }],
    });
    expect(snapshot.totalChars).toBe("Тема".length + "Низкий".length + "Текст".length);
  });
});
