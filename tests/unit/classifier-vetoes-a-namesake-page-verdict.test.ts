/**
 * Вердикт прочитанной страницы не может объявить своим то, что разметка
 * признала чужим.
 *
 * Стадия чтения получает о субъекте только ФИО и решает по тексту страницы;
 * на прогоне DPA-2026-0049 она назвала «страницами субъекта» 13 карточек ИП и
 * 4 страницы офтальмолога. Из этих вердиктов собраны «Основные сюжеты в
 * выдаче» на второй странице отчёта — то есть мешанина попала клиенту в резюме
 * мимо всей работы классификатора.
 *
 * Вето применяется в одном месте — сразу после того, как вердикты получены или
 * переиспользованы: артефакт прошлого прогона живёт по `schemaVersion`, и
 * фильтр только на свежих решениях не защищал бы пересборку.
 */

import { describe, expect, it } from "vitest";
import { applySubjectDecisionVeto } from "@/modules/digital-profile/orion-golden/analytics/run-link-verdicts";
import type { LinkVerdict } from "@/modules/digital-profile/orion-golden/contracts/link-verdict";

function verdict(ref: string, subjectMatch: LinkVerdict["subjectMatch"]): LinkVerdict {
  return {
    schemaVersion: "link-verdict-v1",
    evidenceRef: ref,
    url: `https://example.org/${ref}`,
    domain: "example.org",
    subjectMatch,
    tone: "adverse",
    theme: "Тема страницы",
    quotes: [],
  } as unknown as LinkVerdict;
}

describe("вето разметки над вердиктом чтения", () => {
  const decisionByRef = new Map([
    ["inventory:a", "SUBJECT_MATCH"],
    ["inventory:b", "OTHER_SUBJECT"],
    ["inventory:c", "AMBIGUOUS"],
    ["inventory:d", "LIKELY_SUBJECT"],
  ]);

  it("страница другого лица перестаёт быть страницей субъекта", () => {
    const out = applySubjectDecisionVeto({
      verdicts: [verdict("inventory:b", "subject")],
      decisionByRef,
    });
    expect(out.verdicts[0]?.subjectMatch).toBe("other");
    expect(out.vetoed).toBe(1);
  });

  it("неподтверждённая принадлежность даёт «непонятно», а не «субъект»", () => {
    const out = applySubjectDecisionVeto({
      verdicts: [verdict("inventory:c", "subject")],
      decisionByRef,
    });
    expect(out.verdicts[0]?.subjectMatch).toBe("unclear");
  });

  it("подтверждённые и вероятные страницы не трогаются", () => {
    const out = applySubjectDecisionVeto({
      verdicts: [verdict("inventory:a", "subject"), verdict("inventory:d", "subject")],
      decisionByRef,
    });
    expect(out.verdicts.map((v) => v.subjectMatch)).toEqual(["subject", "subject"]);
    expect(out.vetoed).toBe(0);
  });

  it("вердикт, который и так не «субъект», не меняется", () => {
    const out = applySubjectDecisionVeto({
      verdicts: [verdict("inventory:b", "unclear")],
      decisionByRef,
    });
    expect(out.verdicts[0]?.subjectMatch).toBe("unclear");
    expect(out.vetoed).toBe(0);
  });

  it("без решения по наблюдению вердикт остаётся как есть", () => {
    const out = applySubjectDecisionVeto({
      verdicts: [verdict("inventory:unknown", "subject")],
      decisionByRef,
    });
    expect(out.verdicts[0]?.subjectMatch).toBe("subject");
  });
});
