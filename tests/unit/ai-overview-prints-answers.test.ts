/**
 * Страница AI-ответов печатает сами ответы и считает ответы, а не ссылки.
 *
 * Отчёт 83 (DPA-2026-0050): «Россия — AI-ответы» — шесть листов одной и той
 * же картинки, в сайдбаре «Показано 32 результата», под ответом четыре
 * строки «Ответ поискового ИИ». Ответов при этом два — Алисы и Google, по
 * запросу ФИО, — и их текст на бумагу не попадал.
 *
 * Закрепляется: буллеты страницы — тела ответов с подписью движка и строки
 * «Источник: домен»; строка состава считает ответы по движкам; картинка
 * панели подписана движком и перечисляет источники, а не повторяет «Ответ
 * поискового ИИ».
 */

import { describe, expect, it } from "vitest";
import { buildKnowledgeAiFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/knowledge-ai";
import type { FragmentExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import { buildKnowledgePanelSvg } from "@/modules/digital-profile/orion-golden/assets/media-asset-svg";
import { buildCanonicalVisualAssets } from "@/modules/digital-profile/services/canonical-visual-assets";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

const QUERY = "Кремлёв Умар Назарович";
const ALICE = "Умар Назарович Кремлёв — российский спортивный функционер, глава Международной ассоциации бокса. В сентябре 2024 года стал владельцем дилерского холдинга «Рольф».";
const GOOGLE = "Umar Kremlev is a Russian sports official, president of the International Boxing Association since 2020. He was born in Serpukhov in 1982.";

type Row = { ref: string; engine: "YANDEX" | "GOOGLE"; provider: string; url?: string; title: string; snippet?: string };

const ROWS: Row[] = [
  { ref: "inventory:alice", engine: "YANDEX", provider: "topvisor-yandex", title: "Ответ Алисы (Яндекс)", snippet: ALICE },
  { ref: "inventory:alice-s1", engine: "YANDEX", provider: "topvisor-yandex", url: "https://tass.ru/sport/1", title: "tass.ru" },
  { ref: "inventory:alice-s2", engine: "YANDEX", provider: "topvisor-yandex", url: "https://ru.wikipedia.org/wiki/K", title: "ru.wikipedia.org" },
  { ref: "inventory:google", engine: "GOOGLE", provider: "topvisor-google", title: "Ответ Google AI Overview", snippet: GOOGLE },
  { ref: "inventory:google-s1", engine: "GOOGLE", provider: "topvisor-google", url: "https://en.wikipedia.org/wiki/Umar_Kremlev", title: "en.wikipedia.org" },
];

function scopedInput(rows: Row[]): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  for (const r of rows) {
    evidenceIndex[r.ref] = {
      kind: "ai_answer",
      url: r.url ?? `topvisor://ai/${r.ref}`,
      domain: r.url ? new URL(r.url).hostname : undefined,
      title: r.title,
      snippet: r.snippet ?? "",
      engine: r.engine,
      provider: r.provider,
      region: "RU",
      query: QUERY,
      subjectDecision: "SUBJECT_MATCH",
    };
  }
  return {
    findings: [],
    surfaceUnits: [
      { surface: "ai_answers", region: "RU", engine: "MULTI", claims: [], metrics: [], evidenceRefs: rows.map((r) => r.ref) },
    ],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

const extras = {
  visualAssets: {
    p19_ru_knowledge_2: [
      { assetRef: "ru_ai_answers", kind: "knowledge_panel", hasImage: true, visibleItems: ROWS.map((r) => ({ ref: r.ref, title: r.title, url: r.url })) },
    ],
  },
} as unknown as FragmentExtras;

function aiPage() {
  const { slides } = buildKnowledgeAiFragment("RU_KNOWLEDGE_AI", "RU_PROFILE", "Россия", scopedInput(ROWS), extras);
  const pages = slides.filter((s) => s.baseSlotId === "p19_ru_knowledge_2");
  expect(pages.length).toBeGreaterThan(0);
  return pages;
}

describe("страница AI-ответов", () => {
  it("буллеты — тела ответов с подписью движка и источники доменом", () => {
    const bullets = aiPage().flatMap((s) => s.content.bullets ?? []);
    expect(bullets.some((b) => b.includes("Яндекс") && b.includes("Рольф"))).toBe(true);
    expect(bullets.some((b) => b.includes("Google") && b.includes("Serpukhov"))).toBe(true);
    // Источники ответа — одной строкой после его тела, а не строкой на ссылку:
    // десять строк «Источник: домен» расползались на три листа по три.
    expect(bullets).toContain("Источники ответа: tass.ru, ru.wikipedia.org");
    expect(bullets).toContain("Источники ответа: en.wikipedia.org");
    expect(bullets.some((b) => /^Источник: /.test(b))).toBe(false);
    const alice = bullets.findIndex((b) => b.includes("Рольф"));
    expect(bullets[alice + 1]).toBe("Источники ответа: tass.ru, ru.wikipedia.org");
  });

  it("строка состава считает ответы по движкам, а не ссылки", () => {
    const first = aiPage()[0]!;
    const found = first.content.whatWasFound ?? "";
    expect(found).toMatch(/Ответов поискового ИИ: 2/);
    expect(found).toMatch(/Алиса.*1/);
    expect(found).toMatch(/Google.*1/);
    expect(found).not.toMatch(/Показано \d+ результат/);
    expect(first.metrics?.answers).toBe(2);
  });
});

describe("панель знаний вместо ответа", () => {
  it("подпись называет панель знаний, а не AI Overview, и отсутствие ответа Google названо", async () => {
    // Отчёт 84, стр. 78: Google AI Overview по запросу ФИО не показал ни в
    // России, ни в Дубае; панель взяла строку панели знаний и подписала её
    // «Google AI Overview» — по движку, а не по виду строки.
    const kb: RawInventoryItem = {
      inventoryId: "kb-uae",
      caseId: "case-1",
      reportRunId: "run-1",
      source: "serper",
      provider: "serper",
      region: "UAE",
      query: "Kremlev Umar Nazarovich",
      collectedAt: "2026-09-03T00:00:00.000Z",
      evidenceType: "knowledge_block",
      title: "Umar Kremlev",
      snippet: "Umar Kremlev is a Russian sports functionary, president of the International Boxing Association.",
      sourceUrl: "serper://knowledge/uae/1",
      rawMetadata: { engine: "GOOGLE", surface: "knowledge_block", provider: "serper" },
    } as unknown as RawInventoryItem;
    const visuals = await buildCanonicalVisualAssets({ subjectName: "Kremlev Umar Nazarovich", items: [kb], allowImagePreviewNetwork: false });
    const entry = visuals.assets.find((a) => a.assetRef === "uae_ai_answers");
    expect(entry?.caption ?? "").toMatch(/Панель знаний Google/);
    expect(entry?.caption ?? "").not.toMatch(/AI Overview/);

    const scoped = {
      ...scopedInput([]),
      scope: { regions: ["UAE"] },
      surfaceUnits: [{ surface: "ai_answers", region: "UAE", engine: "GOOGLE", claims: [], metrics: [], evidenceRefs: ["inventory:kb-uae"] }],
      evidenceIndex: { "inventory:kb-uae": { kind: "knowledge_block", url: "serper://knowledge/uae/1", title: "Umar Kremlev", snippet: "Umar Kremlev is a Russian sports functionary.", engine: "GOOGLE", provider: "serper", region: "UAE", query: "Kremlev Umar Nazarovich", subjectDecision: "SUBJECT_MATCH" } },
      surfaceCollectionHints: [{ surface: "ai_answers", region: "UAE", engine: "GOOGLE", status: "NO_RESULTS", provider: "topvisor", errorCode: null }],
    } as unknown as ScopedFragmentInput;
    const uaeExtras = { visualAssets: { p31_uae_knowledge: [{ assetRef: "uae_ai_answers", kind: "knowledge_panel", hasImage: true, visibleItems: [{ ref: "inventory:kb-uae", title: "Umar Kremlev" }] }] } } as unknown as FragmentExtras;
    const { slides } = buildKnowledgeAiFragment("UAE_KNOWLEDGE_AI", "UAE_PROFILE", "ОАЭ", scoped, uaeExtras);
    const page = slides.find((s) => s.baseSlotId === "p31_uae_knowledge")!;
    const text = [page.content.statusNote ?? "", ...(page.content.bullets ?? [])].join(" ");
    expect(text).toMatch(/AI-ответ Google по запросу ФИО в выдаче не показан/);
  });
});

describe("разбивка ответов по листам", () => {
  it("первый лист печатает тела в левой колонке, продолжения несут по ответу с источниками", () => {
    const long = (seed: string) =>
      Array.from({ length: 12 }, (_, i) => `${seed} — предложение номер ${i + 1} длинное настолько, чтобы ответ занял весь свой бюджет.`).join(" ");
    const rows: Row[] = [
      { ref: "inventory:alice", engine: "YANDEX", provider: "topvisor-yandex", title: "Ответ Алисы (Яндекс)", snippet: long("Алиса") },
      { ref: "inventory:alice-s1", engine: "YANDEX", provider: "topvisor-yandex", url: "https://tass.ru/1", title: "tass.ru" },
      { ref: "inventory:alice-s2", engine: "YANDEX", provider: "topvisor-yandex", url: "https://ria.ru/1", title: "ria.ru" },
      { ref: "inventory:google", engine: "GOOGLE", provider: "topvisor-google", title: "Ответ Google AI Overview", snippet: long("Google") },
      { ref: "inventory:google-s1", engine: "GOOGLE", provider: "topvisor-google", url: "https://en.wikipedia.org/1", title: "en.wikipedia.org" },
      { ref: "inventory:google-s2", engine: "GOOGLE", provider: "topvisor-google", url: "https://reuters.com/1", title: "reuters.com" },
    ];
    const { slides } = buildKnowledgeAiFragment("RU_KNOWLEDGE_AI", "RU_PROFILE", "Россия", scopedInput(rows), extras);
    const pages = slides.filter((s) => s.baseSlotId === "p19_ru_knowledge_2");
    const chars = (s: (typeof pages)[number]) => (s.content.bullets ?? []).reduce((n, b) => n + b.length, 0);
    expect(chars(pages[0]!)).toBeLessThanOrEqual(1000);
    for (const p of pages.slice(1)) {
      expect((p.content.bullets ?? []).length).toBeLessThanOrEqual(3);
      expect(chars(p)).toBeLessThanOrEqual(3600);
    }
    // Ни один блок не потерян между листами: два тела и две строки источников.
    const all = pages.flatMap((p) => p.content.bullets ?? []);
    expect(all.filter((b) => b.startsWith("Источники ответа: ")).length).toBe(2);
    expect(all.length).toBeGreaterThanOrEqual(4);
  });
});

describe("картинка панели AI-ответа", () => {
  it("подписана движком и перечисляет источники", () => {
    const svg = buildKnowledgePanelSvg({
      title: "Россия — ИИ-ответы поисковых систем",
      summary: ALICE,
      facts: [],
      engineLabel: "Алиса (Яндекс)",
      sources: ["tass.ru", "ru.wikipedia.org"],
    });
    expect(svg).toContain("Алиса (Яндекс)");
    expect(svg).toContain("Источники: tass.ru, ru.wikipedia.org");
  });

  it("ассет несёт ответ Алисы первым, движок в подписи, источники доменами", async () => {
    const item = (r: Row): RawInventoryItem =>
      ({
        inventoryId: r.ref.replace("inventory:", ""),
        caseId: "case-1",
        reportRunId: "run-1",
        source: "serp_observation",
        provider: r.provider,
        region: "RU",
        query: QUERY,
        collectedAt: "2026-09-03T00:00:00.000Z",
        evidenceType: "ai_answer",
        title: r.title,
        snippet: r.snippet ?? "",
        sourceUrl: r.url ?? `topvisor://ai/${r.ref}`,
        rawMetadata: { engine: r.engine, surface: "ai_answer", provider: r.provider },
      }) as unknown as RawInventoryItem;
    const visuals = await buildCanonicalVisualAssets({
      subjectName: QUERY,
      items: [...ROWS].reverse().map(item),
      allowImagePreviewNetwork: false,
    });
    const asset = visuals.visualAssets.p19_ru_knowledge_2?.[0];
    expect(asset?.visibleItems?.[0]?.ref).toBe("inventory:alice");
    const entry = visuals.assets.find((a) => a.assetRef === "ru_ai_answers");
    expect(entry?.caption ?? "").toMatch(/Алис/);
    expect(entry?.caption ?? "").not.toMatch(/Ответ поискового ИИ/);
  });
});
