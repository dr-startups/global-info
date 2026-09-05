/**
 * Лист «Кого проверяли» называет признаки, которыми проверяли принадлежность.
 *
 * Отчёт 85: 92 материала отнесены к субъекту по якорям оператора — дате
 * рождения, работодателю, должности, ИНН, — а лист «Кого проверяли» о них
 * молчит: якоря лежат в записи решения только на ветке `ANCHORS_CONFIRMED`, а
 * прогон шёл с решением «различимой персоны нет». Читатель отчёта — сам
 * субъект, и он обязан видеть, чем его материал отличали от материала полного
 * тёзки, при любом решении о персоне.
 *
 * Там же: «OpenSanctions — источник не ответил» на стр. 3 против «доступ к базе
 * отклонён: ключ не принят» на стр. 65. Источник ответил — отказом; фраза
 * «не ответил» выдумана слоем текста. Причину называет запись решения.
 */

import { describe, expect, it } from "vitest";
import { buildFrontMatterFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/front-matter";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type {
  PersonaDecisionRecord,
  ScopedFragmentInput,
} from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { FragmentExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

const SCOPED = {
  subject: { displayName: "Егоров Алексей Евгеньевич", aliases: [] },
  findings: [],
  surfaceUnits: [],
  evidenceIndex: {},
  scope: { regions: null, surfaces: null, subjectMatch: null, findingIds: null },
  metricSnapshot: {},
} as unknown as ScopedFragmentInput;

const ANCHORS = {
  birthDate: "1977-11-30",
  phrases: [
    { kind: "employer", text: "Арбитражный Суд Краснодарского края", strong: true },
    { kind: "position", text: "председатель Арбитражного суда Краснодарского края", strong: true },
  ],
  inn: ["231112942662"],
  domains: ["pravo.ru"],
  confirmedOn: [],
};

const WITHOUT_PERSONA: PersonaDecisionRecord = {
  decision: "APPROVED_WITHOUT_PERSONA",
  anchors: ANCHORS,
  selected: null,
  sources: [
    { source: "wikipedia", status: "SUCCESS" },
    { source: "knowledge_graph", status: "SUCCESS" },
    { source: "opensanctions", status: "FAILED", code: "PROVIDER_REQUEST_FAILED" },
  ],
  cardCount: 5,
  decidedAt: "2026-09-04T15:04:56.366Z",
};

function personaSlide(record: PersonaDecisionRecord): SlideContentContract {
  const out = buildFrontMatterFragment("FRONT_MATTER", SCOPED, {
    personaDecision: record,
  } as FragmentExtras);
  const slide = out.slides.find((s) => s.baseSlotId === "p03_persona");
  if (!slide) throw new Error("лист «Кого проверяли» не собран");
  return slide;
}

function sheetText(slide: SlideContentContract): string {
  const c = slide.content;
  return [c.narrative, ...(c.bullets ?? []), c.whatToCheck, c.sourceNote].filter(Boolean).join(" ");
}

describe("признаки печатаются при любом решении о персоне", () => {
  it("решение «персоны нет» не прячет якоря прогона", () => {
    const text = sheetText(personaSlide(WITHOUT_PERSONA));
    expect(text).toContain("дата рождения 1977-11-30");
    expect(text).toContain("Арбитражный Суд Краснодарского края");
    expect(text).toContain("председатель Арбитражного суда Краснодарского края");
    expect(text).toContain("ИНН 231112942662");
    expect(text).toContain("pravo.ru");
  });

  it("без якорей лист говорит прежними словами", () => {
    const text = sheetText(personaSlide({ ...WITHOUT_PERSONA, anchors: null }));
    expect(text).toContain("различимой персоны нет");
    expect(text).not.toContain("дата рождения 1977");
  });

  it("отказ источника называется тем, что случилось", () => {
    const text = sheetText(personaSlide(WITHOUT_PERSONA));
    expect(text).toContain("OpenSanctions — запрос к источнику не выполнен");
    expect(text).not.toContain("OpenSanctions — источник не ответил");
  });

  it("отказ без записанной причины не выдумывает её", () => {
    const text = sheetText(
      personaSlide({
        ...WITHOUT_PERSONA,
        sources: [{ source: "opensanctions", status: "FAILED" }],
      })
    );
    expect(text).toContain("OpenSanctions — данных от источника нет");
  });
});
