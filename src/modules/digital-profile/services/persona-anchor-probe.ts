/**
 * Проба якорей по строкам, которые панель персон и так купила.
 *
 * Панель отвечает на вопрос «про кого мы собираем» до первой траты. Для
 * известного человека на него отвечает карточка Википедии или панель знаний, а
 * для малоизвестного — никто: прогон DPA-2026-0049 показал оператору пять
 * чужих статей («Кравченко», «Голубев», страница фамилии «Егоров», список
 * Героев России, «Штерн»), судьи среди них не было, и оператор честно ответил
 * «различимой персоны нет».
 *
 * Проба ничего не решает за оператора и никакой новой сущности не заводит: она
 * берёт признаки, названные им самим, и показывает, **на каких строках выдачи**
 * каждый из них найден, а на каких стоят признаки другого человека. Ответ —
 * адресами: их можно открыть и проверить глазами. Кластеризация выдачи в
 * персон здесь намеренно не делается — это был бы второй ответ на вопрос
 * тождества (см. `docs/ENGINEERING.md`, «Карточка панели — сущность источника»).
 */

import {
  anchorHitsInText,
  foreignBirthDates,
  hasSubjectAnchors,
  innsInText,
  type SubjectAnchors,
} from "../orion-golden/analytics/subject-anchors";

/** Строка выдачи в том виде, в каком её показывает панель. */
export type PersonaProbeRow = {
  title: string;
  snippet?: string | null;
  url: string | null;
  domain: string | null;
  engine?: "GOOGLE" | "YANDEX";
};

export type AnchorProbeHit = {
  /** Написание якоря, как его ввёл оператор (или сама дата/домен). */
  anchor: string;
  kind: string;
  strong: boolean;
  rows: PersonaProbeRow[];
};

export type AnchorProbeConflict = {
  title: string;
  url: string | null;
  domain: string | null;
  /**
   * `registry_inn_unverified` — реестровая строка с ИНН при неизвестном своём:
   * это не чужой человек, а признак, который нечем сверить.
   */
  reason: "foreign_birth_date" | "foreign_inn" | "registry_inn_unverified";
  /** Найденное написание чужого признака — оператор видит, за что строка отвергнута. */
  value: string;
};

export type AnchorProbeResult = {
  hits: AnchorProbeHit[];
  /** Якоря, не найденные ни на одной строке: их стоит переписать короче. */
  missing: string[];
  conflicts: AnchorProbeConflict[];
  /** Строки без якоря и без конфликта — панель показывает их как есть. */
  unmatchedRows: PersonaProbeRow[];
};

function textOf(row: PersonaProbeRow): string {
  return [row.title, row.snippet ?? "", row.url ?? ""].filter(Boolean).join(" ");
}

/**
 * Разложить строки пробы по якорям оператора.
 *
 * Функция чистая: ни сети, ни базы, ни модели — её ответ воспроизводится на тех
 * же строках дословно.
 */
export function checkAnchorsInProbe(input: {
  anchors: SubjectAnchors;
  rows: PersonaProbeRow[];
}): AnchorProbeResult {
  const anchors = input.anchors;
  const hitsByAnchor = new Map<string, AnchorProbeHit>();
  const conflicts: AnchorProbeConflict[] = [];
  const matchedRows = new Set<PersonaProbeRow>();

  /*
   * Оператор не назвал ни одного признака — пробе нечего сказать.
   *
   * Это тот же ответ, что и у классификатора: без якорей строгих правил нет, и
   * объявлять строку «непроверяемой» не с чем — сверять её не с чем тоже.
   */
  if (!hasSubjectAnchors(anchors)) {
    return { hits: [], missing: [], conflicts: [], unmatchedRows: [...input.rows] };
  }

  for (const row of input.rows) {
    const text = textOf(row);
    for (const hit of anchorHitsInText({ text, url: row.url, anchors })) {
      /*
       * Ключ — написание, которое ввёл оператор: он ищет в списке свою фразу, а
       * не её падежную форму со страницы.
       */
      const key = hit.kind === "birth_date" ? anchors.birthDate ?? hit.value : hit.value;
      const existing = hitsByAnchor.get(key);
      if (existing) existing.rows.push(row);
      else hitsByAnchor.set(key, { anchor: key, kind: hit.kind, strong: hit.strong, rows: [row] });
      matchedRows.add(row);
    }

    const foreignDate = foreignBirthDates(text, anchors.birthDate)[0];
    if (foreignDate) {
      conflicts.push({
        title: row.title,
        url: row.url,
        domain: row.domain,
        reason: "foreign_birth_date",
        value: foreignDate,
      });
      matchedRows.add(row);
      continue;
    }
    const ownInnOnRow = anchors.inn.some((i) => text.includes(i));
    const foreignInn = ownInnOnRow ? undefined : innsInText(text).find((i) => !anchors.inn.includes(i));
    if (foreignInn) {
      conflicts.push({
        title: row.title,
        url: row.url,
        domain: row.domain,
        // Свой ИНН известен — строка о другом человеке; неизвестен — признак
        // есть, а сверить его не с чем, и так это и называется.
        reason: anchors.inn.length > 0 ? "foreign_inn" : "registry_inn_unverified",
        value: foreignInn,
      });
      matchedRows.add(row);
    }
  }

  const declared = [
    ...(anchors.birthDate ? [anchors.birthDate] : []),
    ...anchors.phrases.map((p) => p.text),
    ...anchors.inn,
    ...anchors.domains,
  ];
  const missing = declared.filter((a) => !hitsByAnchor.has(a));

  return {
    hits: [...hitsByAnchor.values()],
    missing,
    conflicts,
    unmatchedRows: input.rows.filter((r) => !matchedRows.has(r)),
  };
}
