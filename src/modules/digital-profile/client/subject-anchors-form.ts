/**
 * Форма признаков субъекта: разбор строк оператора и предупреждения до траты.
 *
 * Признак — это то, чем субъект отличается от полного тёзки: где работает, кем,
 * когда родился, какой у него ИНН. Прогон DPA-2026-0049 показал цену вопроса
 * без признаков: 585 материалов «о субъекте» принадлежали четырём разным людям,
 * а оператор в панели персон честно ответил «различимой персоны нет» — назвать
 * ему было нечего, панель об этом не спрашивала.
 *
 * Логика формы живёт отдельным модулем, а не в разметке: её можно проверить
 * исполнением. Слов для человека здесь нет — только ключи словаря.
 */

import {
  anchorPhraseStems,
  hasStrongSubjectAnchor,
  isValidInn,
  type SubjectAnchorKind,
} from "../orion-golden/analytics/subject-anchors";
import type { SubjectAnchorsDTO, SubjectIdentityProfileDTO } from "./api";
import type { PersonaPhrase } from "./persona-panel-text";

export const ANCHOR_KINDS: readonly SubjectAnchorKind[] = [
  "employer",
  "position",
  "birthPlace",
  "education",
  "fact",
];

export type AnchorFormRow = { kind: SubjectAnchorKind; text: string; strong: boolean };

export type AnchorFormState = {
  /** Дата рождения кейса — показывается, но здесь не правится. */
  birthDate: string | null;
  rows: AnchorFormRow[];
  innText: string;
  domainsText: string;
};

/**
 * Многословная фраза сильна сама по себе, однословная — нет.
 *
 * «Арбитражный суд Краснодарского края» не стоит в текстах о других Егоровых,
 * а «судья» стоит: одним словом подтверждать принадлежность значило бы
 * повторить 0049 другими средствами. Тот же ответ даёт сервер при сохранении.
 */
export function strongByDefault(text: string): boolean {
  return anchorPhraseStems(text).length > 1;
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Строки формы → блок `anchors` профиля кейса. */
export function anchorsFromForm(state: AnchorFormState): SubjectAnchorsDTO {
  return {
    birthDate: state.birthDate,
    phrases: state.rows
      .map((row) => ({ ...row, text: row.text.replace(/\s+/g, " ").trim() }))
      .filter((row) => row.text.length > 0)
      .map((row) => ({
        kind: row.kind,
        text: row.text,
        strong: row.strong || strongByDefault(row.text),
      })),
    inn: lines(state.innText),
    domains: lines(state.domainsText),
  };
}

/** Профиль кейса → строки формы. */
export function anchorFormFromProfile(
  profile: SubjectIdentityProfileDTO | null
): AnchorFormState {
  const anchors = profile?.anchors ?? null;
  if (anchors) {
    return {
      birthDate: anchors.birthDate ?? null,
      rows: anchors.phrases.map((p) => ({ kind: p.kind, text: p.text, strong: p.strong })),
      innText: anchors.inn.join("\n"),
      domainsText: anchors.domains.join("\n"),
    };
  }
  /*
   * Прежние контекст-слова показываются строками формы: их вводил оператор, и
   * терять их при переходе на признаки незачем. ИНН из `knownIdentifiers` —
   * наоборот: в профилях до этого шага там лежат номера, поднятые из той же
   * выдачи, которую они подтверждают (в 0049 — три чужих). Подставить их в
   * поле «со слов клиента» значило бы выдать находку за слова клиента.
   */
  return {
    birthDate: null,
    rows: (profile?.contextIdentifiers ?? []).map((text) => ({
      kind: "fact" as const,
      text,
      strong: strongByDefault(text),
    })),
    innText: "",
    domainsText: "",
  };
}

/**
 * Чего форме не хватает — словами оператора, до платного сбора.
 *
 * Ворота считает сервер (`personaGateState`); здесь тот же признак называется
 * заранее, чтобы оператор узнал о нём в форме, а не отказом старта.
 */
export function anchorFormWarnings(state: AnchorFormState): PersonaPhrase[] {
  const anchors = anchorsFromForm(state);
  const warnings: PersonaPhrase[] = [];

  if (!hasStrongSubjectAnchor(anchors)) {
    warnings.push({ key: "persona.anchorsNoStrong" });
  } else if (anchors.phrases.length === 0 && anchors.inn.length === 0 && anchors.domains.length === 0) {
    // Решение владельца (0054, №2): одной даты рождения для старта хватает, но
    // часть материалов останется «принадлежность не подтверждена».
    warnings.push({ key: "persona.anchorsOnlyBirthDate" });
  }

  const singleWord = anchors.phrases.filter((p) => !p.strong).map((p) => p.text);
  if (singleWord.length > 0) {
    warnings.push({ key: "persona.anchorsSingleWord", vars: { items: singleWord.join(", ") } });
  }

  const badInn = anchors.inn.filter((value) => !isValidInn(value));
  if (badInn.length > 0) {
    // Сервер откажет тем же условием; оператор узнаёт причину до отказа.
    warnings.push({ key: "persona.anchorsBadInn", vars: { items: badInn.join(", ") } });
  }

  return warnings;
}
