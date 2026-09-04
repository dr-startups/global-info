import { describe, expect, it } from "vitest";
import {
  adverseVisualSidebar,
  highlightPhrase,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { undeclaredClientTextDomains } from "@/modules/digital-profile/orion-golden/deck-sections/section-validation";
import type { ScopedEvidenceIndex } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type {
  VisibleAssetItem,
  VisualAssetsBySlot,
} from "@/modules/digital-profile/orion-golden/deck-sections/canonical-slots";
import { loadReport72DeckInputs } from "../../scripts/run-orion-deck-sections-report72";
import { buildSectionPackForFragment } from "@/modules/digital-profile/orion-golden/deck-sections/section-builders";
import type { SectionBuildContext } from "@/modules/digital-profile/orion-golden/deck-sections/section-builders";
import type { ExecutiveSummaryExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

/**
 * Строка снимка, которой нет среди улик страницы, источника не называет.
 *
 * Прогон DPA-2026-0053 не собрался вовсе: `RU_SERP_SCREENSHOT` и
 * `UAE_SERP_SCREENSHOT` отказали с «sidebar domain not derived from page
 * evidence» на `xn--80ankme.ru` (это `закон.ru`) и `court.read`. Причина одна и
 * та же: домен и адрес строки брались из самой строки снимка, когда улики по
 * ней в индексе нет, — а в `evidenceRefs` слайда такая строка не попадает, и
 * названный клиенту источник оказывался невыводимым из улик страницы.
 *
 * Правило у кода уже было записано: «источник называется, если его можно
 * назвать, — и не называется иначе». Третья причина безымянности — улики по
 * строке нет вовсе — в нём не учитывалась.
 */

const ROW: VisibleAssetItem = {
  ref: "inventory:row-no-evidence",
  url: "https://xn--80ankme.ru/news/court.read",
  domain: "xn--80ankme.ru",
  // Заголовок с именем издания — обычная строка выдачи; у строки без улики он
  // тоже невыводим из улик страницы.
  title: "Закон.ru: судья назначен председателем суда",
  adverse: true,
  themeTitle: "Криминальные / судебные материалы",
};

const WITH_EVIDENCE: ScopedEvidenceIndex = {
  "inventory:row-with-evidence": {
    url: "https://pravo.ru/story/1",
    domain: "pravo.ru",
    title: "Назначение председателя суда",
  },
};

describe("строка снимка без улики", () => {
  it("во фразе «Почему выделено» ни домена, ни адреса строки нет", () => {
    const phrase = highlightPhrase({ row: ROW, evidence: WITH_EVIDENCE });
    // Клиенту домен печатается читаемым, а ворота сверяют punycode: проверяются
    // обе формы — в отчёте 0053 в тексте стоял «закон.ru», а в отказе
    // `xn--80ankme.ru`, и по одной строке дефект было не узнать.
    expect(phrase.sidebar.toLowerCase()).not.toContain("закон.ru");
    expect(phrase.sidebar).not.toContain("xn--80ankme.ru");
    expect(phrase.sidebar).not.toContain("court.read");
  });

  it("фраза при этом остаётся фразой, а не прочерком", () => {
    const phrase = highlightPhrase({ row: ROW, evidence: WITH_EVIDENCE });
    expect(phrase.sidebar.trim().length).toBeGreaterThan(20);
    // Рубрика вместо заголовка: своё слово вместо чужого, которое нечем
    // подтвердить.
    expect(phrase.sidebar).toContain("Криминальные / судебные материалы");
  });

  it("в перечень источников снимка её домен не попадает", () => {
    const sidebar = adverseVisualSidebar(
      "slot_ru_serp_visual",
      {
        visualAssets: {
          slot_ru_serp_visual: [{ assetRef: "a1", visibleItems: [ROW] }],
        },
      } as never,
      { evidenceIndex: WITH_EVIDENCE, findings: [] } as never
    );
    expect(sidebar.explainedDomains).toEqual([]);
    expect(sidebar.explainedRefs).toEqual([]);
    // Рамка на снимке остаётся объяснённой: объяснений столько же, сколько рамок.
    expect(sidebar.explanations).toHaveLength(1);
  });

  it("собранный текст проходит те же ворота, что остановили прогон 0053", () => {
    const phrase = highlightPhrase({ row: ROW, evidence: WITH_EVIDENCE });
    const allowed = new Set(["pravo.ru"]);
    // Обе формы: и то, что печатается клиенту, и то, что уходит на лист
    // «почему выделено».
    expect(undeclaredClientTextDomains(phrase.sidebar, allowed, new Set())).toEqual([]);
    expect(undeclaredClientTextDomains(phrase.full, allowed, new Set())).toEqual([]);
  });
});

describe("строка снимка с уликой", () => {
  const row: VisibleAssetItem = {
    ref: "inventory:row-with-evidence",
    url: "https://pravo.ru/story/1",
    domain: "pravo.ru",
    title: "Назначение председателя суда",
    adverse: true,
    themeTitle: "Криминальные / судебные материалы",
  };

  it("называет свой источник, как называла", () => {
    const phrase = highlightPhrase({ row, evidence: WITH_EVIDENCE });
    expect(phrase.sidebar).toContain("pravo.ru");
  });
});


/**
 * Тот же закон на нейтральной строке: подпись «видимые источники» перечисляет
 * домены улик страницы, а не домены строк снимка.
 */
describe("нейтральная строка снимка без улики", () => {
  const inputs = loadReport72DeckInputs();
  const NEUTRAL: VisibleAssetItem = {
    ref: "inventory:neutral-no-evidence",
    url: "https://xn--80ankme.ru/news/court.read",
    domain: "xn--80ankme.ru",
    title: "Обзор судебной практики",
    adverse: false,
  };

  function sourceNoteOf(rows: VisibleAssetItem[], evidenceIndex: ScopedEvidenceIndex): string {
    const visualAssets: VisualAssetsBySlot = {
      p10_ru_serp_visual: [
        {
          assetRef: "ru_serp_snapshot",
          kind: "serp_screenshot",
          title: "Россия — результаты поисковой выдачи",
          hasImage: true,
          evidenceRefs: rows.map((r) => r.ref),
          visibleItems: rows,
        },
      ],
    };
    const ctx: SectionBuildContext = {
      caseId: inputs.caseId,
      reportRunId: inputs.reportRunId,
      sourceDatasetId: inputs.sourceDatasetId,
      contentVersion: "test-content-version",
      subject: { displayName: "Сергей Глинка", aliases: [] },
      bundle: inputs.mergedBundle,
      surfaceUnits: inputs.surfaceUnits,
      metricSnapshot: inputs.metricSnapshot,
      evidenceIndex,
      extras: {
        executiveSummary: inputs.executiveSummary as unknown as ExecutiveSummaryExtras,
        surfaceCollectionHints: inputs.surfaceCollectionHints,
        visualAssets,
      },
      buildLog: [],
    };
    const base = buildSectionPackForFragment("RU_SERP_SCREENSHOT", ctx).slides.find(
      (s) => !s.isContinuation
    )!;
    return String(base.content.sourceNote ?? "");
  }

  it("её домен не попадает в подпись источников снимка", () => {
    const note = sourceNoteOf([NEUTRAL], {});
    expect(note).not.toContain("закон.ru");
    expect(note).not.toContain("xn--80ankme.ru");
    expect(note).not.toContain("court.read");
  });

  it("домен строки с уликой в подписи остаётся", () => {
    // Улика настоящая, из эталона: построитель сужает индекс до области
    // фрагмента, и выдуманная ссылка в него не попадает ни при каком коде.
    const ref = "inventory:serp-obs-cmrjsdc5q00c5vd9g7s7j5esb";
    const withEvidence: VisibleAssetItem = {
      ref,
      url: "https://www.forbes.ru/profile/sergei-glinka",
      domain: "forbes.ru",
      title: "Сергей Глинка",
      adverse: false,
    };
    expect(sourceNoteOf([withEvidence], inputs.evidenceIndex)).toContain("forbes.ru");
  });
});
