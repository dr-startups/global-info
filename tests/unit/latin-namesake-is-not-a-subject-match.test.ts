/**
 * Однофамилец с чужим латинским именем — не подтверждение принадлежности.
 *
 * Кадр ниже приехал из живого прогона DPA-2026-0046 целиком: статья о другом
 * человеке получала `SUBJECT_MATCH / full_name_match` с уверенностью 0,85.
 * Кириллическая «Борисов» из сниппета давала фамилию, латинская «borisov» из
 * заголовка и адреса — «имя», и одно и то же слово считалось дважды. Имени
 * субъекта в материале нет вовсе.
 *
 * Решение владельца от 02.09.2026: чужое латинское имя рядом с фамилией
 * конфликтом **не** выводится (у имени нет опознаваемой формы, и позиционное
 * правило объявило бы другим лицом «BATE Borisov», а ложная чужесть прячет
 * негатив клиента). Однофамилец доезжает до аналитика как «требует
 * подтверждения», и это закреплено здесь проверкой, а не прозой.
 */

import { describe, expect, it } from "vitest";
import {
  classifySubjectRelevance,
  subjectIdentityFromProfile,
  type SubjectIdentity,
} from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import { buildSubjectIdentityProfile } from "@/modules/digital-profile/orion-golden/identity/subject-identity-profile-builder";
import { classifierProfileFromIdentityProfile } from "@/modules/digital-profile/services/job-subject-profile";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

function identityOfCase(subjectName: string, aliases: string[] = []): SubjectIdentity {
  const profile = buildSubjectIdentityProfile({
    caseId: "case-unit-latin-namesake",
    subjectName,
    aliases,
  });
  return subjectIdentityFromProfile(classifierProfileFromIdentityProfile(profile));
}

const BORISOV = (): SubjectIdentity =>
  identityOfCase("Борисов Анатолий Анатольевич", [
    "Толя Вайлдвей",
    "Толя Wildways",
    "Анатолий Wildways",
  ]);

/** Наблюдение прогона DPA-2026-0046, Google/ОАЭ, Serper, organic, позиция 9. */
function alexeiBorisovFrame(overrides: Partial<RawInventoryItem> = {}): RawInventoryItem {
  return {
    inventoryId: "obs-3c69d19a1fc9d9b9",
    caseId: "case-unit-latin-namesake",
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "serper",
    region: "UAE",
    query: "Borisov Anatoliy",
    collectedAt: "2026-09-01T12:25:03.529Z",
    evidenceType: "search_result",
    // Сниппет провайдера как есть: «Алeксeй Юpьeвич» написан со смешением
    // алфавитов, а «Борисов» — чистой кириллицей, и именно она давала фамилию.
    title: "Alexei Borisov",
    snippet: "Alexei Yurievich Borisov (Russian: Алeксeй Юpьeвич Борисов ) (born 7 December 1960) is a Russian musician, active in the Russian underground music scene ...",
    sourceUrl: "https://en.wikipedia.org/wiki/Alexei_Borisov",
    rawMetadata: { surface: "organic", engine: "GOOGLE", rank: 9 },
    ...overrides,
  };
}

describe("статья об однофамильце не подтверждается именем, которого в ней нет", () => {
  it("кадр живого прогона не получает SUBJECT_MATCH", () => {
    const verdict = classifySubjectRelevance(alexeiBorisovFrame(), BORISOV());

    // Вердикт целиком, одним утверждением: латинская фамилия не может быть
    // засчитана вторым, «именным» признаком, и в списке совпавшего её нет.
    expect({
      decision: verdict.decision,
      reasonCode: verdict.reasonCode,
      matchedIdentifiers: verdict.matchedIdentifiers,
    }).toEqual({
      decision: "LIKELY_SUBJECT",
      reasonCode: "surname_with_subject_query",
      matchedIdentifiers: ["Борисов", "subject_query"],
    });
  });

  it("чужое латинское имя рядом с фамилией конфликтом не объявляется", () => {
    const verdict = classifySubjectRelevance(alexeiBorisovFrame(), BORISOV());

    expect(verdict.conflictingIdentifiers).toEqual([]);
    expect(verdict.decision).not.toBe("OTHER_SUBJECT");
  });

  it("без запроса тот же кадр — «одна фамилия»", () => {
    const verdict = classifySubjectRelevance(
      alexeiBorisovFrame({ query: undefined }),
      BORISOV()
    );

    expect(verdict.decision).toBe("AMBIGUOUS");
    expect(verdict.reasonCode).toBe("surname_only");
  });

  it("без сниппета латинская фамилия всё равно считается фамилией", () => {
    // Раньше здесь было «есть имя, нет фамилии»
    // (INSUFFICIENT_IDENTIFIERS / partial_name_without_surname) — так система
    // теряла и собственные материалы субъекта, написанные латиницей.
    const verdict = classifySubjectRelevance(alexeiBorisovFrame({ snippet: "" }), BORISOV());

    expect(verdict.decision).toBe("LIKELY_SUBJECT");
    expect(verdict.reasonCode).toBe("surname_with_subject_query");
  });

  it("настоящее латинское совпадение имени совпадать не перестаёт", () => {
    // Эталон-72: субъект «Глинка Сергей Михайлович», статья о нём же.
    const glinka = identityOfCase("Глинка Сергей Михайлович");
    const verdict = classifySubjectRelevance(
      {
        inventoryId: "obs-sergey-glinka",
        caseId: "case-unit-latin-namesake",
        reportRunId: "run-1",
        source: "serp_observation",
        provider: "serper",
        region: "RU",
        query: "Глинка Сергей Михайлович",
        collectedAt: "2026-09-01T12:25:03.529Z",
        evidenceType: "search_result",
        title: "Sergey Glinka - Wikipedia",
        snippet: "",
        sourceUrl: "https://en.wikipedia.org/wiki/Sergey_Glinka",
        rawMetadata: { surface: "organic" },
      },
      glinka
    );

    expect(verdict.decision).toBe("SUBJECT_MATCH");
    expect(verdict.reasonCode).toBe("full_name_match");
    expect(verdict.matchedIdentifiers).toContain("sergey");
  });

  it("материал о самом субъекте не теряется, когда фамилия произведена от его имени", () => {
    /*
     * У субъекта «Иванов Иван Иванович» сито фамилии (первые четыре буквы)
     * вычищало из имён его же «ivan», и негативный материал о клиенте получал
     * «одна фамилия» — в журнале диспозиций это `APPENDIX_AMBIGUOUS`, то есть
     * из аудита в приложение и молча. Дорогая сторона ошибки: ложная чужесть
     * прячет негатив клиента.
     */
    const subject = identityOfCase("Иванов Иван Иванович");
    const verdict = classifySubjectRelevance(
      {
        inventoryId: "obs-ivan-ivanov",
        caseId: "case-unit-latin-namesake",
        reportRunId: "run-1",
        source: "serp_observation",
        provider: "serper",
        region: "UAE",
        query: "Ivan Ivanov",
        collectedAt: "2026-09-01T12:25:03.529Z",
        evidenceType: "search_result",
        title: "Ivan Ivanov charged with fraud",
        snippet: "Ivan Ivanov, a businessman from Moscow, was charged ...",
        sourceUrl: "https://www.thenationalnews.com/ivan-ivanov",
        rawMetadata: { surface: "organic" },
      },
      subject
    );

    expect(verdict.decision).toBe("SUBJECT_MATCH");
    expect(verdict.reasonCode).toBe("full_name_match");
  });

  it("собственная статья субъекта с «ё»-фамилией опознаётся по второй школе транслитерации", () => {
    /*
     * Заголовок и адрес — настоящие: собственная статья субъекта живого кейса
     * «Кремлёв Умар Назарович» написана «Kremlyov», то есть по той школе, по
     * которой строятся поисковые запросы, а не по той, которой профиль
     * порождает свои транслитерации. Пока формой фамилии считалась одна
     * «kremlev», статья о самом субъекте получала «есть имя, нет фамилии».
     */
    const subject = identityOfCase("Кремлёв Умар Назарович");
    const verdict = classifySubjectRelevance(
      {
        inventoryId: "obs-umar-kremlyov",
        caseId: "case-unit-latin-namesake",
        reportRunId: "run-1",
        source: "serp_observation",
        provider: "serper",
        region: "RU",
        query: "Кремлёв Умар Назарович",
        collectedAt: "2026-09-01T12:25:03.529Z",
        evidenceType: "search_result",
        title: "Umar Kremlyov - Wikipedia",
        snippet: "",
        sourceUrl: "https://en.wikipedia.org/wiki/Umar_Kremlyov",
        rawMetadata: { surface: "organic" },
      },
      subject
    );

    expect(verdict.decision).toBe("SUBJECT_MATCH");
    expect(verdict.reasonCode).toBe("full_name_match");
    expect(verdict.matchedIdentifiers).toContain("Кремлёв");
  });
  it("однофамилица со склонённой фамилией из псевдонима подтверждения не получает", () => {
    /*
     * «Фонд Борисова» в псевдонимах приносит в транслитерации «borisova». Пока
     * это слово считалось именем, статья о другой женщине подтверждалась как
     * материал о субъекте с уверенностью 0,85 — тот же дефект, что и у
     * латинской фамилии, только на данных оператора.
     */
    const subject = identityOfCase("Борисов Анатолий Анатольевич", [
      "Толя Вайлдвей",
      "Толя Wildways",
      "Анатолий Wildways",
      "Фонд Борисова",
    ]);
    const verdict = classifySubjectRelevance(
      {
        inventoryId: "obs-anna-borisova",
        caseId: "case-unit-latin-namesake",
        reportRunId: "run-1",
        source: "serp_observation",
        provider: "serper",
        region: "RU",
        query: "Борисов Анатолий",
        collectedAt: "2026-09-01T12:25:03.529Z",
        evidenceType: "search_result",
        title: "Anna Borisova charged with fraud",
        snippet: "Анна Борисова, предпринимательница из Твери, обвиняется в мошенничестве ...",
        sourceUrl: "https://example.org/anna-borisova",
        rawMetadata: { surface: "organic" },
      },
      subject
    );

    expect(verdict.decision).not.toBe("SUBJECT_MATCH");
    expect(verdict.reasonCode).toBe("surname_with_subject_query");
    expect(verdict.matchedIdentifiers).not.toContain("borisova");
  });

  it("собственная статья субъекта опознаётся и по первой школе транслитерации", () => {
    /*
     * Пара к тесту про «Kremlyov»: то же имя, записанное по школе, которой
     * профиль порождает свои транслитерации. Обе половины «берём обе таблицы»
     * должны держаться вердиктом, а не только раскладкой.
     */
    const subject = identityOfCase("Кремлёв Умар Назарович");
    const verdict = classifySubjectRelevance(
      {
        inventoryId: "obs-umar-kremlev",
        caseId: "case-unit-latin-namesake",
        reportRunId: "run-1",
        source: "serp_observation",
        provider: "serper",
        region: "RU",
        query: "Кремлёв Умар Назарович",
        collectedAt: "2026-09-01T12:25:03.529Z",
        evidenceType: "search_result",
        title: "Umar Kremlev heads the boxing federation",
        snippet: "",
        sourceUrl: "https://example.org/umar-kremlev",
        rawMetadata: { surface: "organic" },
      },
      subject
    );

    expect(verdict.decision).toBe("SUBJECT_MATCH");
    expect(verdict.reasonCode).toBe("full_name_match");
  });
});
