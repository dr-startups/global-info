import { describe, expect, it } from "vitest";
import { buildIdentityFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/identity";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import { getClientTextFieldBudgets } from "@/modules/digital-profile/orion-golden/client/load-client-text-contract";
import {
  WIKIPEDIA_ARTICLE_LEAD_PREFIX,
  WIKIPEDIA_ARTICLE_LEAD_PREFIX_UNCONFIRMED,
  WIKIPEDIA_FRAGMENT_CATEGORY_LABELS,
  WIKIPEDIA_FRAGMENT_RECOMMENDATIONS,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

/**
 * Страница Википедии печатает саму статью: основное описание дословно и
 * отдельным блоком — фрагменты, требующие внимания.
 *
 * Путь именно буллетный. Карточка `content_card` при нехватке места молча
 * отбрасывает предложения (предупреждение в лог и ничего больше), а буллеты
 * после перехода на меру рендерера слышны: переполнение уходит в продолжение.
 * Тихая потеря на странице, чья ценность — дословность, недопустима.
 */

const LEAD =
  "Андерс Хольмстрём — шведский предприниматель, основатель инвестиционной компании. " +
  "С 2015 года руководит фондом в Стокгольме.";

const QUOTE_NEGATIVE =
  "В 2019 году в отношении компании начата налоговая проверка, завершившаяся доначислением.";
const QUOTE_OUTDATED = "По состоянию на 2014 год компания насчитывала двенадцать сотрудников.";

type ReviewInput = {
  status?: "REVIEWED" | "NOT_REVIEWED";
  notReviewedReason?: "offline" | "model-unavailable";
  lead?: string;
  sections?: string[];
  fragments?: Array<{
    quote: string;
    category: "negative" | "needs_update";
    gloss: string;
    section?: string;
  }>;
  truncated?: boolean;
  reviewedChars?: number;
  articleTextChars?: number;
  subjectMatch?: string;
  /** Сколько фрагментов снял аудит дословности. */
  auditDropped?: number;
};

type ScopedInput = {
  checkExists?: boolean;
  subjectDecision?: string;
  review?: ReviewInput | null;
  foundVia?: string;
  langlinkOf?: { language: string; title: string };
  rowTitles?: string[];
  claimTexts?: string[];
  language?: string;
  region?: "RU" | "UAE";
};

function scoped(input: ScopedInput): ScopedFragmentInput {
  const region = input.region ?? "RU";
  const language = input.language ?? "ru";
  const rows = input.rowTitles ?? ["Anders Holmström — биография"];
  const evidenceIndex: Record<string, unknown> = {};
  const rowRefs = rows.map((title, i) => {
    const ref = `inventory:wiki-row-${i}`;
    evidenceIndex[ref] = {
      kind: "wikipedia",
      region,
      title,
      domain: `${language}.wikipedia.org`,
      url: `https://${language}.wikipedia.org/wiki/row${i}`,
      subjectDecision: "SUBJECT_MATCH",
    };
    return ref;
  });
  const review = input.review;
  evidenceIndex["inventory:wiki-check-0"] = {
    kind: "wikipedia_check",
    wikipediaExists: input.checkExists ?? true,
    language,
    title: "Anders Holmström",
    url: `https://${language}.wikipedia.org/wiki/Anders_Holmstrom`,
    checkedAt: "2026-07-01T12:00:00.000Z",
    query: "Anders Holmström",
    subjectDecision: input.subjectDecision ?? "SUBJECT_MATCH",
    domain: `${language}.wikipedia.org`,
    region,
    foundVia: input.foundVia,
    langlinkOf: input.langlinkOf,
    articleReview:
      review === null || review === undefined
        ? undefined
        : {
            status: review.status ?? "REVIEWED",
            notReviewedReason: review.notReviewedReason,
            lead: review.lead ?? LEAD,
            sections: review.sections ?? ["Биография"],
            fragments: review.fragments ?? [],
            truncated: review.truncated ?? false,
            reviewedChars: review.reviewedChars ?? 900,
            articleTextChars: review.articleTextChars ?? 900,
            subjectMatch: review.subjectMatch ?? "subject",
            audit: { dropped: review.auditDropped ?? 0, reasons: [] },
          },
  };
  const claims = (input.claimTexts ?? []).map((text) => ({
    text,
    subjectMatch: "SUBJECT_MATCH",
    evidenceRefs: rowRefs,
  }));
  const status = "MEASURED";
  return {
    subject: { displayName: "Anders Holmström", aliases: [] },
    findings: [],
    surfaceUnits: [
      {
        surface: "wikipedia",
        region,
        claims,
        metrics: [
          { key: "totalCount", value: rows.length, sampleStatus: status, denominator: rows.length },
          { key: "subjectMatchCount", value: rows.length, sampleStatus: status },
          { key: "otherSubjectCount", value: 0, sampleStatus: status },
          { key: "ambiguousCount", value: 0, sampleStatus: status },
          { key: "adverseSubjectCount", value: 0, sampleStatus: status, denominator: 0 },
        ],
        evidenceRefs: rowRefs,
        emptyMarkerRefs: [],
      },
    ],
    evidenceIndex,
    scope: { regions: [region], surfaces: ["wikipedia"], subjectMatch: null, findingIds: null },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

function slides(input: ScopedInput): SlideContentContract[] {
  const uae = input.region === "UAE";
  return buildIdentityFragment(
    uae ? "UAE_IDENTITY_WIKIPEDIA" : "RU_IDENTITY_WIKIPEDIA",
    uae ? "UAE_PROFILE" : "RU_PROFILE",
    uae ? "ОАЭ / международный" : "Россия",
    scoped(input)
  ).slides;
}

function build(input: ScopedInput): SlideContentContract {
  return slides(input)[0]!;
}

function allBullets(input: ScopedInput): string[] {
  return slides(input).flatMap((s) => s.content.bullets ?? []);
}

function pageText(input: ScopedInput): string {
  return slides(input)
    .flatMap((s) => [
      s.content.narrative,
      ...(s.content.bullets ?? []),
      s.content.whatWasFound,
      s.content.whyItMatters,
      s.content.whatToCheck,
      s.content.statusNote,
      s.content.sourceNote,
    ])
    .filter(Boolean)
    .join(" ");
}

const NEGATIVE_FRAGMENT = {
  quote: QUOTE_NEGATIVE,
  category: "negative" as const,
  gloss: "налоговая проверка 2019 года",
  section: "Деятельность",
};

const REVIEWED_WITH_NEGATIVE: ScopedInput = {
  review: { fragments: [NEGATIVE_FRAGMENT] },
};

describe("основное описание статьи печатается дословно", () => {
  it("лид идёт буллетами целыми предложениями, с подписью «дословно»", () => {
    const bullets = allBullets(REVIEWED_WITH_NEGATIVE);
    const lead = bullets.filter((b) => b.startsWith(WIKIPEDIA_ARTICLE_LEAD_PREFIX));
    expect(lead).toHaveLength(1);
    const leadText = bullets
      .filter((b) => b.startsWith(WIKIPEDIA_ARTICLE_LEAD_PREFIX))
      .map((b) => b.slice(WIKIPEDIA_ARTICLE_LEAD_PREFIX.length))
      .join(" ");
    expect(LEAD).toContain(leadText);
  });

  it("ни одного многоточия в новых строках", () => {
    for (const bullet of allBullets(REVIEWED_WITH_NEGATIVE)) {
      expect(bullet).not.toContain("…");
      expect(bullet).not.toContain("...");
    }
  });

  it("строки выдачи уступают место статье", () => {
    const bullets = allBullets(REVIEWED_WITH_NEGATIVE);
    expect(bullets.some((b) => b.includes("Anders Holmström — биография"))).toBe(false);
  });
});

describe("фрагменты статьи отделены от описания и несут рекомендацию", () => {
  it("негативный фрагмент печатается меткой, цитатой, подписью, разделом и рекомендацией", () => {
    const bullet = allBullets(REVIEWED_WITH_NEGATIVE).find((b) =>
      b.startsWith(WIKIPEDIA_FRAGMENT_CATEGORY_LABELS.negative)
    );
    expect(bullet).toBeDefined();
    expect(bullet!).toContain(`«${QUOTE_NEGATIVE}»`);
    expect(bullet!).toContain("налоговая проверка 2019 года");
    expect(bullet!).toContain("раздел «Деятельность»");
    expect(bullet!).toContain(WIKIPEDIA_FRAGMENT_RECOMMENDATIONS.negative);
  });

  it("устаревший фрагмент получает свою метку и свою рекомендацию", () => {
    const bullet = allBullets({
      review: {
        fragments: [
          {
            quote: QUOTE_OUTDATED,
            category: "needs_update",
            gloss: "данные 2014 года",
            section: "Компания",
          },
        ],
      },
    }).find((b) => b.startsWith(WIKIPEDIA_FRAGMENT_CATEGORY_LABELS.needs_update));
    expect(bullet).toBeDefined();
    expect(bullet!).toContain(WIKIPEDIA_FRAGMENT_RECOMMENDATIONS.needs_update);
    expect(bullet!).not.toContain(WIKIPEDIA_FRAGMENT_RECOMMENDATIONS.negative);
  });

  it("нарратив называет число выделенных фрагментов", () => {
    expect(build(REVIEWED_WITH_NEGATIVE).content.narrative ?? "").toContain(
      "В тексте статьи выделено 1"
    );
  });

  it("буллеты остаются в бюджете клиентского текста", () => {
    const budget = getClientTextFieldBudgets().bullet;
    const long = {
      review: {
        fragments: [
          {
            quote: "Ц".repeat(220),
            category: "negative" as const,
            gloss: "П".repeat(100),
            section: "Р".repeat(60),
          },
        ],
      },
    };
    for (const bullet of allBullets(long)) expect(bullet.length).toBeLessThanOrEqual(budget);
  });

  it("лид и восемь фрагментов уходят в продолжения, а не теряются", () => {
    const many = {
      review: {
        fragments: Array.from({ length: 8 }, (_, i) => ({
          quote: `${QUOTE_NEGATIVE} Вариант ${i}.`,
          category: "negative" as const,
          gloss: `подпись фрагмента ${i}`,
          section: "Деятельность",
        })),
      },
    };
    const pages = slides(many);
    expect(pages.length).toBeGreaterThan(1);
    const printed = allBullets(many);
    for (let i = 0; i < 8; i += 1) {
      expect(printed.some((b) => b.includes(`подпись фрагмента ${i}`))).toBe(true);
    }
  });
});

describe("чужой негатив не работает на профиль субъекта", () => {
  const UNCONFIRMED: ScopedInput = {
    subjectDecision: "AMBIGUOUS",
    review: { fragments: [NEGATIVE_FRAGMENT] },
  };

  it("при неподтверждённой принадлежности фрагменты не печатаются", () => {
    const text = pageText(UNCONFIRMED);
    expect(text).not.toContain(QUOTE_NEGATIVE);
    expect(text).not.toContain(WIKIPEDIA_FRAGMENT_CATEGORY_LABELS.negative);
  });

  it("лид при этом печатается — он и помогает установить принадлежность", () => {
    const bullets = allBullets(UNCONFIRMED);
    expect(bullets.some((b) => b.startsWith(WIKIPEDIA_ARTICLE_LEAD_PREFIX_UNCONFIRMED))).toBe(true);
    expect(bullets.join(" ")).toContain("шведский предприниматель");
  });

  it("страница объясняет словами, почему фрагментов нет", () => {
    expect(build(UNCONFIRMED).content.narrative ?? "").toContain(
      "принадлежность статьи проверяемому лицу не подтверждена"
    );
    expect(pageText(UNCONFIRMED)).not.toContain("В тексте статьи выделено");
  });

  it("разбор «статья о другом лице» ведёт себя так же", () => {
    // Понижение решения делает загрузчик входов; здесь проверяется, что
    // страница на понижённом решении печатает ту же защищённую ветку.
    const text = pageText({
      subjectDecision: "OTHER_SUBJECT",
      review: { subjectMatch: "other", fragments: [NEGATIVE_FRAGMENT] },
    });
    expect(text).not.toContain(QUOTE_NEGATIVE);
  });
});

describe("честные пустоты разбора", () => {
  it("«не разобрано» называет причину и не утверждает, что негатива нет", () => {
    const text = pageText({
      review: { status: "NOT_REVIEWED", notReviewedReason: "model-unavailable", fragments: [] },
    });
    expect(text).toContain("Разбор текста статьи не выполнялся");
    expect(text).not.toContain("фрагментов в тексте статьи не выделено");
  });

  it("офлайн-причина названа своими словами", () => {
    const text = pageText({
      review: { status: "NOT_REVIEWED", notReviewedReason: "offline", fragments: [] },
    });
    expect(text).toContain("Разбор текста статьи не выполнялся");
    expect(text).not.toContain("model-unavailable");
    expect(text).not.toContain("offline");
  });

  it("разбор без фрагментов — это результат, и он назван", () => {
    const text = pageText({ review: { fragments: [] } });
    expect(text).toContain("Негативных или спорных фрагментов в тексте статьи не выделено");
  });

  it("урезанный вход оговаривается числом разобранных знаков", () => {
    const text = pageText({
      review: { fragments: [], truncated: true, reviewedChars: 60000, articleTextChars: 214000 },
    });
    expect(text).toContain("разобраны первые 60000 знаков");
  });

  it("без разбора страница о тексте статьи молчит вовсе", () => {
    const text = pageText({ review: null });
    expect(text).not.toContain("текста статьи");
    expect(text).not.toContain("текст статьи");
    expect(text).not.toContain("Начало статьи");
  });
});

describe("о содержании статьи говорит один инструмент", () => {
  it("разбор нашёл негатив — страница не объявляет статью чистой", () => {
    // Словарь заголовков (`ADVERSE_PATTERNS`) на «Anders Holmström — биография»
    // молчит: ровно эта конфигурация на живом прогоне давала «существенных
    // негативных формулировок не выявлено» рядом с разбором, нашедшим негатив.
    const text = pageText(REVIEWED_WITH_NEGATIVE);
    expect(text).toContain("В тексте статьи выделено 1");
    expect(text).not.toContain("Негативных или спорных фрагментов в тексте статьи не выделено");
  });

  it("словарь заголовков говорит о заголовках строк выдачи, а не о статье", () => {
    const text = pageText(REVIEWED_WITH_NEGATIVE);
    expect(text).toContain("В заголовках");
    expect(text).not.toContain("Существенных негативных или спорных формулировок в них не выявлено");
  });
});

describe("одинаковые строки выдачи — один сигнал", () => {
  it("три одинаковых клейма печатаются одним буллетом", () => {
    const bullets = allBullets({
      review: null,
      claimTexts: ["Дуров, Павел Валерьевич", "Дуров, Павел Валерьевич", "Дуров, Павел Валерьевич"],
    });
    expect(bullets.filter((b) => b.includes("Дуров, Павел Валерьевич"))).toHaveLength(1);
  });
});

describe("способ находки статьи назван", () => {
  it("статья соседнего раздела названа найденной по межъязыковой ссылке", () => {
    const narrative =
      build({
        region: "UAE",
        language: "en",
        foundVia: "langlink",
        langlinkOf: { language: "ru", title: "Мордашов, Алексей Александрович" },
        review: null,
      }).content.narrative ?? "";
    expect(narrative).toContain("по межъязыковой ссылке");
    expect(narrative).toContain("русскоязычн");
  });

  it("находка поиском о межъязыковой ссылке не говорит", () => {
    expect(build({ review: null }).content.narrative ?? "").not.toContain("межъязыковой");
  });
});

describe("дословный текст статьи печатается целиком", () => {
  /*
   * Домен внутри дословной цитаты — часть текста статьи, а не наша ссылка на
   * источник. Источник этой строки назван на том же слайде адресом самой
   * статьи, поэтому правило «домен в клиентском тексте выводится из
   * доказательств страницы» здесь исполнено, а не обойдено. Гард, снимавший
   * такие строки, удалял дословный текст и при этом ничего не предотвращал:
   * буллеты в область доменных ворот не входят вовсе.
   */
  const withForeignDomain: ScopedInput = {
    review: {
      lead:
        "Андерс Хольмстрём — шведский предприниматель. " +
        "Профиль опубликован на vedomosti.ru в 2020 году.",
      fragments: [
        {
          quote: "Материал forbes.com называет сделку спорной, ссылаясь на источники.",
          category: "negative",
          gloss: "спорная сделка",
          section: "Деятельность",
        },
      ],
    },
  };

  it("предложение лида с чужим доменом не выбрасывается", () => {
    const bullets = allBullets(withForeignDomain);
    expect(bullets.join(" ")).toContain("шведский предприниматель");
    expect(bullets.join(" ")).toContain("vedomosti.ru");
  });

  it("фрагмент с чужим доменом печатается и не молчит", () => {
    expect(pageText(withForeignDomain)).toContain("forbes.com");
  });

  it("метрики подавления на слайде больше нет", () => {
    expect(build(withForeignDomain).metrics?.fragmentsSuppressedByDomainGuard).toBeUndefined();
  });

  it("обычная проза без пробела после точки не считается адресом и не пропадает", () => {
    // «предприниматель.Он», «им.Пушкина», «г.Москва» — это текст статьи, а не
    // домены. Прежний гард снимал такие предложения целиком.
    const bullets = allBullets({
      review: {
        lead: "Андерс Хольмстрём — предприниматель.Он живёт в г.Москва и работает в им.Пушкина.",
        fragments: [],
      },
    });
    expect(bullets.join(" ")).toContain("предприниматель.Он");
    expect(bullets.join(" ")).toContain("г.Москва");
  });
});

describe("отброшенный разбор не выдаётся за чистую статью", () => {
  it("аудит снял все фрагменты — страница не говорит «не выделено»", () => {
    const text = pageText({ review: { fragments: [], auditDropped: 2 } });
    expect(text).not.toContain("Негативных или спорных фрагментов в тексте статьи не выделено");
    expect(text).toContain("не прошли сверку с текстом статьи");
    expect(text).toContain("вывод об отсутствии негатива в тексте статьи из этого не следует");
  });

  it("часть снята — страница называет число неприведённых", () => {
    const text = pageText({
      review: { fragments: [NEGATIVE_FRAGMENT], auditDropped: 3 },
    });
    expect(text).toContain("В тексте статьи выделено 1");
    expect(text).toContain("Ещё 3 не прошли сверку с текстом статьи");
  });

  it("ничего не снималось — прежняя честная пустота остаётся", () => {
    const text = pageText({ review: { fragments: [], auditDropped: 0 } });
    expect(text).toContain("Негативных или спорных фрагментов в тексте статьи не выделено");
    expect(text).not.toContain("не прошли сверку");
  });
});

describe("страница не утверждает того, чего не проверяла", () => {
  it("неподтверждённая статья не объявляется совпавшей по имени субъекта", () => {
    // «Глинка (дворянский род)»: совпала фамилия, а не имя субъекта. До этого
    // шага ветка была недостижима — чеканка всегда давала подтверждение.
    const narrative =
      build({ subjectDecision: "AMBIGUOUS", review: null }).content.narrative ?? "";
    expect(narrative).not.toContain("заголовок которой совпадает с именем субъекта");
    expect(narrative).toContain("по имени субъекта найдена статья");
    expect(narrative).toContain("принадлежность статьи проверяемому лицу не подтверждена");
  });

  it("langlink-находка называет способ находки, а не совпадение заголовка", () => {
    const narrative =
      build({
        region: "UAE",
        language: "en",
        subjectDecision: "AMBIGUOUS",
        foundVia: "langlink",
        langlinkOf: { language: "ru", title: "Мордашов, Алексей Александрович" },
        review: null,
      }).content.narrative ?? "";
    expect(narrative).not.toContain("заголовок которой совпадает с именем субъекта");
    expect(narrative).toContain("межъязыковой ссылке");
  });

  it("«почему важно» тёзки тоже не утверждает совпадения имени", () => {
    const why =
      build({ subjectDecision: "AMBIGUOUS", review: null }).content.whyItMatters ?? "";
    expect(why).not.toContain("Статья с совпадающим именем");
    expect(why).toContain("найденная по имени субъекта");
  });
});

describe("каждая строка лида помечена как дословная", () => {
  it("длинный лид не оставляет неподписанных абзацев рядом с чужими клеймами", () => {
    const long = Array.from(
      { length: 8 },
      (_, i) => `Предложение лида номер ${i} про деятельность проверяемого лица и его компанию.`
    ).join(" ");
    const bullets = allBullets({ review: { lead: long, fragments: [] } });
    const leadBullets = bullets.filter((b) => b.includes("Предложение лида"));
    expect(leadBullets.length).toBeGreaterThan(1);
    for (const bullet of leadBullets) {
      expect(bullet.startsWith("Начало статьи (дословно")).toBe(true);
    }
  });
});
