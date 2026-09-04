/**
 * Resolve the canonical subject identity profile for a unified job.
 *
 * Subject-specific values are NEVER hardcoded here — they come only from an
 * injected profile or the case's own persisted identity artifact. If neither is
 * available the job fails closed (the canonical prepare raises
 * SUBJECT_PROFILE_MISSING); there is no baseline-subject default.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClassifierSubjectProfile } from "../orion-golden/analytics/subject-resolution-classifier";
import type { SubjectIdentityProfile } from "../orion-golden/identity/subject-identity-profile";
import {
  anchorPhraseStems,
  type SubjectAnchors,
} from "../orion-golden/analytics/subject-anchors";

/**
 * Контекст-слова прежних кейсов становятся якорями, а не пропадают.
 *
 * Дата рождения кейса приезжает в профиль бутстрапом, и одного её появления
 * достаточно, чтобы включить строгую лестницу. Оператор, который до этого ввёл
 * «Арбитражный суд Краснодарского края» в поле контекст-слов, не должен
 * обнаружить, что его ввод перестал читаться: слово из старого поля — тот же
 * признак, просто названный раньше. Многословная фраза сильна, однословная —
 * слаба: одно слово стоит и в чужих текстах.
 */
function withLegacyContextAsAnchors(p: SubjectIdentityProfile): SubjectAnchors {
  const anchors = p.anchors!;
  if (anchors.phrases.length > 0) return anchors;
  const legacy = (p.contextIdentifiers ?? []).map((t) => String(t ?? "").trim()).filter(Boolean);
  if (legacy.length === 0) return anchors;
  return {
    ...anchors,
    phrases: legacy.map((text) => ({
      kind: "fact" as const,
      text,
      strong: anchorPhraseStems(text).length > 1,
    })),
  };
}

/** Adapt the content-brain SubjectIdentityProfile into the classifier profile. */
export function classifierProfileFromIdentityProfile(
  p: SubjectIdentityProfile
): ClassifierSubjectProfile {
  const given =
    p.givenNames && p.givenNames.length > 0
      ? p.givenNames
      : p.fullNameRu?.firstName
        ? [p.fullNameRu.firstName]
        : [];
  const family =
    p.familyNames && p.familyNames.length > 0
      ? p.familyNames
      : p.fullNameRu?.lastName
        ? [p.fullNameRu.lastName]
        : [];
  const patronymics =
    p.patronymics && p.patronymics.length > 0
      ? p.patronymics
      : p.fullNameRu?.patronymic
        ? [p.fullNameRu.patronymic]
        : [];
  return {
    displayName: p.displayName,
    fullNameRu: p.fullNameRu,
    givenNames: given,
    familyNames: family,
    patronymics,
    aliases: p.aliases ?? [],
    transliterations: p.transliterations ?? [],
    namesakeProfiles: p.namesakeProfiles ?? [],
    // При якорях старое поле пустеет: его слова уже переехали фразами, и два
    // набора признаков с разной силой были бы двумя ответами на один вопрос.
    contextIdentifiers: p.anchors ? [] : (p.contextIdentifiers ?? []),
    ...(p.anchors ? { anchors: withLegacyContextAsAnchors(p) } : {}),
    /*
     * Идентификатором ИНН становится только от оператора.
     *
     * `knownIdentifiers.inn` прежних кейсов заполнял конвейер, добывая номера
     * по соседству с ФИО из собранного корпуса (прогон DPA-2026-0049: два из
     * трёх — чужие). Такое поле читается как предложение, а не как признак:
     * classifier получает пустой список, а сам номер остаётся в файле и виден
     * оператору.
     */
    knownIdentifiers: { inn: p.anchors?.inn ?? [] },
    negativeIdentitySignals: {
      wrongPatronymics: p.negativeIdentitySignals?.wrongPatronymics ?? [],
      wrongNames: p.negativeIdentitySignals?.wrongNames ?? [],
      unrelatedKnownPersons: p.negativeIdentitySignals?.unrelatedKnownPersons ?? [],
    },
  };
}

/**
 * Resolve a classifier subject profile for a case.
 * Order: injected profile → case-scoped persisted identity artifact → null.
 */
export async function resolveJobSubjectProfile(input: {
  caseId: string;
  injected?: ClassifierSubjectProfile | null;
}): Promise<ClassifierSubjectProfile | null> {
  if (input.injected) return input.injected;

  try {
    const { ORION_GOLDEN_QA_STORAGE_ROOT, caseScopedArtifactRoot } = await import(
      "../orion-golden/evidence/admin-review-decision-store"
    );
    const caseRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, input.caseId);
    const path = join(caseRoot, "subject-identity-profile.json");
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as SubjectIdentityProfile;
      if (parsed.displayName) return classifierProfileFromIdentityProfile(parsed);
    }
  } catch {
    // fall through to null — fail-closed at prepare with an explicit blocker.
  }
  return null;
}
