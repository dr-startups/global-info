/**
 * Обложка черновика говорит, что это черновик.
 *
 * Иначе документ, собранный для проверки аналитиком, в чужих руках неотличим
 * от документа, который проверку прошёл. Строка едет текстом в нагрузке —
 * рендерер прошлой версии напечатает её как обычный подзаголовок обложки, и
 * окна деплоя у правки нет.
 *
 * Ключ кэша пакета обязан различать состояния: без этого выпуск взял бы обложку
 * черновика из кэша и напечатал бы клиенту слово «черновик».
 */

import { describe, expect, it } from "vitest";
import { buildFrontMatterFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/front-matter";
import { fragmentInputHash } from "@/modules/digital-profile/orion-golden/deck-sections/section-builders";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { FragmentExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

const SCOPED = {
  subject: { displayName: "Егоров Алексей Евгеньевич", aliases: [] },
  findings: [],
  surfaceUnits: [],
  evidenceIndex: {},
  scope: { regions: null, surfaces: null, subjectMatch: null, findingIds: null },
  metricSnapshot: {},
} as unknown as ScopedFragmentInput;

const DRAFT_LINE = "Черновик для проверки аналитиком — не для передачи клиенту.";

function coverNarrative(extras: FragmentExtras): string {
  const out = buildFrontMatterFragment("FRONT_MATTER", SCOPED, extras);
  const cover = out.slides.find((s) => s.baseSlotId === "p01_cover");
  if (!cover) throw new Error(`обложка не собрана: ${out.slides.map((s) => s.baseSlotId).join(", ")}`);
  return String(cover.content.narrative ?? "");
}

describe("обложка черновика", () => {
  it("черновик называет себя черновиком", () => {
    expect(coverNarrative({ documentState: "draft" } as FragmentExtras)).toContain(DRAFT_LINE);
  });

  it("выпуск строки о черновике не несёт", () => {
    const text = coverNarrative({ documentState: "released" } as FragmentExtras);
    expect(text).not.toContain("Черновик");
    expect(text).toContain("Конфиденциально");
  });

  it("состояние не названо — обложка прежняя", () => {
    const text = coverNarrative({} as FragmentExtras);
    expect(text).not.toContain("Черновик");
  });

  it("ключ кэша пакета различает черновик и выпуск", () => {
    const draft = fragmentInputHash("FRONT_MATTER_MAIN", SCOPED, {
      documentState: "draft",
    } as FragmentExtras);
    const released = fragmentInputHash("FRONT_MATTER_MAIN", SCOPED, {
      documentState: "released",
    } as FragmentExtras);
    expect(draft).not.toBe(released);
  });
});
