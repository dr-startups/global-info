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

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { CompositeObservation } from "./composite-serp-merge";
import type { ClassifierSubjectProfile } from "../orion-golden/analytics/subject-resolution-classifier";
import { buildSubjectIdentityProfile } from "../orion-golden/identity/subject-identity-profile-builder";
import { classifierProfileFromIdentityProfile } from "./job-subject-profile";
import { compositeObservationsToInventory } from "./canonical-report-prepare";
import { subjectProfilePath } from "./subject-profile-admin";

export type CaseSubjectRef = { fullName: string; aliases: string[] };

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
          select: { fullName: true, aliases: true },
          orderBy: { createdAt: "asc" },
          take: 1,
        },
      },
    });
    const subject = row?.subjects[0];
    if (!subject?.fullName) return null;
    return { fullName: subject.fullName, aliases: subject.aliases ?? [] };
  } catch {
    return null;
  }
}

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

  const identity = buildSubjectIdentityProfile({
    caseId: input.caseId,
    subjectName: subject.fullName,
    aliases: subject.aliases,
    inventory: { items },
  });

  let persistedToCaseRoot = false;
  try {
    const path = subjectProfilePath(input.caseId);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
      persistedToCaseRoot = true;
    }
  } catch {
    // Persisting to the case root is best-effort; the job still gets a profile.
  }

  return { profile: classifierProfileFromIdentityProfile(identity), persistedToCaseRoot };
}
