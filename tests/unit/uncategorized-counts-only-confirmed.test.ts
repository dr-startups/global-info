/**
 * «Другие материалы о субъекте» считают подтверждённые, а не вероятные.
 *
 * Стр. 47 отчёта 85 (лист ОАЭ): «Другие материалы о субъекте: 84. Примеры: 90+
 * "Alexey Egorov" profiles; Alexey Egorov; Alexey Egorov» — при четырёх
 * подтверждённых материалах региона. Счёт складывал `SUBJECT_MATCH` и
 * `LIKELY_SUBJECT`, а ярлык обещал первое. Правило то же, по которому
 * «вероятно» не входит в KPI: о субъекте — значит подтверждено.
 */

import { describe, expect, it } from "vitest";
import { uncategorizedBulletForRegion } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/regional-summary";
import type { FragmentExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

const EXTRAS = {
  uncategorizedMaterials: {
    version: "uncategorized-materials-v1",
    count: 6,
    subjectMatchCount: 2,
    likelySubjectCount: 4,
    topExamples: [],
    allEvidenceRefs: [],
    byRegion: {
      UAE: {
        count: 6,
        subjectMatchCount: 2,
        examples: [
          {
            evidenceRef: "inventory:obs-likely-1",
            title: '90+ "Alexey Egorov" profiles',
            domain: "linkedin.com",
            region: "UAE",
            subjectMatch: "LIKELY_SUBJECT",
          },
          {
            evidenceRef: "inventory:obs-match-1",
            title: "Alexey Egorov speaks at the Dubai arbitration forum",
            domain: "gulfnews.com",
            region: "UAE",
            subjectMatch: "SUBJECT_MATCH",
          },
        ],
      },
    },
  },
} as unknown as FragmentExtras;

describe("счёт «других материалов о субъекте»", () => {
  it("считает только подтверждённые", () => {
    const out = uncategorizedBulletForRegion("UAE", EXTRAS);
    expect(out?.count).toBe(2);
    expect(out?.bullet).toContain("Другие материалы о субъекте: 2");
  });

  it("в примерах не стоят вероятные совпадения", () => {
    const out = uncategorizedBulletForRegion("UAE", EXTRAS);
    expect(out?.bullet).not.toContain("90+");
    expect(out?.evidenceRefs).toEqual(["inventory:obs-match-1"]);
  });

  it("прежний артефакт без счёта подтверждённых строки не даёт", () => {
    const legacy = {
      uncategorizedMaterials: {
        version: "uncategorized-materials-v1",
        count: 6,
        subjectMatchCount: 2,
        likelySubjectCount: 4,
        topExamples: [],
        allEvidenceRefs: [],
        byRegion: { UAE: { count: 6, examples: [] } },
      },
    } as unknown as FragmentExtras;
    expect(uncategorizedBulletForRegion("UAE", legacy)).toBeNull();
  });

  it("подтверждённых нет — строки нет вовсе", () => {
    const onlyLikely = {
      uncategorizedMaterials: {
        ...(EXTRAS.uncategorizedMaterials as never as Record<string, unknown>),
        byRegion: {
          UAE: {
            count: 1,
            subjectMatchCount: 0,
            examples: [
              {
                evidenceRef: "inventory:obs-likely-1",
                title: '90+ "Alexey Egorov" profiles',
                domain: "linkedin.com",
                region: "UAE",
                subjectMatch: "LIKELY_SUBJECT",
              },
            ],
          },
        },
      },
    } as unknown as FragmentExtras;
    expect(uncategorizedBulletForRegion("UAE", onlyLikely)).toBeNull();
  });
});
