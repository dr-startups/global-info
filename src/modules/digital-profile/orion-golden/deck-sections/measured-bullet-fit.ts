/**
 * Перекладка страниц пути буллетов по мере рендерера.
 *
 * Вопрос «сколько влезает на лист» имеет ровно один ответ — код отрисовки
 * рендерера. Мерный прогон возвращает по каждой странице доступную под список
 * высоту и высоту каждого поданного элемента (той же функцией, которой блок
 * будет нарисован), а здесь блоки раскладываются по этим числам: пока
 * следующий влезает в остаток — кладём, не влезает — начинает следующий лист.
 * Собственной формулы высоты тут нет и быть не может: она была бы пересказом
 * переноса глифов на другом языке, а такой пересказ уже промахнулся на живом
 * прогоне (0,37 % на стр. 11 — предел жанра, а не недокалиброванность).
 *
 * Сложение отдельных высот заведомо не оптимистичнее совместной меры (у каждой
 * входит постоянная добавка), поэтому укладка ошибается только в сторону
 * «страница чуть свободнее» — потеря по построению невозможна.
 */

import type { SlideContentContract } from "./contracts";
import {
  buildContinuationSlide,
  continuationNumberInTitle,
  continuationTitle,
  stripContinuationSuffix,
} from "./continuation-slide";

/** Мера одной страницы пути буллетов — как её отдал рендерер. */
export type BulletMeasurePage = {
  slideKey: string;
  page: number;
  /** Сколько высоты осталось под список после обвязки страницы. */
  availableHeight: number;
  /** Потолок числа элементов у ветки отрисовки этой страницы. */
  maxItems: number;
  /** Высота каждого **поданного** элемента списка, в порядке подачи. */
  itemHeights: number[];
  keptItems: number;
  droppedBullets: number;
  droppedLines: number;
};

export type BulletMeasureVerdict = {
  version: string;
  pages: BulletMeasurePage[];
};

/** Форма вердикта, которую строитель умеет читать. Меняется форма — меняется строка. */
export const BULLET_MEASURE_VERSION = "orion-bullet-measure-v1";

/**
 * Разобрать ответ мерного прогона.
 *
 * Мера — единственный источник ответа «сколько влезает», и от неё зависит
 * состав страниц отчёта. Ответ 200 с чужим телом (рендерер прошлой версии
 * после частичного деплоя, прокси, подменивший тело) без разбора уезжал бы в
 * укладку и падал `TypeError` где-то в арифметике вместо названного отказа
 * попытки. Это граница системы — здесь и проверяем.
 */
export function parseBulletMeasureVerdict(raw: unknown): BulletMeasureVerdict {
  const body = (raw ?? {}) as { version?: unknown; pages?: unknown };
  if (body.version !== BULLET_MEASURE_VERSION) {
    throw new Error(
      `bullet measure response version ${JSON.stringify(body.version)} != ${BULLET_MEASURE_VERSION}`
    );
  }
  if (!Array.isArray(body.pages)) {
    throw new Error("bullet measure response has no pages array");
  }
  return {
    version: BULLET_MEASURE_VERSION,
    pages: body.pages.map((page, i) => {
      const p = (page ?? {}) as Record<string, unknown>;
      const num = (key: string): number => {
        const value = p[key];
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(`bullet measure page ${i} has no numeric ${key}`);
        }
        return value;
      };
      if (typeof p.slideKey !== "string" || !p.slideKey) {
        throw new Error(`bullet measure page ${i} has no slideKey`);
      }
      if (!Array.isArray(p.itemHeights) || p.itemHeights.some((h) => typeof h !== "number")) {
        throw new Error(`bullet measure page ${i} has no itemHeights`);
      }
      return {
        slideKey: p.slideKey,
        page: num("page"),
        availableHeight: num("availableHeight"),
        maxItems: num("maxItems"),
        itemHeights: p.itemHeights as number[],
        keptItems: num("keptItems"),
        droppedBullets: num("droppedBullets"),
        droppedLines: num("droppedLines"),
      };
    }),
  };
}

/** Мерный прогон рендерера: пейлоад на входе, вердикт на выходе. */
export type BulletMeasureAdapter = (
  payload: Record<string, unknown>
) => Promise<BulletMeasureVerdict>;

/**
 * Разрез «элементы списка рендерера ↔ буллеты деки» на одной странице: сколько
 * элементов добавляет склейка страницы до буллетов и сколько после.
 */
export type BulletItemFold = { leading: number; trailing: number };

/** Страница цепочки слота глазами перекладки. */
export type SlotChainPage = {
  slideId: string;
  bulletCount: number;
  fold: BulletItemFold;
};

export type SlotChain = {
  baseSlotId: string;
  pages: SlotChainPage[];
};

/** Сколько буллетов достаётся каждой странице цепочки слота, по порядку. */
export type BulletRecutPlan = ReadonlyMap<string, number[]>;

/** Есть ли в вердикте хоть одна потеря — единственное условие продолжения цикла. */
export function measureVerdictHasLoss(verdict: BulletMeasureVerdict): boolean {
  return verdict.pages.some((p) => p.droppedBullets > 0 || p.droppedLines > 0);
}

/**
 * Ёмкость листа, которого в деке ещё нет.
 *
 * Её никто не мерил, и гадать о ней нельзя. Есть у цепочки измеренное
 * продолжение — берём его ёмкость (обвязка у продолжений одинаковая); нет —
 * кладём на новый лист весь остаток и оставляем вопрос следующей итерации.
 * Ошибка допущения стоит итерацию, но никогда — потерю.
 */
const UNKNOWN_CAPACITY = Number.POSITIVE_INFINITY;

type PageBudget = {
  /** Сколько высоты под сами блоки: доступная минус вклейка страницы. */
  bulletHeight: number;
  /** Сколько блоков разрешает ветка отрисовки. */
  bulletSlots: number;
};

export function planBulletRecut(input: {
  chains: ReadonlyArray<SlotChain>;
  verdict: BulletMeasureVerdict;
}): BulletRecutPlan {
  const measured = new Map(input.verdict.pages.map((p) => [p.slideKey, p]));
  const plan = new Map<string, number[]>();

  for (const chain of input.chains) {
    const heights: number[] = [];
    /** Лист, на котором блок лежит сейчас: назад блоки не едут. */
    const seedPage: number[] = [];
    const budgets: PageBudget[] = [];
    let usable = true;
    for (const page of chain.pages) {
      const m = measured.get(page.slideId);
      if (!m) {
        // Страница без меры, но с буллетами: её рисует не путь буллетов — или
        // не так, как мы думаем. Раскладывать вслепую нельзя.
        if (page.bulletCount > 0) usable = false;
        budgets.push({ bulletHeight: 0, bulletSlots: 0 });
        continue;
      }
      if (m.itemHeights.length !== page.bulletCount + page.fold.leading + page.fold.trailing) {
        usable = false;
        break;
      }
      const chromeHeights = [
        ...m.itemHeights.slice(0, page.fold.leading),
        ...(page.fold.trailing > 0 ? m.itemHeights.slice(-page.fold.trailing) : []),
      ];
      budgets.push({
        bulletHeight: Math.max(0, m.availableHeight - chromeHeights.reduce((n, h) => n + h, 0)),
        bulletSlots: Math.max(0, m.maxItems - page.fold.leading - page.fold.trailing),
      });
      const own = m.itemHeights.slice(
        page.fold.leading,
        m.itemHeights.length - page.fold.trailing
      );
      heights.push(...own);
      for (let k = 0; k < own.length; k += 1) seedPage.push(budgets.length - 1);
    }
    if (!usable) continue;

    const contBudgets = budgets.slice(1).filter((b) => b.bulletSlots > 0);
    const freshPage: PageBudget = contBudgets.length
      ? contBudgets.reduce((a, b) => (b.bulletHeight > a.bulletHeight ? b : a))
      : { bulletHeight: UNKNOWN_CAPACITY, bulletSlots: UNKNOWN_CAPACITY };

    const counts = budgets.map(() => 0);
    const countAt = (i: number): number => counts[i] ?? 0;
    const budgetAt = (i: number): PageBudget => budgets[i] ?? freshPage;
    let p = 0;
    let used = 0;
    for (const [idx, h] of heights.entries()) {
      // Блоки едут только вперёд: лист, ещё не существующий в деке, никем не
      // мерен, а подтягивать блок назад значило бы уплотнять уже принятую
      // страницу по допущению вместо измерения.
      if (seedPage[idx]! > p) {
        p = seedPage[idx]!;
        used = 0;
      }
      if (countAt(p) > 0 && (used + h > budgetAt(p).bulletHeight || countAt(p) >= budgetAt(p).bulletSlots)) {
        p += 1;
        used = 0;
      }
      // Блок, не влезающий на лист даже в одиночку, уезжает целиком: базовый
      // лист остаётся с нарративом и KPI, а блок начинает следующий. Резать
      // блок по строкам — ровно та потеря, ради которой цикл и заведён. Дальше
      // ещё не существующего листа поиск не идёт: он последняя инстанция, и
      // блок ложится на него, каким бы высоким ни был.
      while (
        countAt(p) === 0 &&
        p < budgets.length &&
        (h > budgetAt(p).bulletHeight || budgetAt(p).bulletSlots < 1)
      ) {
        p += 1;
        used = 0;
      }
      while (counts.length <= p) counts.push(0);
      counts[p] = countAt(p) + 1;
      used += h;
    }

    const before = chain.pages.map((page) => page.bulletCount);
    if (counts.length === before.length && counts.every((n, i) => n === before[i])) continue;
    plan.set(chain.baseSlotId, counts);
  }
  return plan;
}

/**
 * Применить план: буллеты цепочки перекладываются по страницам, при
 * необходимости появляются новые продолжения, нумерация подписей приводится к
 * новой длине цепочки.
 *
 * Мультимножество буллетов слота инвариантно — блок не теряется, не двоится и
 * не покидает свой слот. Нарушение здесь означало бы потерянный у клиента
 * текст, поэтому проверяется, а не подразумевается.
 */
export function applyBulletRecut(
  slides: SlideContentContract[],
  plan: BulletRecutPlan
): SlideContentContract[] {
  if (plan.size === 0) return slides;
  const out: SlideContentContract[] = [];
  let i = 0;
  while (i < slides.length) {
    const base = slides[i]!;
    let end = i + 1;
    while (
      end < slides.length &&
      slides[end]!.isContinuation &&
      slides[end]!.baseSlotId === base.baseSlotId
    ) {
      end += 1;
    }
    const counts = base.isContinuation ? undefined : plan.get(base.baseSlotId);
    out.push(...(counts ? recutChain(slides.slice(i, end), counts) : slides.slice(i, end)));
    i = end;
  }
  return out;
}

function recutChain(chain: SlideContentContract[], counts: number[]): SlideContentContract[] {
  const base = chain[0]!;
  const pooled = chain.flatMap((s) => s.content.bullets ?? []);
  const pageCount = Math.max(chain.length, counts.length);
  /*
   * Образец нового листа — последнее **продолжение** цепочки, а не её основа.
   *
   * У основы бывает свой шаблон и свой визуал: у страницы «почему выделено»
   * основа рисует снимок выдачи (`serp-screenshot-analysis`,
   * `visualAssetRefs: [снимок]`), а продолжения — только фразы
   * (`continuation`, визуала нет). Клон основы получил бы её визуал, а страница
   * с визуалом в пейлоаде списка не несёт вовсе (`hasVisual` → `bullets:
   * undefined`): положенный на неё текст исчезал бы **до** рендерера — мимо
   * телеметрии и мимо меры, — а снимок печатался бы дважды. Ровно та
   * молчаливая потеря, ради которой заведён весь цикл.
   */
  const last = chain[chain.length - 1]!;
  const donor = last.isContinuation ? last : base;
  // Счёт подписи читается из цепочки: один построитель нумерует продолжения от
  // «2/4», считая первой страницей саму основу, другой — от «1/2», считая
  // только продолжения. Единое правило переписало бы чужие подписи. Подписи
  // без номера считаются нумерацией «основа — первая страница»: так их
  // получают продолжения, которых построитель выпустил ровно одно.
  const offset = (continuationNumberInTitle(chain[1]?.title ?? "") ?? 2) - 1;
  const titleTotal = pageCount - 1 + offset;
  const chainTitle = stripContinuationSuffix(chain[1]?.title ?? base.title);
  // Число листов не изменилось — подписи не трогаем: блоки просто переехали
  // между уже подписанными страницами.
  const renumber = pageCount !== chain.length;

  const out: SlideContentContract[] = [];
  let taken = 0;
  for (let page = 0; page < pageCount; page += 1) {
    const bullets = pooled.slice(taken, taken + (counts[page] ?? 0));
    taken += counts[page] ?? 0;
    if (page === 0) {
      out.push({ ...base, content: { ...base.content, bullets } });
      continue;
    }
    const existing = chain[page];
    if (existing) {
      out.push({
        ...existing,
        title: renumber
          ? continuationTitle(stripContinuationSuffix(existing.title), page + offset, titleTotal)
          : existing.title,
        content: { ...existing.content, bullets },
      });
      continue;
    }
    // Нового листа в деке ещё нет: он строится тем же конструктором, что и
    // продолжения построителя, — иначе на нём осталась бы обвязка первой
    // страницы блока. Таблица и объяснения выделенного на новый лист не едут:
    // это содержимое своей страницы, и напечатанное дважды оно и есть дубль.
    out.push({
      ...buildContinuationSlide({
        base: donor,
        index: page + offset,
        totalPages: titleTotal,
        baseTitle: chainTitle,
        content: {
          ...donor.content,
          narrative: undefined,
          table: undefined,
          highlightExplanations: undefined,
          bullets,
        },
      }),
      slideId: `${base.slideId}__cont${page}`,
      baseSlotId: base.baseSlotId,
      continuationOf: base.slideId,
      continuationIndex: page,
    });
  }
  const after = out.flatMap((s) => s.content.bullets ?? []);
  if (after.length !== pooled.length || after.some((b, idx) => b !== pooled[idx])) {
    throw new Error(
      `bullet recut lost content in slot ${base.baseSlotId}: ${pooled.length} → ${after.length}`
    );
  }
  return out;
}
