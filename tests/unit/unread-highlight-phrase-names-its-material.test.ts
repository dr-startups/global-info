/**
 * Фраза непрочитанной страницы называет свой материал, а не только рубрику.
 *
 * Фраза печатала «рубрика — домен; страница не читалась…» и не печатала ни
 * заголовка, ни адреса, то есть материал не называла вовсе. Пока два таких
 * материала одного издания стояли на разных листах, читатель этого не видел;
 * стоило разбивке сдвинуться — и лист «почему выделено» напечатал **две
 * дословно одинаковые строки подряд**. Схлопнуть их нельзя: каждая объясняет
 * свою рамку, и «выделено: 2» под одним объяснением — потеря.
 *
 * Лечится причиной: адрес наблюдения у двух материалов разный всегда, даже
 * когда домен и рубрика совпадают. Механизм тот же, что у прочитанной
 * страницы, — адрес живёт в полной форме, а из узкой колонки уступает место,
 * и тогда строке нужен лист-продолжение.
 */

import { describe, expect, it } from "vitest";
import { highlightPhrase } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedEvidenceIndex } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { VisibleAssetItem } from "@/modules/digital-profile/orion-golden/deck-sections/canonical-slots";

const RUBRIC = "PEP / RCA / watchlist-сигналы";

function row(ref: string, url: string): VisibleAssetItem {
  return {
    ref,
    url,
    domain: "emirates-ledger.ae",
    title: "Anders Holmström referenced in UAE PEP/RCA compliance screening",
    adverse: true,
    themeTitle: RUBRIC,
  };
}

function index(rows: VisibleAssetItem[]): ScopedEvidenceIndex {
  const out: ScopedEvidenceIndex = {};
  for (const r of rows) {
    out[r.ref] = { url: r.url, domain: r.domain, title: r.title };
  }
  return out;
}

const FIRST = row("inventory:uae-1", "https://emirates-ledger.ae/anders-holmstrom-pep-rca-1");
const SECOND = row("inventory:uae-2", "https://emirates-ledger.ae/anders-holmstrom-pep-rca-7");

describe("непрочитанная страница называет свой материал адресом", () => {
  it("адрес наблюдения стоит в полной форме фразы", () => {
    const phrase = highlightPhrase({ row: FIRST, evidence: index([FIRST]) });
    expect(phrase.read).toBe(false);
    expect(phrase.full).toContain("emirates-ledger.ae/anders-holmstrom-pep-rca-1");
    expect(phrase.link).toBe("emirates-ledger.ae/anders-holmstrom-pep-rca-1");
  });

  it("два материала одного издания под одной рубрикой различаются", () => {
    const evidence = index([FIRST, SECOND]);
    const first = highlightPhrase({ row: FIRST, evidence });
    const second = highlightPhrase({ row: SECOND, evidence });
    expect(first.full).not.toBe(second.full);
  });

  it("рубрика, домен и причина непрочтения остаются на месте", () => {
    const phrase = highlightPhrase({ row: FIRST, evidence: index([FIRST]) });
    expect(phrase.full).toContain(RUBRIC);
    expect(phrase.full).toContain("emirates-ledger.ae");
    expect(phrase.full).toContain("текст страницы в этом прогоне не проверялся");
    expect(phrase.full).toContain("по заголовку и описанию в выдаче");
  });

  it("адрес уцелел в узкой колонке — уступает цитата слов выдачи, не адрес", () => {
    // Заголовок фикстуры несёт слово словаря («PEP»), и полная форма получает
    // цитату слов выдачи (шаг 0053). В узкую колонку она не входит и уступает
    // первой — как цитата прочитанной страницы; адрес и основание остаются.
    const phrase = highlightPhrase({ row: FIRST, evidence: index([FIRST]) });
    expect(phrase.sidebar).toContain("emirates-ledger.ae/anders-holmstrom-pep-rca-1");
    expect(phrase.sidebarHasLink).toBe(true);
    expect(phrase.sidebar).toContain("текст страницы в этом прогоне не проверялся");
    expect(phrase.full).toMatch(/^«[^»]*PEP[^»]*»/);
    expect(phrase.sidebarComplete).toBe(false);
  });

  it("длинный адрес узкой колонке не уступает — уступает объяснение", () => {
    const long = row(
      "inventory:uae-3",
      "https://emirates-ledger.ae/business/compliance/2026/anders-holmstrom-referenced-in-uae-pep-rca-compliance-screening-full-report"
    );
    const phrase = highlightPhrase({ row: long, evidence: index([long]) });
    // Первая редакция отдавала адрес целиком и рассчитывала на
    // лист-продолжение; у страниц изображений и подсказок его нет, и материал
    // оставался неназванным. Теперь уходит объяснение, а адрес остаётся.
    expect(phrase.sidebarHasLink).toBe(true);
    expect(phrase.sidebarComplete).toBe(false);
    expect(phrase.sidebar).toContain(
      "emirates-ledger.ae/business/compliance/2026/anders-holmstrom-referenced-in-uae-pep-rca-compliance-screening-full-report"
    );
    expect(phrase.full).toContain(
      "emirates-ledger.ae/business/compliance/2026/anders-holmstrom-referenced-in-uae-pep-rca-compliance-screening-full-report"
    );
  });

  it("строка без адреса фразу не ломает и продолжения не требует", () => {
    const noUrl: VisibleAssetItem = { ...FIRST, ref: "inventory:uae-4", url: undefined };
    const evidence: ScopedEvidenceIndex = {
      "inventory:uae-4": { domain: "emirates-ledger.ae", title: noUrl.title },
    };
    const phrase = highlightPhrase({ row: noUrl, evidence });
    expect(phrase.link).toBeUndefined();
    expect(phrase.sidebarHasLink).toBe(false);
    expect(phrase.sidebarComplete).toBe(true);
    expect(phrase.full).toContain("emirates-ledger.ae");
  });
});
