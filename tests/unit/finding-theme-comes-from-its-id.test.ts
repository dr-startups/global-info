/**
 * Тему находки дека узнаёт по идентификатору, а не по разбору ярлыка.
 *
 * Разбор шёл подстрокой: `f.theme.toLowerCase().includes(t.label.toLowerCase())`.
 * Пока ярлыки были непохожими, это работало; после разделения офшорной темы
 * **старый ярлык стал содержать новый** — «Офшоры / корпоративное владение»
 * находит «Корпоративное владение». Находка прежнего прогона разбиралась как
 * описательная тема: бралась чужая присказка, чужое «почему важно» и, что хуже,
 * `isAccusingTheme` становился `false` — молча отключалась защита «обвиняющая
 * тема не цитирует благоприятно прочитанную страницу».
 *
 * Идентификатор находки несёт `themeId` (`finding-<themeId>-<решение>-<хэш>`) и
 * ярлыком не притворяется: он переживает и переименование темы в каталоге, и
 * набор, сохранённый прошлым прогоном.
 */

import { describe, expect, it } from "vitest";
import { localizedThemedClaim } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { Finding } from "@/modules/digital-profile/orion-golden/contracts/finding";

const OFFSHORE_WHY =
  "Для KYC это типичный запрос на раскрытие бенефициаров и источников контроля.";
const OWNERSHIP_WHY =
  "Само по себе владение компаниями претензией не является, но состав долей и историю сделок обычно просят подтвердить документами.";

/** Кросс-региональная находка: опора российская, страница — ОАЭ. */
function finding(findingId: string, theme: string): Finding {
  return {
    findingId,
    theme,
    claim:
      "Найдены публикации по теме:\n" +
      "«Структура владения раскрыта в реестре» — источник kulak.team\n" +
      "Всего по теме: 3 материала.\n" +
      OFFSHORE_WHY,
    riskLevel: "medium",
    regions: ["RU", "UAE"],
    evidenceRefs: ["ev-ru", "ev-uae"],
    sourceDomains: ["kulak.team", "gulfnews.com"],
  } as unknown as Finding;
}

/** Страницу ОАЭ прочитали и признали нейтральной. */
function uaeScoped(): ScopedFragmentInput {
  return {
    findings: [],
    surfaceUnits: [],
    evidenceIndex: {
      "ev-ru": {
        title: "Структура владения раскрыта в реестре",
        domain: "kulak.team",
        region: "RU",
      },
      "ev-uae": {
        title: "Gulf News profiles a Dubai holding company ownership chain",
        domain: "gulfnews.com",
        region: "UAE",
        readVerdictTone: "neutral",
      },
    },
    scope: { regions: ["UAE"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

describe("тема находки берётся у идентификатора", () => {
  it("прежний ярлык не разбирается как новая описательная тема", () => {
    const claim = localizedThemedClaim(
      finding("finding-offshore_corporate-subject_match-1b4c64c7", "Офшоры / корпоративное владение"),
      uaeScoped()
    );
    // Тема каталогу неизвестна — значит обвиняющая: защита остаётся на месте.
    expect(claim).not.toContain("Gulf News profiles a Dubai holding company");
    expect(claim).not.toContain(OWNERSHIP_WHY);
  });

  it("переименованный ярлык темы не мешает: идентификатор её называет", () => {
    const claim = localizedThemedClaim(
      finding("finding-offshore_structures-subject_match-4cc9cf0d", "Офшоры (прежняя редакция ярлыка)"),
      uaeScoped()
    );
    expect(claim).toContain(OFFSHORE_WHY);
    expect(claim).not.toContain("Gulf News profiles a Dubai holding company");
  });

  it("описательная тема нейтральную страницу цитирует по-прежнему", () => {
    const claim = localizedThemedClaim(
      finding("finding-corporate_ownership-subject_match-4cc9cf0d", "Корпоративное владение"),
      uaeScoped()
    );
    expect(claim).toContain("Gulf News profiles a Dubai holding company");
    expect(claim).toContain(OWNERSHIP_WHY);
  });
});
