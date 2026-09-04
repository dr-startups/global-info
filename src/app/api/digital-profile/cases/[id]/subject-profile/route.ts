/**
 * /api/digital-profile/cases/[id]/subject-profile
 *   GET — case-owned subject identity profile (or the generic default built
 *         from the case subject when none is persisted yet)
 *   PUT — save operator edits (anchors, aliases, namesakes, negative signals);
 *         self-conflicting negatives are dropped fail-closed and reported.
 *         The birth date is not an editable field: it comes from the case
 *         subject card, whatever the body says.
 *
 * Changes affect classification only after «Пересобрать отчёт» / a new job —
 * this route never triggers collection or render by itself.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule, ValidationError, NotFoundError } from "@/modules/digital-profile/http/errors";
import { readJsonBody } from "@/modules/digital-profile/http/request";
import {
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import {
  getSubjectProfileForEdit,
  saveSubjectProfileEdits,
  type SubjectProfileEdits,
} from "@/modules/digital-profile/services/subject-profile-admin";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function loadCaseSubject(
  caseId: string
): Promise<{ fullName: string; aliases: string[]; dateOfBirth: string | null }> {
  const { prisma } = await import("@/server/prisma/client");
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
  if (!row) throw new NotFoundError("Case not found");
  const subject = row.subjects[0];
  if (!subject?.fullName) throw new ValidationError("case has no subject");
  return {
    fullName: subject.fullName,
    aliases: subject.aliases ?? [],
    // Дата рождения — признак субъекта, и в профиль она приходит отсюда.
    dateOfBirth: subject.dateOfBirth ? subject.dateOfBirth.toISOString().slice(0, 10) : null,
  };
}

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ValidationError(`${field} must be an array of strings`);
  }
  return value as string[];
}

function parseEdits(body: Record<string, unknown>): SubjectProfileEdits {
  const namesakesRaw = body.namesakeProfiles;
  let namesakeProfiles: SubjectProfileEdits["namesakeProfiles"];
  if (namesakesRaw !== undefined) {
    if (!Array.isArray(namesakesRaw)) {
      throw new ValidationError("namesakeProfiles must be an array");
    }
    namesakeProfiles = namesakesRaw.map((n) => {
      const obj = (n ?? {}) as Record<string, unknown>;
      return {
        label: String(obj.label ?? ""),
        noiseTerms: stringList(obj.noiseTerms ?? [], "namesakeProfiles.noiseTerms") ?? [],
      };
    });
  }
  const anchorsRaw = body.anchors;
  let anchors: SubjectProfileEdits["anchors"];
  if (anchorsRaw !== undefined) {
    if (!anchorsRaw || typeof anchorsRaw !== "object" || Array.isArray(anchorsRaw)) {
      throw new ValidationError("anchors must be an object");
    }
    const obj = anchorsRaw as Record<string, unknown>;
    const phrasesRaw = obj.phrases;
    if (phrasesRaw !== undefined && !Array.isArray(phrasesRaw)) {
      throw new ValidationError("anchors.phrases must be an array");
    }
    anchors = {
      birthDate: obj.birthDate == null ? null : String(obj.birthDate),
      phrases: ((phrasesRaw as unknown[]) ?? []).map((p) => {
        const row = (p ?? {}) as Record<string, unknown>;
        return {
          kind: String(row.kind ?? "fact") as NonNullable<SubjectProfileEdits["anchors"]>["phrases"][number]["kind"],
          text: String(row.text ?? ""),
          strong: row.strong === true,
        };
      }),
      inn: stringList(obj.inn, "anchors.inn") ?? [],
      domains: stringList(obj.domains, "anchors.domains") ?? [],
    };
  }
  return {
    anchors,
    contextIdentifiers: stringList(body.contextIdentifiers, "contextIdentifiers"),
    aliases: stringList(body.aliases, "aliases"),
    unrelatedKnownPersons: stringList(body.unrelatedKnownPersons, "unrelatedKnownPersons"),
    wrongPatronymics: stringList(body.wrongPatronymics, "wrongPatronymics"),
    namesakeProfiles,
    inn: stringList(body.inn, "inn"),
  };
}

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "case.view");
  await requireCaseAccess(user, id, "VIEWER");
  const subject = await loadCaseSubject(id);
  const data = getSubjectProfileForEdit({
    caseId: id,
    subjectName: subject.fullName,
    subjectAliases: subject.aliases,
    subjectDateOfBirth: subject.dateOfBirth,
  });
  return jsonOk(data);
});

export const PUT = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "case.update");
  await requireCaseAccess(user, id, "EDITOR");
  const subject = await loadCaseSubject(id);
  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const data = saveSubjectProfileEdits({
    caseId: id,
    subjectName: subject.fullName,
    subjectAliases: subject.aliases,
    subjectDateOfBirth: subject.dateOfBirth,
    edits: parseEdits(body),
  });
  return jsonOk(data);
});
