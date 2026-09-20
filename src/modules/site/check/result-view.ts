/**
 * Экран результата из ответа ручки: шкала, заголовок, сводка, группы плашек,
 * ответы источников.
 *
 * Экран не приписывает материалам тем, о которых ручка не знает. `materialsFound`
 * — различные негативные материалы, счёт темы — материалы темы, и материал бывает
 * в двух темах и без темы (решение владельца 15.09: негатив без темы каталога —
 * тоже «негатив найден»). Макет пишет «4 материала в 2 темах» — это правда, только
 * пока счёты тем покрывают все материалы.
 */

import { CLIENT_RISK_LABELS, riskLabel, riskWord } from "@/modules/digital-profile/orion-golden/client/risk-scale";
import { RESULT_TEXT } from "@/modules/site/content/check";
import { formatCheckDate, materialsText, plural, themesInText } from "./format";
import type { ResultJson, RiskStep } from "./types";

export type { ResultJson } from "./types";

export type RiskTone = RiskStep | "none";

export interface ScaleView {
  tone: RiskTone;
  /** Сколько делений из трёх закрашено. */
  filled: number;
  word: string | null;
  labels: readonly string[];
  ariaLabel: string;
}

export interface TextPart {
  text: string;
  strong?: boolean;
}

export interface FindingGroup {
  /** `null` — материалы без названия темы. */
  label: string | null;
  countText: string;
  /** Закрашенных строк; число материалов целиком — в `countText`. */
  bars: number;
}

export interface LedgerRow {
  name: string;
  value: string | null;
  tone: "ok" | "warn";
}

export interface ResultView {
  verdict: string;
  scale: ScaleView;
  title: { word: string | null; text: string };
  summary: TextPart[];
  groups: FindingGroup[];
  ledger: LedgerRow[];
  partialNote: string | null;
  checkedAtText: string | null;
}

const STEPS: readonly RiskStep[] = ["low", "medium", "high"];
const ORDINALS = ["первый", "второй", "третий"] as const;
/** Слова шкалы снизу вверх; ступеней три, как в отчёте (`risk-scale.ts`). */
const SCALE_LABELS: readonly string[] = [...CLIENT_RISK_LABELS].reverse();

/** Строк плашек в группе не больше: список из сорока полос ничего не добавляет к числу. */
const MAX_BARS = 8;

export function scaleView(level: RiskStep | null): ScaleView {
  const index = level ? STEPS.indexOf(level) : -1;
  if (index < 0) {
    return { tone: "none", filled: 0, word: null, labels: SCALE_LABELS, ariaLabel: "Шкала риска: уровень не определён" };
  }
  return {
    tone: STEPS[index]!,
    filled: index + 1,
    word: riskLabel(STEPS[index]!),
    labels: SCALE_LABELS,
    ariaLabel: `Шкала риска: ${ORDINALS[index]} уровень из трёх`,
  };
}

/**
 * Показание дугой — та же шкала из трёх ступеней, согнутая в дугу прибора.
 *
 * Стрелка стоит против середины закрашенной ступени. Углы взяты из дуг макета
 * (`240×134`, центр 120×126): ступень занимает по 57.34°, между ними просветы,
 * и середины приходятся на 151.33°, 90° и 28.67° — стрелка отсчитывает от левого
 * конца, поэтому угол поворота дополняет их до 180°.
 */
export const DIAL_POINTER_ANGLES = [28.67, 90, 151.33] as const;

export interface DialView {
  tone: RiskTone;
  /** Сколько дуг из трёх горит. */
  filled: number;
  /** Поворот стрелки в градусах; `null` — уровня нет, стрелки тоже. */
  pointerAngle: number | null;
  /** Число внутри дуги: материалы или прочерк. */
  num: string;
  unit: string;
  labels: readonly string[];
  /** Какая подпись ступени — текущая; `-1` — никакая. */
  levelIndex: number;
  ariaLabel: string;
}

export function dialView(result: ResultJson): DialView {
  const scale = scaleView(result.riskLevel);
  const known = result.verdict === "NEGATIVE_FOUND" || result.verdict === "CLEAN";
  const found = result.verdict === "NEGATIVE_FOUND";
  return {
    tone: scale.tone,
    filled: scale.filled,
    pointerAngle: scale.filled > 0 ? DIAL_POINTER_ANGLES[scale.filled - 1]! : null,
    num: known ? String(result.materialsFound) : "—",
    unit: known ? plural(result.materialsFound, ["материал", "материала", "материалов"]) : "нет данных",
    labels: scale.labels,
    levelIndex: scale.filled - 1,
    ariaLabel: known
      ? `${scale.ariaLabel}. ${found ? `Найдено ${materialsText(result.materialsFound)}` : "Негативных материалов не найдено"}`
      : scale.ariaLabel,
  };
}

export interface ThemeRow {
  id: string;
  label: string;
  /** «высокий уровень»; `null` — уровня у темы нет. */
  levelText: string | null;
  tone: RiskTone;
  countText: string;
  /** Доля полосы: тема против самой большой темы результата. */
  fraction: number;
  /** Строки скрытых заголовков — ровно то, что честно сказать о материале. */
  hidden: string[];
}

/**
 * Темы результата строками. Заголовков находок ручка не отдаёт, поэтому в
 * раскрытой теме стоят не выдуманные заголовки, а прямая фраза о том, что
 * заголовок скрыт; фразы разные, чтобы строки не читались одной повторённой.
 */
export function themeRows(result: ResultJson): ThemeRow[] {
  if (result.verdict !== "NEGATIVE_FOUND") return [];
  const groups =
    result.themes.length > 0
      ? result.themes.map((theme) => ({
          id: theme.id,
          label: theme.label,
          level: theme.level,
          count: theme.count,
        }))
      : [{ id: "no-theme", label: RESULT_TEXT.noTheme, level: null, count: result.materialsFound }];
  const max = Math.max(...groups.map((group) => group.count), 1);
  let line = 0;
  return groups.map((group) => ({
    id: group.id,
    label: group.label,
    levelText: group.level ? `${riskWord(group.level)} уровень` : null,
    tone: group.level ?? "none",
    countText: materialsText(group.count),
    fraction: group.count / max,
    hidden: Array.from(
      { length: Math.min(group.count, MAX_BARS) },
      () => RESULT_TEXT.hiddenTitles[line++ % RESULT_TEXT.hiddenTitles.length]!
    ),
  }));
}

export interface AnsweredView {
  answered: number;
  total: number;
  fraction: number;
}

/**
 * Группы источников списком без подробностей — под показанием на «найдено»:
 * там важно, кого спросили, а что именно ответил каждый, говорят темы.
 */
export function answeredLedger(sourcesChecked: readonly string[]): LedgerRow[] {
  const checked = new Set(sourcesChecked);
  return SOURCE_GROUPS.map((group) => ({
    name: group.name,
    value: null,
    tone: checked.has(group.id) ? ("ok" as const) : ("warn" as const),
  }));
}

/** «Ответили 2 из 4» — и столько же хода по верхней кромке доски. */
export function sourcesAnswered(sourcesChecked: readonly string[]): AnsweredView {
  const checked = new Set(sourcesChecked);
  const answered = SOURCE_GROUPS.filter((group) => checked.has(group.id)).length;
  return { answered, total: SOURCE_GROUPS.length, fraction: answered / SOURCE_GROUPS.length };
}

const SOURCE_GROUPS = [
  { id: "search", name: "Поисковая выдача", inText: "поисковая выдача", clean: "первые страницы" },
  { id: "surfaces", name: "Картинки, видео и подсказки", inText: "картинки, видео и подсказки", clean: null },
  {
    id: "open_sources",
    name: "Открытые источники",
    inText: "открытые источники",
    clean: "энциклопедии, справочники, публичные профили",
  },
  { id: "sanctions", name: "Санкционные и PEP-списки", inText: "санкционные и PEP-списки", clean: "совпадений нет" },
] as const;

const NEGATIVE_LEAD = "Найдены материалы, которые могут нанести ущерб репутации: ";

function negativeSummary(result: ResultJson): TextPart[] {
  const materials = { text: materialsText(result.materialsFound), strong: true };
  const themes = result.themes.length;
  if (themes === 0) {
    return [{ text: NEGATIVE_LEAD }, materials, { text: "; тему для них определить не удалось." }];
  }
  const counted = result.themes.reduce((sum, theme) => sum + theme.count, 0);
  if (counted < result.materialsFound) {
    return [{ text: NEGATIVE_LEAD }, materials, { text: "; темы определены не для всех." }];
  }
  return [{ text: NEGATIVE_LEAD }, materials, { text: " в " }, { text: themesInText(themes), strong: true }, { text: "." }];
}

function negativeGroups(result: ResultJson): FindingGroup[] {
  if (result.themes.length === 0) {
    return [
      { label: null, countText: materialsText(result.materialsFound), bars: Math.min(result.materialsFound, MAX_BARS) },
    ];
  }
  return result.themes.map((theme) => ({
    label: theme.label,
    countText: materialsText(theme.count),
    bars: Math.min(theme.count, MAX_BARS),
  }));
}

function cleanLedger(checked: ReadonlySet<string>): LedgerRow[] {
  return SOURCE_GROUPS.map((group) =>
    checked.has(group.id)
      ? { name: group.name, value: group.clean, tone: "ok" as const }
      : { name: group.name, value: "нет ответа", tone: "warn" as const }
  );
}

function insufficientLedger(checked: ReadonlySet<string>): LedgerRow[] {
  return SOURCE_GROUPS.map((group) => {
    if (checked.has(group.id)) return { name: group.name, value: "ответ получен", tone: "ok" as const };
    const value = group.id === "search" ? "нет ответа — это основной источник проверки" : "нет ответа";
    return { name: group.name, value, tone: "warn" as const };
  });
}

function partialNote(checked: ReadonlySet<string>): string {
  const names = SOURCE_GROUPS.filter((group) => checked.has(group.id)).map((group) => group.inText);
  return names.length > 0
    ? `Часть источников не ответила. Проверены: ${names.join(", ")}.`
    : "Часть источников не ответила.";
}

export function resultView(result: ResultJson, options: { timeZone?: string } = {}): ResultView {
  const checked = new Set(result.sourcesChecked);
  const checkedAtText = result.checkedAt ? `Проверка от ${formatCheckDate(result.checkedAt, options.timeZone)}` : null;

  if (result.verdict === "NEGATIVE_FOUND" || result.verdict === "CLEAN") {
    const scale = scaleView(result.riskLevel);
    const negative = result.verdict === "NEGATIVE_FOUND";
    return {
      verdict: result.verdict,
      scale,
      title: scale.word ? { word: scale.word, text: "уровень риска" } : { word: null, text: "Уровень риска не определён" },
      summary: negative
        ? negativeSummary(result)
        : [{ text: "Негативных материалов не найдено ни в одном из проверенных источников." }],
      groups: negative ? negativeGroups(result) : [],
      ledger: negative ? [] : cleanLedger(checked),
      partialNote: result.partial ? partialNote(checked) : null,
      checkedAtText,
    };
  }

  // «Данных недостаточно»: причина называется по тому, ответил ли поиск.
  const reason = checked.has("search")
    ? "поисковая выдача не вернула материалов по этому имени."
    : "не ответила поисковая выдача — основной источник проверки.";
  return {
    verdict: result.verdict,
    scale: scaleView(null),
    title: { word: null, text: "Уровень риска не определён" },
    summary: [{ text: `Недостаточно данных для заключения: ${reason}` }],
    groups: [],
    ledger: insufficientLedger(checked),
    partialNote: null,
    checkedAtText,
  };
}
