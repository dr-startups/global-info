/**
 * Абзац страницы — одна величина, и меряют её одним числом в одном месте.
 *
 * Абзац собирается в два приёма: построитель кладёт `content.narrative`, а
 * нагрузка приклеивает к нему прозу находки (`whatWasFound` + `whyItMatters`;
 * на карточных шаблонах рекомендация исключена — её печатает своя карточка).
 * Бюджет шаблона при этом применялся к обеим величинам: сверка пакета меряла
 * абзац **построителя**, сторож нагрузки — абзац **страницы**.
 *
 * Отсюда и вставшие прогоны владельца: 416 знаков построителя проходили сверку,
 * а страница уезжала на 620 — и на живых кейсах перерастала лист (1013, 1014,
 * 1101, 1178). Модель тут ни при чём: и стадия 2, и стадия 3 прогоняют
 * переписанный пакет через ту же сверку.
 *
 * Проверяется поведением через настоящие входы: сверку пакета и склейку
 * нагрузки, — а не чтением новой функции.
 */

import { describe, expect, it } from "vitest";
import { toRendererPayload } from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import {
  narrativeBudgetOf,
  validateSectionPack,
} from "@/modules/digital-profile/orion-golden/deck-sections/section-validation";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import type { ReportDeckManifest } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { SectionPackV2 } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const BUDGET = narrativeBudgetOf("wikipedia-check");

/** Проза находки: разные предложения, чтобы дедупликация её не съела. */
const PROSE_SENTENCES = [
  "Найдена запись профиля в разделе биографий.",
  "Ссылка ведёт на страницу с историей правок.",
  "Автор последней правки реестром не установлен.",
  "Материал сверен с двумя независимыми источниками.",
  "Дата создания страницы указана в карточке статьи.",
];

const prose = (n: number): string => PROSE_SENTENCES.slice(0, n).join(" ");

/** Текст ровно из целых предложений заданной длины. */
function sentences(totalChars: number): string {
  const one = "Проверка выполнена по официальному источнику. ";
  let out = "";
  while (out.length + one.length <= totalChars) out += one;
  return out.trimEnd();
}

function packWith(content: Record<string, unknown>): SectionPackV2 {
  return {
    version: "section-pack-v2",
    fragmentKey: "RU_WIKIPEDIA",
    caseId: "c",
    reportRunId: "r",
    datasetId: "d",
    sourceDatasetId: "d",
    sourceFindingIds: [],
    evidenceRefs: [],
    inputs: { sourceFindingIds: [], evidenceRefs: [] },
    metrics: { adverseDisplayedCount: 0, adverseDatasetCount: 0 },
    provenance: { providers: [], reportRunIds: ["r"], evidenceRefs: [] },
    validation: { passed: true, issues: [] },
    slides: [
      {
        slideId: "p13_ru_wikipedia",
        templateId: "wikipedia-check",
        title: "Проверка статьи",
        findingIds: [],
        evidenceRefs: [],
        metrics: {},
        visualAssetRefs: [],
        content,
      },
    ],
  } as unknown as SectionPackV2;
}

/** Замечания сверки пакета про абзац. */
function narrativeIssues(content: Record<string, unknown>): string[] {
  const report = validateSectionPack({
    pack: packWith(content),
    expectedCaseId: "c",
    expectedReportRunId: "r",
    expectedDatasetId: "d",
    bundle: { findings: [] } as never,
    knownEvidenceRefs: new Set<string>(),
  });
  return report.issues.filter((i) => i.includes("narrative"));
}

const EMPTY_MANIFEST = { toc: [], sectionPageRanges: [] } as unknown as ReportDeckManifest;

/** Абзац, который нагрузка реально кладёт на страницу. */
function pageNarrative(over: Partial<RendererSlide> & { template: string }): string {
  const payload = toRendererPayload({
    deckManifest: EMPTY_MANIFEST,
    rendererSlides: [
      {
        slideKey: "p13_ru_wikipedia",
        sectionKey: "RU_PROFILE",
        templateId: "wikipedia-check",
        title: "Проверка статьи",
        pageNumber: 1,
        totalPageCount: 1,
        baseSlotId: "p13_ru_wikipedia",
        isContinuation: false,
        evidenceRefs: [],
        findingIds: [],
        metrics: {},
        visualAssetRefs: [],
        staticBlocks: [],
        ...over,
      } as RendererSlide,
    ],
    subjectName: "Сергей Глинка",
  }) as { deckManifest: { finalSlides: Array<Record<string, unknown>> } };
  return String(payload.deckManifest.finalSlides[0]?.narrative ?? "");
}

describe("сверка пакета меряет абзац страницы, а не абзац построителя", () => {
  it("абзац построителя по бюджету, но с прозой сверх него — красный", () => {
    // Ровно тот случай, на котором встали прогоны: 900 ≤ 998 у построителя,
    // а на листе — за тысячу.
    const narrative = sentences(900);
    const content = { narrative, whatWasFound: prose(5), bullets: [] };

    expect(narrative.length).toBeLessThanOrEqual(BUDGET);
    // Что абзац страницы за бюджетом, говорит сторож нагрузки — он и остаётся
    // последним рубежом. Но ловить это должна сверка пакета, до него.
    expect(() =>
      pageNarrative({ template: "orion_golden_wikipedia_check", narrative, whatWasFound: prose(5) })
    ).toThrow(/narrative over template budget/u);
    expect(narrativeIssues(content).length).toBeGreaterThan(0);
  });

  it("абзац страницы по бюджету — молчит", () => {
    // Контроль: сверка не начинает ругаться на всё подряд. Абзац эталона-72
    // (416 построителя + 204 прозы) — законный лист.
    const narrative = sentences(416);
    const content = { narrative, whatWasFound: prose(2), bullets: [] };

    expect(pageNarrative({ template: "orion_golden_wikipedia_check", narrative, whatWasFound: prose(2) }).length)
      .toBeLessThanOrEqual(BUDGET);
    expect(narrativeIssues(content)).toEqual([]);
  });

  it("рекомендация карточного шаблона в абзац страницы не входит", () => {
    // Её печатает своя карточка «Что проверить», и сверка обязана считать так
    // же — иначе законный лист краснеет на тексте, которого в абзаце нет.
    // Абзац короткий намеренно: резак абзацев трогает только текст от 220
    // знаков, а его пре-существующая потеря — предмет другой работы.
    const narrative = sentences(180);
    const whatToCheck = "Проверить упоминание в разделе биографий и сверить с реестром. ".repeat(3);
    const content = { narrative, whatToCheck, bullets: [] };

    expect(pageNarrative({ template: "orion_golden_wikipedia_check", narrative, whatToCheck })).not.toContain(
      "Проверить упоминание"
    );
    expect(narrativeIssues(content)).toEqual([]);
  });

  it("на некарточном шаблоне рекомендация в абзаце остаётся", () => {
    const narrative = sentences(300);
    const whatToCheck = "Проверить упоминание в разделе биографий.";

    expect(pageNarrative({ template: "orion_golden_prose", narrative, whatToCheck })).toContain(
      "Проверить упоминание"
    );
  });
});
