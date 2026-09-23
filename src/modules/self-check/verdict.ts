/**
 * Вердикт лёгкого прогона — тем же ответом, что у отчёта.
 *
 * Решение владельца 15.09.2026: негатив материала — предикат строки отчёта
 * (`resolveItemAdverse`), тема — каталог тем отчёта, уровень темы — правило
 * отчёта. Сводка аудита, на которой строило вердикт ТЗ, ставит средний уровень
 * каждому без статьи в Википедии, и «мы нашли материалы» получил бы почти
 * каждый посетитель при нуле материалов. Своего словаря и своих порогов здесь
 * нет — только то, что относится к посетителю: какие темы показать и что
 * значит «данных недостаточно».
 *
 * Страниц лёгкий прогон не читает: материал судится по заголовку и сниппету
 * выдачи. Принадлежность субъекту — тоже ответом отчёта (классификатор
 * принадлежности), поэтому полного тёзку с тем же ФИО он не отличает; об этом
 * говорит дисклеймер экрана результата.
 */

import type { ThemeDef } from "@/modules/digital-profile/config/finding-themes";
import { getFindingThemes } from "@/modules/digital-profile/config/finding-themes";
import { resolveItemAdverse } from "@/modules/digital-profile/orion-golden/analytics/item-adverse";
import { riskFor, themesFor } from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import {
  buildSubjectResolution,
  type SubjectIdentity,
} from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import { serpMaterialKey } from "@/modules/digital-profile/serp-observation/material-key";

/**
 * Версия правила вердикта: пишется в запись рядом с результатом.
 *
 * v2 — считаются только материалы о субъекте: запись v1 по тому же делу могла
 * назвать негативом чужие материалы, и различать их надо по записи.
 */
export const LIGHT_VERDICT_SOURCE = "light-verdict-v2";

export type SelfCheckVerdict = "NEGATIVE_FOUND" | "CLEAN" | "INSUFFICIENT_DATA";

/** Группы источников — так их называет экран результата. */
export type SourceGroup = "search" | "surfaces" | "open_sources" | "sanctions";

export interface LightVerdictInput {
  /** Материалы — теми же адаптерами, что у подготовки отчёта. */
  items: readonly RawInventoryItem[];
  /** Итог базового сбора по провайдерам (`actualProviders` джобы). */
  providers: ReadonlyArray<{ providerId: string; status: string; runtime?: string }>;
  /** Последний скрининг по каждой базе (`resolveComplianceScreenings`). */
  screenings: ReadonlyArray<{ provider: string; status: string }>;
  /** Кого проверяем — профиль дела, тот же, что у классификатора отчёта. */
  subject: SubjectIdentity;
}

export interface VerdictTheme {
  id: string;
  label: string;
  /** Негативных материалов в теме. */
  count: number;
  /** Уровень данных (`none` … `critical`); ступенью печати его делает проекция. */
  level: string;
}

export interface LightVerdict {
  verdict: SelfCheckVerdict;
  /** Уровень данных; у «данных недостаточно» уровня нет. */
  riskLevel: string | null;
  materialsFound: number;
  /** Показанных тем — в отчёте находка и есть тема. */
  findingsTotal: number;
  themes: VerdictTheme[];
  partial: boolean;
  sourcesChecked: SourceGroup[];
  source: typeof LIGHT_VERDICT_SOURCE;
}

/**
 * Подписи тем для посетителя — утверждённый макет и приложение A ТЗ. Тема без
 * подписи сайта (из файла переопределения каталога) печатается подписью каталога.
 */
export const SITE_THEME_LABELS: Readonly<Record<string, string>> = {
  security_scrutiny: "Санкции и ограничения по линии безопасности",
  criminal_legal: "Суд и криминал",
  pep_rca_watchlist: "Санкционные и PEP-списки",
  political_exposure: "Политика и публичность",
  offshore_structures: "Офшоры",
  corporate_ownership: "Корпоративное владение",
  family_associates: "Семья и связи",
  financial_claims: "Финансовые претензии и долги",
};

/** Поисковые провайдеры: ответил хотя бы один — вывод по выдаче возможен. */
const SEARCH_PROVIDERS: readonly string[] = ["yandex", "google", "orion_profile"];

/**
 * Группа источников проверена, если ответил хотя бы один её провайдер.
 *
 * Картинки, видео и подсказки ищет `orion_google_surfaces`. Провайдер `surfaces`
 * в сеть не ходит — его агент записывает, что умеют провайдеры, — и его
 * «завершился» не значит, что поверхности кто-то искал.
 */
const SOURCE_GROUP_PROVIDERS: ReadonlyArray<readonly [SourceGroup, readonly string[]]> = [
  ["search", SEARCH_PROVIDERS],
  ["surfaces", ["orion_google_surfaces"]],
  ["open_sources", ["wikipedia"]],
];

/** Сетевые провайдеры базового сбора: отказ любого делает результат неполным. */
const COLLECTION_PROVIDERS = new Set(SOURCE_GROUP_PROVIDERS.flatMap(([, ids]) => ids));

const FAILED_PROVIDER_STATUSES = new Set(["failed", "unavailable"]);

/** Типы риска записи комплаенса, которые посетитель видит темой санкционных и PEP-списков. */
const SANCTIONS_RISK_TYPE = /SANCTION|PEP|RCA|WATCHLIST/iu;

const COMPLIANCE_THEME_ID = "pep_rca_watchlist";

const LEVEL_RANK: Readonly<Record<string, number>> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

/**
 * Ответил ли провайдер о человеке. Демо-агент ответом не считается: его строки в
 * материалы не попадают (как и в отчёт), и без этого условия демо-сбор выглядел бы
 * проверкой, которая ничего не нашла.
 */
function providerAnswered(p: { status: string; runtime?: string }): boolean {
  return p.status === "completed" && p.runtime !== "mock";
}

/**
 * Материал выдачи — наблюдение слияния с настоящим адресом.
 *
 * Адрес обязателен: агент поверхностей пишет заметки «что умеет провайдер» без
 * адреса, слияние пропускает их как наблюдения, и приёмка на стенде 15.09 получила
 * «чисто» при нуле настоящих материалов. Для тем и негатива заметки и подсказки
 * по-прежнему проходят — это вопрос только о том, есть ли на чём судить.
 */
function isSerpMaterial(item: RawInventoryItem): boolean {
  return item.source === "serp_observation" && /^https?:\/\//iu.test(item.sourceUrl ?? "");
}

/**
 * Совпадение комплаенса — негатив в теме санкционных и PEP-списков.
 *
 * Словарь темы читает заголовок, а заголовок записи комплаенса — имя человека:
 * по нему тема не назначится никогда. Тип риска записи структурный, и сайт
 * говорит ровно то, что обещает главная: «запись с вашим именем в санкционном
 * списке или в списке политически значимых лиц». Совпадение при этом не
 * подтверждается — запись остаётся у аналитика в `PENDING`.
 */
function isSanctionsHit(item: RawInventoryItem): boolean {
  if (item.evidenceType !== "compliance_hit") return false;
  const riskTypes = (item.rawMetadata as { riskTypes?: unknown } | undefined)?.riskTypes;
  return Array.isArray(riskTypes) && riskTypes.some((type) => SANCTIONS_RISK_TYPE.test(String(type)));
}

/**
 * Негативен ли материал — ответом строки отчёта, кроме записи комплаенса.
 *
 * Запись комплаенса судится только типом риска. Для строки выдачи площадка
 * санкционного реестра — негатив сама по себе, а адрес записи комплаенса и есть
 * такая площадка: предикат строки сделал бы негативом любую запись базы, в том
 * числе без санкционного и PEP-типа, — а совпадение по комплаенсу автоматически не
 * подтверждается.
 */
function isAdverseMaterial(item: RawInventoryItem): boolean {
  return item.evidenceType === "compliance_hit" ? isSanctionsHit(item) : resolveItemAdverse(item);
}

/**
 * Материалы о субъекте — ответом классификатора принадлежности отчёта.
 *
 * Первый живой прогон 23.09.2026: непубличный человек получил «критический»
 * уровень по материалам о людях с другим отчеством и по служебным страницам
 * «Внимание, розыск!» без ФИО — вердикт спрашивал «негатив ли это», но не «о нём
 * ли это». Решение владельца: в счёт идёт материал, где названы фамилия и имя, а
 * отчество, если названо, совпадает. Это ровно `SUBJECT_MATCH` классификатора: и
 * в отчёте на показатели «о субъекте» влияет только он, а одна фамилия выше
 * `LIKELY_SUBJECT` не поднимается. Своего сопоставления имён здесь нет — был бы
 * второй ответ на вопрос, о ком материал.
 *
 * Запись комплаенса отсюда не судится: её имя и дату рождения сверяет база, и
 * совпадение остаётся у аналитика в `PENDING` (`isSanctionsHit`).
 */
function subjectMaterialRefs(items: readonly RawInventoryItem[], subject: SubjectIdentity): Set<string> {
  const judged = items.filter((item) => item.evidenceType !== "compliance_hit");
  if (judged.length === 0) return new Set();
  const resolution = buildSubjectResolution({
    caseId: judged[0].caseId,
    datasetId: LIGHT_VERDICT_SOURCE,
    subject,
    items: judged,
    sourceHashes: [],
  });
  return new Set(
    resolution.items.filter((r) => r.decision === "SUBJECT_MATCH").map((r) => r.evidenceRef)
  );
}

function isAboutSubject(item: RawInventoryItem, subjectRefs: ReadonlySet<string>): boolean {
  return item.evidenceType === "compliance_hit" || subjectRefs.has(`inventory:${item.inventoryId}`);
}

/**
 * Ключ материала. Запись без адреса материалом ни с кем не делится — то же
 * правило, что у ключа материала аналитики (`item-adverse.ts`): иначе три базы с
 * одним именем стали бы одним совпадением.
 */
function materialKey(item: RawInventoryItem): string {
  return item.sourceUrl
    ? serpMaterialKey({ url: item.sourceUrl, title: item.title }, item.inventoryId)
    : item.inventoryId;
}

export function lightVerdict(input: LightVerdictInput): LightVerdict {
  const answered = (ids: readonly string[]) =>
    input.providers.some((p) => ids.includes(p.providerId) && providerAnswered(p));
  const screened = input.screenings.some((s) => s.status === "SUCCESS");
  const sourcesChecked: SourceGroup[] = SOURCE_GROUP_PROVIDERS.filter(([, ids]) => answered(ids)).map(
    ([group]) => group
  );
  if (screened) sourcesChecked.push("sanctions");
  const partial =
    !screened ||
    input.providers.some(
      (p) => COLLECTION_PROVIDERS.has(p.providerId) && FAILED_PROVIDER_STATUSES.has(p.status)
    );
  const common = { partial, sourcesChecked, source: LIGHT_VERDICT_SOURCE } as const;

  if (!input.items.some(isSerpMaterial) || !answered(SEARCH_PROVIDERS)) {
    return {
      verdict: "INSUFFICIENT_DATA",
      riskLevel: null,
      materialsFound: 0,
      findingsTotal: 0,
      themes: [],
      ...common,
    };
  }

  const complianceTheme = getFindingThemes().find((t) => t.themeId === COMPLIANCE_THEME_ID) ?? null;
  // Негатив считается по всем материалам, с темой и без (решение владельца после
  // приёмки 15.09): строку, которую отчёт красит негативной, сайт чистой не
  // называет. Темы только называют посетителю, о чём материалы.
  const negative = new Set<string>();
  // Тема → материалы темы, у каждого — негативен ли он.
  const byTheme = new Map<string, { theme: ThemeDef; materials: Map<string, boolean> }>();
  const subjectRefs = subjectMaterialRefs(input.items, input.subject);
  for (const item of input.items) {
    // Чужой материал не входит ни в негатив, ни в знаменатель темы.
    if (!isAboutSubject(item, subjectRefs)) continue;
    const key = materialKey(item);
    const adverse = isAdverseMaterial(item);
    // Тема без базового уровня (деловой профиль) описывает, а не предупреждает:
    // посетителю её не показывают, и признак живёт в каталоге, а не списком здесь.
    const themes = themesFor(item, false).filter((theme) => theme.baseRisk !== "none");
    if (isSanctionsHit(item) && complianceTheme && !themes.some((t) => t.themeId === complianceTheme.themeId)) {
      themes.push(complianceTheme);
    }
    if (adverse) negative.add(key);
    for (const theme of themes) {
      const entry = byTheme.get(theme.themeId) ?? { theme, materials: new Map<string, boolean>() };
      entry.materials.set(key, (entry.materials.get(key) ?? false) || adverse);
      byTheme.set(theme.themeId, entry);
    }
  }

  const themes: VerdictTheme[] = [];
  for (const { theme, materials } of byTheme.values()) {
    const adverseCount = [...materials.values()].filter(Boolean).length;
    if (adverseCount === 0) continue;
    themes.push({
      id: theme.themeId,
      label: SITE_THEME_LABELS[theme.themeId] ?? theme.label,
      count: adverseCount,
      level: riskFor(theme, adverseCount, materials.size),
    });
  }
  themes.sort(
    (a, b) =>
      (LEVEL_RANK[b.level] ?? 0) - (LEVEL_RANK[a.level] ?? 0) || b.count - a.count || a.id.localeCompare(b.id)
  );

  if (negative.size === 0) {
    return { verdict: "CLEAN", riskLevel: "low", materialsFound: 0, findingsTotal: 0, themes: [], ...common };
  }
  return {
    verdict: "NEGATIVE_FOUND",
    // Негатив без показываемой темы — уровень, который `riskFor` даёт негативу в
    // теме без базового уровня: «low».
    riskLevel: themes[0]?.level ?? "low",
    materialsFound: negative.size,
    findingsTotal: themes.length,
    themes,
    ...common,
  };
}
