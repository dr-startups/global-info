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

import { CLIENT_RISK_LABELS, riskLabel } from "@/modules/digital-profile/orion-golden/client/risk-scale";
import { formatCheckDate, materialsText, themesInText } from "./format";
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
