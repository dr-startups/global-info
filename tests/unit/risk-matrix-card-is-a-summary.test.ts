/**
 * Карточка матрицы рисков — сводка, а не простыня.
 *
 * Эталон отрасли даёт на этом месте одну страницу сводных строк; мы печатали
 * карточки по 460–575 знаков со статистикой, перечнем заголовков («Примеры: …»)
 * и цитатами — теми же, что уже стоят в тематических блоках региональных
 * резюме. Карточка оставляет тему, степень, строку «в чём проблема» и строку
 * «что делать»; цитаты остаются там, где они и были.
 *
 * Объяснение риска от модели («почему это важно») печаталось только в карточке
 * матрицы. Оно переезжает в резюме — иначе на живом прогоне исчезло бы из
 * отчёта вовсе.
 */

import { describe, expect, it } from "vitest";
import {
  buildExecutiveSummaryFragment,
  buildRiskMatrixFragment,
  RISK_MATRIX_LIKELY_AGGREGATE_ID,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/executive";
import { DECK_TEMPLATE_REGISTRY } from "@/modules/digital-profile/orion-golden/deck-sections";
import type { FragmentExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { Finding } from "@/modules/digital-profile/orion-golden/contracts/finding";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const BODY_BUDGET = DECK_TEMPLATE_REGISTRY["risk-matrix"].layout.itemCharBudget;

const THEME = "Криминальные / судебные материалы";
const STATS_LINE = "7 свидетельств (5 негативных) в источниках audit-it.ru, x.com, m.sledst.org.";

/** Претензия синтезатора в том виде, в каком она приходит с живого прогона. */
const STRUCTURED_CLAIM = [
  `«${THEME}»`,
  STATS_LINE,
  "Всего по теме: 14 материалов, с негативным контекстом — 4.",
  "Где видно: audit-it.ru, x.com.",
  "Примеры: Глинка Сергей (ИНН 773800015809) в реестре... · Связанный с Россией бизнесмен Сергей Глинка ... · Russian businessman Sergei Glinka is attempting to gain control of the Popeci defense plant",
].join("\n");

function finding(over: Partial<Finding> = {}): Finding {
  return {
    findingId: "finding-criminal_legal-subject_match-16447175",
    theme: THEME,
    subjectMatch: "SUBJECT_MATCH",
    claim: STRUCTURED_CLAIM,
    riskLevel: "critical",
    promotionPriority: "P1",
    evidenceRefs: ["inventory:e1"],
    recommendedAction: "Проверить статусы дел и первоисточники до принятия решений.",
    ...over,
  } as unknown as Finding;
}

function scopedWith(findings: Finding[], likelySubjectCount = 0): ScopedFragmentInput {
  return {
    subject: { displayName: "Тест", aliases: [] },
    findings,
    surfaceUnits: [],
    evidenceIndex: {},
    scope: {},
    metricSnapshot: {
      likelySubjectCount,
      compositeCount: 100,
      subjectMatchCount: 10,
      adverseFindingCount: 2,
      perRegionCounts: {},
    },
  } as unknown as ScopedFragmentInput;
}

/** Тексты карточек всех страниц матрицы. */
function cards(findings: Finding[], likelySubjectCount = 0, extras?: FragmentExtras): string[] {
  const { slides } = buildRiskMatrixFragment(
    "EXECUTIVE" as never,
    scopedWith(findings, likelySubjectCount),
    extras
  );
  return slides.flatMap((s) => s.content.bullets ?? []);
}

const GPT_EXPLANATION =
  "Судебные сюжеты вокруг актива читаются банком как незакрытый спор о контроле.";

const GPT_EXTRAS = {
  gptCaseAnalysis: {
    overallRiskLevel: "high",
    executiveConclusion: "Вывод модели по кейсу.",
    keyRisks: [
      {
        theme: "Криминальные и судебные материалы",
        severity: "high",
        explanation: GPT_EXPLANATION,
        advice: "Запросить справки о статусе дел.",
      },
    ],
    positiveSignals: [],
    recommendations: ["Собрать документы."],
  },
} as unknown as FragmentExtras;

describe("карточка матрицы — сводка из трёх строк", () => {
  it("первая строка — дословно строка статистики претензии", () => {
    const [card] = cards([finding()]);
    expect(card!.split("\n")[0]).toBe(STATS_LINE);
  });

  it("перечня заголовков, «Где видно» и цитат в карточке нет", () => {
    const [card] = cards([finding()]);
    expect(card).not.toMatch(/Примеры:/u);
    expect(card).not.toMatch(/Где видно:/u);
    expect(card).not.toMatch(/Всего по теме:/u);
    expect(card).not.toMatch(/—\s*источник/u);
    expect(card).not.toMatch(/«/u);
  });

  it("строка «Что делать» остаётся — других мест у тематической рекомендации нет", () => {
    const [card] = cards([finding()]);
    const lines = card!.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("Что делать: Проверить статусы дел и первоисточники до принятия решений.");
  });

  it("тело карточки укладывается в бюджет реестра", () => {
    const long = finding({
      recommendedAction:
        "Запросить в банке-контрагенте первичные документы по сделке и сверить их с публикациями. " +
        "Одновременно поднять судебные карточки по каждому эпизоду и зафиксировать статусы на дату отчёта.",
    });
    for (const card of cards([long, finding({ findingId: "f2" })])) {
      expect(card.length, card).toBeLessThanOrEqual(BODY_BUDGET);
    }
  });

  it("длинная рекомендация обрезается по границе предложения", () => {
    const [card] = cards([
      finding({
        recommendedAction:
          "Запросить в банке-контрагенте первичные документы по сделке и сверить их с публикациями. " +
          "Одновременно поднять судебные карточки по каждому эпизоду и зафиксировать статусы на дату отчёта.",
      }),
    ]);
    const action = card!.split("\n").at(-1)!;
    expect(action.startsWith("Что делать: ")).toBe(true);
    expect(action.endsWith(".")).toBe(true);
    expect(action).not.toMatch(/публикациями\s+Одновременно/u);
  });

  it("ввод к цитатам не обещает того, чего в сводке нет", () => {
    // Претензия синтезатора часто начинается строкой-вводом с двоеточием, за
    // которой идут цитаты. Цитаты в карточку не попадают — значит, и обещания
    // быть не должно; числа темы договаривают строку.
    const [card] = cards([
      finding({
        claim: [
          `«${THEME}»`,
          "Найдены публикации, в которых субъект связывается с судебными сюжетами:",
          "«Court schedules hearing» — источник kapitalnytt.se",
          "Всего по теме: 5 материалов, с негативным контекстом — 5.",
        ].join("\n"),
      }),
    ]);
    expect(card).not.toMatch(/:\s*$/mu);
    expect(card!.split("\n")[0]).toBe("Всего по теме: 5 материалов, с негативным контекстом — 5.");
  });

  it("ввод без масштаба темы просто теряет двоеточие", () => {
    const [card] = cards([
      finding({
        claim: [
          `«${THEME}»`,
          "Найдены публикации, в которых субъект связывается с судебными сюжетами:",
          "«Court schedules hearing» — источник kapitalnytt.se",
        ].join("\n"),
      }),
    ]);
    expect(card!.split("\n")[0]).toBe(
      "Найдены публикации, в которых субъект связывается с судебными сюжетами."
    );
  });

  it("бесструктурная претензия даёт первое предложение, а не обрубок", () => {
    const [card] = cards([
      finding({
        claim:
          "В открытых источниках упоминается участие в корпоративном споре вокруг завода в Молдове, " +
          "стороны публично обвиняют друг друга в давлении на суд. Отдельные публикации описывают " +
          "продолжение конфликта и внимание прессы к сделке.",
      }),
    ]);
    const problem = card!.split("\n")[0]!;
    expect(problem.length).toBeLessThanOrEqual(170);
    expect(problem.endsWith(".")).toBe(true);
    expect(problem.startsWith("В открытых источниках упоминается участие")).toBe(true);
  });
});

describe("оговорка о принадлежности", () => {
  it("тематическая вероятная тема несёт оговорку", () => {
    const [card] = cards([
      finding({ findingId: "f-likely", subjectMatch: "LIKELY_SUBJECT", riskLevel: "low" }),
    ]);
    expect(card).toContain("Принадлежность пока не подтверждена");
    expect(card!.split("\n")[0]).toBe(STATS_LINE);
  });

  it("синтетический агрегат оговорку не дублирует", () => {
    const all = cards([finding()], 55);
    const aggregate = all.at(-1)!;
    expect(aggregate).toContain("«вероятно об этом лице»");
    expect(aggregate).not.toContain("Принадлежность пока не подтверждена");
    expect(aggregate.length).toBeLessThanOrEqual(BODY_BUDGET);
  });

  it("агрегат сохраняет свой идентификатор вне findingIds", () => {
    const { slides } = buildRiskMatrixFragment("EXECUTIVE" as never, scopedWith([finding()], 55));
    expect(slides.flatMap((s) => s.findingIds)).not.toContain(RISK_MATRIX_LIKELY_AGGREGATE_ID);
  });
});

describe("объяснение риска от модели живёт в резюме", () => {
  const scoped = scopedWith([finding()]);
  const extras = {
    ...GPT_EXTRAS,
    executiveSummary: {
      verdict: "ELEVATED",
      executiveConclusion: "Итоговый вывод по кейсу.",
      keyFindings: [
        {
          findingId: "finding-criminal_legal-subject_match-16447175",
          title: THEME,
          factualBasis: "Подтверждённый факт: публикации о судебных сюжетах.",
          clientImpact: "Вопросы комплаенса.",
          recommendedAction: "Сверить статусы дел.",
        },
      ],
      priorityActions: ["Сверить статусы дел."],
      identityCaveats: [],
      dataLimitations: [],
    },
  } as unknown as FragmentExtras;

  it("объяснения нет в карточке матрицы", () => {
    const [card] = cards([finding()], 0, GPT_EXTRAS);
    expect(card).not.toContain(GPT_EXPLANATION);
  });

  it("карточка берёт «Что делать» из совета модели", () => {
    const [card] = cards([finding()], 0, GPT_EXTRAS);
    expect(card).toContain("Что делать: Запросить справки о статусе дел.");
  });

  it("без анализа модели «Что делать» остаётся рекомендацией находки", () => {
    const [card] = cards([finding()]);
    expect(card).toContain("Что делать: Проверить статусы дел и первоисточники до принятия решений.");
  });

  it("объяснение стоит в буллете резюме между фактурой и «Что делать»", () => {
    const { slides } = buildExecutiveSummaryFragment("EXECUTIVE" as never, scoped, extras);
    const bullet = (slides[0]!.content.bullets ?? [])[0]!;
    const lines = bullet.split("\n");
    const explanationAt = lines.findIndex((l) => l.includes(GPT_EXPLANATION));
    const actionAt = lines.findIndex((l) => l.startsWith("Что делать:"));
    expect(explanationAt).toBeGreaterThan(0);
    expect(actionAt).toBeGreaterThan(explanationAt);
  });
});
