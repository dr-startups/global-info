import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReport72DeckInputs, loadReportAssets } from "../../scripts/run-orion-deck-sections-report72";
import { runDeckBuild } from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import type { ExecutiveSummaryExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ComposedClientSummary } from "@/modules/digital-profile/orion-golden/contracts/composed-client-summary";
import type { Finding } from "@/modules/digital-profile/orion-golden/contracts/finding";

/**
 * Враждебный корпус формы DPA-2026-0053: дека собирается, ворота не блокируют.
 *
 * Четыре отказа того прогона открывались по одному, каждый — выкатом и
 * получасовой попыткой, потому что эталоны деки — прогоны без якорей, и формы
 * данных строгого режима они не видели. Здесь эталон `report-72` нарочно
 * портится всем, на чём вставал 0053, и тем, что могло встать следом:
 * кириллическое имя издания в заголовке, описание с пропущенным пробелом,
 * ответ ИИ длиннее тысячи знаков, строка снимка без улики, ник с
 * подчёркиванием, код заглавными в заголовке, IDN-домен, две находки с
 * одинаковым телом карточки, повтор пункта на странице.
 *
 * Свойство одно: `assembly.errors` пуст, обязательные секции целы, `blocking`
 * пуст. Что именно сборка починила, названо в её разборе, а не спрятано.
 */

const inputs = loadReport72DeckInputs();

/** Улика по ссылке снимка: индекс хранит её и как наблюдение, и как инвентарь. */
function evidenceKeysOf(index: Record<string, unknown>, ref: string): string[] {
  const id = ref.replace(/^serp_observation:/u, "");
  return Object.keys(index).filter((k) => k === ref || k.endsWith(id));
}

function hostileInputs() {
  const evidenceIndex = structuredClone(inputs.evidenceIndex);
  // Выделенные строки снимка выдачи — те, чьи заголовки печатает фраза «Почему
  // выделено»: именно через неё в 0053 в текст попали «Закон.ru» и «court.Read».
  const baseAssets = loadReportAssets(evidenceIndex).visualAssets;
  const ruAdverse = (baseAssets.p10_ru_serp_visual?.[0]?.visibleItems ?? []).filter((v) => v.adverse);
  const uaeAdverse = (baseAssets.p27_uae_serp_visual?.[0]?.visibleItems ?? []).filter((v) => v.adverse);
  expect(ruAdverse.length, "в эталоне есть выделенные строки снимка RU").toBeGreaterThan(0);
  const brand = ruAdverse[0]!;
  for (const key of evidenceKeysOf(evidenceIndex, brand.ref)) {
    evidenceIndex[key]!.title = "Алексей Егоров - Закон.ru";
  }
  const cut = uaeAdverse[0];
  if (cut) {
    for (const key of evidenceKeysOf(evidenceIndex, cut.ref)) {
      evidenceIndex[key]!.snippet =
        "represented the interests of ZAO Alcoa Metallurg Rus in a Russian court.Read more";
      evidenceIndex[key]!.title = "Egorov Puginsky Afanasiev & Partners — ROSNEFT_OIL case";
    }
  }
  const refs = Object.keys(evidenceIndex);
  const organic = refs.filter((r) => evidenceIndex[r]?.kind === "organic" && evidenceIndex[r]?.region === "RU");
  const [r3, r4] = organic.slice(-2);
  if (r3) {
    evidenceIndex[r3]!.title = "egorov_ab — судья Егоров на связи";
    evidenceIndex[r3]!.domain = "xn--80ankme.ru";
    evidenceIndex[r3]!.url = "https://xn--80ankme.ru/news/1";
  }
  if (r4) {
    evidenceIndex[r4]!.subjectDecision = "AMBIGUOUS";
    evidenceIndex[r4]!.subjectReason = "full_name_no_anchor";
  }
  // Длинный английский ответ ИИ — таким был ответ Google по ОАЭ в 0053.
  const aiRef = refs.find((r) => evidenceIndex[r]?.kind === "ai_answer" && evidenceIndex[r]?.snippet);
  if (aiRef) {
    evidenceIndex[aiRef]!.snippet = Array.from(
      { length: 14 },
      (_, i) => `Sentence ${i + 1}: because the patronymic is not commonly shared, the results describe several different people with the same name.`
    ).join(" ");
  }
  const bundle = structuredClone(inputs.mergedBundle);
  // Две находки с одинаковым телом карточки под разными темами (матрица).
  const likely = bundle.findings.find((f) => f.subjectMatch === "LIKELY_SUBJECT") ?? bundle.findings[0];
  if (likely) {
    bundle.findings.push({
      ...structuredClone(likely),
      findingId: `${likely.findingId}-twin`,
      theme: `${likely.theme} (второй тёзка)`,
      subjectMatch: "LIKELY_SUBJECT",
    } as Finding);
  }
  // Одна и та же находка дважды — приложение напечатало бы её два раза.
  const appendix = bundle.findings.find((f) => f.subjectMatch === "OTHER_SUBJECT");
  if (appendix) {
    bundle.findings.push({ ...structuredClone(appendix), findingId: `${appendix.findingId}-again` } as Finding);
  }
  const visualAssets = loadReportAssets(evidenceIndex).visualAssets;
  return { evidenceIndex, bundle, visualAssets, brandRef: brand.ref };
}

describe("враждебный корпус формы 0053", () => {
  it("дека собирается, обязательные секции целы, ворота сборки не блокируют", () => {
    const hostile = hostileInputs();
    const outputRoot = mkdtempSync(join(tmpdir(), "hostile-deck-"));
    const result = runDeckBuild({
      ctx: {
        caseId: inputs.caseId,
        reportRunId: inputs.reportRunId,
        sourceDatasetId: inputs.sourceDatasetId,
        contentVersion: "hostile-test",
        subject: { displayName: "Егоров Алексей Евгеньевич", aliases: ["Alexey Egorov"] },
        bundle: hostile.bundle,
        surfaceUnits: inputs.surfaceUnits,
        metricSnapshot: inputs.metricSnapshot,
        evidenceIndex: hostile.evidenceIndex,
        extras: {
          executiveSummary: inputs.executiveSummary as unknown as ExecutiveSummaryExtras,
          composedClientSummary:
            (inputs.composedClientSummary as unknown as ComposedClientSummary) ?? undefined,
          surfaceCollectionHints: inputs.surfaceCollectionHints,
          complianceScreenings: inputs.complianceScreenings,
          personaDecision: inputs.personaDecision ?? undefined,
          visualAssets: hostile.visualAssets,
        },
      },
      bundleForValidation: hostile.bundle,
      knownEvidenceRefs: inputs.knownEvidenceRefs,
      outputRoot,
      baseObservationCountBefore: inputs.baseCountBefore,
      baseObservationCountAfter: inputs.baseCountAfter,
      serpObservations: inputs.serpObservations,
    });
    expect(result.assembly.errors).toEqual([]);
    expect(result.manifest.requiredSectionsFailed).toEqual([]);
    expect(result.assemblyValidation?.blocking ?? []).toEqual([]);
    // Секции, которые ворота отвергли бы, названы — их не должно быть.
    const failed = result.packs.filter((p) => !p.validation.passed).map((p) => `${p.fragmentKey}: ${p.validation.issues[0]}`);
    expect(failed).toEqual([]);
    // Корпус действительно дошёл до страницы: имя издания стоит в тексте снимка,
    // а повтор приложения снят починкой, а не пропущен.
    const serp = result.packs.find((p) => p.fragmentKey === "RU_SERP_SCREENSHOT");
    const serpText = JSON.stringify(serp?.slides.map((s) => s.content) ?? []);
    expect(serpText).toContain("Закон.ru");
    // Дубликат вырезается там, где напечатан второй раз, — это может быть и
    // страница продолжения приложения.
    const repaired = result.assembly.repeatRepairs.map((r) => r.slideKey);
    expect(repaired.some((k) => k.startsWith("appendix_main_base"))).toBe(true);
  });
});
