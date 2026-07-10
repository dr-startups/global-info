/**
 * Clone Railway production Glinka case (DPA-2026-0012) into local Postgres.
 *
 *   npx tsx --env-file=.env scripts/clone-railway-glinka-case.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "dotenv";
import { PrismaClient, type Prisma } from "@prisma/client";

const RAILWAY_CASE_ID = "cmreamy2t0002o30f29urzcog";
const RAILWAY_CASE_NUMBER = "DPA-2026-0012";

function bootstrapLocalEnv(): void {
  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const parsed = parse(readFileSync(envPath));
    for (const [k, v] of Object.entries(parsed)) {
      if (v && !process.env[k]) process.env[k] = v;
    }
  }
  process.env.DATABASE_URL ??=
    "postgresql://postgres:postgres@localhost:5432/global_info?schema=public";
}

function railwayPublicDbUrl(): string {
  if (process.env.RAILWAY_DB?.trim()) return process.env.RAILWAY_DB.trim();
  const res = spawnSync("railway", ["variables", "--service", "Postgres", "--json"], {
    encoding: "utf-8",
    shell: true,
  });
  if (res.status !== 0) throw new Error(`railway variables failed: ${res.stderr || res.stdout}`);
  const vars = JSON.parse(res.stdout) as Record<string, string>;
  const url = vars.DATABASE_PUBLIC_URL;
  if (!url) throw new Error("DATABASE_PUBLIC_URL missing");
  return url;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

async function createManyBatched<T>(
  label: string,
  rows: T[],
  insert: (batch: T[]) => Promise<unknown>,
  batchSize = 80
): Promise<void> {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    await insert(batch);
    console.log(`[clone-glinka] ${label} ${Math.min(i + batch.length, rows.length)}/${rows.length}`);
  }
}

async function main() {
  bootstrapLocalEnv();
  const remote = new PrismaClient({ datasources: { db: { url: railwayPublicDbUrl() } } });
  const local = new PrismaClient();

  const remoteCase = await remote.case.findFirst({
    where: { id: RAILWAY_CASE_ID, deletedAt: null },
    include: { subjects: true },
  });
  if (!remoteCase) throw new Error("railway-case-not-found");
  console.log(`[clone-glinka] subject=${remoteCase.subjects[0]?.fullName}`);

  const numberClash = await local.case.findFirst({
    where: { caseNumber: RAILWAY_CASE_NUMBER, NOT: { id: RAILWAY_CASE_ID } },
    select: { id: true },
  });
  if (numberClash) {
    const renamed = `${RAILWAY_CASE_NUMBER}-LOCAL-${numberClash.id.slice(-6)}`;
    console.log(`[clone-glinka] rename clash → ${renamed}`);
    await local.case.update({ where: { id: numberClash.id }, data: { caseNumber: renamed } });
  }

  if (await local.case.findFirst({ where: { id: RAILWAY_CASE_ID }, select: { id: true } })) {
    console.log("[clone-glinka] deleting previous local clone…");
    await local.case.delete({ where: { id: RAILWAY_CASE_ID } });
  }

  await local.case.create({
    data: {
      id: remoteCase.id,
      caseNumber: remoteCase.caseNumber,
      title: remoteCase.title,
      status: remoteCase.status,
      lawfulBasis: remoteCase.lawfulBasis,
      consentStatus: remoteCase.consentStatus,
      targetRegions: remoteCase.targetRegions,
      createdBy: remoteCase.createdBy || "railway-clone",
      reviewedBy: remoteCase.reviewedBy,
      reviewedAt: remoteCase.reviewedAt,
      notes: remoteCase.notes,
      createdAt: remoteCase.createdAt,
      updatedAt: remoteCase.updatedAt,
      subjects: {
        create: remoteCase.subjects.map((s) => ({
          id: s.id,
          fullName: s.fullName,
          aliases: s.aliases,
          dateOfBirth: s.dateOfBirth,
          nationality: s.nationality,
          country: s.country,
          emails: s.emails,
          phones: s.phones,
          identifiers: s.identifiers === null ? undefined : toJson(s.identifiers),
          notes: s.notes,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        })),
      },
    },
  });

  const [
    searchQueries,
    searchResults,
    surfaces,
    dbProfiles,
    risks,
    wiki,
    screenshots,
    reportVersions,
    serpObservations,
    serpSynthetic,
    serpCaptures,
  ] = await Promise.all([
    remote.searchQuery.findMany({ where: { caseId: RAILWAY_CASE_ID } }),
    remote.searchResult.findMany({ where: { caseId: RAILWAY_CASE_ID } }),
    remote.searchSurfaceItem.findMany({ where: { caseId: RAILWAY_CASE_ID } }),
    remote.databaseProfile.findMany({ where: { caseId: RAILWAY_CASE_ID } }),
    remote.riskFinding.findMany({ where: { caseId: RAILWAY_CASE_ID } }),
    remote.wikipediaCheck.findMany({ where: { caseId: RAILWAY_CASE_ID } }),
    remote.screenshot.findMany({ where: { caseId: RAILWAY_CASE_ID } }),
    remote.reportVersion.findMany({ where: { caseId: RAILWAY_CASE_ID } }),
    remote.serpObservation.findMany({ where: { caseId: RAILWAY_CASE_ID } }),
    remote.serpSyntheticAsset.findMany({ where: { caseId: RAILWAY_CASE_ID } }),
    remote.serpCapture.findMany({ where: { caseId: RAILWAY_CASE_ID } }),
  ]);

  console.log("[clone-glinka] remote counts", {
    searchQueries: searchQueries.length,
    searchResults: searchResults.length,
    surfaces: surfaces.length,
    dbProfiles: dbProfiles.length,
    risks: risks.length,
    wiki: wiki.length,
    screenshots: screenshots.length,
    reportVersions: reportVersions.length,
    serpObservations: serpObservations.length,
    serpSynthetic: serpSynthetic.length,
    serpCaptures: serpCaptures.length,
  });

  await createManyBatched("searchQuery", searchQueries, (batch) =>
    local.searchQuery.createMany({
      data: batch.map((q) => ({
        id: q.id,
        caseId: q.caseId,
        engine: q.engine,
        queryText: q.queryText,
        source: q.source,
        createdBy: q.createdBy,
        createdAt: q.createdAt,
      })),
      skipDuplicates: true,
    })
  );

  await createManyBatched("searchResult", searchResults, (batch) =>
    local.searchResult.createMany({
      data: batch.map((r) => ({
        id: r.id,
        caseId: r.caseId,
        queryId: r.queryId,
        engine: r.engine,
        url: r.url,
        normalizedUrl: r.normalizedUrl,
        dedupHash: r.dedupHash,
        title: r.title,
        snippet: r.snippet,
        rank: r.rank,
        classification: r.classification,
        reviewStatus: r.reviewStatus,
        source: r.source,
        rawMetadata: r.rawMetadata === null ? undefined : toJson(r.rawMetadata),
        createdAt: r.createdAt,
      })),
      skipDuplicates: true,
    })
  );

  await createManyBatched("surface", surfaces, (batch) =>
    local.searchSurfaceItem.createMany({
      data: batch.map((r) => ({
        id: r.id,
        caseId: r.caseId,
        type: r.type,
        provider: r.provider,
        source: r.source,
        query: r.query,
        region: r.region,
        language: r.language,
        title: r.title,
        snippet: r.snippet,
        url: r.url,
        domain: r.domain,
        imageUrl: r.imageUrl,
        thumbnailUrl: r.thumbnailUrl,
        videoUrl: r.videoUrl,
        rank: r.rank,
        classification: r.classification,
        riskTheme: r.riskTheme,
        rawMetadata: r.rawMetadata === null ? undefined : toJson(r.rawMetadata),
        dedupHash: r.dedupHash,
        capturedAt: r.capturedAt,
        demo: r.demo,
        reviewStatus: r.reviewStatus,
        deletedAt: r.deletedAt,
        deletedBy: r.deletedBy,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      skipDuplicates: true,
    })
  );

  if (dbProfiles.length) {
    await local.databaseProfile.createMany({
      data: dbProfiles.map((r) => ({
        id: r.id,
        caseId: r.caseId,
        provider: r.provider,
        importMethod: r.importMethod,
        matchType: r.matchType,
        matchScore: r.matchScore,
        evidenceRefs: toJson(r.evidenceRefs),
        importedBy: r.importedBy,
        importedAt: r.importedAt,
        hitSource: r.hitSource,
        subjectName: r.subjectName,
        matchedName: r.matchedName,
        aliases: toJson(r.aliases),
        categories: toJson(r.categories),
        riskTypes: toJson(r.riskTypes),
        countries: toJson(r.countries),
        datesOfBirth: toJson(r.datesOfBirth),
        confidence: r.confidence,
        profileId: r.profileId,
        profileUrl: r.profileUrl,
        summary: r.summary,
        reviewStatus: r.reviewStatus,
        reviewedBy: r.reviewedBy,
        reviewedAt: r.reviewedAt,
        rawMetadataSafe: r.rawMetadataSafe === null ? undefined : toJson(r.rawMetadataSafe),
      })),
      skipDuplicates: true,
    });
  }

  if (risks.length) {
    await local.riskFinding.createMany({
      data: risks.map((r) => ({
        id: r.id,
        caseId: r.caseId,
        category: r.category,
        severity: r.severity,
        title: r.title,
        summary: r.summary,
        evidenceRefs: toJson(r.evidenceRefs),
        reviewStatus: r.reviewStatus,
        reviewedBy: r.reviewedBy,
        reviewedAt: r.reviewedAt,
        createdBy: r.createdBy,
        signalType: r.signalType,
        riskTheme: r.riskTheme,
        confidence: r.confidence,
        rationale: r.rationale,
        demo: r.demo,
        dedupHash: r.dedupHash,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      skipDuplicates: true,
    });
  }

  if (wiki.length) {
    await local.wikipediaCheck.createMany({
      data: wiki.map((r) => ({
        id: r.id,
        caseId: r.caseId,
        exists: r.exists,
        url: r.url,
        language: r.language,
        pageTitle: r.pageTitle,
        snapshot: r.snapshot === null ? undefined : toJson(r.snapshot),
        lastChecked: r.lastChecked,
        checkedBy: r.checkedBy,
      })),
      skipDuplicates: true,
    });
  }

  if (screenshots.length) {
    await local.screenshot.createMany({
      data: screenshots.map((r) => ({
        id: r.id,
        caseId: r.caseId,
        resultId: r.resultId,
        storageKey: r.storageKey,
        mimeType: r.mimeType,
        sha256: r.sha256,
        sizeBytes: r.sizeBytes,
        sourceUrl: r.sourceUrl,
        capturedAt: r.capturedAt,
        capturedBy: r.capturedBy,
        deletedAt: r.deletedAt,
        deletedBy: r.deletedBy,
      })),
      skipDuplicates: true,
    });
  }

  if (reportVersions.length) {
    await local.reportVersion.createMany({
      data: reportVersions.map((r) => ({
        id: r.id,
        caseId: r.caseId,
        version: r.version,
        status: r.status,
        reportJson: toJson(r.reportJson),
        pptxUrl: r.pptxUrl,
        pdfUrl: r.pdfUrl,
        pptxStorageKey: r.pptxStorageKey,
        pdfStorageKey: r.pdfStorageKey,
        renderedAt: r.renderedAt,
        templateVersion: r.templateVersion,
        renderWarnings: r.renderWarnings === null ? undefined : toJson(r.renderWarnings),
        watermark: r.watermark,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
      })),
      skipDuplicates: true,
    });
  }

  // OrionReportRun rows required by SERP FK.
  const runIds = new Set<string>();
  for (const r of serpObservations) runIds.add(r.auditRunId);
  for (const r of serpSynthetic) runIds.add(r.auditRunId);
  for (const r of serpCaptures) runIds.add(r.reportRunId);
  for (const runId of runIds) {
    await local.orionReportRun.upsert({
      where: { id: runId },
      create: {
        id: runId,
        caseId: RAILWAY_CASE_ID,
        mode: "railway_clone",
        storeMode: "file",
        status: "active",
        internalOnly: true,
        metadataJson: { clonedFrom: "railway", caseNumber: RAILWAY_CASE_NUMBER },
      },
      update: {},
    });
  }
  console.log(`[clone-glinka] orionReportRuns ensured=${runIds.size}`);

  if (serpObservations.length) {
    await createManyBatched("serpObservation", serpObservations, (batch) =>
      local.serpObservation.createMany({
        data: batch.map((r) => ({
          id: r.id,
          caseId: r.caseId,
          auditRunId: r.auditRunId,
          queryId: r.queryId,
          queryText: r.queryText,
          provider: r.provider,
          engine: r.engine,
          surface: r.surface,
          region: r.region,
          language: r.language,
          rank: r.rank,
          url: r.url,
          title: r.title,
          snippet: r.snippet,
          domain: r.domain,
          searchDocumentId: null,
          providerStatus: r.providerStatus,
          rawPayloadJson: r.rawPayloadJson === null ? undefined : toJson(r.rawPayloadJson),
          capturedAt: r.capturedAt,
          createdAt: r.createdAt,
        })),
        skipDuplicates: true,
      })
    );
  }

  if (serpSynthetic.length) {
    await createManyBatched("serpSynthetic", serpSynthetic, (batch) =>
      local.serpSyntheticAsset.createMany({
        data: batch.map((r) => ({
          id: r.id,
          caseId: r.caseId,
          auditRunId: r.auditRunId,
          queryId: r.queryId,
          provider: r.provider,
          engine: r.engine,
          surface: r.surface,
          region: r.region,
          language: r.language,
          storageKey: r.storageKey,
          sha256: r.sha256,
          mimeType: r.mimeType,
          width: r.width,
          height: r.height,
          caption: r.caption,
          status: r.status,
          createdAt: r.createdAt,
        })),
        skipDuplicates: true,
      })
    );
  }

  if (serpCaptures.length) {
    await local.serpCapture.createMany({
      data: serpCaptures.map((r) => ({
        id: r.id,
        caseId: r.caseId,
        reportRunId: r.reportRunId,
        query: r.query,
        queryHash: r.queryHash,
        engine: r.engine,
        region: r.region,
        locale: r.locale,
        device: r.device,
        captureStatus: r.captureStatus,
        geoStatus: r.geoStatus,
        connectionMode: r.connectionMode,
        storageKey: r.storageKey,
        sha256: r.sha256,
        sourceUrl: r.sourceUrl,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        capturedAt: r.capturedAt,
        capturedBy: r.capturedBy,
        metadataJson: r.metadataJson === null ? undefined : toJson(r.metadataJson),
        errorJson: r.errorJson === null ? undefined : toJson(r.errorJson),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      skipDuplicates: true,
    });
  }

  const pointer = join(process.cwd(), "storage", "digital-profile", "glinka-case-id.txt");
  mkdirSync(join(pointer, ".."), { recursive: true });
  writeFileSync(pointer, `${RAILWAY_CASE_ID}\n`, "utf-8");

  const verify = await local.case.findUnique({
    where: { id: RAILWAY_CASE_ID },
    select: {
      caseNumber: true,
      consentStatus: true,
      createdAt: true,
      subjects: { select: { fullName: true }, take: 1 },
      _count: {
        select: {
          searchResults: true,
          searchSurfaceItems: true,
          databaseProfiles: true,
          riskFindings: true,
          serpObservations: true,
        },
      },
    },
  });

  const metaPath = join(process.cwd(), "storage", "digital-profile", "glinka-railway-clone.json");
  writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        clonedAt: new Date().toISOString(),
        caseId: RAILWAY_CASE_ID,
        caseNumber: RAILWAY_CASE_NUMBER,
        baselinePdf: "orion-classic-audit (53).pdf",
        verify,
      },
      null,
      2
    )}\n`,
    "utf-8"
  );

  console.log(JSON.stringify({ ok: true, pointer, verify }, null, 2));
  await remote.$disconnect();
  await local.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
});
