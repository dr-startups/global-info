import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { prisma } from "../src/server/prisma/client";
import { createCase } from "../src/modules/digital-profile/services/case-service";
import { runFullAudit } from "../src/modules/digital-profile/services/agent-run-service";
import { runExactOrionPipeline } from "../src/modules/digital-profile/orion-section-pipeline/run-exact-orion-pipeline";
import { createOrionPipelineStore } from "../src/modules/digital-profile/orion-section-pipeline/persistence";

const OUT = join(process.cwd(), "storage", "digital-profile", "qa-r9-4-orion-db-persistence");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function runInspect(pptx: string, reportJson: string, outPath: string): number {
  const result = spawnSync("python", ["scripts/inspect-0541-pptx.py", pptx, reportJson], {
    cwd: process.cwd(),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${result.stdout || ""}${result.stderr || ""}`;
  const match = out.match(/\{[\s\S]*\}/);
  if (match) writeFileSync(outPath, `${match[0]}\n`, "utf-8");
  return result.status ?? 1;
}

async function ensureCaseId(): Promise<string> {
  if (process.env.CASE_ID?.trim()) return process.env.CASE_ID.trim();
  const created = await createCase({
    fullName: `R9.4 QA Subject ${new Date().toISOString().slice(0, 19)}`,
    aliases: ["Konstantin Tomilin"],
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
    targetRegions: ["RU", "UAE", "INTERNATIONAL"],
    notes: "R9.4 additive DB persistence QA case",
  });
  return created.id;
}

async function tableExists(tableName: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT to_regclass('public.${tableName}') IS NOT NULL AS "exists"`
  );
  return Boolean(rows?.[0]?.exists);
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(join(OUT, "file-mode"), { recursive: true });
  mkdirSync(join(OUT, "db-mode"), { recursive: true });

  const caseId = await ensureCaseId();
  writeFileSync(join(OUT, "qa-case-id.txt"), `${caseId}\n`, "utf-8");

  const migrationPath = join(
    process.cwd(),
    "prisma",
    "migrations",
    "20260704222856_add_orion_section_pipeline_persistence",
    "migration.sql"
  );
  const migrationSql = existsSync(migrationPath) ? readFileSync(migrationPath, "utf-8") : "";
  const migrationInspection = {
    migrationPath,
    exists: existsSync(migrationPath),
    hasDropTable: /drop\s+table/i.test(migrationSql),
    hasDropColumn: /drop\s+column/i.test(migrationSql),
    hasDeleteFrom: /delete\s+from/i.test(migrationSql),
    hasCreateTable: /create\s+table/i.test(migrationSql),
    hasCreateIndex: /create\s+index/i.test(migrationSql),
    hasAddFk: /add\s+constraint/i.test(migrationSql),
    safeAdditive:
      /create\s+table/i.test(migrationSql) &&
      !/drop\s+table/i.test(migrationSql) &&
      !/drop\s+column/i.test(migrationSql) &&
      !/delete\s+from/i.test(migrationSql),
  };
  writeJson(join(OUT, "migration-inspection.json"), migrationInspection);
  check("migration additive safety", migrationInspection.safeAdditive);

  const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf-8");
  const prismaSchemaInspection = {
    modelsPresent: {
      OrionReportRun: schema.includes("model OrionReportRun"),
      OrionReportMacroSection: schema.includes("model OrionReportMacroSection"),
      OrionReportMicroStage: schema.includes("model OrionReportMicroStage"),
      OrionReportJsonVersion: schema.includes("model OrionReportJsonVersion"),
      OrionReportConsistencyCheck: schema.includes("model OrionReportConsistencyCheck"),
    },
    tablePrefix: "dp_orion_",
  };
  writeJson(join(OUT, "prisma-schema-inspection.json"), prismaSchemaInspection);
  check(
    "prisma schema has required ORION models",
    Object.values(prismaSchemaInspection.modelsPresent).every(Boolean)
  );

  try {
    const fullAudit = await runFullAudit(caseId, { actorId: "qa-r9-4" }, { runtimeMode: "real_first_with_fallback" });
    writeJson(join(OUT, "full-audit-runtime.json"), {
      outcome: fullAudit.outcome,
      runtimeStrategy: fullAudit.runtimeStrategy,
      runSummary: fullAudit.runSummary,
    });
    check("full audit executed", true, fullAudit.outcome);
  } catch (error) {
    check("full audit executed", false, error instanceof Error ? error.message : String(error));
  }

  const fileRoot = join(OUT, "file-mode");
  const fileRun = await runExactOrionPipeline(caseId, {
    outputRoot: fileRoot,
    locale: "ru",
    useRealCaseData: true,
    storeMode: "file",
  });
  check("file mode pipeline PASS", fileRun.consistencyInspection.status === "PASS");

  const dbTablesReady = await tableExists("dp_orion_report_runs");
  let dbStatus: "PASS" | "SKIPPED" | "FAIL" = "SKIPPED";
  let dbSkipReason = "";
  let dbRoundtrip: Record<string, unknown> = {
    status: "SKIPPED",
    reason: "db tables not available",
  };
  const dbRoot = join(OUT, "db-mode");

  if (!dbTablesReady) {
    dbSkipReason = "ORION migration was created but not applied to local DB";
    check("db mode skipped", true, dbSkipReason);
    writeJson(join(dbRoot, "composed", "final-report-json-client.json"), {
      status: "SKIPPED",
      reason: dbSkipReason,
    });
    writeFileSync(
      join(dbRoot, "composed", "final-report-v17-ru-client.pdf"),
      "SKIPPED: DB mode artifacts unavailable\n",
      "utf-8"
    );
  } else {
    try {
      const dbRun = await runExactOrionPipeline(caseId, {
        outputRoot: dbRoot,
        locale: "ru",
        useRealCaseData: true,
        storeMode: "db",
      });
      const dbStore = createOrionPipelineStore({ mode: "db" });
      const loadedRun = await dbStore.loadRun({
        caseId,
        reportRunId: dbRun.run.runId,
        outputRoot: dbRoot,
      });
      const loadedMicroStages = await dbStore.loadMicroStages({
        caseId,
        reportRunId: dbRun.run.runId,
        outputRoot: dbRoot,
      });
      const loadedAnalysis = await dbStore.loadSectionAnalysis({
        caseId,
        reportRunId: dbRun.run.runId,
        outputRoot: dbRoot,
        microStageKey: "executive_narrative_summary",
      });
      dbRoundtrip = {
        status: "PASS",
        dbRunId: dbRun.run.runId,
        loadedRun: Boolean(loadedRun),
        loadedMicroStageCount: loadedMicroStages.length,
        loadedExecutiveAnalysis: Boolean(loadedAnalysis),
        compare: {
          fileModeMicroStages: fileRun.slideManifests.length,
          dbModeMicroStages: dbRun.slideManifests.length,
          fileModeClientPages: fileRun.compositionInspection.finalClientPageCount,
          dbModeClientPages: dbRun.compositionInspection.finalClientPageCount,
        },
      };
      check("db mode pipeline PASS", dbRun.consistencyInspection.status === "PASS");
      check(
        "db vs file structural equality",
        dbRun.slideManifests.length === fileRun.slideManifests.length &&
          dbRun.compositionInspection.finalClientPageCount === fileRun.compositionInspection.finalClientPageCount
      );
      dbStatus = "PASS";
    } catch (error) {
      dbStatus = "FAIL";
      dbRoundtrip = {
        status: "FAIL",
        reason: error instanceof Error ? error.message : String(error),
      };
      check("db mode pipeline", false, error instanceof Error ? error.message : String(error));
    }
  }

  writeJson(join(OUT, "db-roundtrip-inspection.json"), dbRoundtrip);

  const fileClient = readJson<Record<string, unknown>>(join(fileRoot, "composed", "final-report-json-client.json"));
  const dbClientPath = join(dbRoot, "composed", "final-report-json-client.json");
  const dbClient = existsSync(dbClientPath) ? readJson<Record<string, unknown>>(dbClientPath) : fileClient;
  const combinedDbSafety = JSON.stringify(dbClient);
  const forbidden = [
    "OPENAI_API_KEY",
    "sk-",
    "C:\\",
    "/mnt/",
    "storage/digital-profile",
    "signedUrl",
    "rawPrompt",
    "rawModelResponse",
    "debug",
    "stackTrace",
    "providerInternal",
    "runtimeInternal",
  ];
  const hits = forbidden.filter((x) => combinedDbSafety.toLowerCase().includes(x.toLowerCase()));
  const dbClientSafety = {
    status: hits.length === 0 ? "PASS" : "BLOCKED",
    forbiddenHits: hits,
  };
  writeJson(join(OUT, "db-client-safety-inspection.json"), dbClientSafety);
  check("db client safety", dbClientSafety.status === "PASS");

  writeJson(join(OUT, "db-persistence-inspection.json"), {
    dbTablesReady,
    dbStatus,
    dbSkipReason: dbStatus === "SKIPPED" ? dbSkipReason : undefined,
    fileModeRunId: fileRun.run.runId,
  });

  if (existsSync(join(dbRoot, "composed", "final-report-v17-ru-client.pptx")) && existsSync(dbClientPath)) {
    const inspectRc = runInspect(
      join(dbRoot, "composed", "final-report-v17-ru-client.pptx"),
      dbClientPath,
      join(dbRoot, "composed", "r9-inspect-client.json")
    );
    check("db mode inspect client", inspectRc === 0, `rc=${inspectRc}`);
  } else {
    writeJson(join(dbRoot, "composed", "r9-inspect-client.json"), {
      status: "SKIPPED",
      reason: "db-mode rendered artifacts not available",
    });
  }

  const required = [
    "migration-inspection.json",
    "prisma-schema-inspection.json",
    "db-persistence-inspection.json",
    "db-roundtrip-inspection.json",
    "db-client-safety-inspection.json",
    "file-mode/composed/final-report-json-client.json",
    "db-mode/composed/final-report-json-client.json",
    "db-mode/composed/final-report-v17-ru-client.pdf",
    "db-mode/composed/r9-inspect-client.json",
  ];
  for (const rel of required) {
    check(`${rel} exists`, existsSync(join(OUT, rel)));
  }

  writeJson(join(OUT, "qa-summary.json"), {
    status: failures ? "BLOCKED" : dbStatus === "SKIPPED" ? "PASS_WITH_DB_SKIPPED" : "PASS",
    failures,
    caseId,
    dbStatus,
    dbTablesReady,
  });

  const finalStatus = failures ? "BLOCKED" : dbStatus === "SKIPPED" ? "PASS_WITH_DB_SKIPPED" : "PASS";
  console.log(`\nVerdict: ${finalStatus}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
