/**
 * Снимок клиентского текста видит фразы «Почему выделено».
 *
 * Клиенту эти фразы показывает боковая панель рядом со снимком выдачи, и в
 * payload рендерера они лежат в `visualAnalysis.highlightExplanations`. Снимок
 * читал только одноимённое поле верхнего уровня, которого в payload нет, —
 * поэтому в текстовом эталоне не было ни одной такой фразы, и переписать их
 * можно было молча. Для шага, который эти фразы переписывает целиком, это
 * неприемлемо.
 */

import { describe, expect, it } from "vitest";
import {
  CLIENT_TEXT_SNAPSHOT_VERSION,
  extractClientText,
} from "../../scripts/lib/client-text-snapshot";

const PHRASE =
  "На странице rupep.org — санкции и заморозка активов: «Активы заморожены решением Совета ЕС.» rupep.org/ru/person/8095";

describe("снимок клиентского текста и фразы боковой панели", () => {
  it("захватывает фразы из visualAnalysis, как их видит клиент", () => {
    const snapshot = extractClientText({
      slides: [
        {
          slideKey: "p10_ru_serp_visual",
          template: "orion_golden_serp_screenshot",
          title: "Россия — снимок выдачи",
          visualAnalysis: {
            sidebarMode: "adverse_explanation",
            highlightExplanations: [{ clientReason: PHRASE, frameTone: "red" }],
          },
        },
      ],
    });
    expect(snapshot.slides[0]!.highlights).toEqual([PHRASE]);
  });

  it("фразы считаются в общем объёме клиентского текста", () => {
    const snapshot = extractClientText({
      slides: [
        {
          slideKey: "p10",
          visualAnalysis: { highlightExplanations: [{ clientReason: "Фраза." }] },
        },
      ],
    });
    expect(snapshot.totalChars).toBe("Фраза.".length);
  });

  it("слайд без панели поля не заводит", () => {
    const snapshot = extractClientText({
      slides: [{ slideKey: "p01_cover", title: "Обложка" }],
    });
    expect(snapshot.slides[0]!.highlights).toBeUndefined();
  });

  it("версия снимка поднята — эталон без фраз считается устаревшим", () => {
    expect(CLIENT_TEXT_SNAPSHOT_VERSION).toBe("client-text-snapshot-v4");
  });
});
