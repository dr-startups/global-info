import { describe, expect, it } from "vitest";
import { buildKnowledgeAiFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/knowledge-ai";
import { withContinuations } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { FragmentExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import { SLIDE_CONTENT_SCHEMA_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import { DECK_TEMPLATE_REGISTRY } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";

/**
 * Страница AI-ответов не ужимает сайдбар до трети листа.
 *
 * Прогон DPA-2026-0053 остановился на странице 62: лист AI-ответов рисовал
 * панель и сайдбар в верхней трети, а тела ответов — под ними. Сайдбару
 * доставалось 1,6 млн EMU — шесть строк по 35 знаков, — а дека кладёт в него
 * 660 знаков, как во всякую панель. Рендерер выбросил два блока, ворота выпуска
 * отказали, отчёт не выдан.
 *
 * Теперь сайдбар получает ту же колонку, что и всякая панель, а тела ответов
 * идут под картинкой в левой колонке (62 % полосы, ~95 знаков в строке).
 * Первый лист поэтому берёт не больше 1000 знаков; остаток — на продолжения,
 * без потери ни одного блока.
 */

const ANSWER =
  "Because the patronymic is not commonly shared, the search results mostly describe several " +
  "different people: a judge in Krasnodar, an ophthalmologist in Podolsk and a swimmer. " +
  Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} is here to make the answer long.`).join(" ");

function base(bullets: string[]): SlideContentContract {
  return {
    schemaVersion: SLIDE_CONTENT_SCHEMA_VERSION,
    slideId: "p31_uae_knowledge",
    baseSlotId: "p31_uae_knowledge",
    sectionId: "UAE_PROFILE",
    isContinuation: false,
    continuationOf: null,
    continuationIndex: null,
    templateId: "ai-overview",
    title: "ОАЭ — панель знаний и AI Overview",
    content: { bullets, whatWasFound: "Зафиксирован 1 ответ поискового ИИ Google." },
    evidenceRefs: [],
    findingIds: [],
    metrics: {},
  } as unknown as SlideContentContract;
}

describe("разбивка с пустым первым листом", () => {
  it("тела уходят на продолжения целиком, первый лист остаётся без списка", () => {
    const slides = withContinuations(base([ANSWER, "Источники ответа: a.ru, b.ru"]), "ai-overview", {
      firstPageBullets: 0,
    });
    expect(slides[0]?.content.bullets ?? []).toEqual([]);
    const carried = slides.slice(1).flatMap((s) => s.content.bullets ?? []);
    expect(carried).toEqual([ANSWER, "Источники ответа: a.ru, b.ru"]);
    expect(slides.length).toBe(2);
  });

  it("длинные тела раскладываются по продолжениям без потерь", () => {
    const bodies = Array.from({ length: 5 }, (_, i) => `${i + 1}. ${ANSWER}`);
    const slides = withContinuations(base(bodies), "ai-overview", { firstPageBullets: 0 });
    expect(slides[0]?.content.bullets ?? []).toEqual([]);
    expect(slides.slice(1).flatMap((s) => s.content.bullets ?? [])).toEqual(bodies);
    for (const s of slides.slice(1)) expect((s.content.bullets ?? []).length).toBeLessThanOrEqual(3);
  });
});

const QUERY = "Егоров Алексей Евгеньевич";
const ROWS = [
  { ref: "inventory:google", engine: "GOOGLE", title: "Ответ Google AI Overview", snippet: ANSWER },
  { ref: "inventory:google-s1", engine: "GOOGLE", url: "https://en.wikipedia.org/wiki/E", title: "en.wikipedia.org" },
];

function scoped(): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  for (const r of ROWS) {
    evidenceIndex[r.ref] = {
      kind: "ai_answer",
      url: r.url ?? `topvisor://ai/${r.ref}`,
      domain: r.url ? new URL(r.url).hostname : undefined,
      title: r.title,
      snippet: r.snippet ?? "",
      engine: r.engine,
      provider: "topvisor-google",
      region: "UAE",
      query: QUERY,
      subjectDecision: "SUBJECT_MATCH",
    };
  }
  return {
    findings: [],
    surfaceUnits: [
      { surface: "ai_answers", region: "UAE", engine: "MULTI", claims: [], metrics: [], evidenceRefs: ROWS.map((r) => r.ref) },
    ],
    evidenceIndex,
    scope: { regions: ["UAE"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

const withVisual = {
  visualAssets: {
    p31_uae_knowledge: [
      { assetRef: "uae_ai_answers", kind: "knowledge_panel", hasImage: true, visibleItems: [] },
    ],
  },
} as unknown as FragmentExtras;

describe("страница AI-ответов", () => {
  const cap = DECK_TEMPLATE_REGISTRY["ai-overview"].layout.maxBulletCharsPerSlide ?? 0;
  const chars = (s: SlideContentContract): number =>
    (s.content.bullets ?? []).reduce((n, b) => n + b.length, 0);

  it("ёмкость первого листа объявлена под узкую колонку", () => {
    expect(cap).toBe(1000);
  });

  it("длинный ответ не переполняет первый лист и не теряется", () => {
    const { slides } = buildKnowledgeAiFragment("UAE_KNOWLEDGE_AI", "UAE_PROFILE", "ОАЭ", scoped(), withVisual);
    const pages = slides.filter((s) => s.baseSlotId === "p31_uae_knowledge");
    expect(chars(pages[0]!)).toBeLessThanOrEqual(cap);
    const all = pages.flatMap((s) => s.content.bullets ?? []).join(" ");
    expect(all).toContain("ophthalmologist in Podolsk");
    expect(all).toContain("en.wikipedia.org");
  });

  it("короткий ответ остаётся на первом листе, продолжений нет", () => {
    const short = scoped();
    (short.evidenceIndex as Record<string, { snippet?: string }>)["inventory:google"]!.snippet =
      "Alexey Egorov is a judge in Krasnodar.";
    const { slides } = buildKnowledgeAiFragment("UAE_KNOWLEDGE_AI", "UAE_PROFILE", "ОАЭ", short, withVisual);
    const pages = slides.filter((s) => s.baseSlotId === "p31_uae_knowledge");
    expect(pages).toHaveLength(1);
    expect(chars(pages[0]!)).toBeGreaterThan(0);
  });
});
