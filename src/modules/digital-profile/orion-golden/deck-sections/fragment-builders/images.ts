/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { FragmentKey, SectionType } from "../contracts";
import type { ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import type { NotShownRow, VisibleAssetItem } from "../canonical-slots";
import type { FragmentBuildOutput, FragmentExtras } from "./shared";
import { pluralRu } from "../../../report/i18n/plural-ru";
import { clientSafeDomains } from "../../../services/composite-serp-merge";
import {
  adverseVisualSidebar,
  buildPageEvidenceView,
  composePageRowComposition,
  type PageRowComposition,
  claimText,
  clampClientText,
  distribute,
  enumerateRu,
  findingForVisibleRow,
  pageFindingBlocks,
  sourcesSentence,
  visualSlide,
} from "./shared";

/**
 * Плиток на сетке.
 *
 * Столько строк рисует построитель ассетов (`rows.slice(0, 6)`), и столько же
 * страница вправе засчитать. Продукту ограничение уже не нужно —
 * `visibleItems` там ровно нарисованное, — но замороженная фикстура эталона 72
 * старше этой починки: у неё в мете все строки набора (у ОАЭ — 42 на шесть
 * плиток), и без потолка страница напечатала бы «42».
 */
const GRID_TILE_CAPACITY = 6;

/**
 * Почему превью не получено — клиентскими словами.
 *
 * `offline` значит «мы не спрашивали»: выдать его за отказ площадки нельзя,
 * иначе офлайн-пересборка обвиняет источник в том, чего он не делал. Машинный
 * код (`http_403`, `not_an_image`) клиенту не показывается — перевод один на
 * все причины и живёт здесь. `undefined` — законный вход: у строки, которой нет
 * в доказательствах страницы, причину предъявить нечем.
 */
function previewFailureWords(reason: NotShownRow["reason"] | undefined): string {
  if (!reason) return "причина не установлена";
  if (reason.startsWith("http_") || reason === "network") return "источник не отдал файл";
  switch (reason) {
    case "offline":
      return "превью в этом прогоне не запрашивались";
    case "budget_exhausted":
      return "не успели загрузиться за отведённое время";
    case "not_an_image":
      return "по адресу не изображение";
    case "too_large":
      return "файл слишком велик";
    case "decode_failed":
      return "файл не читается";
    case "no_url":
      return "у строки нет пригодного адреса изображения";
    default:
      return "причина не установлена";
  }
}

/** Ёмкость строки «что обнаружено» в боковой панели страницы изображений. */
const SIDEBAR_FOUND_BUDGET = 400;

/** Строки страницы, которые нашли, но не нарисовали, — с их доменами и находками. */
type NotShownOnPage = {
  rows: Array<{ row: NotShownRow; item: VisibleAssetItem }>;
  domains: string[];
  adverse: Array<{ row: NotShownRow; item: VisibleAssetItem }>;
  /**
   * Строки, которых нет в индексе доказательств этой страницы.
   *
   * Назвать о них нечего — ни домена, ни ссылки, — но и молчать нельзя:
   * страница обязана сосчитать всё, что на ней нашли (пункт BK). Поэтому они
   * входят в число и получают общую причину, а домена не получают.
   */
  unindexed: number;
};

/**
 * Не показанные строки этой страницы — с доменами из её же доказательств.
 *
 * Домен берётся из индекса доказательств, а не из меты ассета: ворота области
 * сверяют каждый названный домен именно с ним, и домен, добытый другим
 * способом (например, хост CDN у строки без адреса страницы), обрушил бы
 * обязательную секцию. По той же причине строка, которой в индексе нет, не
 * получает ни домена, ни ссылки среди доказательств — сказать о ней нечего.
 *
 * Но **в счёт она входит**: прежде такая строка отбрасывалась целиком и не
 * оставляла следа нигде — ни в числе «Из N строк», ни в причинах, ни в
 * предупреждениях. Потеря обязана быть слышна, а «Из 4 строк» вместо «Из 3» —
 * самый дешёвый способ её услышать.
 */
function notShownOnThisPage(
  slotId: string,
  extras: FragmentExtras,
  scoped: ScopedFragmentInput
): NotShownOnPage {
  const all = (extras.visualAssets?.[slotId] ?? []).flatMap((m) => m.notShown ?? []);
  let unindexed = 0;
  const rows = all
    .flatMap((row) => {
      const e = scoped.evidenceIndex[row.ref];
      if (!e) {
        unindexed += 1;
        return [];
      }
      const item: VisibleAssetItem = {
        ref: row.ref,
        url: e.url,
        domain: e.domain,
        title: e.title,
        // Признак — тот же, что у нарисованных строк: его проставил построитель
        // ассета единым предикатом. Пересчитывать его здесь значило бы завести
        // на странице второе правило и разойтись с её же рамками.
        adverse: row.adverse,
      };
      return [{ row, item }];
    });
  return {
    rows,
    domains: [...new Set(clientSafeDomains(rows.map((r) => r.item.domain)))],
    adverse: rows.filter((r) => r.row.adverse),
    unindexed,
  };
}

/**
 * Строка о найденном, но не показанном.
 *
 * Плитки-заглушки в отчёте нет: сетка рисует только полученные превью. Значит,
 * остальное страница обязана назвать словами — счётом, причиной и доменами, а
 * негативную строку отдельно: молча терять негативный сигнал нельзя.
 *
 * Порядок предложений — не вкусовщина: строка сайдбара режется по границе
 * предложения с конца, поэтому перечисление источников стоит последним. Платить
 * за длину приходится доменами, а не сигналом о негативе.
 *
 * **Бюджет держится устройством, а не совпадением длин.** Прежде перечисление
 * причин ничем не ограничивалось и стояло до фразы о негативе: замер ревью дал
 * 388 знаков из 400 — запас двенадцать, — и на трёх негативных строках с
 * доменами под сорок знаков плюс семи прочих сигнал уже терялся (пункт BL).
 * Теперь строка собирается вариантами: за длину платят сначала домены, потом
 * перечисление причин, потом домены при самой фразе о негативе, — а сама фраза
 * не платит никогда.
 */
function notShownNote(
  page: NotShownOnPage,
  drawn: number,
  budget: number
): string | undefined {
  const missing = page.rows.length + page.unindexed;
  if (missing === 0) return undefined;
  // Причины сводятся по клиентским словам, а не по коду: `http_403` и
  // `network` — одна новость для читателя и одна строка в перечислении.
  const byWords = new Map<string, number>();
  for (const { row } of page.rows) {
    const words = previewFailureWords(row.reason);
    byWords.set(words, (byWords.get(words) ?? 0) + 1);
  }
  if (page.unindexed > 0) {
    // Причина отказа превью у такой строки может быть какой угодно, но
    // предъявить её нечем: самой строки в доказательствах страницы нет.
    const words = previewFailureWords(undefined);
    byWords.set(words, (byWords.get(words) ?? 0) + page.unindexed);
  }
  const reasons = [...byWords.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))
    .map(([words, n]) => `${words} — ${n}`)
    .join(", ");
  const found = drawn + missing;
  const headBase =
    `Из ${found} ${pluralRu(found, "строки", "строк", "строк")} этой страницы ` +
    `показано ${drawn}: ${missing} без превью`;
  const adverseDomains = enumerateRu(
    clientSafeDomains(page.adverse.map((a) => a.item.domain)),
    3
  );
  const adverseBare = page.adverse.length
    ? ` Среди них ${page.adverse.length} с негативным признаком.`
    : "";
  const adverseNote = page.adverse.length
    ? ` Среди них ${page.adverse.length} с негативным признаком${
        adverseDomains ? ` — ${adverseDomains}` : ""
      }.`
    : "";
  const domains = enumerateRu(page.domains, 3);
  const sources = domains ? ` Их источники: ${domains}.` : "";
  // Порядок отказа — от наименее ценного к самому ценному. Последний вариант
  // печатается, даже если и он не влез: обрезать его будет вызывающий, но
  // фраза о негативе к тому моменту стоит сразу за коротким заголовком.
  const variants = [
    `${headBase} (${reasons}).${adverseNote}${sources}`,
    `${headBase} (${reasons}).${adverseNote}`,
    `${headBase}.${adverseNote}`,
    `${headBase}.${adverseBare}`,
  ];
  return variants.find((v) => v.length <= budget) ?? variants[variants.length - 1]!;
}

export function buildImagesFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const slots = slotsForFragment(key);
  const units = scoped.surfaceUnits.filter((u) => u.surface === "images");
  // Same normalized claim text must not repeat across the image slides.
  const seenClaimText = new Set<string>();
  const claims = units
    .flatMap((u) => u.claims)
    .filter((c) => {
      const norm = c.text.trim().toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "");
      if (seenClaimText.has(norm)) return false;
      seenClaimText.add(norm);
      return true;
    });
  const refs = units.flatMap((u) => u.evidenceRefs);
  const claimChunks = distribute(claims, slots.length);
  const slides = slots.map((slot, i) => {
    // Red-framed image cards on THIS page's bound grid (§7.1 / PDF p19):
    // page scope = visible tiles only — never region-level refChunks.
    const sidebar = adverseVisualSidebar(slot.slotId, extras, scoped);
    const pageRefs =
      sidebar.gridRefs.length > 0
        ? sidebar.gridRefs
        : (extras.visualAssets?.[slot.slotId] ?? [])
            .flatMap((a) => (a.visibleItems ?? []).map((v) => v.ref))
            .filter((r) => Boolean(scoped.evidenceIndex[r]));
    const view = buildPageEvidenceView(scoped, pageRefs);
    const notShownOnPage = notShownOnThisPage(slot.slotId, extras, scoped);
    const pageDomainSet = new Set(
      view.domains.map((d) => d.toLowerCase()).filter((d) => d && d !== "—")
    );
    // Drop claim bullets that cite domains not on this grid.
    const pageClaims = claimChunks[i].filter((c) => {
      const domains = (c.text.match(/\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+\b/giu) ?? []).map((d) =>
        d.toLowerCase()
      );
      if (domains.length === 0) return true;
      if (pageDomainSet.size === 0) return true;
      return domains.some((d) => pageDomainSet.has(d));
    });
    /*
     * Негатив страницы — одна единица счёта и одна арифметика.
     *
     * Единица — **нарисованная рамка**: её ставит построитель ассета тем же
     * единым предикатом, а дека рамки объясняет и не пересчитывает (§8, «Одна
     * строка — один материал»). Пока заголовок считал по одному правилу, тело
     * по другому, а строки без превью по третьему, лист нёс «негативных
     * источников нет» над красной рамкой, которую сам же объяснял, и
     * «негативных заголовков — 3» над «Показано 1 результат».
     *
     * Теперь:  заголовок = выделено красным + найдено без превью,
     * и каждое слагаемое печатается своей фразой рядом со своим набором строк.
     * Потолок ёмкости оставлен ради замороженной фикстуры эталона
     * (см. `GRID_TILE_CAPACITY`): «выделено красным» не бывает больше
     * «показано».
     */
    const shownOnGrid = Math.min(sidebar.visibleRows.length, GRID_TILE_CAPACITY);
    const adverseOnGrid = Math.min(sidebar.adverseRows.length, shownOnGrid);
    const adverseTotal = adverseOnGrid + notShownOnPage.adverse.length;
    /*
     * Тело страницы называет то же число, что заголовок, а не считает своё.
     *
     * Запасная ветка описания состава считает негатив своим предикатом по
     * ссылкам страницы — на сетке это второй ответ на вопрос, у которого уже
     * есть первый: рамка. Поэтому число ей передаётся готовым.
     */
    const composition: PageRowComposition = {
      ...composePageRowComposition(scoped, pageRefs),
      adverseHeadlines: adverseOnGrid,
    };
    const pageBlocks = pageFindingBlocks(scoped, view, { composition });
    /*
     * Не показанное называется первым.
     *
     * Строка сайдбара режется по границе предложения с конца, и «мы нашли, но
     * не показали» — ровно то, что нельзя потерять на длинной странице.
     */
    const counted = sidebar.explanations.length
      ? `Изображения на этой странице: ${shownOnGrid}; выделено красным (ведут на негативные источники): ${adverseOnGrid}.`
      : pageBlocks.whatWasFound;
    // Бюджет считается до сборки: что осталось от строки после обязательного
    // счётчика, то и может занять рассказ о непоказанном.
    const note = notShownNote(
      notShownOnPage,
      shownOnGrid,
      Math.max(80, SIDEBAR_FOUND_BUDGET - (counted?.length ?? 0) - 1)
    );
    const foundText = [note, counted].filter(Boolean).join(" ");
    const whatWasFound = foundText ? clampClientText(foundText, SIDEBAR_FOUND_BUDGET) : undefined;
    const verdictTitle =
      shownOnGrid > 0 || adverseTotal > 0
        ? `${slot.title}: ${
            adverseTotal > 0
              ? `${adverseTotal} ${pluralRu(
                  adverseTotal,
                  "изображение ведёт на негативный источник",
                  "изображения ведут на негативные источники",
                  "изображений ведут на негативные источники"
                )}`
              : "негативных источников нет"
          }`
        : undefined;
    return visualSlide({
      slot,
      sectionId,
      extras,
      scoped,
      ...(verdictTitle ? { title: verdictTitle } : {}),
      content: {
        bullets: pageClaims.map((c) => clampClientText(claimText(c), 400)),
        ...pageBlocks,
        ...(whatWasFound ? { whatWasFound } : {}),
        // Подпись источников не спорит с абзацем над ней: страница говорит и о
        // не нарисованных строках, значит, называет и их площадки.
        ...(notShownOnPage.domains.length
          ? {
              sourceNote: sourcesSentence([
                ...new Set([...view.domains, ...notShownOnPage.domains]),
              ]),
            }
          : {}),
        // Статус страницы считает весь её негатив, а не только выделенный
        // рамкой: строка без превью тоже ведёт на негативный источник.
        ...(adverseTotal > 0
          ? {
              statusNote: `Изображений, ведущих на негативные источники, — ${adverseTotal}; каждое требует сверки с первоисточником.`,
              whatToCheck: clampClientText(
                "Проверить сайты-источники выделенных изображений и подготовить позицию по каждому негативному материалу.",
                220
              ),
              whyItMatters: clampClientText(
                sidebar.explanations.length
                  ? // Consistent with the red frames: the page DOES carry adverse
                    // visual signals, so the meaning block must not claim otherwise.
                    "Выделенные изображения связаны с негативными источниками и формируют нежелательный визуальный фон в блоке «Картинки»: пользователь видит их до перехода на сайты."
                  : "Часть изображений ведёт на негативные источники: превью получить не удалось, но сами материалы остаются в выдаче по субъекту и открываются по клику.",
                320
              ),
            }
          : {}),
        ...(sidebar.explanations.length
          ? { highlightExplanations: sidebar.explanations }
          : {}),
      },
      evidenceRefs: [...new Set([...pageRefs, ...notShownOnPage.rows.map((r) => r.row.ref)])],
      findingIds: [
        ...new Set([
          ...view.findings.map((f) => f.findingId),
          ...sidebar.explainedFindingIds,
          // Находка по негативной строке доносится и без плитки: рамки нет, а
          // материал есть.
          ...notShownOnPage.adverse
            .map((a) => findingForVisibleRow(a.item, scoped)?.findingId)
            .filter((id): id is string => Boolean(id)),
        ]),
      ],
      metrics: { items: pageRefs.length, adverseImages: adverseTotal },
      noUnderlyingData: refs.length === 0,
      noDataReason: i === 0 ? "no-images" : "no-images-continued",
    });
  });
  return { slides, status: "READY" };
}
