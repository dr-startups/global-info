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
