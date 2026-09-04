import { describe, expect, it } from "vitest";
import {
  countLinkReadByRegion,
  type LinkVerdictRow,
} from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import {
  readShareDenominator,
  readShareExecutiveLine,
  readShareRegionalSentence,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { MetricSnapshot } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

/**
 * Страница, принадлежность которой не подтверждена, долю негатива не разбавляет.
 *
 * Знаменатель доли отвечает на вопрос «из скольких страниц о проверяемом лице».
 * Страница, где совпало одно ФИО, ответа на него не даёт: в числитель она не
 * попадает (вето разметки делает её «неясной»), а в знаменателе стояла — и доля
 * выходила тем меньше, чем больше в выдаче полных тёзок.
 */

const rows: LinkVerdictRow[] = [
  { evidenceRef: "e1", region: "RU", subjectMatch: "subject", tone: "adverse" },
  { evidenceRef: "e2", region: "RU", subjectMatch: "subject", tone: "neutral" },
  { evidenceRef: "e3", region: "RU", subjectMatch: "other", tone: "adverse" },
  { evidenceRef: "e4", region: "RU", subjectMatch: "unclear", tone: "adverse" },
  { evidenceRef: "e5", region: "RU", subjectMatch: "unclear", tone: "neutral" },
];

const reasonByRef = new Map<string, string>([
  ["e1", "full_name_with_anchor:employer"],
  ["e4", "full_name_no_anchor"],
  ["e5", "registry_inn_unverified"],
]);

function snapshot(counts: MetricSnapshot["linkReadByRegion"]): MetricSnapshot {
  return {
    metricSnapshotId: "m",
    datasetId: "d",
    reportRunId: "r",
    baseCount: 0,
    enrichmentCount: 0,
    compositeCount: 10,
    subjectMatchCount: 2,
    likelySubjectCount: 0,
    ambiguousCount: 2,
    otherSubjectCount: 1,
    adverseFindingCount: 1,
    perRegionCounts: { RU: 10 },
    linkReadByRegion: counts,
  };
}

describe("знаменатель доли — только подтверждённые страницы", () => {
  const counts = countLinkReadByRegion(rows, reasonByRef);

  it("страницы без подтверждающего признака считаются отдельно", () => {
    expect(counts.RU).toEqual({
      requested: 5,
      read: 5,
      readOther: 1,
      readUnconfirmed: 2,
      adverseRead: 1,
    });
  });

  it("знаменатель вычитает и чужих, и неподтверждённых", () => {
    expect(readShareDenominator(counts.RU!)).toBe(2);
  });

  it("причины разметки нет — счётчик остаётся нулевым, прежние прогоны не меняются", () => {
    expect(countLinkReadByRegion(rows).RU?.readUnconfirmed).toBe(0);
    expect(readShareDenominator(countLinkReadByRegion(rows).RU!)).toBe(4);
  });

  it("страница региона называет исключённые страницы своими словами", () => {
    const sentence = readShareRegionalSentence(snapshot(counts), "RU");
    expect(sentence).toContain("1 из 2");
    expect(sentence).toContain(
      "Страницы о других людях (1) и с неподтверждённой принадлежностью (2) в долю не входят."
    );
  });

  it("подтверждённых страниц нет — доля не считается, и сказано почему", () => {
    const none = {
      RU: { requested: 3, read: 3, readOther: 0, readUnconfirmed: 3, adverseRead: 0 },
    };
    const sentence = readShareRegionalSentence(snapshot(none), "RU");
    expect(sentence).toContain("доля негатива не приводится");
    expect(sentence).toContain("подтверждена признаком сверх совпадения имени");
    expect(readShareExecutiveLine(snapshot(none))).toBeUndefined();
  });

  it("строка резюме тоже объясняет разницу", () => {
    const line = readShareExecutiveLine(snapshot(counts));
    expect(line).toContain("1 из 2");
    expect(line).toContain("с неподтверждённой принадлежностью (2)");
  });
});
