/**
 * Строка, у которой рамку сняла принадлежность, называется словами.
 *
 * Снять красную рамку с материала, чья принадлежность не подтверждена, — это
 * правильно; сделать это молча — значит потерять содержимое. Страница обязана
 * сказать, сколько её строк ведут на негативные источники и почему они не
 * выделены: без этого читатель видит чистую сетку там, где половина плиток
 * ведёт на негатив об однофамильцах.
 */

import { describe, expect, it } from "vitest";
import { buildImagesFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/images";
import type { FragmentExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const SLOT = "p14_ru_images_1";

type Row = {
  ref: string;
  title: string;
  domain: string;
  url: string;
  subjectDecision: string;
  /** Рамка на самой картинке — то, что уже нарисовал построитель ассета. */
  adverse: boolean;
  /** Формулировка была негативной, но рамку сняла принадлежность. */
  adverseWording?: boolean;
};

const CONFIRMED: Row = {
  ref: "img-confirmed",
  title: "Суд назначил слушание по делу федерации",
  domain: "news-example.ru",
  url: "https://news-example.ru/2",
  subjectDecision: "SUBJECT_MATCH",
  adverse: true,
};

const UNCONFIRMED: Row = {
  ref: "img-unconfirmed",
  title: "Уголовное дело о взятке: обвинительный приговор",
  domain: "gorod-news.ru",
  url: "https://gorod-news.ru/crime/77",
  subjectDecision: "AMBIGUOUS",
  adverse: false,
  adverseWording: true,
};

const CLEAN: Row = {
  ref: "img-clean",
  title: "Фотография с турнира в Ташкенте",
  domain: "sport-example.ru",
  url: "https://sport-example.ru/photo/1",
  subjectDecision: "SUBJECT_MATCH",
  adverse: false,
};

function scopedFor(rows: Row[]): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  for (const r of rows) {
    evidenceIndex[r.ref] = {
      title: r.title,
      url: r.url,
      domain: r.domain,
      region: "RU",
      kind: "images",
      subjectDecision: r.subjectDecision,
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

function extrasFor(rows: Row[]): FragmentExtras {
  return {
    visualAssets: {
      [SLOT]: [
        {
          assetRef: "ru_image_grid_1",
          kind: "image_grid",
          title: "Россия — изображения в поиске (1)",
          hasImage: true,
          visibleItems: rows.map((r) => ({
            ref: r.ref,
            url: r.url,
            domain: r.domain,
            title: r.title,
            adverse: r.adverse,
            ...(r.adverseWording ? { adverseWording: true } : {}),
            subjectDecision: r.subjectDecision,
          })),
        },
      ],
    },
  } as unknown as FragmentExtras;
}

function bodyOf(rows: Row[]): string {
  const slide = buildImagesFragment(
    "RU_IMAGES",
    "RU_PROFILE",
    "Россия",
    scopedFor(rows),
    extrasFor(rows)
  ).slides.find((s) => s.slideId === SLOT)!;
  return String(slide.content.whatWasFound ?? "");
}

describe("страница называет строки, у которых рамку сняла принадлежность", () => {
  it("считает их отдельным числом и объясняет причину", () => {
    const body = bodyOf([CONFIRMED, UNCONFIRMED, CLEAN]);
    expect(body).toContain("выделено красным (ведут на негативные источники): 1");
    expect(body).toMatch(/Ещё 1[^.]*принадлежность[^.]*не подтверждена/u);
  });

  it("молчит, когда снимать было нечего", () => {
    const body = bodyOf([CONFIRMED, CLEAN]);
    expect(body).toContain("выделено красным (ведут на негативные источники): 1");
    expect(body).not.toMatch(/принадлежность[^.]*не подтверждена/u);
  });
});
