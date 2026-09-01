/**
 * Сноска «Источники» называет только те площадки, куда клиент может сойти.
 *
 * Страница сетки говорит и о строках, которые нашла, но не нарисовала, —
 * значит, называет и их площадки. Наблюдение **без адреса** площадкой в этом
 * смысле не является: строка «Источники — …» обещает читателю место, а по
 * такому наблюдению идти некуда. В счёте «нашли, но не показали» оно остаётся:
 * потеря обязана быть слышна.
 *
 * Стр. 67 живого прогона 92: четыре нарисованные плитки и две ненарисованные
 * строки с причинами `no_url` и `not_an_image`.
 */

import { describe, expect, it } from "vitest";
import { buildImagesFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/images";
import type { FragmentExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const SLOT = "p14_ru_images_1";

type Row = { ref: string; title: string; domain: string; url: string };

const DRAWN: Row[] = [
  { ref: "img-1", title: "Умар Кремлёв на турнире", domain: "sportnews.ru", url: "https://sportnews.ru/1" },
  { ref: "img-2", title: "Портрет спортивного функционера", domain: "photobank.ru", url: "https://photobank.ru/2" },
];
const NOT_SHOWN_WITH_URL: Row = {
  ref: "img-3",
  title: "Материал без превью",
  domain: "gallery-portal.ru",
  url: "https://gallery-portal.ru/3",
};
const NOT_SHOWN_WITHOUT_URL: Row = {
  ref: "img-4",
  title: "Наблюдение без адреса",
  domain: "unreachable-host.ru",
  url: "",
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
      subjectDecision: "SUBJECT_MATCH",
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

function sourceNoteOf(missing: Row[]): string {
  const extras = {
    visualAssets: {
      [SLOT]: [
        {
          assetRef: "ru_image_grid_1",
          kind: "image_grid",
          title: "Россия — изображения в поиске (1)",
          hasImage: true,
          visibleItems: DRAWN.map((t) => ({
            ref: t.ref,
            url: t.url,
            domain: t.domain,
            title: t.title,
            adverse: false,
          })),
          notShown: missing.map((m) => ({
            ref: m.ref,
            adverse: false,
            reason: m.url ? "not_an_image" : "no_url",
          })),
        },
      ],
    },
  } as unknown as FragmentExtras;
  const slide = buildImagesFragment(
    "RU_IMAGES",
    "RU_PROFILE",
    "Россия",
    scopedFor([...DRAWN, ...missing]),
    extras
  ).slides.find((s) => s.slideId === SLOT)!;
  return String(slide.content.sourceNote ?? "");
}

describe("сноска источников страницы изображений", () => {
  it("площадку не нарисованной строки с адресом называет", () => {
    expect(sourceNoteOf([NOT_SHOWN_WITH_URL])).toContain("gallery-portal.ru");
  });

  it("площадку наблюдения без адреса не называет", () => {
    const note = sourceNoteOf([NOT_SHOWN_WITH_URL, NOT_SHOWN_WITHOUT_URL]);
    expect(note).toContain("gallery-portal.ru");
    expect(note).not.toContain("unreachable-host.ru");
  });
});
