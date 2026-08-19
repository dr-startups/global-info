/**
 * Причина непрочтения и принадлежность по прочтению доезжают до индекса.
 *
 * Фраза «Почему выделено» строится по двум полям, которых у индекса раньше не
 * было: `readFailure` (почему страницу не открыли — иначе непрочитанная строка
 * и строка, которую не читали вовсе, звучат одинаково) и `verdictSubjectMatch`
 * (принадлежность по прочтению — по ней фраза оговаривает вероятную).
 * Проводка проверяется здесь: тесты самой фразы подают эти поля руками и
 * пропажу загрузчика не замечают.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeckInputsFromAnalyticsDir } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";

const REF = "inventory:obs-1";

const OBSERVATION = {
  observationKey: "obs-1",
  surface: "organic",
  region: "RU",
  engine: "YANDEX",
  url: "https://news.example/court",
  title: "Суд по иску о взыскании 72 млн рублей",
  domain: "news.example",
  rank: 3,
  evidenceRefs: [REF],
};

function analyticsDirWith(verdicts: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "deck-verdict-fields-"));
  const write = (name: string, value: unknown): void => {
    writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };
  write("verified-finding-bundle.json", { findings: [] });
  write("ambiguous-findings.json", []);
  write("surface-analysis.json", {});
  write("executive-summary.json", {});
  write("report-data-binding.json", {
    baseReportRunId: "run-1",
    datasetId: "ds-1",
    caseId: "case-1",
  });
  write("provider-delta.json", { baseCount: 1, arsenkinObservationCount: 0 });
  write("composite-serp-observations.json", {
    observations: [OBSERVATION],
    baseCount: 1,
    compositeCount: 1,
  });
  write("subject-resolution.json", { items: [] });
  write("link-verdicts.json", { verdicts });
  return dir;
}

describe("поля решения по странице в индексе доказательств", () => {
  it("причина непрочтения записана словом решения", () => {
    const inputs = loadDeckInputsFromAnalyticsDir(
      analyticsDirWith([
        {
          evidenceRef: REF,
          subjectMatch: "unclear",
          tone: "neutral",
          theme: "Суд по иску",
          readFailure: "blocked",
          quotes: [],
        },
      ])
    );
    expect(inputs.evidenceIndex[REF]?.readFailure).toBe("blocked");
  });

  it("прочитанная страница причины непрочтения не получает", () => {
    const inputs = loadDeckInputsFromAnalyticsDir(
      analyticsDirWith([
        {
          evidenceRef: REF,
          subjectMatch: "subject",
          tone: "adverse",
          theme: "Судебные эпизоды",
          quotes: [{ text: "Суд удовлетворил иск о взыскании." }],
        },
      ])
    );
    expect(inputs.evidenceIndex[REF]?.readFailure).toBeUndefined();
  });

  it("вероятная принадлежность по прочтению записана отдельно от решения о лице", () => {
    const inputs = loadDeckInputsFromAnalyticsDir(
      analyticsDirWith([
        {
          evidenceRef: REF,
          subjectMatch: "likely",
          tone: "adverse",
          theme: "Судебные эпизоды",
          quotes: [{ text: "Суд удовлетворил иск о взыскании." }],
        },
      ])
    );
    expect(inputs.evidenceIndex[REF]?.verdictSubjectMatch).toBe("likely");
    expect(inputs.evidenceIndex[REF]?.subjectDecision).not.toBe("OTHER_SUBJECT");
  });
});
