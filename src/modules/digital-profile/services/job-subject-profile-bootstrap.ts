/**
 * Automatic bootstrap of the subject identity profile from the collected data.
 *
 * When a unified job reaches composite merge and no case-owned profile exists
 * yet, the system builds one itself: the subject name/aliases come from the
 * case record, and identifiers (INN/OGRN, locations, wrong patronymics of
 * homonyms) are discovered from the just-collected observations by the generic
 * profile builder. The result is persisted to the case-scoped artifact root so
 * the profile panel and future rebuilds see the same file. An existing
 * (operator-edited) profile is never overwritten.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { CompositeObservation } from "./composite-serp-merge";
import type { ClassifierSubjectProfile } from "../orion-golden/analytics/subject-resolution-classifier";
import type { SubjectIdentityProfile } from "../orion-golden/identity/subject-identity-profile";
import { buildSubjectIdentityProfile } from "../orion-golden/identity/subject-identity-profile-builder";
import { classifierProfileFromIdentityProfile } from "./job-subject-profile";
import { compositeObservationsToInventory } from "./canonical-report-prepare";
import { subjectProfilePath } from "./subject-profile-admin";

export type CaseSubjectRef = { fullName: string; aliases: string[]; dateOfBirth?: string | null };

/**
 * Слить машинную находку в профиль кейса, не тронув то, что ввёл оператор.
 *
 * Раньше бутстрап писал файл только при его отсутствии — и кейс с уже
 * заведённым профилем не получал ни даты рождения, ни обновлённых предложений
 * (рецензия проекта нашла это на файле 0049 с тремя чужими ИНН). Слияние
 * решает обе задачи и остаётся идемпотентным: повтор на тех же данных даёт
 * дословно тот же файл.
 */
export function mergeDiscoveredIntoProfile(
  existing: SubjectIdentityProfile,
  built: SubjectIdentityProfile,
  birthDateIso: string | null
): SubjectIdentityProfile {
  const anchors = existing.anchors ?? { birthDate: null, phrases: [], inn: [], domains: [] };
  const merged: SubjectIdentityProfile = {
    ...existing,
    anchors: { ...anchors, birthDate: birthDateIso ?? anchors.birthDate ?? null },
    ...(built.discovered?.inn?.length ? { discovered: { inn: built.discovered.inn } } : {}),
    negativeIdentitySignals: {
      ...existing.negativeIdentitySignals,
      // Чужие отчества выводятся из корпуса и обновляются каждым прогоном:
      // они называют других людей, а не субъекта, и правкой оператора не являются.
      wrongPatronymics: uniqStrings([
        ...(existing.negativeIdentitySignals?.wrongPatronymics ?? []),
        ...(built.negativeIdentitySignals?.wrongPatronymics ?? []),
      ]),
    },
  };
  return merged;
}

function uniqStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

/** Case subject from DB; null when unavailable (offline tests inject it). */
async function loadCaseSubjectSafe(
  caseId: string,
  prisma: PrismaClient | null
): Promise<CaseSubjectRef | null> {
  if (!prisma) return null;
  try {
    const row = await prisma.case.findFirst({
      where: { id: caseId, deletedAt: null },
      select: {
        subjects: {
          select: { fullName: true, aliases: true, dateOfBirth: true },
          orderBy: { createdAt: "asc" },
          take: 1,
        },
      },
    });
    const subject = row?.subjects[0];
    if (!subject?.fullName) return null;
    return {
      fullName: subject.fullName,
      aliases: subject.aliases ?? [],
      dateOfBirth: subject.dateOfBirth ? subject.dateOfBirth.toISOString().slice(0, 10) : null,
    };
  } catch {
    return null;
  }
}

/** Файловое хранилище профиля кейса — умолчание для продакшна. */
const defaultProfileStore = {
  read(caseId: string): SubjectIdentityProfile | null {
    const path = subjectProfilePath(caseId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as SubjectIdentityProfile;
    } catch {
      return null;
    }
  },
  write(caseId: string, profile: SubjectIdentityProfile): void {
    const path = subjectProfilePath(caseId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  },
};

export type SubjectProfileBootstrapResult = {
  profile: ClassifierSubjectProfile;
  /** true when the case-root profile file was created by this bootstrap. */
  persistedToCaseRoot: boolean;
};

/**
 * Build a subject identity profile from the case subject plus the collected
 * composite observations, persist it to the case root when absent, and return
 * the classifier-ready profile. Returns null only when the case subject cannot
 * be resolved (then the prepare still fails closed with SUBJECT_PROFILE_MISSING).
 */
export async function bootstrapSubjectProfileFromCollection(input: {
  caseId: string;
  baseReportRunId: string;
  enrichmentRunId: string | null;
  observations: CompositeObservation[];
  /** Injected subject (offline tests); production resolves from the case. */
  subject?: CaseSubjectRef | null;
  prisma?: PrismaClient | null;
  /** Чтение и запись файла профиля; по умолчанию — файловая система кейса. */
  store?: {
    read: (caseId: string) => SubjectIdentityProfile | null;
    write: (caseId: string, profile: SubjectIdentityProfile) => void;
  };
}): Promise<SubjectProfileBootstrapResult | null> {
  const subject =
    input.subject ?? (await loadCaseSubjectSafe(input.caseId, input.prisma ?? null));
  if (!subject?.fullName?.trim()) return null;

  const items = compositeObservationsToInventory({
    caseId: input.caseId,
    baseReportRunId: input.baseReportRunId,
    enrichmentRunId: input.enrichmentRunId,
    observations: input.observations,
  });

  const built = buildSubjectIdentityProfile({
    caseId: input.caseId,
    subjectName: subject.fullName,
    aliases: subject.aliases,
    inventory: { items },
  });
  const birthDate = subject.dateOfBirth ?? null;

  const store = input.store ?? defaultProfileStore;
  let identity = mergeDiscoveredIntoProfile(built, built, birthDate);
  let persistedToCaseRoot = false;
  try {
    /*
     * Файл кейса дополняется, а не подменяется: якоря и тёзки ввёл оператор,
     * а дата рождения и предложения — машинная часть, и она обновляется каждым
     * прогоном. Раньше бутстрап звался только при отсутствии файла, и кейс с
     * заведённым профилем не получал ни даты рождения, ни свежих предложений —
     * ровно случай прогона DPA-2026-0049.
     */
    const previous = store.read(input.caseId);
    if (previous?.displayName) identity = mergeDiscoveredIntoProfile(previous, built, birthDate);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(identity)) {
      store.write(input.caseId, identity);
      persistedToCaseRoot = true;
    }
  } catch {
    // Persisting to the case root is best-effort; the job still gets a profile.
  }

  return { profile: classifierProfileFromIdentityProfile(identity), persistedToCaseRoot };
}
