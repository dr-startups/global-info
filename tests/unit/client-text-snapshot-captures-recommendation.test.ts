import { describe, expect, it } from "vitest";
import { extractClientText } from "../../scripts/lib/client-text-snapshot";

/**
 * Рекомендация на странице живёт в `actions`, а не в текстовом поле.
 *
 * Макеты `orion_golden_no_data_compact` и панели с карточкой «Что проверить»
 * получают её отдельным полем полезной нагрузки. Пока снимок его не читал,
 * весь текст карточек «Что проверить» не был закреплён эталоном вовсе — и
 * менялся молча.
 */
describe("снимок клиентского текста", () => {
  it("захватывает рекомендацию карточки «Что проверить»", () => {
    const snapshot = extractClientText({
      slides: [
        {
          slideKey: "p29_uae_wikipedia",
          template: "orion_golden_no_data_compact",
          title: "ОАЭ — Википедия",
          narrative: "Поверхность не собиралась в этом прогоне.",
          actions: [{ label: "Мы предлагаем проверить наличие статьи вручную." }],
        },
      ],
    });
    expect(snapshot.slides[0]!.actions).toEqual([
      "Мы предлагаем проверить наличие статьи вручную.",
    ]);
  });

  it("слайд без рекомендации поля не заводит", () => {
    const snapshot = extractClientText({
      slides: [{ slideKey: "p01_cover", title: "Обложка" }],
    });
    expect(snapshot.slides[0]!.actions).toBeUndefined();
  });

  it("рекомендация считается в общем объёме клиентского текста", () => {
    const withAction = extractClientText({
      slides: [{ slideKey: "p1", actions: [{ label: "Двенадцать" }] }],
    });
    expect(withAction.totalChars).toBe("Двенадцать".length);
  });
});
