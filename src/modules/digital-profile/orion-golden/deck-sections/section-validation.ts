import { domainToASCII } from "node:url";
/**
 * Section-level QA — every SectionPack must pass before assembly.
 * A failed pack never reaches the DeckAssembler.
 */

import { SectionPackV2Schema, type SectionPackV2 } from "./contracts";
import {
  WIKIPEDIA_FRAGMENT_CATEGORY_LABELS,
  pickWikipediaCheckEntry,
} from "./fragment-builders/shared";
import { clientAddress } from "../client/client-address";
import {
  DECK_TEMPLATE_REGISTRY,
  SILENTLY_CLIPPED_NARRATIVE_TEMPLATES,
  type DeckTemplateId,
} from "./template-registry";
import { narrativeBudgetOf, pageNarrativeOf } from "./page-narrative";
import { normalizeEvidenceRef, type ScopedEvidenceIndex } from "./scoped-input";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";
import {
  getClientTextFieldBudgets,
  matchInternalClientToken,
} from "../client/load-client-text-contract";

export type SectionValidationReport = {
  fragmentKey: string;
  passed: boolean;
  issues: string[];
};

/**
 * Шаблон страницы, которая печатает проверку Википедии, — один ответ на файл.
 *
 * Спрашивается он трижды: страничной областью доменов, воротами отрицания и
 * воротами принадлежности фрагментов. Три литерала расходятся молча, а
 * разойтись им есть куда: у слота `p29_uae_wikipedia` тот же построитель
 * отдаёт лист другого шаблона, когда строк выдачи не собрано.
 */
const WIKIPEDIA_CHECK_TEMPLATE = "wikipedia-check";

/**
 * Templates whose dynamic sidebar/what-found copy must be strictly derived
 * from the slide's own evidence refs (page scope) — never from region- or
 * bundle-level findings/domains.
 */
const PAGE_SCOPED_TEMPLATES = new Set([
  "serp-screenshot-analysis",
  "suggestions",
  "image-grid",
  "wikipedia-knowledge",
  WIKIPEDIA_CHECK_TEMPLATE,
  "ai-overview",
  "related-queries",
  "serp-table",
]);

/** Fragments whose serp-table slides carry region-level summary rows. */
const REGION_SUMMARY_FRAGMENTS = new Set(["RU_SUMMARY", "UAE_SUMMARY", "COMPLIANCE_MAIN"]);

/**
 * Домены в клиентском тексте. Зона — буквы **или** punycode (`xn--…`).
 *
 * Требование «зона состоит только из букв» отсекало кириллические зоны: у
 * `.рф` она выглядит как `xn--p1ai`, с цифрами и дефисами. На боевом прогоне
 * 28.07 из строки «Источники — … xn--h1ajim.xn--p1ai …» вырезался обрезок
 * `xn--h1ajim.xn`; такого домена не существует, среди доказательств страницы
 * его не было, и обязательная секция `RU_SERP` получила отказ
 * «sidebar domain not derived from page evidence». Дека не собралась вовсе —
 * `pageCount: 0`. То есть отчёт с любым источником в зоне `.рф` до клиента не
 * доходил.
 *
 * Буквенная зона требовалась, чтобы не считать доменами даты и числа
 * («28.07.2026», «3.14»), — это свойство сохранено: punycode-зона обязана
 * начинаться с `xn--`.
 */
// Границы заданы просмотрами, а не `\b`: в JS `\b` считает словом только
// ASCII, поэтому перед кириллической буквой она не срабатывает вовсе и
// «руни.рф» не опознавался как домен.
export const DOMAIN_TOKEN_RE =
  /(?<![\p{L}0-9.-])[\p{L}0-9][\p{L}0-9-]*(?:\.[\p{L}0-9-]+)*\.(?:xn--[a-z0-9-]+|\p{L}{2,})(?![\p{L}0-9-])/giu;

/**
 * Напечатанный адрес страницы: хост и путь до конца слова.
 *
 * Путь адреса — не имя источника: сегмент вроде `otchet.html` внутри ссылки
 * читался как отдельный домен, которого нет среди доказательств, и
 * обязательная секция получала отказ — то есть дека не собиралась вовсе.
 *
 * Выражение опознаёт **чужой** адрес, и только его: свой вырезается раньше и
 * точным совпадением (см. `undeclaredClientTextDomains`). Поэтому неточность
 * границы здесь безопасна — она даёт лишний разбор чужого адреса, а не
 * освобождение.
 */
const PRINTED_LINK_RE =
  /(?<![\p{L}0-9.-])(?:https?:\/\/)?([\p{L}0-9][\p{L}0-9-]*(?:\.[\p{L}0-9-]+)*\.(?:xn--[a-z0-9-]+|\p{L}{2,}))(\/[^\s»"]*)/giu;

/** Печатный адрес ищется в тексте как есть, поэтому спецсимволы экранируются. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Домены клиентского текста, не выводимые из доказательств страницы.
 *
 * Один ответ на весь отчёт: секционная валидация и проверка сборки задавали
 * этот вопрос по отдельности и разными выражениями — ASCII-только против
 * юникодного, — то есть один и тот же текст могли оценить по-разному.
 */
export function undeclaredClientTextDomains(
  text: string,
  allowed: ReadonlySet<string>,
  /**
   * Адреса доказательств страницы — в том виде, в каком отчёт их печатает
   * (`clientAddress`).
   */
  allowedLinks: ReadonlySet<string> = new Set()
): string[] {
  const out: string[] = [];
  const check = (raw: string): void => {
    const domain = normalizeDomainForCompare(raw);
    if (domain && !allowed.has(domain)) out.push(domain);
  };
  /*
   * Свой адрес вырезается целиком и по точному совпадению.
   *
   * У пути нет «конца слова»: в нём законны пробел (из `%20`), точка с запятой,
   * апостроф, скобки. Любой набор терминаторов на них промахивается, матч
   * обрывается — и хвост собственного адреса уходит в общий разбор, где
   * `otchet.html` и `doc.pdf` выглядят доменами. Это тот самый отказ
   * обязательной секции, ради которого освобождение и заводилось, только
   * взведённый обычными символами адреса. Сравнение печатных строк вопроса о
   * границе не задаёт вовсе.
   *
   * Длинные адреса вырезаются первыми: короткий может оказаться префиксом
   * длинного, и тогда от длинного остался бы хвост.
   *
   * Границы у вхождения обязательны. Доказательство с корневым адресом даёт
   * печатную форму из одного домена («x.com»), и вырезание сырой подстрокой
   * снимало его изнутри чужих имён — `evil-x.com`, `mx.com`, `yx.com` уходили
   * из разбора вместе с ним. Слева граница домена, справа — граница домена и
   * пути: адрес с путём освобождается только целиком, а корневой — только там,
   * где он стоит сам по себе.
   */
  let rest = text.toLowerCase();
  for (const link of [...allowedLinks].sort((a, z) => z.length - a.length)) {
    const printed = String(link ?? "").trim().toLowerCase();
    if (!printed) continue;
    rest = rest.replace(
      new RegExp(`(?<![\\p{L}0-9.-])${escapeForRegExp(printed)}(?![\\p{L}0-9\\-/])`, "giu"),
      " "
    );
  }
  // Остаток: ссылка, которой у страницы нет, отвечает и за хост, и за домены в
  // пути — домен, спрятанный в сегменте чужого адреса, тоже назван клиенту.
  rest = rest.replace(PRINTED_LINK_RE, (_match, host: string, path: string) => {
    check(host);
    return ` ${path} `;
  });
  for (const m of rest.matchAll(DOMAIN_TOKEN_RE)) check(m[0]);
  return out;
}

const TEXT_BUDGETS = getClientTextFieldBudgets();

/**
 * Сколько абзаца влезает на лист — вопрос шаблона, а не поля.
 *
 * Там, где абзац рисует молча обрезающая карточка, ответ один и он реестровый:
 * ёмкость померена по листу. Здесь применялся общий бюджет клиентского поля
 * (1100 знаков на все шаблоны, шире любого листа), и абзац страницы Википедии
 * в золотом эталоне — 952 знака при объявленных 900 — проходил без возражений,
 * а рендерер потом отрезал хвост, не сказав об этом никому.
 *
 * У остальных шаблонов реестровое число — сид раскладки, а не замер, и потерю
 * там рендерер объявляет сам (`dropped_bullets` → `CONTENT_DROPPED_BY_RENDERER`).
 * Требовать от них того же значило бы завалить приёмку на здоровой деке
 * числом, которое никто не мерил.
 */
export { narrativeBudgetOf };

export function validateSectionPack(input: {
  pack: SectionPackV2;
  expectedCaseId: string;
  expectedReportRunId: string;
  expectedDatasetId: string;
  bundle: VerifiedFindingBundle;
  knownEvidenceRefs: Set<string>;
  /** Full run evidence index for the sidebar domain-derivation gate. */
  evidenceIndex?: ScopedEvidenceIndex;
}): SectionValidationReport {
  const issues: string[] = [];
  const { pack } = input;

  // 1. Schema valid (v3 self-contained: caseId/datasetId/sourceFindingIds/
  // evidenceRefs required; superRefine enforces datasetId==sourceDatasetId and
  // sourceFindingIds/evidenceRefs == inputs.*).
  const parsed = SectionPackV2Schema.safeParse(pack);
  if (!parsed.success) {
    issues.push(`schema: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }

  // 2/3. Lineage matches — explicit self-contained fields, never inferred.
  if (!pack.caseId) {
    issues.push("missing caseId");
  } else if (pack.caseId !== input.expectedCaseId) {
    issues.push(`foreign caseId: ${pack.caseId}`);
  }
  if (pack.reportRunId !== input.expectedReportRunId) {
    issues.push(`foreign reportRunId: ${pack.reportRunId}`);
  }
  if (pack.datasetId !== input.expectedDatasetId) {
    issues.push(`stale datasetId: ${pack.datasetId}`);
  }
  if (pack.sourceDatasetId !== input.expectedDatasetId) {
    issues.push(`stale sourceDatasetId: ${pack.sourceDatasetId}`);
  }

  // 4/5. All findingIds and evidenceRefs must exist.
  const knownFindings = new Set([
    ...input.bundle.findings.map((f) => f.findingId),
    ...(input.bundle.excludedFindingIds ?? []),
  ]);
  for (const slide of pack.slides) {
    for (const id of slide.findingIds) {
      if (!knownFindings.has(id)) issues.push(`unknown findingId on ${slide.slideId}: ${id}`);
    }
    for (const ref of slide.evidenceRefs) {
      if (!input.knownEvidenceRefs.has(ref)) {
        issues.push(`unknown evidenceRef on ${slide.slideId}: ${ref}`);
      }
    }
  }

  // 6. OTHER_SUBJECT never enters subject KPI slides.
  const otherSubjectIds = new Set(
    input.bundle.findings
      .filter((f) => f.subjectMatch === "OTHER_SUBJECT")
      .map((f) => f.findingId)
  );
  if (pack.fragmentKey !== "APPENDIX_MAIN") {
    for (const slide of pack.slides) {
      for (const id of slide.findingIds) {
        if (otherSubjectIds.has(id)) {
          issues.push(`OTHER_SUBJECT finding in subject KPI slide ${slide.slideId}: ${id}`);
        }
      }
    }
  }

  // 7. Client text within budgets; 8. no internal tokens; unsupported claims
  // guard: any narrative sentence naming a findingId must reference a known one
  // (covered by findingIds check + bullets carry [findingId] markers).
  for (const slide of pack.slides) {
    checkText(issues, slide.slideId, "title", slide.title, TEXT_BUDGETS.title);
    /*
     * Меряется абзац **страницы**, а не абзац построителя: проза находки
     * приклеивается к нему уже в нагрузке и добавляет сотни знаков. Пока
     * сверка смотрела на `content.narrative`, 416 знаков проходили, а на лист
     * уезжало 620 — и на живых прогонах лист перерастал ёмкость.
     */
    checkText(
      issues,
      slide.slideId,
      "narrative",
      pageNarrativeOf(
        slide.content,
        DECK_TEMPLATE_REGISTRY[slide.templateId as DeckTemplateId]?.rendererTemplate ?? ""
      ),
      narrativeBudgetOf(slide.templateId)
    );
    checkText(issues, slide.slideId, "whatWasFound", slide.content.whatWasFound, TEXT_BUDGETS.whatWasFound);
    checkText(issues, slide.slideId, "whyItMatters", slide.content.whyItMatters, TEXT_BUDGETS.whyItMatters);
    checkText(issues, slide.slideId, "whatToCheck", slide.content.whatToCheck, TEXT_BUDGETS.whatToCheck);
    for (const b of slide.content.bullets ?? []) {
      // AI answers are exempt from the bullet budget (no truncation allowed),
      // but never from the internal-token check.
      const budget = slide.templateId === "ai-overview" ? Number.MAX_SAFE_INTEGER : TEXT_BUDGETS.bullet;
      checkText(issues, slide.slideId, "bullet", b, budget);
    }
    // Адрес печатается ячейкой и проверяется вместе со строками. Поле полосы
    // читается только ради старых артефактов: живого входа у него нет.
    for (const cell of [
      ...(slide.content.table?.rows ?? []).flat(),
      ...(slide.content.table?.rowAddresses ?? []),
    ]) {
      if (matchInternalClientToken(stripFindingMarkers(cell))) {
        issues.push(`internal token in table cell on ${slide.slideId}: "${cell.slice(0, 60)}"`);
      }
    }
  }

  // 9. Local metrics reconcile.
  if (pack.metrics.adverseDisplayedCount > pack.metrics.adverseDatasetCount) {
    issues.push("metrics: adverseDisplayedCount > adverseDatasetCount");
  }
  if (pack.metrics.displayedCount > pack.metrics.datasetCount && pack.metrics.datasetCount > 0) {
    issues.push("metrics: displayedCount > datasetCount");
  }

  // 10. Continuation structure valid: each continuation references an earlier
  // base slide in the same pack and indexes are sequential.
  const baseIds = new Set(pack.slides.filter((s) => !s.isContinuation).map((s) => s.slideId));
  const contByBase = new Map<string, number[]>();
  for (const slide of pack.slides) {
    if (!slide.isContinuation) continue;
    if (!slide.continuationOf || !baseIds.has(slide.continuationOf)) {
      issues.push(`continuation ${slide.slideId} has no base slide in pack`);
      continue;
    }
    const list = contByBase.get(slide.continuationOf) ?? [];
    list.push(slide.continuationIndex ?? -1);
    contByBase.set(slide.continuationOf, list);
  }
  for (const [b, idx] of contByBase) {
    const sorted = [...idx].sort((a, z) => a - z);
    for (let i = 0; i < sorted.length; i += 1) {
      if (sorted[i] !== i + 1) {
        issues.push(`continuation indexes for ${b} not sequential: ${sorted.join(",")}`);
        break;
      }
    }
  }

  // Status/slide coherence.
  if (pack.status === "READY" && pack.slides.length === 0) {
    issues.push("READY pack has no slides");
  }
  if (pack.status === "EMPTY_VALID" && pack.slides.length > 0) {
    issues.push("EMPTY_VALID pack must not carry slides");
  }

  // 11. Sidebar scope subsets (fail closed): every slide's findingIds and
  // evidenceRefs must stay inside the fragment's own scoped inputs — no
  // fallback to global VerifiedFindingBundle findings or global domains.
  const inputFindingIds = new Set(pack.inputs.findingIds);
  const inputRefs = new Set(pack.inputs.evidenceRefs);
  for (const slide of pack.slides) {
    for (const id of slide.findingIds) {
      if (!inputFindingIds.has(id)) {
        issues.push(`sidebar findingId outside fragment scope on ${slide.slideId}: ${id}`);
      }
    }
    for (const ref of slide.evidenceRefs) {
      if (!inputRefs.has(ref)) {
        issues.push(`sidebar evidenceRef outside fragment scope on ${slide.slideId}: ${ref}`);
      }
    }
  }

  // 12. Page-scope domain derivation (fail closed): on page-scoped templates
  // every source domain named in the dynamic conclusion, source footer or
  // highlight explanations must be derivable from that slide's OWN evidence
  // refs — never from an unrelated global domain list.
  if (input.evidenceIndex && !REGION_SUMMARY_FRAGMENTS.has(pack.fragmentKey)) {
    /*
     * Продолжение наследует область своей базы.
     *
     * Ворота ходили по списку шаблонов, и лист «…: почему выделено» — новый тип
     * страницы — оказался вне проверки целиком, хотя доменов на нём больше, чем
     * на любом другом: цитаты и адреса первоисточников. Заводя новый шаблон,
     * обойти fail-closed проверку не должно быть возможно.
     */
    const pageScopedIds = new Set(
      pack.slides.filter((s) => PAGE_SCOPED_TEMPLATES.has(s.templateId)).map((s) => s.slideId)
    );
    for (const slide of pack.slides) {
      const ownScope = PAGE_SCOPED_TEMPLATES.has(slide.templateId);
      const inheritedScope =
        slide.isContinuation && slide.continuationOf
          ? pageScopedIds.has(slide.continuationOf)
          : false;
      if (!ownScope && !inheritedScope) continue;
      const normRefs = new Set(slide.evidenceRefs.map(normalizeEvidenceRef));
      const allowed = new Set<string>();
      const allowedLinks = new Set<string>();
      for (const [ref, e] of Object.entries(input.evidenceIndex)) {
        if (!normRefs.has(normalizeEvidenceRef(ref))) continue;
        if (e.domain && e.domain !== "—") allowed.add(normalizeDomainForCompare(e.domain));
        // Адрес — в той же форме, в какой его печатает отчёт: сверка идёт
        // строкой, а не разбором границ.
        const link = clientAddress(e.url);
        if (link) allowedLinks.add(link);
      }
      const dynamicTexts = [
        slide.content.whatWasFound,
        slide.content.sourceNote,
        ...(slide.content.highlightExplanations ?? []).map((h) => h.clientReason),
        // Текст продолжения живёт в буллетах — на базовой странице там лежат
        // цитаты доказательств, разбираемые своими проверками, поэтому в общий
        // разбор буллеты идут только у унаследованной области.
        ...(inheritedScope && !ownScope ? slide.content.bullets ?? [] : []),
      ].filter((t): t is string => Boolean(t));
      for (const text of dynamicTexts) {
        // Сверяется нормализованная форма: клиенту домен показывается читаемым
        // («руни.рф»), а в индексе доказательств он лежит в punycode. Без
        // приведения к одной форме читаемая запись выглядела бы «не
        // выведенной из доказательств» — той же ценой, что уже стоил обрезок
        // `xn--h1ajim.xn`: отказ обязательной секции и пустая дека.
        for (const domain of undeclaredClientTextDomains(text, allowed, allowedLinks)) {
          issues.push(
            `sidebar domain not derived from page evidence on ${slide.slideId}: ${domain}`
          );
        }
      }
    }
  }

  // 13. Утверждение «не найдено» не спорит с собственными наблюдениями отчёта.
  // 14. Фрагменты текста статьи печатаются только при подтверждённой
  //     принадлежности — по данным пака, а не по выводу построителя.
  if (input.evidenceIndex) {
    issues.push(...wikipediaDenialIssues(pack.slides, input.evidenceIndex));
    for (const slide of pack.slides) {
      const fragmentIssue = wikipediaFragmentOwnershipIssue(slide, input.evidenceIndex);
      if (fragmentIssue) issues.push(fragmentIssue);
    }
  }

  return { fragmentKey: pack.fragmentKey, passed: issues.length === 0, issues };
}

/**
 * Страница, чья проверка Википедии ничего не нашла, обязана назвать статью,
 * которая лежит в её же доказательствах.
 *
 * На прогоне 76 страница ОАЭ утверждала «статья в англоязычной Википедии не
 * найдена», а `en.wikipedia.org/wiki/Viktor_Rashnikov` стоял первой строкой
 * таблицы выдачи того же отчёта: проверка ушла кириллическим запросом. Признак
 * — данные страницы, а не слова: строка о субъекте в том же языковом разделе,
 * что и проверка. Проверяется независимо от построителя намеренно — ворота,
 * повторяющие его вывод, подтверждают сами себя.
 *
 * **Область — шаблон `wikipedia-check`, и только он.** Точнее говоря:
 * отрицание, у которого есть с чем спорить, печатает только эта страница.
 * Ту же фразу «Проверка по этому запросу статью не нашла» построитель уносит
 * на лист `coverage-empty-state` того же слота (ветка
 * `collectedRows === 0 && checkExists === false`),
 * но там в доказательствах лежит одна запись проверки — спорить не с чем, и
 * ворота молчали бы и без якоря. Держать на этом правило нельзя: состав
 * доказательств того листа решает чужой построитель, а якорь — здесь.
 *
 * Обратная сторона — лист, у которого спорить есть с чем, а отрицания он не
 * печатает. Региональное резюме по построению несёт доказательства **всего**
 * региона: область его фрагмента задана поверхностями таблицы покрытия вместе
 * с `wikipedia` и её маркерами «статья не найдена». О Википедии лист резюме
 * при этом не говорит ни слова, то есть адрес статьи в его тексте не окажется
 * никогда. 01.09.2026 одной `/wiki/`-строки полного тёзки с `SUBJECT_MATCH` в
 * наборе региона хватило, чтобы обязательная секция `UAE_SUMMARY` получила
 * `FAILED` и сборка деки остановилась целиком — при полностью оплаченном
 * сборе. Якорь тот же, которым ниже пользуются ворота принадлежности
 * фрагментов.
 *
 * **Единица суда — цепочка листов, а не лист.** Абзац этой страницы режется по
 * листам (`SILENTLY_CLIPPED_NARRATIVE_TEMPLATES`), продолжение наследует
 * доказательства базы целиком, а оговорка с адресом печатается один раз.
 * Поэтому адрес ищется в объединённом тексте цепочки, а отказ называет базовый
 * лист. Требовать адрес от каждого листа — значит ронять обязательную секцию на
 * её же честном тексте, как только страница переросла один лист.
 */
function wikipediaDenialIssues(
  slides: SectionPackV2["slides"],
  evidenceIndex: ScopedEvidenceIndex
): string[] {
  const chains = new Map<string, SectionPackV2["slides"]>();
  for (const slide of slides) {
    if (slide.templateId !== WIKIPEDIA_CHECK_TEMPLATE) continue;
    const baseSlideId = slide.continuationOf ?? slide.slideId;
    const chain = chains.get(baseSlideId);
    if (chain) chain.push(slide);
    else chains.set(baseSlideId, [slide]);
  }
  const issues: string[] = [];
  for (const [baseSlideId, chain] of chains) {
    // Доказательства собираются со всей цепочки на вырост: сегодня
    // `buildContinuationSlide` расстилает базу целиком, и продолжение несёт
    // ровно те же ссылки, так что база и объединение равны. Равенство держится
    // на чужом построителе, а не на правиле, поэтому спрашивается цепочка —
    // ровно то, что судится.
    const entries = [...new Set(chain.flatMap((s) => s.evidenceRefs))].map(
      (ref) => evidenceIndex[ref]
    );
    const checks = entries.filter((e) => e?.kind === "wikipedia_check");
    // Страница отрицает статью только там, где ни одна проверка её не нашла.
    if (checks.length === 0 || checks.some((e) => e?.wikipediaExists === true)) continue;
    const deniedDomains = new Set(
      checks
        .filter((e) => e?.wikipediaExists === false)
        .map((e) =>
          String(e?.language ?? "")
            .toLowerCase()
            .split(/[-_]/u)[0]
        )
        .filter(Boolean)
        .map((language) => `${language}.wikipedia.org`)
    );
    if (deniedDomains.size === 0) continue;
    const text = chain
      .flatMap((slide) => [
        slide.content.narrative,
        slide.content.whatWasFound,
        slide.content.whyItMatters,
        slide.content.whatToCheck,
        slide.content.sourceNote,
        ...(slide.content.bullets ?? []),
      ])
      .filter(Boolean)
      .join(" ");
    const unnamed = entries
      .filter(
        (e) =>
          e?.kind !== "wikipedia_check" &&
          e?.subjectDecision === "SUBJECT_MATCH" &&
          deniedDomains.has(String(e?.domain ?? "").toLowerCase()) &&
          /\/wiki\//u.test(String(e?.url ?? ""))
      )
      // Игла — ровно то, что печатает построитель в предложении о статье
      // (`identity.ts`): полный адрес, а если разобрать нечего — площадка.
      // Обрезок в полном адресе не находится, и ворота роняли бы обязательную
      // секцию на здоровом тексте.
      .map((e) => clientAddress(e!.url) ?? String(e!.domain))
      .filter((link) => !text.includes(link));
    if (unnamed.length > 0) {
      issues.push(
        `wikipedia denial contradicts page evidence on ${baseSlideId}: ${unnamed.join(", ")}`
      );
    }
  }
  return issues;
}

/**
 * Фрагмент текста статьи — это негатив о ком-то.
 *
 * Пока не доказано, что статья о проверяемом лице, такой фрагмент работал бы на
 * чужой профиль (правило шага AG). Построитель эту ветку закрывает, но ворота
 * повторяют проверку по данным слайда: проверка, читающая вывод построителя,
 * подтверждает сама себя. Признак фрагмента — метка категории, та же, которой
 * его печатают.
 */
function wikipediaFragmentOwnershipIssue(
  slide: SectionPackV2["slides"][number],
  evidenceIndex: ScopedEvidenceIndex
): string | null {
  /*
   * Признак держится на шаблоне страницы, а не на одной метке.
   *
   * «Требует проверки: …» — общеупотребительная фраза: статус ручного ревью,
   * уровень риска, подпись в комплаенсе. Пока признаком служила только она,
   * любой такой буллет на чужом слайде отклонял бы обязательную секцию — то
   * есть деку целиком.
   */
  if (slide.templateId !== WIKIPEDIA_CHECK_TEMPLATE) return null;
  const labels = Object.values(WIKIPEDIA_FRAGMENT_CATEGORY_LABELS);
  const fragments = (slide.content.bullets ?? []).filter((b) =>
    labels.some((label) => String(b ?? "").startsWith(`${label}: `))
  );
  if (fragments.length === 0) return null;
  // Спрашивается принадлежность **той** записи, о которой страница печатает, —
  // выбор общий с построителем. «Хоть одна подтверждённая» позволяла бы записи
  // «статьи нет» оправдывать фрагменты неподтверждённой найденной статьи.
  const printed = pickWikipediaCheckEntry(
    slide.evidenceRefs
      .map((ref) => evidenceIndex[ref])
      .filter((e): e is NonNullable<typeof e> => e?.kind === "wikipedia_check")
  );
  return printed?.subjectDecision === "SUBJECT_MATCH"
    ? null
    : `wikipedia article fragments without confirmed ownership on ${slide.slideId}: ${fragments.length}`;
}

/** Одна форма домена для сверки: нижний регистр, без `www.`, punycode. */
export function normalizeDomainForCompare(domain: string): string {
  const d = String(domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^www\./u, "");
  if (!d) return "";
  return domainToASCII(d) || d;
}

function stripFindingMarkers(text: string): string {
  return (
    text
      .replace(/\[finding-[^\]]+\]/gu, "")
      // Domains from evidence URLs are legitimate client-facing content
      // (e.g. audit-it.ru); the technical-token check must not match them.
      .replace(/\b[\w-]+(?:\.[\w-]+)+\b/gu, "")
  );
}

function checkText(
  issues: string[],
  slideId: string,
  field: string,
  value: string | undefined,
  budget: number
): void {
  if (!value) return;
  if (value.length > budget) {
    issues.push(`${field} over budget on ${slideId}: ${value.length}>${budget}`);
  }
  if (matchInternalClientToken(stripFindingMarkers(value))) {
    issues.push(`internal token in ${field} on ${slideId}: "${value.slice(0, 60)}"`);
  }
}
