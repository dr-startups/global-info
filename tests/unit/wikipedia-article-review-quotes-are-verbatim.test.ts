import { describe, expect, it, vi } from "vitest";
import {
  auditArticleFragments,
  runWikipediaArticleReview,
  splitArticleText,
  WIKIPEDIA_ARTICLE_REVIEW_MAX_INPUT_CHARS,
} from "@/modules/digital-profile/orion-golden/analytics/run-wikipedia-article-review";
import { WIKIPEDIA_ARTICLE_REVIEW_SCHEMA_VERSION } from "@/modules/digital-profile/orion-golden/contracts/wikipedia-article-review";

/**
 * Роль модели — выбрать и назвать, а не написать. Всё остальное проверяется
 * дословно и без модели.
 *
 * Цитата фрагмента обязана быть подстрокой текста статьи — тем же аудитом, что
 * держит цитаты прочитанных страниц (`quoteFoundInText`). Придуманная строка не
 * доезжает до пакета, и причина её снятия записана: правка, которую нельзя
 * объяснить, ничем не лучше ошибки, которую она исправляет.
 */

const LEAD =
  "Алексей Александрович Мордашов — российский предприниматель, основной акционер " +
  "металлургической компании.";

const ARTICLE_TEXT =
  `${LEAD}\n\n` +
  "== Биография ==\n" +
  "Родился в Череповце в семье рабочих металлургического комбината.\n\n" +
  "== Санкции ==\n" +
  "В 2022 году внесён в санкционные списки Европейского союза. " +
  "По итогам 2022 года состояние уменьшилось на 11 миллиардов долларов.\n";

const IN_SANCTIONS = "В 2022 году внесён в санкционные списки Европейского союза.";
const IN_LEAD = "основной акционер металлургической компании";

describe("детерминированный разбор текста статьи", () => {
  it("лид — это текст до первого заголовка раздела", () => {
    expect(splitArticleText(ARTICLE_TEXT).lead).toBe(LEAD);
  });

  it("разделы называются своими заголовками, а не выдумываются", () => {
    const sections = splitArticleText(ARTICLE_TEXT).sections;
    expect(sections.map((s) => s.title)).toEqual(["Биография", "Санкции"]);
    expect(sections[1]!.body).toContain("11 миллиардов долларов");
  });

  it("статья без заголовков — один лид и ни одного раздела", () => {
    const parsed = splitArticleText("Короткая справка о лице.");
    expect(parsed.lead).toBe("Короткая справка о лице.");
    expect(parsed.sections).toEqual([]);
  });
});

describe("аудит фрагментов сверяет каждую цитату с текстом статьи", () => {
  const audit = (fragments: Array<Record<string, unknown>>) =>
    auditArticleFragments({
      fragments,
      articleText: ARTICLE_TEXT,
      sections: splitArticleText(ARTICLE_TEXT).sections,
    });

  it("цитата, которой в статье нет, снимается с записью причины", () => {
    const report = audit([
      { quote: "Обвинён в уклонении от уплаты налогов в 2019 году.", category: "negative", gloss: "налоги" },
    ]);
    expect(report.fragments).toHaveLength(0);
    expect(report.dropped).toBe(1);
    expect(report.reasons.join(" ")).toMatch(/нет в тексте статьи/u);
  });

  it("дословная цитата остаётся и получает свой раздел", () => {
    const report = audit([
      { quote: IN_SANCTIONS, category: "negative", gloss: "санкции ЕС 2022 года" },
    ]);
    expect(report.dropped).toBe(0);
    expect(report.fragments[0]!.quote).toBe(IN_SANCTIONS);
    expect(report.fragments[0]!.section).toBe("Санкции");
    expect(report.fragments[0]!.category).toBe("negative");
  });

  it("цитата из лида раздела не получает", () => {
    const report = audit([{ quote: IN_LEAD, category: "needs_update", gloss: "описание бизнеса" }]);
    expect(report.fragments[0]!.section).toBeUndefined();
  });

  it("длинная цитата укорачивается до границы предложения и сверяется заново", () => {
    const long =
      "В 2022 году внесён в санкционные списки Европейского союза. " +
      "По итогам 2022 года состояние уменьшилось на 11 миллиардов долларов.";
    expect(long.length).toBeGreaterThan(120);
    const report = auditArticleFragments({
      fragments: [{ quote: long, category: "negative", gloss: "санкции и потери" }],
      articleText: ARTICLE_TEXT,
      sections: splitArticleText(ARTICLE_TEXT).sections,
      maxQuoteChars: 80,
    });
    expect(report.fragments).toHaveLength(1);
    expect(report.fragments[0]!.quote).toBe(IN_SANCTIONS);
    expect(ARTICLE_TEXT).toContain(report.fragments[0]!.quote);
  });

  it("укоротить до границы предложения нечем — фрагмент снимается", () => {
    const report = auditArticleFragments({
      fragments: [
        {
          quote: "Родился в Череповце в семье рабочих металлургического комбината.",
          category: "needs_update",
          gloss: "происхождение",
        },
      ],
      articleText: ARTICLE_TEXT,
      sections: splitArticleText(ARTICLE_TEXT).sections,
      maxQuoteChars: 30,
    });
    expect(report.fragments).toHaveLength(0);
    expect(report.dropped).toBe(1);
  });

  it("слишком короткая цитата основанием не служит", () => {
    const report = audit([{ quote: "Родился", category: "needs_update", gloss: "происхождение" }]);
    expect(report.fragments).toHaveLength(0);
    expect(report.dropped).toBe(1);
  });

  it("подпись короче четырёх знаков снимает фрагмент", () => {
    const report = audit([{ quote: IN_SANCTIONS, category: "negative", gloss: "ЕС" }]);
    expect(report.fragments).toHaveLength(0);
  });

  it("категория вне списка не принимается", () => {
    const report = audit([{ quote: IN_SANCTIONS, category: "critical", gloss: "санкции ЕС" }]);
    expect(report.fragments).toHaveLength(0);
  });
});

const CHECK = {
  id: "w1",
  exists: true,
  language: "ru",
  pageTitle: "Мордашов, Алексей Александрович",
  url: "https://ru.wikipedia.org/wiki/Мордашов",
  articleText: ARTICLE_TEXT,
};

const SUBJECT = { fullName: "Мордашов Алексей Александрович", aliases: [] };

describe("стадия разбора статьи", () => {
  it("офлайн не зовёт ни сеть, ни модель, но детерминированную часть делает", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const set = await runWikipediaArticleReview({
        caseId: "c1",
        subject: SUBJECT,
        checks: [CHECK],
        deps: { env: { NETWORK_CALLS: "0" } as unknown as NodeJS.ProcessEnv },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(set.schemaVersion).toBe(WIKIPEDIA_ARTICLE_REVIEW_SCHEMA_VERSION);
      const review = set.reviews[0]!;
      expect(review.status).toBe("NOT_REVIEWED");
      expect(review.notReviewedReason).toBe("offline");
      expect(review.lead).toBe(LEAD);
      expect(review.sections).toEqual(["Биография", "Санкции"]);
      expect(review.fragments).toEqual([]);
      expect(review.checkRef).toBe("inventory:wiki-w1");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("два прогона дают байтово одинаковый артефакт", async () => {
    const call = async () => ({
      subjectMatch: "subject",
      fragments: [{ quote: IN_SANCTIONS, category: "negative", gloss: "санкции ЕС 2022 года" }],
    });
    const run = () =>
      runWikipediaArticleReview({
        caseId: "c1",
        subject: SUBJECT,
        checks: [CHECK],
        deps: { call, env: {} as NodeJS.ProcessEnv },
      });
    const [a, b] = [await run(), await run()];
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.reviews[0]!.status).toBe("REVIEWED");
    expect(a.reviews[0]!.fragments).toHaveLength(1);
  });

  it("модель не вправе повысить принадлежность, только понизить", async () => {
    const other = await runWikipediaArticleReview({
      caseId: "c1",
      subject: SUBJECT,
      checks: [CHECK],
      deps: {
        call: async () => ({ subjectMatch: "other", fragments: [] }),
        env: {} as NodeJS.ProcessEnv,
      },
    });
    expect(other.reviews[0]!.subjectMatch).toBe("other");

    // Фамилии субъекта в тексте нет — «это он» не принимается: тот же пол,
    // что у вердиктов прочитанных страниц.
    const foreign = await runWikipediaArticleReview({
      caseId: "c1",
      subject: { fullName: "Иванов Пётр Сергеевич", aliases: [] },
      checks: [CHECK],
      deps: {
        call: async () => ({ subjectMatch: "subject", fragments: [] }),
        env: {} as NodeJS.ProcessEnv,
      },
    });
    expect(foreign.reviews[0]!.subjectMatch).toBe("unclear");
  });

  it("статья без текста записи разбора не заводит", async () => {
    const set = await runWikipediaArticleReview({
      caseId: "c1",
      subject: SUBJECT,
      checks: [{ ...CHECK, articleText: null }],
      deps: { env: {} as NodeJS.ProcessEnv },
    });
    expect(set.reviews).toEqual([]);
  });

  it("длинная статья режется по капу и говорит об этом", async () => {
    const long = `${ARTICLE_TEXT}\n${"Дополнительный текст статьи. ".repeat(4000)}`.trim();
    expect(long.length).toBeGreaterThan(WIKIPEDIA_ARTICLE_REVIEW_MAX_INPUT_CHARS);
    let seen = 0;
    const set = await runWikipediaArticleReview({
      caseId: "c1",
      subject: SUBJECT,
      checks: [{ ...CHECK, articleText: long }],
      deps: {
        call: async (input: { userPayload: unknown }) => {
          seen = String(
            (input.userPayload as { article?: { text?: string } }).article?.text ?? ""
          ).length;
          return { subjectMatch: "subject", fragments: [] };
        },
        env: {} as NodeJS.ProcessEnv,
      },
    });
    expect(seen).toBe(WIKIPEDIA_ARTICLE_REVIEW_MAX_INPUT_CHARS);
    const review = set.reviews[0]!;
    expect(review.truncated).toBe(true);
    expect(review.reviewedChars).toBe(WIKIPEDIA_ARTICLE_REVIEW_MAX_INPUT_CHARS);
    expect(review.articleTextChars).toBe(long.length);
  });

  it("отказ модели — честное «не разобрано», а не выдуманный разбор", async () => {
    const set = await runWikipediaArticleReview({
      caseId: "c1",
      subject: SUBJECT,
      checks: [CHECK],
      deps: {
        call: async () => {
          throw new Error("openai-http-500");
        },
        env: {} as NodeJS.ProcessEnv,
      },
    });
    const review = set.reviews[0]!;
    expect(review.status).toBe("NOT_REVIEWED");
    expect(review.notReviewedReason).toBe("model-unavailable");
    expect(review.fragments).toEqual([]);
    // Детерминированная часть от отказа модели не страдает.
    expect(review.lead).toBe(LEAD);
  });

  it("фрагментов не больше восьми на статью", async () => {
    const set = await runWikipediaArticleReview({
      caseId: "c1",
      subject: SUBJECT,
      checks: [CHECK],
      deps: {
        call: async () => ({
          subjectMatch: "subject",
          fragments: Array.from({ length: 12 }, () => ({
            quote: IN_SANCTIONS,
            category: "negative",
            gloss: "санкции ЕС 2022 года",
          })),
        }),
        env: {} as NodeJS.ProcessEnv,
      },
    });
    expect(set.reviews[0]!.fragments.length).toBeLessThanOrEqual(8);
  });
});

describe("содержимое статьи не роняет прогон", () => {
  it("длинный заголовок раздела обрезается, а не бросает исключением", async () => {
    const heading = "Р".repeat(176);
    const body = "В 2019 году внесён в реестр недобросовестных поставщиков решением суда.";
    const set = await runWikipediaArticleReview({
      caseId: "c1",
      subject: SUBJECT,
      checks: [{ ...CHECK, articleText: `${LEAD}\n\n== ${heading} ==\n${body}\n` }],
      deps: {
        call: async () => ({
          subjectMatch: "subject",
          fragments: [{ quote: body, category: "negative", gloss: "реестр недобросовестных" }],
        }),
        env: {} as NodeJS.ProcessEnv,
      },
    });
    const review = set.reviews[0]!;
    expect(review.status).toBe("REVIEWED");
    expect(review.fragments[0]!.section!.length).toBeLessThanOrEqual(160);
    expect(review.fragments[0]!.section!.startsWith("Р")).toBe(true);
  });
});

describe("купленным считается только состоявшийся разбор", () => {
  it("прошлый REVIEWED переиспользуется без обращения к модели", async () => {
    let calls = 0;
    const set = await runWikipediaArticleReview({
      caseId: "c1",
      subject: SUBJECT,
      checks: [CHECK],
      previous: [
        {
          checkRef: "inventory:wiki-w1",
          language: "ru",
          title: CHECK.pageTitle,
          lead: "старый лид",
          sections: [],
          articleTextChars: 1,
          reviewedChars: 1,
          truncated: false,
          subjectMatch: "subject",
          fragments: [
            { quote: IN_SANCTIONS, category: "negative", gloss: "санкции ЕС 2022 года" },
          ],
          audit: { dropped: 0, reasons: [] },
          status: "REVIEWED",
        },
      ],
      deps: {
        call: async () => {
          calls += 1;
          return { subjectMatch: "subject", fragments: [] };
        },
        env: {} as NodeJS.ProcessEnv,
      },
    });
    expect(calls).toBe(0);
    const review = set.reviews[0]!;
    expect(review.fragments[0]!.quote).toBe(IN_SANCTIONS);
    // Детерминированная часть пересчитана по нынешнему снимку, а не взята из
    // прошлого артефакта: лид принадлежит тексту, а не покупке.
    expect(review.lead).toBe(LEAD);
    // Цитата купленного разбора проходит аудит заново по нынешнему тексту.
    expect(review.fragments[0]!.section).toBe("Санкции");
  });

  it("прошлый NOT_REVIEWED покупкой не был: разбор выполняется заново", async () => {
    let calls = 0;
    const set = await runWikipediaArticleReview({
      caseId: "c1",
      subject: SUBJECT,
      checks: [CHECK],
      previous: [
        {
          checkRef: "inventory:wiki-w1",
          language: "ru",
          title: CHECK.pageTitle,
          lead: LEAD,
          sections: [],
          articleTextChars: 1,
          reviewedChars: 1,
          truncated: false,
          subjectMatch: "unclear",
          fragments: [],
          audit: { dropped: 0, reasons: [] },
          status: "NOT_REVIEWED",
          notReviewedReason: "model-unavailable",
        },
      ],
      deps: {
        call: async () => {
          calls += 1;
          return {
            subjectMatch: "subject",
            fragments: [{ quote: IN_SANCTIONS, category: "negative", gloss: "санкции ЕС" }],
          };
        },
        env: {} as NodeJS.ProcessEnv,
      },
    });
    expect(calls).toBe(1);
    expect(set.reviews[0]!.status).toBe("REVIEWED");
  });
});
