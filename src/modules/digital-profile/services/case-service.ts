/**
 * Case service for the Digital Profile module.
 *
 * Encapsulates all case CRUD + summary logic. Uses the shared Prisma client and
 * the `dp_*` models. Delete is always a soft delete (sets `deletedAt`). Returns
 * typed DTOs that expose only the fields the UI/API needs.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/server/prisma/client";
import { NotFoundError } from "../http/errors";
import { recordAudit } from "./audit-log-service";
import type {
  CaseStatus,
  ConsentStatus,
  LawfulBasis,
} from "../types";
import type {
  CreateDigitalProfileCaseInput,
  ListDigitalProfileCasesQuery,
  UpdateDigitalProfileCaseInput,
} from "../validation/case-schemas";

export interface ActorContext {
  /** Nullable until auth exists. */
  actorId?: string | null;
}

export interface CaseSubjectDTO {
  id: string;
  fullName: string;
  aliases: string[];
  dateOfBirth: Date | null;
  nationality: string | null;
  country: string | null;
}

export interface CaseDTO {
  id: string;
  caseNumber: string;
  title: string;
  status: CaseStatus;
  lawfulBasis: LawfulBasis | null;
  consentStatus: ConsentStatus;
  targetRegions: string[];
  notes: string | null;
  createdBy: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  subject: CaseSubjectDTO | null;
}

export interface CaseListItemDTO {
  id: string;
  caseNumber: string;
  title: string;
  status: CaseStatus;
  consentStatus: ConsentStatus;
  subjectName: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaginatedCases {
  items: CaseListItemDTO[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CaseSummaryDTO {
  id: string;
  caseNumber: string;
  title: string;
  status: CaseStatus;
  consentStatus: ConsentStatus;
  lawfulBasis: LawfulBasis | null;
  createdAt: Date;
  updatedAt: Date;
  counts: {
    subjects: number;
    searchQueries: number;
    searchResults: number;
    screenshots: number;
    riskFindings: number;
    databaseProfiles: number;
    wikipediaChecks: number;
    aiProfiles: number;
    reportVersions: number;
    agentRuns: number;
  };
}

const caseSelect = {
  id: true,
  caseNumber: true,
  title: true,
  status: true,
  lawfulBasis: true,
  consentStatus: true,
  targetRegions: true,
  notes: true,
  createdBy: true,
  reviewedBy: true,
  reviewedAt: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
  subjects: {
    select: {
      id: true,
      fullName: true,
      aliases: true,
      dateOfBirth: true,
      nationality: true,
      country: true,
    },
    orderBy: { createdAt: "asc" },
    take: 1,
  },
} satisfies Prisma.CaseSelect;

type CaseWithSubject = Prisma.CaseGetPayload<{ select: typeof caseSelect }>;

function toCaseDTO(row: CaseWithSubject): CaseDTO {
  const subject = row.subjects[0] ?? null;
  return {
    id: row.id,
    caseNumber: row.caseNumber,
    title: row.title,
    status: row.status as CaseStatus,
    lawfulBasis: row.lawfulBasis as LawfulBasis | null,
    consentStatus: row.consentStatus as ConsentStatus,
    targetRegions: row.targetRegions,
    notes: row.notes,
    createdBy: row.createdBy,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    subject: subject
      ? {
          id: subject.id,
          fullName: subject.fullName,
          aliases: subject.aliases,
          dateOfBirth: subject.dateOfBirth,
          nationality: subject.nationality,
          country: subject.country,
        }
      : null,
  };
}

async function generateCaseNumber(
  tx: Prisma.TransactionClient
): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `DPA-${year}-`;
  const count = await tx.case.count({
    where: { caseNumber: { startsWith: prefix } },
  });
  return `${prefix}${String(count + 1).padStart(4, "0")}`;
}

/** Fetches an active (non-deleted) case id or throws NotFound. */
async function findActiveCaseOrThrow(caseId: string): Promise<{ id: string }> {
  const found = await prisma.case.findFirst({
    where: { id: caseId, deletedAt: null },
    select: { id: true },
  });
  if (!found) throw new NotFoundError("Case not found");
  return found;
}

export async function createCase(
  input: CreateDigitalProfileCaseInput,
  ctx: ActorContext = {}
): Promise<CaseDTO> {
  const createdBy = ctx.actorId ?? "system";

  // Retry once on the rare caseNumber race (unique constraint).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const row = await prisma.$transaction(async (tx) => {
        const caseNumber = await generateCaseNumber(tx);
        const created = await tx.case.create({
          data: {
            caseNumber,
            title: `Digital Profile Audit — ${input.fullName}`,
            status: "DRAFT",
            lawfulBasis: input.lawfulBasis,
            consentStatus: input.consentStatus,
            targetRegions: input.targetRegions ?? [],
            notes: input.notes,
            createdBy,
            subjects: {
              create: {
                fullName: input.fullName,
                aliases: input.aliases ?? [],
                dateOfBirth: input.birthDate ?? null,
              },
            },
          },
          select: caseSelect,
        });
        await recordAudit(
          {
            caseId: created.id,
            action: "CASE_CREATED",
            actorId: ctx.actorId,
            metadata: { caseNumber },
          },
          tx
        );
        return created;
      });
      return toCaseDTO(row);
    } catch (err) {
      const isUnique =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002";
      if (isUnique && attempt === 0) continue;
      throw err;
    }
  }
  // Unreachable, but keeps TypeScript happy.
  throw new Error("Failed to create case");
}

export interface ListCasesOptions {
  restrictToCaseIds?: string[] | null;
  /**
   * Показать кейсы-фикстуры смоков. По умолчанию нет: список принадлежит
   * оператору, а фикстуры — это следы прогонов смоков (шаг 13, B6).
   */
  includeFixtures?: boolean;
}

/**
 * Условие выборки для списка кейсов.
 *
 * Вынесено отдельно, потому что здесь решается, что оператор видит, а что нет,
 * и это решение проверяется тестом, а не живой базой.
 */
export function caseListWhere(
  params: Partial<Pick<ListDigitalProfileCasesQuery, "status" | "q" | "includeDeleted">>,
  opts: ListCasesOptions = {}
): Prisma.CaseWhereInput {
  const { status, q, includeDeleted } = params;
  return {
    ...(includeDeleted ? {} : { deletedAt: null }),
    ...(opts.includeFixtures ? {} : { isFixture: false }),
    ...(opts.restrictToCaseIds ? { id: { in: opts.restrictToCaseIds } } : {}),
    ...(status ? { status } : {}),
    ...(q
      ? {
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { caseNumber: { contains: q, mode: "insensitive" } },
            {
              subjects: {
                some: { fullName: { contains: q, mode: "insensitive" } },
              },
            },
          ],
        }
      : {}),
  };
}

export async function listCases(
  params: ListDigitalProfileCasesQuery,
  opts: ListCasesOptions = {}
): Promise<PaginatedCases> {
  const { page, pageSize } = params;

  // CLIENT_VIEWER (or any restricted user) only ever sees granted cases. An
  // empty array means "no accessible cases" -> empty page.
  if (opts.restrictToCaseIds && opts.restrictToCaseIds.length === 0) {
    return { items: [], total: 0, page, pageSize };
  }

  const where = caseListWhere(params, opts);

  const [rows, total] = await Promise.all([
    prisma.case.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        caseNumber: true,
        title: true,
        status: true,
        consentStatus: true,
        deletedAt: true,
        createdAt: true,
        updatedAt: true,
        subjects: {
          select: { fullName: true },
          orderBy: { createdAt: "asc" },
          take: 1,
        },
      },
    }),
    prisma.case.count({ where }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      caseNumber: row.caseNumber,
      title: row.title,
      status: row.status as CaseStatus,
      consentStatus: row.consentStatus as ConsentStatus,
      subjectName: row.subjects[0]?.fullName ?? null,
      deletedAt: row.deletedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    total,
    page,
    pageSize,
  };
}

export async function getCaseById(
  caseId: string,
  ctx: ActorContext = {}
): Promise<CaseDTO> {
  const row = await prisma.case.findFirst({
    where: { id: caseId, deletedAt: null },
    select: caseSelect,
  });
  if (!row) throw new NotFoundError("Case not found");

  await recordAudit({
    caseId,
    action: "CASE_VIEWED",
    actorId: ctx.actorId,
  });

  return toCaseDTO(row);
}

export async function updateCase(
  caseId: string,
  input: UpdateDigitalProfileCaseInput,
  ctx: ActorContext = {}
): Promise<CaseDTO> {
  await findActiveCaseOrThrow(caseId);

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.case.update({
      where: { id: caseId },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.lawfulBasis !== undefined
          ? { lawfulBasis: input.lawfulBasis }
          : {}),
        ...(input.consentStatus !== undefined
          ? { consentStatus: input.consentStatus }
          : {}),
        ...(input.targetRegions !== undefined
          ? { targetRegions: input.targetRegions }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      select: caseSelect,
    });
    await recordAudit(
      {
        caseId,
        action: "CASE_UPDATED",
        actorId: ctx.actorId,
        metadata: { fields: Object.keys(input) },
      },
      tx
    );
    return updated;
  });

  return toCaseDTO(row);
}

export interface SoftDeletedCase {
  id: string;
  deletedAt: Date | null;
}

export async function deleteCaseSoft(
  caseId: string,
  ctx: ActorContext = {}
): Promise<SoftDeletedCase> {
  await findActiveCaseOrThrow(caseId);

  const row = await prisma.$transaction(async (tx) => {
    const deleted = await tx.case.update({
      where: { id: caseId },
      data: {
        deletedAt: new Date(),
        deletedBy: ctx.actorId ?? "system",
        status: "ARCHIVED",
      },
      select: { id: true, deletedAt: true },
    });
    await recordAudit(
      {
        caseId,
        action: "CASE_SOFT_DELETED",
        actorId: ctx.actorId,
      },
      tx
    );
    return deleted;
  });

  return row;
}

export async function getCaseSummary(
  caseId: string
): Promise<CaseSummaryDTO> {
  const row = await prisma.case.findFirst({
    where: { id: caseId, deletedAt: null },
    select: {
      id: true,
      caseNumber: true,
      title: true,
      status: true,
      consentStatus: true,
      lawfulBasis: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          subjects: true,
          searchQueries: true,
          searchResults: true,
          screenshots: true,
          riskFindings: true,
          databaseProfiles: true,
          wikipediaChecks: true,
          aiProfiles: true,
          reportVersions: true,
          agentRuns: true,
        },
      },
    },
  });
  if (!row) throw new NotFoundError("Case not found");

  return {
    id: row.id,
    caseNumber: row.caseNumber,
    title: row.title,
    status: row.status as CaseStatus,
    consentStatus: row.consentStatus as ConsentStatus,
    lawfulBasis: row.lawfulBasis as LawfulBasis | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    counts: row._count,
  };
}
