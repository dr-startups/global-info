import { describe, expect, it } from "vitest";
import {
  COVERAGE_EMPTY_COPY,
  claimBodyWithoutTheme,
  coverageContent,
  narrativeWithScope,
  reflowThemeBullet,
  themedClaim,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import {
  mergeSerpRowsByMaterial,
  serpMaterialKey,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import { countIdentityByObservation } from "../../src/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import {
  boilerplateShape,
  composeClientSummary,
} from "../../src/modules/digital-profile/orion-golden/analytics/client-summary-composer";
import { sampleClientSummaryPack } from "../../src/modules/digital-profile/orion-golden/contracts/sample-contracts";
import {
  fixSubjectNameOrder,
  subjectNameParts,
} from "../../src/modules/digital-profile/orion-golden/analytics/russian-name-order";
import { claimSpeaksAboutTheme } from "../../src/modules/digital-profile/orion-golden/analytics/representative-evidence-selector";
import type { CanonicalClaim } from "../../src/modules/digital-profile/orion-golden/contracts/canonical-claim";
import type { Finding } from "../../src/modules/digital-profile/orion-golden/contracts/finding";

/**
 * Шаг 13, этап 4 — связность и честность (docs/rework/13-regression-run-findings.md).
 *
 * Разделы C4, C5, C6, C10, C11, D7: отчёт повторял один и тот же абзац шесть
 * раз, печатал заголовок темы дважды подряд, заявлял отсутствие подсказок и тут
 * же их цитировал, показывал одну страницу как несколько «позиций» с
 * противоположными оценками и иллюстрировал тему материалом не о ней.
 */

const THEME = "Офшоры / корпоративное владение";

function offshoreFinding(): Finding {
  return {
    theme: THEME,
    claim: [
      "Найдены публикации об офшорных и корпоративных структурах владения:",
      "«Дуров, Павел Валерьевич — Википедия»",
      "«Сумма сделки не разглашалась» — источник ko.ru",
      "Всего по теме: 3 материала, с негативным контекстом — 1.",
      "Где видно: ko.ru, linkedin.com.",
    ].join("\n"),
    evidenceRefs: [],
  } as unknown as Finding;
}

describe("C6 — заголовок темы не печатается дважды", () => {
  it("тема стоит в тексте один раз", () => {
    const lines = themedClaim(offshoreFinding()).split("\n");
    expect(lines.filter((l) => l.trim() === `«${THEME}»`)).toHaveLength(1);
    expect(lines[0]).toBe(`«${THEME}»`);
  });

  it("тело темы её заголовок не повторяет", () => {
    expect(claimBodyWithoutTheme(offshoreFinding())).not.toContain(`«${THEME}»`);
  });

  it("тема, стоящая в начале строки, тоже не удваивается", () => {
    const out = reflowThemeBullet(`«Тема риска» Найдены публикации о теме риска.`);
    expect(out.split("\n").filter((l) => l.trim() === "«Тема риска»")).toHaveLength(1);
  });

  it("служебные врезки не приклеиваются к цитате", () => {
    const out = themedClaim(offshoreFinding());
    // «Где видно: …» — отдельный абзац, а не хвост строки с доказательством.
    expect(out.split("\n").some((l) => l.startsWith("Где видно:"))).toBe(true);
  });
});

describe("C5 — шаблонный абзац не повторяется дословно", () => {
  it("имя темы и список доменов не делают фразу другой", () => {
    const a = "Публикация (tass.ru, lenta.ru) содержит утверждения источника.";
    const b = "Публикация (ko.ru) содержит утверждения источника.";
    expect(boilerplateShape(a)).toBe(boilerplateShape(b));
  });

  it("перечисление тем сводится к той же форме, что и одна тема", () => {
    expect(boilerplateShape("Сверить первоисточники по теме «А», «Б», «В».")).toBe(
      boilerplateShape("Сверить первоисточники по теме «А».")
    );
  });

  it("разные по смыслу фразы не схлопываются", () => {
    expect(boilerplateShape("Запросить полную запись Dow Jones.")).not.toBe(
      boilerplateShape("Сверить первоисточники по теме «А».")
    );
  });

  it("оговорка звучит один раз на всё резюме, а не в каждой теме", () => {
    const base = sampleClientSummaryPack();
    const theme = base.materialThemes[0]!;
    const pack = {
      ...base,
      materialThemes: [
        {
          ...theme,
          recommendedChecks: [
            `Сверить первоисточники и статус материалов по теме «${theme.clientTitle}».`,
            "Подготовить согласованную позицию для KYC и партнёрских запросов.",
          ],
        },
        {
          ...theme,
          themeId: "criminal_judicial",
          clientTitle: "Криминальные и судебные материалы",
          recommendedChecks: [
            `Сверить первоисточники и статус материалов по теме «Криминальные и судебные материалы».`,
            "Подготовить согласованную позицию для KYC и партнёрских запросов.",
          ],
        },
      ],
      nextSteps: [
        `Сверить первоисточники и статус материалов по теме «${theme.clientTitle}», «Криминальные и судебные материалы».`,
        "Подготовить согласованную позицию для KYC и партнёрских запросов.",
      ],
    } as unknown as Parameters<typeof composeClientSummary>[0]["pack"];

    const themes = composeClientSummary({ pack }).sections.themes;
    const bodies = themes.map((t) => t.body).join("\n");
    const occurrences = (needle: string) => bodies.split(needle).length - 1;

    expect(themes.length).toBe(2);
    expect(occurrences(theme.qualification)).toBe(1);
    // Рекомендации уже собраны разделом «Следующие проверки» одной строкой.
    expect(occurrences("Что проверить:")).toBe(0);
  });
});

describe("C8 — отчество не уезжает за фамилию", () => {
  const NAME = "Дуров Павел Валерьевич";

  it("исправляет анкетный порядок в косвенном падеже", () => {
    expect(
      fixSubjectNameOrder("которые можно было бы связать с Павлом Дуровым Валерьевичем.", NAME)
    ).toBe("которые можно было бы связать с Павлом Валерьевичем Дуровым.");
    expect(fixSubjectNameOrder("профиль Павла Дурова Валерьевича", NAME)).toBe(
      "профиль Павла Валерьевича Дурова"
    );
  });

  it("правильный порядок не трогает", () => {
    for (const t of [
      "Павел Валерьевич Дуров основал Telegram",
      "интервью Павла Валерьевича Дурова",
      "Николай Валерьевич Дуров, математик",
    ]) {
      expect(fixSubjectNameOrder(t, NAME)).toBe(t);
    }
  });

  it("анкетную запись как заголовок не переставляет", () => {
    // «Дуров Павел Валерьевич» в шапке и в карточке — законная форма.
    expect(fixSubjectNameOrder("Отчёт о цифровом профиле — Дуров Павел Валерьевич", NAME)).toBe(
      "Отчёт о цифровом профиле — Дуров Павел Валерьевич"
    );
  });

  it("цитату источника не переписывает", () => {
    const t = "В выборке: «Дуров Павел Валерьевич: биография» — источник ko.ru.";
    expect(fixSubjectNameOrder(t, NAME)).toBe(t);
  });

  it("женское отчество узнаёт", () => {
    expect(fixSubjectNameOrder("с Марией Дуровой Валерьевной", "Дурова Мария Валерьевна")).toBe(
      "с Марией Валерьевной Дуровой"
    );
  });

  it("без отчества в имени субъекта молчит", () => {
    const t = "связаться с Павлом Дуровым Валерьевичем";
    expect(fixSubjectNameOrder(t, "Павел Дуров")).toBe(t);
    expect(subjectNameParts("Павел Дуров")).toBeNull();
  });
});

describe("C10 — корзины идентификации покрывают все наблюдения", () => {
  it("наблюдение без решения попадает в «недостаточно признаков»", () => {
    const counts = countIdentityByObservation({
      observationRefGroups: [["r1"], ["r2"], ["r3"], ["r4"], ["r5"]],
      decisionByRef: new Map([
        ["r1", "SUBJECT_MATCH"],
        ["r2", "LIKELY_SUBJECT"],
        ["r3", "OTHER_SUBJECT"],
        ["r4", "INSUFFICIENT_IDENTIFIERS"],
      ]),
    });
    const total =
      counts.subjectMatchCount +
      counts.likelySubjectCount +
      counts.ambiguousCount +
      counts.otherSubjectCount +
      counts.insufficientCount;
    // Цифры на обложке не сходились с разбивкой ровно на эти наблюдения.
    expect(total).toBe(5);
    expect(counts.insufficientCount).toBe(2);
  });
});

describe("C11 — пустая поверхность не отвечает за все остальные", () => {
  it("контур проверки назван в самом утверждении", () => {
    const out = narrativeWithScope(
      "Поисковые подсказки по запросам о субъекте проверены: материалов нет — это результат проверки.",
      "Яндекс, Россия"
    );
    expect(out).toContain("(Яндекс, Россия): материалов нет");
  });

  it("без контура формулировка прежняя", () => {
    const text = "Блок изображений проверен: материалов нет.";
    expect(narrativeWithScope(text, undefined)).toBe(text);
    expect(narrativeWithScope(text, "  ")).toBe(text);
  });

  it("страница пустых подсказок отправляет читателя к остальным системам", () => {
    const body = coverageContent("no-suggestions", { kind: "MEASURED_EMPTY" }, "Яндекс, Россия");
    expect(body.narrative).toContain("(Яндекс, Россия)");
    expect(body.bullets?.join(" ")).toContain("другим поисковым системам");
  });

  it("все формулировки пустых поверхностей пригодны для вставки контура", () => {
    // narrativeWithScope вставляет контур перед двоеточием; без него текст
    // молча остался бы глобальным утверждением.
    for (const [reason, copy] of Object.entries(COVERAGE_EMPTY_COPY)) {
      expect(copy.measuredWhat, reason).toContain(":");
    }
  });
});

describe("D7 — одна страница выдачи это одна строка таблицы", () => {
  const scoped = {
    evidenceIndex: {
      a: { domain: "ru.wikipedia.org", title: "Дуров, Павел Валерьевич", url: "https://ru.wikipedia.org/wiki/x" },
      b: { domain: "ru.wikipedia.org", title: "Дуров, Павел Валерьевич", url: "https://ru.wikipedia.org/wiki/x?utm=1" },
      c: { domain: "youtube.com", title: "Durov's Genius Schemes", url: "https://youtube.com/watch?v=1" },
      d: { domain: "youtube.com", title: "Durov's Genius Schemes", url: "https://youtube.com/watch?v=1&t=2" },
      e: { domain: "forbes.ru", title: "Павел Дуров", url: "https://forbes.ru/1" },
    },
  } as never;

  it("повторные наблюдения одного материала сливаются", () => {
    const merged = mergeSerpRowsByMaterial(["a", "b", "c", "d", "e"], scoped);
    expect(merged).toHaveLength(3);
    expect(merged[0]!.refs).toEqual(["a", "b"]);
    expect(merged[1]!.refs).toEqual(["c", "d"]);
  });

  it("порядок первого появления сохраняется", () => {
    const merged = mergeSerpRowsByMaterial(["e", "a", "b"], scoped);
    expect(merged.map((g) => g.refs[0])).toEqual(["e", "a"]);
  });

  it("разные материалы одного домена остаются разными строками", () => {
    expect(
      serpMaterialKey({ domain: "rbc.ru", title: "Первый" })
    ).not.toBe(serpMaterialKey({ domain: "rbc.ru", title: "Второй" }));
  });

  it("без заголовка материал опознаётся по адресу", () => {
    expect(serpMaterialKey({ domain: "rbc.ru", url: "https://rbc.ru/a/" })).toBe(
      serpMaterialKey({ domain: "rbc.ru", url: "http://www.rbc.ru/a" })
    );
    expect(serpMaterialKey({ domain: "rbc.ru", url: "https://rbc.ru/a" })).not.toBe(
      serpMaterialKey({ domain: "rbc.ru", url: "https://rbc.ru/b" })
    );
  });
});

describe("C4 — тему представляет материал, который о ней написан", () => {
  const claim = (text: string): CanonicalClaim =>
    ({
      originalTitle: "Павел Дуров",
      displayExcerpt: "",
      fullClaimText: text,
    }) as unknown as CanonicalClaim;

  it("узнаёт материал по собственному тексту", () => {
    expect(
      claimSpeaksAboutTheme(
        claim("Найдены публикации об офшорных и корпоративных структурах владения."),
        "offshore_financial_transparency"
      )
    ).toBe(true);
  });

  it("унаследованную тему своей не считает", () => {
    // Профиль во «ВКонтакте» представлял «Офшоры и финансовую прозрачность».
    expect(
      claimSpeaksAboutTheme(
        claim("Найдены материалы о политической и публичной экспозиции субъекта."),
        "offshore_financial_transparency"
      )
    ).toBe(false);
  });
});
