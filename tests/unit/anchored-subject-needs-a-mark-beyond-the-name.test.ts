/**
 * Полное ФИО без якоря не подтверждает принадлежность.
 *
 * Прогон DPA-2026-0049: 585 материалов «о субъекте» принадлежали четырём
 * разным людям — судье, офтальмологу из Подольска, депутату гордумы Краснодара
 * и четырём ИП. Причина в лестнице решений: фамилия + имя без конфликта =
 * SUBJECT_MATCH, а у полного тёзки конфликтов не бывает по построению.
 *
 * Режим задаётся данными, а не флагом: у профиля есть якоря оператора —
 * работает строгая ветка; якорей нет (старые кейсы, фикстуры) — прежняя
 * лестница слово в слово.
 */

import { describe, expect, it } from "vitest";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import {
  classifySubjectRelevance,
  type SubjectIdentity,
} from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";

let seq = 0;
function item(partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `an-${seq}`,
    caseId: "case-egorov",
    reportRunId: "base-run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-09-03T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: "",
    ...partial,
  };
}

const BASE: SubjectIdentity = {
  displayName: "Егоров Алексей Евгеньевич",
  lastName: "Егоров",
  lastNameVariants: ["egorov"],
  firstNames: ["Алексей", "aleksey"],
  patronymics: ["Евгеньевич", "evgenevich"],
  aliases: ["А. Егоров"],
  strongIdentifiers: [],
  contextIdentifiers: [],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [],
  namesakeNoise: [],
};

const ANCHORED: SubjectIdentity = {
  ...BASE,
  anchors: {
    birthDate: "1977-11-30",
    phrases: [
      { kind: "employer", text: "Арбитражный суд Краснодарского края", strong: true },
      { kind: "position", text: "председатель суда", strong: true },
      { kind: "birthPlace", text: "станица Красноармейская", strong: true },
      { kind: "fact", text: "судья", strong: false },
    ],
    inn: [],
    domains: ["krasnodar.arbitr.ru"],
  },
};

describe("строгая ветка: якорь сверх имени", () => {
  it("полное ФИО без якоря — принадлежность не подтверждена", () => {
    const d = classifySubjectRelevance(
      item({
        title: "Егоров Алексей Евгеньевич, офтальмолог — ПроДокторов",
        snippet: "Приём в Подольске, стаж 31 год",
        sourceUrl: "https://prodoctorov.ru/podolsk/vrach/380102-egorov/",
      }),
      ANCHORED
    );
    expect(d.decision).toBe("AMBIGUOUS");
    expect(d.reasonCode).toBe("full_name_no_anchor");
  });

  it("своя дата рождения в сниппете подтверждает материал", () => {
    const d = classifySubjectRelevance(
      item({
        title: "Судья Егоров Алексей Евгеньевич на портале Право.ру",
        snippet: "Родился 30.11.1977г. в ст.Красноармейской Краснодарского края",
        sourceUrl: "https://pravo.ru/arbitr_practice/judge/1465/",
      }),
      ANCHORED
    );
    expect(d.decision).toBe("SUBJECT_MATCH");
    expect(d.reasonCode).toBe("full_name_with_anchor:birth_date");
    expect(d.matchedIdentifiers).toContain("30.11.1977");
  });

  it("работодатель в заголовке подтверждает материал", () => {
    const d = classifySubjectRelevance(
      item({
        title: "Егоров Алексей Евгеньевич Председатель суда | Арбитражный суд Краснодарского края",
        sourceUrl: "https://krasnodar.arbitr.ru/about/mode/judges",
      }),
      ANCHORED
    );
    expect(d.decision).toBe("SUBJECT_MATCH");
    expect(d.reasonCode).toMatch(/^full_name_with_anchor:(employer|position|domain)$/);
  });

  it("чужая дата рождения — материал о другом лице, без ручного ввода тёзки", () => {
    const d = classifySubjectRelevance(
      item({
        title: "Егоров Алексей Евгеньевич - Структура городской Думы Краснодара",
        snippet: "Родился: 10 августа 1983 года в п. Чегдомын Хабаровского края",
        sourceUrl: "https://krd.ru/gorodskaya-duma/struktura/",
      }),
      ANCHORED
    );
    expect(d.decision).toBe("OTHER_SUBJECT");
    expect(d.reasonCode).toBe("foreign_birth_date");
  });

  it("слабый якорь один — вероятно, но не подтверждено", () => {
    const d = classifySubjectRelevance(
      item({ title: "Егоров Алексей Евгеньевич — судья", snippet: "" }),
      ANCHORED
    );
    expect(d.decision).toBe("LIKELY_SUBJECT");
    expect(d.reasonCode).toBe("full_name_with_weak_anchor");
  });

  it("обе стороны сразу — неоднозначно, а не «о другом лице»", () => {
    const d = classifySubjectRelevance(
      item({
        title: "Нейро-ответ: Егоров Алексей Евгеньевич",
        snippet:
          "Возможно, имелись в виду разные люди: председатель Арбитражного суда Краснодарского края и офтальмолог, родился 10 августа 1983 года",
      }),
      ANCHORED
    );
    expect(d.decision).toBe("AMBIGUOUS");
    expect(d.reasonCode).toBe("mixed_identity_signals");
  });

  it("сильный якорь при чужом отчестве — неоднозначно, а не «о другом лице»", () => {
    // Страница, где найдены и признак субъекта, и признак другого человека,
    // говорит о двоих: выбрасывать её нельзя, объявлять своей — тоже.
    const d = classifySubjectRelevance(
      item({
        title: "Егоров Алексей Владимирович и Арбитражный суд Краснодарского края",
        snippet: "",
      }),
      ANCHORED
    );
    expect(d.decision).toBe("AMBIGUOUS");
    expect(d.reasonCode).toBe("mixed_identity_signals");
  });

  it("без якорей лестница прежняя — старые кейсы не двигаются", () => {
    const d = classifySubjectRelevance(
      item({ title: "Егоров Алексей Евгеньевич, офтальмолог — ПроДокторов" }),
      BASE
    );
    expect(d.decision).toBe("SUBJECT_MATCH");
    expect(d.reasonCode).toBe("full_name_match");
  });

  it("чужая дата рождения работает и без якорей — если дата кейса известна", () => {
    const d = classifySubjectRelevance(
      item({
        title: "Егоров Алексей Евгеньевич — Гордума",
        snippet: "Родился: 10 августа 1983 года",
      }),
      { ...BASE, anchors: { birthDate: "1977-11-30", phrases: [], inn: [], domains: [] } }
    );
    expect(d.decision).toBe("OTHER_SUBJECT");
    expect(d.reasonCode).toBe("foreign_birth_date");
  });
});

describe("строгая ветка: ИНН", () => {
  const WITH_INN: SubjectIdentity = {
    ...ANCHORED,
    anchors: { ...ANCHORED.anchors!, inn: ["231112942662"] },
  };

  it("свой ИНН на странице сильнее чужого", () => {
    const d = classifySubjectRelevance(
      item({
        title: "АРБИТРАЖНЫЙ СУД КРАСНОДАРСКОГО КРАЯ — Егоров Алексей Евгеньевич",
        snippet: "ИНН 231112942662, ИНН организации 2309054252",
      }),
      WITH_INN
    );
    expect(d.decision).toBe("SUBJECT_MATCH");
    expect(d.reasonCode).toBe("full_name_with_anchor:inn");
  });

  it("чужой ИНН при известном своём — материал о другом лице", () => {
    const d = classifySubjectRelevance(
      item({
        title: "ИП Егоров Алексей Евгеньевич, Опочка",
        snippet: "ИНН 772809603828, выписка из ЕГРИП",
        sourceUrl: "https://www.rusprofile.ru/ip/306603112500025",
      }),
      WITH_INN
    );
    expect(d.decision).toBe("OTHER_SUBJECT");
    expect(d.reasonCode).toBe("foreign_inn");
  });

  it("чужой ИНН при неизвестном своём — реестр, который не проверить", () => {
    const d = classifySubjectRelevance(
      item({
        title: "Егоров Алексей Евгеньевич ИНН 772809603828",
        snippet: "в реестре юридических лиц и предпринимателей",
      }),
      ANCHORED
    );
    expect(d.decision).toBe("AMBIGUOUS");
    expect(d.reasonCode).toBe("registry_inn_unverified");
  });
});
