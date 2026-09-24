/**
 * Шаг «Кто из них вы?»: подписи карточек и ответы источников словами.
 *
 * Пустая панель без объяснения читается как сбой сайта, а не как честное «таких
 * упоминаний нет», поэтому у каждого источника названо, что с ним было. Порядок
 * источников постоянный, как в макете, а не порядок ответа ручки.
 */

import { formatBirthDate } from "./format";
import type { PersonaCardJson, PersonaSourceJson, PersonaSourceName } from "./types";

export type { PersonaCardJson, PersonaSourceJson, PersonaPanelJson } from "./types";

export interface PersonaLedgerRow {
  name: string;
  value: string;
  tone: "ok" | "warn" | "off";
}

const SOURCE_ORDER: readonly PersonaSourceName[] = ["wikipedia", "knowledge_graph", "opensanctions"];

const SOURCE_NAMES: Readonly<Record<PersonaSourceName, string>> = {
  wikipedia: "Открытые источники",
  knowledge_graph: "Панель знаний Google",
  opensanctions: "Санкционные списки",
};

const CARD_LABELS: Readonly<Record<PersonaSourceName, string>> = {
  wikipedia: "Энциклопедия",
  knowledge_graph: "Панель знаний Google",
  opensanctions: "Санкционные списки",
};

export function cardSourceLabel(source: PersonaSourceName): string {
  return CARD_LABELS[source];
}

function ledgerValue(source: PersonaSourceJson, cards: readonly PersonaCardJson[]): Omit<PersonaLedgerRow, "name"> {
  switch (source.status) {
    case "ok":
      return {
        value: cards.some((card) => card.source === source.source) ? "ответ получен" : "совпадений нет",
        tone: "ok",
      };
    case "not_configured":
      return { value: "не подключена в этой проверке", tone: "off" };
    case "timeout":
      return { value: "ответ не пришёл вовремя — проверка всё равно продолжится", tone: "warn" };
    default:
      return { value: "ответа нет — проверка всё равно продолжится", tone: "warn" };
  }
}

export function personaLedger(
  sources: readonly PersonaSourceJson[],
  cards: readonly PersonaCardJson[]
): PersonaLedgerRow[] {
  return SOURCE_ORDER.flatMap((name) => {
    const source = sources.find((s) => s.source === name);
    return source ? [{ name: SOURCE_NAMES[name], ...ledgerValue(source, cards) }] : [];
  });
}

/**
 * Три источника панели, названные до первого ответа: пока панель собирается,
 * экран поиска показывает, куда ушли запросы. Состояния по отдельным источникам
 * ручка при сборке не отдаёт, поэтому у всех трёх сказано одно — «запрос
 * отправлен», и выдумывать «ответил» нечем.
 */
export const PERSONA_SOURCE_ROWS: ReadonlyArray<{ source: PersonaSourceName; name: string }> = SOURCE_ORDER.map(
  (source) => ({ source, name: SOURCE_NAMES[source] })
);

export interface PersonaTrailRow {
  source: PersonaSourceName;
  name: string;
  state: string;
  /** Отметка в строке следа: число совпадений, «0», «!» или прочерк. */
  mark: string;
  tone: "hit" | "none" | "warn" | "off";
}

const TRAIL_MARK: Readonly<Record<Exclude<PersonaTrailRow["tone"], "hit">, string>> = {
  none: "0",
  warn: "!",
  off: "—",
};

/**
 * След поиска: те же слова, что в панели ответов, плюс отметка справа.
 *
 * Не подключённый источник получает прочерк, а не ноль: ноль значил бы «искали и
 * не нашли», а искать было нечем.
 */
export function personaTrailRows(
  sources: readonly PersonaSourceJson[],
  cards: readonly PersonaCardJson[]
): PersonaTrailRow[] {
  return SOURCE_ORDER.flatMap((name) => {
    const source = sources.find((s) => s.source === name);
    if (!source) return [];
    const { value, tone } = ledgerValue(source, cards);
    const hits = cards.filter((card) => card.source === name).length;
    const trailTone: PersonaTrailRow["tone"] = tone === "ok" ? (hits > 0 ? "hit" : "none") : tone;
    return [
      {
        source: name,
        name: SOURCE_NAMES[name],
        state: value,
        mark: trailTone === "hit" ? String(hits) : TRAIL_MARK[trailTone],
        tone: trailTone,
      },
    ];
  });
}

/**
 * Отметка «Это я» на карточке: повторное нажатие снимает.
 *
 * Карточек одного человека бывает несколько — статья Википедии и запись
 * санкционной базы у публичного лица (предложение владельца 24.09.2026), —
 * поэтому нажатие отмечает, а запускает проверку отдельная кнопка.
 */
export function togglePickedCard(picked: readonly string[], cardId: string): string[] {
  return picked.includes(cardId) ? picked.filter((id) => id !== cardId) : [...picked, cardId];
}

const sentence = (text: string) => (/[.!?…]$/u.test(text) ? text : `${text}.`);

/**
 * Текст карточки. У санкционной карточки описание ручки — отметки базы, а не
 * рассказ о человеке, поэтому текст называет базу и дату рождения в карточке:
 * по ней посетитель и отличает себя от полного тёзки.
 */
export function personaCardText(card: PersonaCardJson): string {
  if (card.source !== "opensanctions") return card.description ?? "";
  const base = sentence(
    card.description ? `Карточка в открытой базе OpenSanctions: ${card.description}` : "Карточка в открытой базе OpenSanctions"
  );
  if (card.birthDates.length === 0) return base;
  return `${base} Дата рождения в карточке: ${card.birthDates.map(formatBirthDate).join(", ")}.`;
}

/** Совпадение даты рождения структурно известно только санкционной карточке. */
export function personaCardMatchNote(card: PersonaCardJson): string | null {
  return card.source === "opensanctions" && card.birthDateMatches ? "Дата рождения совпадает с вашей" : null;
}
