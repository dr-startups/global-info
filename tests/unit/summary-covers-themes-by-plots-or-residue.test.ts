/**
 * Тема претензий не исчезает молча: её закрывает сюжет или остаточный блок.
 *
 * Резюме на пути сюжетов перестаёт печатать словарные рубрики — но только те,
 * страницы которых прочитаны. Тема, чьи наблюдения вошли в сюжет (в том числе
 * нейтральный), из резюме уходит: прочитанная страница сильнее заголовка, и
 * возвращать её по заголовкам значило бы вернуть «телеинтервью в криминальной
 * рубрике» на уровень резюме. Тема, чьи страницы прочитать не удалось,
 * остаётся словарным блоком и честно говорит, на чём она держится.
 *
 * Здесь же — регресс пути без чтения: прогон без вердиктов обязан дать ровно
 * тот текст, что и до шага.
 */

import { describe, expect, it } from "vitest";
import {
  assertComposedSummaryGatesPass,
  composeClientSummary,
} from "@/modules/digital-profile/orion-golden/analytics/client-summary-composer";
import { sampleClientSummaryPack } from "@/modules/digital-profile/orion-golden/contracts/sample-contracts";
import type {
  ClientMaterialTheme,
  ClientReadPlot,
  ClientSummaryPack,
} from "@/modules/digital-profile/orion-golden/contracts/client-summary-pack";

const BASIS_LINE =
  "Страницы по этой теме прочитать не удалось, тема приведена по заголовкам выдачи.";
const NO_ADVERSE_PLOTS_LINE =
  "Существенных негативных сюжетов среди прочитанных страниц не выявлено; " +
  "полный перечень тем публикаций — на страницах «о чём публикации в ТОП-20».";

const SAMPLE = sampleClientSummaryPack();

function theme(over: Partial<ClientMaterialTheme>): ClientMaterialTheme {
  return { ...SAMPLE.materialThemes[0]!, ...over };
}

const COVERED_BY_NEUTRAL_PLOT = theme({
  themeId: "reputational_scandal",
  clientTitle: "Репутационные сюжеты",
  evidenceRefs: ["inventory:obs-03"],
});

const RESIDUAL_PUBLICATIONS = theme({
  themeId: "business_ownership_associates",
  clientTitle: "Деловые связи, владение и контрагенты",
  evidenceRefs: ["inventory:obs-90"],
});

const RESIDUAL_DATABASE = theme({
  themeId: "sanctions_pep_rca_compliance",
  clientTitle: "PEP / RCA / watchlist-сигналы",
  evidenceRefs: ["inventory:obs-91"],
  representativeArticles: [
    {
      ...SAMPLE.materialThemes[0]!.representativeArticles[0]!,
      title: "Anders Holmström",
      domain: "",
      claimKind: "DATABASE_STATUS",
      evidenceRefs: ["inventory:obs-91"],
    },
  ],
});

const ADVERSE_PLOT: ClientReadPlot = {
  plotId: "plot:stockholm",
  title: "Уголовное дело о налоговом мошенничестве в Стокгольме",
  count: 2,
  adverseCount: 2,
  evidenceRefs: ["inventory:obs-01", "inventory:obs-02"],
  sourceDomains: ["affarsposten.se"],
  quotes: [
    {
      text: "Anders Holmström, founder of Nordkap Capital, faces tax-fraud probe in Stockholm",
      domain: "affarsposten.se",
      evidenceRef: "inventory:obs-01",
    },
  ],
};

const NEUTRAL_PLOT: ClientReadPlot = {
  plotId: "plot:interview",
  title: "Интервью о рынке скандинавского венчурного капитала",
  count: 1,
  adverseCount: 0,
  evidenceRefs: ["inventory:obs-03"],
  sourceDomains: ["nordic-review.se"],
  quotes: [],
};

function packWith(
  materialThemes: ClientMaterialTheme[],
  readPlots: ClientReadPlot[]
): ClientSummaryPack {
  return {
    ...SAMPLE,
    materialThemes,
    readPlots,
    evidenceRefs: [
      ...new Set([
        ...materialThemes.flatMap((t) => t.evidenceRefs),
        ...readPlots.flatMap((p) => p.evidenceRefs),
      ]),
    ],
  };
}

describe("покрытие тем на пути сюжетов", () => {
  const summary = composeClientSummary({
    pack: packWith(
      [COVERED_BY_NEUTRAL_PLOT, RESIDUAL_PUBLICATIONS, RESIDUAL_DATABASE],
      [ADVERSE_PLOT, NEUTRAL_PLOT]
    ),
  });

  it("тема, страницы которой прочитаны, уходит из резюме", () => {
    assertComposedSummaryGatesPass(summary);
    expect(summary.sections.themes.map((t) => t.heading)).toEqual([
      ADVERSE_PLOT.title,
      RESIDUAL_PUBLICATIONS.clientTitle,
      RESIDUAL_DATABASE.clientTitle,
    ]);
    expect(summary.fullText).not.toContain(COVERED_BY_NEUTRAL_PLOT.clientTitle);
    expect(summary.gates.SUMMARY_MATERIAL_THEME_COVERAGE).toBe(100);
  });

  it("остаточный блок публикаций называет своё основание", () => {
    const residual = summary.sections.themes.find(
      (t) => t.heading === RESIDUAL_PUBLICATIONS.clientTitle
    )!;
    expect(residual.kind).toBe("claims");
    expect(residual.body.endsWith(BASIS_LINE)).toBe(true);
  });

  it("блок комплаенс-базы фразы о непрочитанных страницах не получает", () => {
    const database = summary.sections.themes.find(
      (t) => t.heading === RESIDUAL_DATABASE.clientTitle
    )!;
    expect(database.body).not.toContain("прочитать не удалось");
  });

  it("секция сюжета помечена как сюжет и несёт свои ссылки", () => {
    const plot = summary.sections.themes[0]!;
    expect(plot.kind).toBe("read_plot");
    expect(plot.themeId).toBe(ADVERSE_PLOT.plotId);
    expect(plot.evidenceRefs).toEqual(ADVERSE_PLOT.evidenceRefs);
  });
});

describe("честная пустота", () => {
  it("все сюжеты нейтральны и остатка нет — резюме говорит это словами", () => {
    const summary = composeClientSummary({
      pack: packWith([COVERED_BY_NEUTRAL_PLOT], [NEUTRAL_PLOT]),
    });
    assertComposedSummaryGatesPass(summary);
    expect(summary.sections.themes).toEqual([]);
    expect(summary.fullText).toContain(NO_ADVERSE_PLOTS_LINE);
    expect(summary.fullText).not.toContain(COVERED_BY_NEUTRAL_PLOT.clientTitle);
    expect(summary.gates.SUMMARY_MATERIAL_THEME_COVERAGE).toBe(100);
  });
});

describe("прогон без чтения ссылок", () => {
  it("даёт ровно тот же текст, что и до шага", () => {
    const summary = composeClientSummary({ pack: SAMPLE });
    assertComposedSummaryGatesPass(summary);
    expect(summary.fullText).toBe(
      "Итоговая оценка: высокий риск. Основные основания: Коррупционные и этические риски; Политические связи и публичная экспозиция.\n" +
        "Главные основания. Коррупционные и этические риски: Sample investigation.\n" +
        "Ограничения. Вывод основан на открытых источниках; первичные документы могут изменить оценку.\n\n" +
        "Исследованы результаты поиска (ТОП-20), открытые СМИ по регионам RU, UAE. Данные сформированы по дате сбора в кейсе.\n\n" +
        "Коротко по итогам аудита\n\n" +
        "Коррупционные и этические риски. По теме «Коррупционные и этические риски» найдены конкретные материалы, " +
        "в том числе «Sample investigation» (news.example). " +
        "В материале сообщается о связанных с субъектом обстоятельствах; утверждения источника не равны установленному факту. " +
        "Коррупционные и этические сюжеты повышают требования к проверке связей, конфликтов интересов и первичных документов. " +
        "Что проверить: Сверить первоисточники по теме. " +
        "Публикация (news.example) содержит утверждения источника; подтверждение по первичным документам требуется.\n\n" +
        "Отдельные подтверждённые карточки международных баз в клиентском резюме не сформированы либо требуют отдельной сверки.\n\n" +
        "Следующие проверки. 1) Подготовить единый пакет документов для KYC."
    );
  });
});
