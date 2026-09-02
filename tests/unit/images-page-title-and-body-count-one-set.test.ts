/**
 * Страница изображений называет своё число негатива один раз и сходится.
 *
 * Стр. 35 отчёта Кремлёва: заголовок «негативных источников нет» и тут же под
 * ним «негативных заголовков — 1». Заголовок считал по флагам ассета, тело —
 * по своему словарю, и словари расходились.
 *
 * Числа страницы теперь связаны арифметикой: **заголовок = выделено красным +
 * найдено без превью**, и ни одно из них не считается вторым способом. Единица
 * счёта — нарисованная рамка: её ставит генератор картинки, дека её объясняет и
 * не пересчитывает (`docs/ENGINEERING.md` §8, «Одна строка — один материал»).
 */

import { describe, expect, it } from "vitest";
import { buildImagesFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/images";
import type { FragmentExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { PreviewFailureReason } from "@/modules/digital-profile/orion-golden/assets/media-asset-svg";
import { resolveRowAdverse } from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";

const SLOT = "p14_ru_images_1";

type Row = {
  ref: string;
  title: string;
  domain: string;
  url: string;
  snippet?: string;
  subjectDecision?: string;
  /**
   * Рамка на самой картинке. По умолчанию — ответ единого предиката, то есть
   * то, что поставит построитель ассета; в отдельных случаях задаётся руками,
   * чтобы проверить расхождение деки с уже нарисованной картинкой.
   */
  framed?: boolean;
};

type Missing = Row & { reason: PreviewFailureReason };

function frame(r: Row): boolean {
  return r.framed ?? resolveRowAdverse(r);
}

function scopedFor(rows: Row[]): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  for (const r of rows) {
    evidenceIndex[r.ref] = {
      title: r.title,
      url: r.url,
      domain: r.domain,
      snippet: r.snippet,
      region: "RU",
      kind: "images",
      subjectDecision: r.subjectDecision ?? "SUBJECT_MATCH",
    };
  }
  return {
    findings: [],
    surfaceUnits: [
      {
        surface: "images",
        region: "RU",
        claims: [],
        metrics: [],
        evidenceRefs: rows.map((r) => r.ref),
      },
    ],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

function extrasFor(drawn: Row[], missing: Missing[]): FragmentExtras {
  return {
    visualAssets: {
      [SLOT]: [
        {
          assetRef: "ru_image_grid_1",
          kind: "image_grid",
          title: "Россия — изображения в поиске (1)",
          hasImage: true,
          visibleItems: drawn.map((t) => ({
            ref: t.ref,
            url: t.url,
            domain: t.domain,
            title: t.title,
            adverse: frame(t),
          })),
          notShown: missing.map((m) => ({ ref: m.ref, adverse: frame(m), reason: m.reason })),
        },
      ],
    },
  } as unknown as FragmentExtras;
}

/** Все числа, которые страница печатает о негативе, плюс её арифметика. */
function page(drawn: Row[], missing: Missing[]) {
  const slide = buildImagesFragment(
    "RU_IMAGES",
    "RU_PROFILE",
    "Россия",
    scopedFor([...drawn, ...missing]),
    extrasFor(drawn, missing)
  ).slides.find((s) => s.slideId === SLOT)!;
  const title = String(slide.title ?? "");
  const body = String(slide.content.whatWasFound ?? "");
  const num = (re: RegExp, text: string): number | null => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  return {
    slide,
    title,
    body,
    /** Заголовок-вывод: сколько изображений страницы ведут на негативный источник. */
    titleCount: /негативных источников нет/.test(title)
      ? 0
      : num(/:\s(\d+)\sизображени/u, title),
    /** «выделено красным» — про рамки на картинке. */
    framedCount: num(/выделено красным \(ведут на негативные источники\): (\d+)/u, body),
    /** «Среди них N с негативным признаком» — про строки без превью. */
    missingCount: num(/Среди них (\d+) с негативным признаком/u, body),
    /** «Показано N результатов» и «негативных заголовков — N» — про строки страницы. */
    shownCount: num(/Показано (\d+) результат/u, body),
    headlineCount: num(/негативных заголовков — (\d+)/u, body),
    explanations: (slide.content.highlightExplanations ?? []).length,
    metric: Number(slide.metrics?.adverseImages ?? NaN),
    statusCount: num(
      /ведущих на негативные источники, — (\d+)/u,
      String(slide.content.statusNote ?? "")
    ),
  };
}

const CLEAN: Row = {
  ref: "img-clean",
  title: "Умар Кремлёв на турнире в Ташкенте",
  domain: "sport-example.ru",
  url: "https://sport-example.ru/photo/1",
};

const ADVERSE: Row = {
  ref: "img-adverse",
  title: "Суд назначил слушание по делу федерации",
  domain: "news-example.ru",
  url: "https://news-example.ru/2",
};

describe("числа страницы сходятся между собой", () => {
  it("негатив среди нарисованных плиток: заголовок, рамки, статус и метрика — одно число", () => {
    const p = page([CLEAN, ADVERSE], [{ ...CLEAN, ref: "m1", reason: "not_an_image" }]);
    expect(p.titleCount).toBe(1);
    expect(p.framedCount).toBe(1);
    expect(p.explanations).toBe(1);
    expect(p.metric).toBe(1);
    expect(p.statusCount).toBe(1);
  });

  it("негатив только среди строк без превью: заголовок равен их числу", () => {
    const missing: Missing = {
      ref: "m1",
      title: "Обыск в офисе компании",
      domain: "news-example.ru",
      url: "https://news-example.ru/3",
      reason: "not_an_image",
    };
    const p = page([CLEAN], [missing]);
    expect(p.titleCount).toBe(1);
    expect(p.missingCount).toBe(1);
    expect(p.metric).toBe(1);
    // Рамок нет — значит и утверждения о них нет.
    expect(p.explanations).toBe(0);
    expect(p.framedCount).toBeNull();
  });

  it("заголовок равен сумме нарисованного негатива и найденного без превью", () => {
    const missing: Missing[] = [
      { ...ADVERSE, ref: "m1", reason: "not_an_image" },
      { ...ADVERSE, ref: "m2", reason: "http_403" },
    ];
    const p = page([CLEAN, ADVERSE], missing);
    expect(p.titleCount).toBe(3);
    expect(p.framedCount).toBe(1);
    expect(p.missingCount).toBe(2);
    expect(p.titleCount).toBe((p.framedCount ?? 0) + (p.missingCount ?? 0));
    expect(p.statusCount).toBe(3);
    expect(p.metric).toBe(3);
  });

  it("негативных заголовков не бывает больше, чем показанных строк", () => {
    // Пункт Б6 ревью: страница печатала «Показано 1 результат … негативных
    // заголовков — 3», потому что счёт шёл по объединению с ненарисованными
    // строками, а «показано» — только по нарисованным.
    const missing: Missing[] = [1, 2, 3].map((i) => ({
      ...ADVERSE,
      ref: `m${i}`,
      reason: "not_an_image" as const,
    }));
    const p = page([CLEAN], missing);
    expect(p.shownCount).toBe(1);
    expect(p.headlineCount).toBe(0);
    expect(p.headlineCount!).toBeLessThanOrEqual(p.shownCount!);
    expect(p.missingCount).toBe(3);
    expect(p.titleCount).toBe(3);
  });
});

describe("страница не спорит с собственной картинкой", () => {
  it("рамка о другом лице считается и объясняется наравне с прочими", () => {
    // Сетка изображений принадлежность не разбирает (решение шага 0035/4:
    // рамку ставит генератор картинки). Значит, дека обязана считать
    // нарисованное, а не вычитать из него по своему признаку — иначе лист
    // говорит «негативных источников нет» над красной рамкой, которую сам же
    // объясняет.
    const other: Row = { ...ADVERSE, ref: "img-other", subjectDecision: "OTHER_SUBJECT" };
    const p = page([CLEAN, other], []);
    expect(p.explanations).toBe(1);
    expect(p.titleCount).toBe(1);
    expect(p.framedCount).toBe(1);
    expect(p.title).not.toMatch(/негативных источников нет/u);
  });

  it("строка без превью о другом лице считается один раз и тем же правилом", () => {
    const other: Missing = {
      ...ADVERSE,
      ref: "m-other",
      subjectDecision: "OTHER_SUBJECT",
      reason: "http_403",
    };
    const p = page([CLEAN], [other]);
    expect(p.missingCount).toBe(1);
    expect(p.titleCount).toBe(1);
    expect(p.title).not.toMatch(/негативных источников нет/u);
  });

  it("замороженная сетка без рамки не оспаривается телом страницы", () => {
    /*
     * Обратная сторона того же случая: сетка собрана прошлой версией, флаг
     * строки `false`, а сегодняшний словарь её заголовок краснит. Тело обязано
     * молчать вместе с заголовком — иначе лист снова несёт «негативных
     * источников нет» над строкой «негативных заголовков — 1», то есть ровно
     * дефект стр. 35, ради которого делался шаг.
     *
     * Это единственное, что держит подстановку `adverseHeadlines:
     * adverseOnGrid` в описании состава: без неё запасная ветка считает негатив
     * своим предикатом по ссылкам страницы и расходится с картинкой.
     */
    const staleClean: Row = { ...ADVERSE, ref: "img-stale-clean", framed: false };
    const p = page([CLEAN, staleClean], []);
    expect(p.titleCount).toBe(0);
    expect(p.explanations).toBe(0);
    expect(p.headlineCount).toBe(0);
    expect(p.title).toMatch(/негативных источников нет/u);
  });

  it("замороженная рамка прошлого прогона не отрицается заголовком", () => {
    // Возобновлённый прогон читает `visual-assets-by-slot.json` прошлой сборки,
    // а рамки вплавлены в PNG. Предикат к тому времени может быть другим —
    // дека всё равно описывает то, что нарисовано.
    const stale: Row = { ...CLEAN, ref: "img-stale", framed: true };
    const p = page([stale], []);
    expect(p.explanations).toBe(1);
    expect(p.titleCount).toBe(1);
    expect(p.framedCount).toBe(1);
  });
});

describe("стр. 35: «биография, бизнес, скандалы»", () => {
  const title = "Кремлёв Умар Назарович: биография, бизнес, скандалы";

  it("на обычной площадке негативен, и все числа страницы это подтверждают", () => {
    const row: Row = {
      ref: "img-scandal",
      title,
      domain: "news-example.ru",
      url: "https://news-example.ru/4",
    };
    const p = page([CLEAN, row], []);
    expect(p.titleCount).toBe(1);
    expect(p.framedCount).toBe(1);
    expect(p.explanations).toBe(1);
  });

  it("на ru.ruwiki.ru не негативен — и страница молчит об этом целиком", () => {
    const row: Row = {
      ref: "img-ruwiki",
      title,
      domain: "ru.ruwiki.ru",
      url: "https://ru.ruwiki.ru/wiki/Кремлёв,_Умар_Назарович",
    };
    const p = page([CLEAN, row], []);
    expect(p.titleCount).toBe(0);
    expect(p.explanations).toBe(0);
    expect(p.headlineCount).toBe(0);
    expect(p.title).toMatch(/негативных источников нет/u);
  });
});

describe("стр. 62: хвост-бренд площадки в заголовке", () => {
  it("совпадение внутри названия площадки считают все счётчики по одному разу", () => {
    const row: Row = {
      ref: "img-investigator",
      title: "Kremlev's boxing empire – The Investigator News",
      domain: "theinvestigatornews.com",
      url: "https://theinvestigatornews.com/2024/08/kremlev",
    };
    const p = page([CLEAN, row], []);
    expect(p.titleCount).toBe(1);
    expect(p.framedCount).toBe(1);
    expect(p.metric).toBe(1);
  });

  it("чистая строка на той же площадке ни одному счётчику не добавляется", () => {
    const row: Row = {
      ref: "img-investigator-clean",
      title: "Итоги турнира по боксу в Дубае",
      domain: "theinvestigatornews.com",
      url: "https://theinvestigatornews.com/2024/07/boxing",
    };
    const p = page([CLEAN, row], []);
    expect(p.titleCount).toBe(0);
    expect(p.headlineCount).toBe(0);
  });
});
