/**
 * Import / bootstrap the primary CEO demo case: Глинка Сергей Михайлович.
 *
 * Steps:
 *  1) create (or reuse) case
 *  2) runFullAudit (real_first_with_fallback)
 *  3) R10 Golden content-brain → post-review client content (case-scoped)
 *  4) optional First36 live render
 *
 * Usage:
 *   npx tsx scripts/import-glinka-case.ts
 *   npx tsx scripts/import-glinka-case.ts --skip-audit
 *   npx tsx scripts/import-glinka-case.ts --skip-golden
 *   npx tsx scripts/import-glinka-case.ts --render-first36
 *   CASE_ID=cm... npx tsx scripts/import-glinka-case.ts --skip-create
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";

const SUBJECT_RU = "Глинка Сергей Михайлович";
/** Railway production primary demo case (DPA-2026-0012). */
const RAILWAY_GLINKA_CASE_ID = "cmreamy2t0002o30f29urzcog";
const ALIASES = [
  "Сергей Глинка",
  "Глинка Сергей",
  "Сергей Михайлович Глинка",
  "Sergey Glinka",
  "Sergei Glinka",
  "Glinka Sergey Mikhaylovich",
  "Sergey Mikhaylovich Glinka",
];

function bootstrapEnv(): void {
  process.env.DATABASE_URL ??=
    process.env.R10_DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5432/global_info?schema=public";
  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const parsed = parse(readFileSync(envPath));
    for (const [k, v] of Object.entries(parsed)) {
      if (v && !process.env[k]) process.env[k] = v;
    }
  }
  process.env.DIGITAL_PROFILE_AI_ANALYST_ENABLED ??= "true";
  process.env.DIGITAL_PROFILE_ORION_GOLDEN_ENABLED ??= "true";
  process.env.ORION_GPT_AUTO_ANALYST ??= "1";
  process.env.R10_CONTENT_BRAIN_ONLY ??= "1";
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function pointerPath(): string {
  return join(process.cwd(), "storage", "digital-profile", "glinka-case-id.txt");
}

function writePointer(caseId: string): void {
  const p = pointerPath();
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, `${caseId}\n`, "utf-8");
}

function readPointer(): string | null {
  const p = pointerPath();
  if (!existsSync(p)) return null;
  const id = readFileSync(p, "utf-8").trim();
  return id || null;
}

async function findExistingGlinkaCaseId(): Promise<string | null> {
  const { prisma } = await import("../src/server/prisma/client");
  const row = await prisma.case.findFirst({
    where: {
      deletedAt: null,
      subjects: {
        some: {
          OR: [
            { fullName: { equals: SUBJECT_RU } },
            { fullName: { contains: "Глинка Сергей Михайлович" } },
            { fullName: { contains: "Glinka Sergey", mode: "insensitive" } },
          ],
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, subjects: { select: { fullName: true }, take: 1 } },
  });
  return row?.id ?? null;
}

async function main() {
  bootstrapEnv();
  const skipCreate = hasFlag("--skip-create");
  const skipAudit = hasFlag("--skip-audit");
  const skipGolden = hasFlag("--skip-golden");
  const renderFirst36 = hasFlag("--render-first36");

  const { createCase } = await import("../src/modules/digital-profile/services/case-service");
  const { prisma } = await import("../src/server/prisma/client");

  let caseId =
    process.env.CASE_ID?.trim() ||
    process.env.GLINKA_CASE_ID?.trim() ||
    readPointer() ||
    RAILWAY_GLINKA_CASE_ID ||
    (await findExistingGlinkaCaseId());

  if (!caseId && skipCreate) {
    throw new Error("No Glinka caseId found and --skip-create was set");
  }

  if (!caseId) {
    console.log(`[import-glinka] creating case for ${SUBJECT_RU}`);
    const created = await createCase(
      {
        fullName: SUBJECT_RU,
        aliases: ALIASES,
        lawfulBasis: "LEGITIMATE_INTEREST",
        consentStatus: "NOT_REQUIRED",
        targetRegions: ["RU", "UAE", "INTERNATIONAL"],
        notes: "CEO First36 primary demo case — Sergey Glinka",
      },
      { actorId: "import-glinka-case" }
    );
    caseId = created.id;
  } else {
    console.log(`[import-glinka] reusing caseId=${caseId}`);
    const existing = await prisma.case.findFirst({
      where: { id: caseId, deletedAt: null },
      select: { id: true, subjects: { select: { fullName: true }, take: 1 } },
    });
    if (!existing) throw new Error(`case-not-found:${caseId}`);
    console.log(`[import-glinka] subject=${existing.subjects[0]?.fullName ?? "?"}`);
  }

  writePointer(caseId);
  console.log(`[import-glinka] CASE_ID=${caseId}`);
  console.log(`[import-glinka] pointer=${pointerPath()}`);

  if (!skipAudit) {
    console.log("[import-glinka] running full audit…");
    const { runFullAudit } = await import("../src/modules/digital-profile/services/agent-run-service");
    const audit = await runFullAudit(
      caseId,
      { actorId: "import-glinka-case" },
      { runtimeMode: "real_first_with_fallback" }
    );
    writeFileSync(
      join(process.cwd(), "storage", "digital-profile", "glinka-full-audit.json"),
      `${JSON.stringify(
        {
          caseId,
          outcome: audit.outcome,
          runtimeStrategy: audit.runtimeStrategy,
          runSummary: audit.runSummary,
        },
        null,
        2
      )}\n`,
      "utf-8"
    );
    console.log(`[import-glinka] audit outcome=${audit.outcome}`);
  } else {
    console.log("[import-glinka] skip audit");
  }

  const {
    ORION_GOLDEN_QA_STORAGE_ROOT,
    caseScopedArtifactRoot,
  } = await import("../src/modules/digital-profile/orion-golden/evidence/admin-review-decision-store");
  const outputRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId);
  mkdirSync(outputRoot, { recursive: true });

  if (!skipGolden) {
    // The legacy R10 content-brain / monolithic composer was retired. Report content
    // is now produced exclusively by the canonical unified job. This importer only
    // seeds the case + evidence; run the canonical report separately:
    //   POST /api/digital-profile/cases/<caseId>/unified-collection
    // (offline canonical replay: npm run smoke:canonical-orchestration-e2e).
    console.log(
      `[import-glinka] golden content-brain retired — run the canonical unified job for ${caseId} (POST /unified-collection). Case + evidence seeded at ${outputRoot}.`
    );
  } else {
    console.log("[import-glinka] skip golden");
  }

  // Evidence counts for orientation
  const counts = await prisma.case.findUnique({
    where: { id: caseId },
    select: {
      _count: {
        select: {
          searchResults: true,
          searchSurfaceItems: true,
          databaseProfiles: true,
          riskFindings: true,
        },
      },
    },
  });
  console.log(`[import-glinka] evidence counts`, counts?._count);

  if (renderFirst36) {
    // Legacy First36 monolithic render retired. Use the canonical unified job render.
    console.log(
      "[import-glinka] First36 legacy render retired — render via the canonical unified job (one DeckAssembler + one renderer)."
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        caseId,
        subject: SUBJECT_RU,
        artifactRoot: outputRoot,
        pointer: pointerPath(),
        next: `npm run render:first36-live -- ${caseId}`,
      },
      null,
      2
    )
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    const { prisma } = await import("../src/server/prisma/client");
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
});
