/**
 * Абзац, не влезающий в лист, уезжает на продолжение целиком.
 *
 * Разбивка была, но отвечала чужим числом: порог брался из клиентского
 * контракта (1100 знаков на любое поле), а не из померенной ёмкости листа
 * (998), и резала она абзац **построителя**, к которому проза находки
 * приклеится позже. Сверх четырёх кусков `splitClientParagraphs` молча
 * возвращал первые четыре, а предложение длиннее предела обрезал.
 *
 * Здесь закреплено: разбивка идёт по бюджету листа с учётом прозы, страниц
 * получается минимум, наполнены они примерно поровну, знаки не теряются, а
 * если разбить без потери нельзя — это громкий именованный отказ.
 */

import { describe, expect, it } from "vitest";
import { toRendererPayload } from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import {
  NarrativeSplitLossError,
  withContinuations,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { narrativeBudgetOf } from "@/modules/digital-profile/orion-golden/deck-sections/section-validation";
import { getClientTextFieldBudgets } from "@/modules/digital-profile/orion-golden/client/load-client-text-contract";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import type { ReportDeckManifest } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const BUDGET = narrativeBudgetOf("wikipedia-check");
const EMPTY_MANIFEST = { toc: [], sectionPageRanges: [] } as unknown as ReportDeckManifest;

/** Проза находки этой страницы: разные предложения, дедупликации не поддаётся. */
const WHAT_WAS_FOUND = [
  "Найдена запись профиля в разделе биографий.",
  "Ссылка ведёт на страницу с историей правок.",
  "Автор последней правки реестром не установлен.",
].join(" ");

/** Текст из целых предложений заданной длины, все разные. */
function sentences(totalChars: number): string {
  const out: string[] = [];
  let len = 0;
  let i = 0;
  while (len < totalChars) {
    const s = `Проверка ${i} выполнена по официальному источнику и записана в реестр.`;
    out.push(s);
    len += s.length + 1;
    i += 1;
  }
  return out.join(" ").slice(0, totalChars).trimEnd();
}

function base(narrative: string, over: Partial<SlideContentContract["content"]> = {}): SlideContentContract {
  return {
    slideId: "p13_ru_wikipedia",
    templateId: "wikipedia-check",
    title: "Проверка статьи",
    findingIds: [],
    evidenceRefs: [],
    metrics: {},
    visualAssetRefs: [],
    content: { narrative, bullets: [], whatWasFound: WHAT_WAS_FOUND, ...over },
  } as unknown as SlideContentContract;
}

/** Абзац страницы так, как его соберёт нагрузка. */
function pageNarrativeOfSlide(slide: SlideContentContract, template: string): string {
  const payload = toRendererPayload({
    deckManifest: EMPTY_MANIFEST,
    rendererSlides: [
      {
        slideKey: slide.slideId,
        sectionKey: "RU_PROFILE",
        template,
        templateId: slide.templateId,
        title: slide.title,
        pageNumber: 1,
        totalPageCount: 1,
        baseSlotId: slide.slideId,
        isContinuation: Boolean(slide.isContinuation),
        evidenceRefs: [],
        findingIds: [],
        metrics: {},
        visualAssetRefs: [],
        staticBlocks: [],
        narrative: slide.content.narrative,
        whatWasFound: slide.content.whatWasFound,
        whyItMatters: slide.content.whyItMatters,
        whatToCheck: slide.content.whatToCheck,
        bullets: slide.content.bullets ?? [],
      } as unknown as RendererSlide,
    ],
    subjectName: "Сергей Глинка",
  }) as { deckManifest: { finalSlides: Array<Record<string, unknown>> } };
  return String(payload.deckManifest.finalSlides[0]?.narrative ?? "");
}

const compact = (s: string) => s.replace(/\s+/gu, "");

/**
 * Сколько страниц заняла бы жадная набивка — тем же правилом «страница
 * закрывается тем, что набрано». Нужна как **независимая** мера: утверждение
 * «страниц не больше жадного» иначе не с чем сравнивать.
 */
function greedyPageCount(text: string): number {
  const sentences = text.split(/(?<=[.!?…])\s+/u).map((x) => x.trim()).filter(Boolean);
  const pages: string[] = [];
  let buf = "";
  for (const sentence of sentences) {
    const room = pages.length === 0 ? FIRST_ROOM : BUDGET;
    const trial = buf ? `${buf} ${sentence}` : sentence;
    if (trial.length <= room) {
      buf = trial;
      continue;
    }
    pages.push(buf);
    buf = sentence;
  }
  pages.push(buf);
  return pages.length;
}

/**
 * Одно предложение заданной длины.
 *
 * Разбивщик режет только по `[.!?…]` + пробел, поэтому длинное перечисление
 * через точку с запятой — это **одно** предложение, и на живой странице оно
 * достижимо: при прозе находки в 204 знака комната первой страницы ≈794.
 */
function oneSentence(totalChars: number): string {
  const word = "перечисление; ";
  let out = "";
  while (out.length + word.length < totalChars - 1) out += word;
  return `${out.slice(0, totalChars - 1).trimEnd()}.`;
}

/** Комната первой страницы: бюджет минус проза находки. */
const FIRST_ROOM = BUDGET - WHAT_WAS_FOUND.length - 1;

describe("абзац сверх ёмкости листа", () => {
  it("уезжает на продолжение: две страницы, ни одна не выше бюджета", () => {
    const text = sentences(1400);

    const pages = withContinuations(base(text), "wikipedia-check");

    expect(pages).toHaveLength(2);
    for (const page of pages) {
      expect(pageNarrativeOfSlide(page, "orion_golden_wikipedia_check").length).toBeLessThanOrEqual(BUDGET);
    }
  });

  it("наполнены примерно поровну, а не под завязку и хвостик", () => {
    // Жадная набивка на 1400 знаках оставляла второй странице триста знаков
    // при первой в 1079; лист с одним предложением в карточке — не страница.
    const text = sentences(1400);

    const lengths = withContinuations(base(text), "wikipedia-check").map(
      (p) => (p.content.narrative ?? "").length
    );

    // Жадная набивка даёт разброс около 40 % от большей страницы; равномерная
    // — единицы процентов. Порог между ними, а не «лишь бы не пополам».
    const spread = Math.max(...lengths) - Math.min(...lengths);
    expect(spread).toBeLessThanOrEqual(Math.max(...lengths) * 0.2);
  });

  it("ни один знак не теряется", () => {
    const text = sentences(1400);

    const pages = withContinuations(base(text), "wikipedia-check");
    const got = pages.map((p) => compact(p.content.narrative ?? "")).join("");

    expect(got.length).toBe(compact(text).length);
  });

  it("место под прозу вычитается: лист, влезающий только без неё, разъезжается", () => {
    /*
     * Комната первой страницы — бюджет **минус** проза находки: она
     * приклеивается к абзацу уже в нагрузке. Считая комнату по полному
     * бюджету, разбивка оставила бы 988 знаков на листе, куда после склейки
     * уедет 1124 — и рендерер молча срезал бы хвост.
     */
    const almost = sentences(BUDGET - 10);

    const pages = withContinuations(base(almost), "wikipedia-check");

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(pageNarrativeOfSlide(page, "orion_golden_wikipedia_check").length).toBeLessThanOrEqual(
        BUDGET
      );
    }
  });

  it("продолжение несёт абзац и не несёт полей находки", () => {
    const pages = withContinuations(base(sentences(1400)), "wikipedia-check");
    const cont = pages[1]!;

    expect(cont.content.narrative ?? "").not.toBe("");
    expect(cont.content.whatWasFound).toBeUndefined();
    expect(cont.content.whyItMatters).toBeUndefined();
    expect(cont.content.whatToCheck).toBeUndefined();
  });

  it("абзац по ёмкости остаётся одной страницей", () => {
    // 950 знаков **страницы** — абзац золотого кейса: место занимает и проза,
    // поэтому построителю остаётся меньше.
    const forBuilder = 950 - WHAT_WAS_FOUND.length - 1;
    const pages = withContinuations(base(sentences(forBuilder)), "wikipedia-check");

    expect(pages).toHaveLength(1);
    expect(pageNarrativeOfSlide(pages[0]!, "orion_golden_wikipedia_check").length).toBeLessThanOrEqual(
      BUDGET
    );
  });

  it("предложение, не влезшее в первую страницу, начинает вторую", () => {
    /*
     * Комната первой страницы меньше комнаты продолжения на длину прозы
     * находки. Предложение между этими двумя числами на первую страницу не
     * помещается, а на продолжение — да; прежде такая страница молча
     * пропускалась, и набранное под комнату продолжения возвращалось **первым**
     * куском, то есть уезжало на первую страницу сверх её комнаты.
     */
    const text = oneSentence(FIRST_ROOM + 40);
    expect(text.length).toBeGreaterThan(FIRST_ROOM);
    expect(text.length).toBeLessThanOrEqual(BUDGET);

    const pages = withContinuations(base(text), "wikipedia-check");

    expect(pages.length).toBe(2);
    expect(pages[1]!.content.narrative ?? "").toContain("перечисление");
    for (const page of pages) {
      expect(pageNarrativeOfSlide(page, "orion_golden_wikipedia_check").length).toBeLessThanOrEqual(
        BUDGET
      );
    }
    expect(compact(pages.map((p) => p.content.narrative ?? "").join(""))).toHaveLength(
      compact(text).length
    );
  });

  it("первая страница забирает то, что было до такого предложения", () => {
    // Тот же вход плюс два коротких предложения перед длинным: раньше все три
    // уезжали одной страницей в 1046 знаков при бюджете 998.
    const head = "Первое короткое предложение. Второе короткое предложение.";
    const text = `${head} ${oneSentence(FIRST_ROOM + 40)}`;

    const pages = withContinuations(base(text), "wikipedia-check");

    expect(pages[0]!.content.narrative ?? "").toContain("Первое короткое");
    for (const page of pages) {
      expect(pageNarrativeOfSlide(page, "orion_golden_wikipedia_check").length).toBeLessThanOrEqual(
        BUDGET
      );
    }
    expect(compact(pages.map((p) => p.content.narrative ?? "").join(""))).toHaveLength(
      compact(text).length
    );
  });

  it("на любом входе кусок влезает в комнату своей страницы и знаки целы", () => {
    /*
     * Свойство, а не пример: разбивка обязана держать инвариант «кусок i
     * влезает в комнату i» на всех длинах предложений, а не только на тех, что
     * короче комнаты. Именно здесь и жил дефект — предложение между комнатой
     * первой страницы и комнатой продолжения.
     */
    for (let len = 40; len <= 2600; len += 37) {
      // Одиночное предложение берётся только той длины, при которой оно вообще
      // помещается на страницу: длиннее — это отказ, и у него свой тест.
      const text = len % 3 === 0 && len <= BUDGET ? oneSentence(len) : sentences(len);
      const pages = withContinuations(base(text), "wikipedia-check");
      const lengths = pages.map((p) => (p.content.narrative ?? "").length);
      lengths.forEach((n, i) => {
        expect(n, `длина ${len}, страница ${i + 1}: ${n} при комнате`).toBeLessThanOrEqual(
          i === 0 ? FIRST_ROOM : BUDGET
        );
      });
      expect(
        compact(pages.map((p) => p.content.narrative ?? "").join("")),
        `длина ${len}: знаки потеряны`
      ).toHaveLength(compact(text).length);
    }
  });

  it("равномерность не покупается лишней страницей", () => {
    /*
     * Равномерная раскладка иногда просит **больше** страниц, чем жадная: два
     * предложения по 420 знаков и одно в 600 она разложит на три листа там, где
     * хватает двух. Лишняя страница в отчёте — это внимание читателя, поэтому
     * ровнее берётся только тогда, когда не длиннее. Вход найден перебором со
     * снятым сторожем: таких входов 436 из 1600.
     */
    const text = [420, 420, 600]
      .map((n, i) => `Предложение ${i} ${"слово ".repeat(Math.floor((n - 20) / 6)).trim()}.`)
      .join(" ");

    const pages = withContinuations(base(text), "wikipedia-check");

    expect(pages.length).toBeLessThanOrEqual(greedyPageCount(text));
    expect(pages.length).toBe(2);
  });

  it("разбивка, которая не может обойтись без потери, отказывает громко", () => {
    // Одно предложение длиннее бюджета разрезать по предложениям нельзя, а
    // тихий обрубок — ровно то, ради чего эта работа делается.
    const huge = oneSentence(BUDGET + 102);

    expect(() => withContinuations(base(huge), "wikipedia-check")).toThrow(
      /narrative split would drop text/u
    );
  });

  it("в отказе стоит число, которое значит весь абзац, а не разницу с комнатой", () => {
    /*
     * `after` у этого отказа означает «сколько знаков сохранится», и здесь не
     * сохраняется ничего: разложить нельзя вовсе. Прежде сюда попадала
     * **комната**, и оператор читал «потеряется 102 знака» там, где терялся
     * весь абзац.
     */
    const huge = oneSentence(BUDGET + 102);

    const err = (() => {
      try {
        withContinuations(base(huge), "wikipedia-check");
        return null;
      } catch (e) {
        return e as NarrativeSplitLossError;
      }
    })();

    expect(err).toBeInstanceOf(NarrativeSplitLossError);
    expect(err!.before).toBe(huge.length);
    expect(err!.after).toBe(0);
  });

  it("шаблон без померенной ёмкости разбивается как прежде", () => {
    // Там число реестра — сид раскладки, а не замер, и о потере рендерер
    // говорит сам. Порог прежний, клиентский.
    const contract = getClientTextFieldBudgets().narrative;
    const text = sentences(contract + 300);

    const pages = withContinuations(
      { ...base(text), templateId: "ai-overview" } as SlideContentContract,
      "ai-overview"
    );

    expect(pages.length).toBeGreaterThan(1);
    expect((pages[0]!.content.narrative ?? "").length).toBeLessThanOrEqual(contract);
  });
});
