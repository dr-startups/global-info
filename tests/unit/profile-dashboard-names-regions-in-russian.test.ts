/**
 * Обзор цифрового профиля называет регионы словами, а не кодом.
 *
 * `RU` и `UAE` — коды контуров, и на странице обзора они печатались дословно:
 * «из 2 региональных контуров (RU: 232, UAE: 86)» и плитка «Региональные
 * контуры: RU · UAE». Это тот же машинный код в клиентском тексте, что и «ru,
 * ch» в карточке комплаенса, — и ответ на вопрос «как регион называется
 * клиенту» в деке уже есть один: `REGION_CLIENT_LABELS`. В том же предложении
 * страницы предмет аудита уже назван по-человечески («Россия, ОАЭ»), то есть
 * одна фраза называла регионы двумя способами сразу.
 */

import { describe, expect, it } from "vitest";
import { buildDigitalProfileOverviewFragment } from "@/modules/digital-profile/orion-golden/deck-sections";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

function overviewSlide(): SlideContentContract {
  const scoped = {
    subject: { displayName: "Йохан Хольмстрём", aliases: [] },
    findings: [],
    surfaceUnits: [],
    metricSnapshot: {
      metricSnapshotId: "m-1",
      datasetId: "d-1",
      reportRunId: "r-1",
      baseCount: 318,
      enrichmentCount: 0,
      compositeCount: 318,
      subjectMatchCount: 149,
      likelySubjectCount: 0,
      ambiguousCount: 161,
      otherSubjectCount: 33,
      adverseFindingCount: 0,
      perRegionCounts: { RU: 232, UAE: 86 },
    },
    scope: { regions: null, surfaces: null, subjectMatch: null, findingIds: null },
    evidenceIndex: {},
  };
  const [slide] = buildDigitalProfileOverviewFragment("EXEC_SUMMARY" as never, scoped as never)
    .slides;
  if (!slide) throw new Error("обзор не собрался");
  return slide;
}

describe("обзор цифрового профиля", () => {
  it("в нарративе регионы названы по-русски", () => {
    const narrative = overviewSlide().content.narrative ?? "";
    expect(narrative).toContain("(Россия: 232, ОАЭ: 86)");
    expect(narrative).not.toMatch(/\bRU\b/u);
    expect(narrative).not.toMatch(/\bUAE\b/u);
  });

  it("плитка «Региональные контуры» называет регионы по-русски", () => {
    const kpis = overviewSlide().content.kpis ?? [];
    const tile = kpis.find((k) => k.label === "Региональные контуры");
    expect(tile?.value).toBe("Россия · ОАЭ");
  });
});
