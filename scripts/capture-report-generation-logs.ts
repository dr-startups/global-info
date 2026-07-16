/**
 * Captures report-generation logs into storage/digital-profile/log-capture/<stamp>/.
 *
 * Two log channels:
 *  1. stdout JSON lines with `"tag":"orion-v2"` (ORION v2 pipeline)
 *  2. inspection JSON artifacts written by the pipeline (all report modes)
 *
 * Usage (host or Docker):
 *   npx tsx scripts/capture-report-generation-logs.ts
 *   CASE_ID=... npx tsx scripts/capture-report-generation-logs.ts --mode orion-v2
 *   CASE_ID=... npx tsx scripts/capture-report-generation-logs.ts --mode storyboard-r912
 *
 * Docker network:
 *   R912_DOCKER_NETWORK=1 RENDERER_URL=http://renderer:8080 npx tsx scripts/capture-report-generation-logs.ts
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

type CaptureMode = "orion-v2" | "storyboard-r912";

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function parseArgs(): { mode: CaptureMode; caseId: string } {
  const argv = process.argv.slice(2);
  let mode: CaptureMode = "orion-v2";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--mode" && argv[i + 1]) {
      mode = argv[i + 1] as CaptureMode;
      i += 1;
    }
  }
  const caseId =
    process.env.CASE_ID?.trim() || "cmr5oqxo301bqvdag2yf0v6sj";
  return { mode, caseId };
}

function bootstrapEnv(): void {
  if (
    process.env.R912_DOCKER_NETWORK === "1" ||
    process.env.R911_DOCKER_NETWORK === "1" ||
    process.env.R910_DOCKER_NETWORK === "1"
  ) {
    process.env.RENDERER_URL = "http://renderer:8080";
  }
}

function copyTree(src: string, dest: string, maxDepth = 6, depth = 0): string[] {
  if (!existsSync(src) || depth > maxDepth) return [];
  mkdirSync(dest, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dest, name);
    const st = statSync(from);
    if (st.isDirectory()) {
      copied.push(...copyTree(from, to, maxDepth, depth + 1));
    } else {
      cpSync(from, to);
      copied.push(to);
    }
  }
  return copied;
}

function collectOrionV2InspectionFiles(outputRoot: string): string[] {
  if (!existsSync(outputRoot)) return [];
  const hits: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      if (
        name.endsWith("-inspection.json") ||
        name === "ai-enforcement-inspection.json" ||
        name === "blueprint.json" ||
        name.endsWith("stage-inspection.json")
      ) {
        hits.push(p);
      }
    }
  };
  walk(outputRoot, 0);
  return hits;
}

async function captureOrionV2(caseId: string, captureRoot: string): Promise<void> {
  const { runOrionV2Report, getOrionV2AiReadiness } = await import(
    "../src/modules/digital-profile/services/orion-v2-report-service"
  );

  const readiness = getOrionV2AiReadiness();
  writeFileSync(
    join(captureRoot, "ai-readiness.json"),
    `${JSON.stringify(readiness, null, 2)}\n`,
    "utf-8"
  );

  const orionLines: string[] = [];
  const wrap =
    (original: typeof console.info) =>
    (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      if (line.includes('"tag":"orion-v2"')) orionLines.push(line);
      original.apply(console, args as Parameters<typeof console.info>);
    };
  const info = console.info;
  const warn = console.warn;
  const error = console.error;
  console.info = wrap(info);
  console.warn = wrap(warn);
  console.error = wrap(error);

  const startedAt = new Date().toISOString();
  let record;
  try {
    record = await runOrionV2Report({
      caseId,
      storeMode: "file",
      gpt55Validate: readiness.ready,
      includeInternalArtifacts: true,
      requireAiAnalysis: readiness.ready,
      allowDeterministicFallback:
        !readiness.ready || process.env.ALLOW_DETERMINISTIC_FALLBACK === "1",
    });
  } finally {
    console.info = info;
    console.warn = warn;
    console.error = error;
  }

  writeFileSync(
    join(captureRoot, "orion-v2-stdout.jsonl"),
    `${orionLines.join("\n")}\n`,
    "utf-8"
  );
  writeFileSync(
    join(captureRoot, "orion-v2-run-record.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf-8"
  );

  const artifactDir = join(captureRoot, "orion-v2-artifacts");
  if (record.outputRoot && existsSync(record.outputRoot)) {
    const files = collectOrionV2InspectionFiles(record.outputRoot);
    mkdirSync(artifactDir, { recursive: true });
    for (const file of files) {
      const rel = file.slice(record.outputRoot.length + 1);
      const dest = join(artifactDir, rel);
      mkdirSync(join(dest, ".."), { recursive: true });
      cpSync(file, dest);
    }
    writeFileSync(
      join(captureRoot, "orion-v2-artifact-index.json"),
      `${JSON.stringify({ outputRoot: record.outputRoot, files }, null, 2)}\n`,
      "utf-8"
    );
  }

  writeFileSync(
    join(captureRoot, "capture-meta.json"),
    `${JSON.stringify(
      {
        mode: "orion-v2",
        caseId,
        startedAt,
        finishedAt: new Date().toISOString(),
        orionStdoutLineCount: orionLines.length,
        runStatus: record.status,
        runId: record.runId,
        outputRoot: record.outputRoot,
      },
      null,
      2
    )}\n`,
    "utf-8"
  );
}

async function captureStoryboardR912(caseId: string, captureRoot: string): Promise<void> {
  const { runR912ClientQualityStoryboardE2e, R912_OUTPUT_ROOT } = await import(
    "../src/modules/digital-profile/orion-client-storyboard/run-r912-real-case-storyboard-e2e"
  );

  const stdoutLines: string[] = [];
  const wrap =
    (original: typeof console.log) =>
    (...args: unknown[]) => {
      stdoutLines.push(args.map(String).join(" "));
      original.apply(console, args as Parameters<typeof console.log>);
    };
  const log = console.log;
  console.log = wrap(log);

  const startedAt = new Date().toISOString();
  let result;
  try {
    result = await runR912ClientQualityStoryboardE2e({
      caseId,
      outputRoot: join(captureRoot, "storyboard-run"),
    });
  } finally {
    console.log = log;
  }

  writeFileSync(
    join(captureRoot, "storyboard-stdout.log"),
    `${stdoutLines.join("\n")}\n`,
    "utf-8"
  );
  writeFileSync(
    join(captureRoot, "storyboard-result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf-8"
  );

  const inspectionDir = join(captureRoot, "storyboard-inspection-json");
  if (existsSync(result.outputRoot)) {
    copyTree(result.outputRoot, inspectionDir);
  }

  writeFileSync(
    join(captureRoot, "capture-meta.json"),
    `${JSON.stringify(
      {
        mode: "storyboard-r912",
        caseId,
        startedAt,
        finishedAt: new Date().toISOString(),
        stdoutLineCount: stdoutLines.length,
        outputRoot: result.outputRoot,
        defaultQaOutputRoot: R912_OUTPUT_ROOT,
      },
      null,
      2
    )}\n`,
    "utf-8"
  );
}

async function main(): Promise<void> {
  bootstrapEnv();
  const { mode, caseId } = parseArgs();
  const captureRoot = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "log-capture",
    `${stamp()}-${mode}`
  );
  mkdirSync(captureRoot, { recursive: true });

  console.log(`[capture] mode=${mode} caseId=${caseId}`);
  console.log(`[capture] output=${captureRoot}`);

  if (mode === "orion-v2") {
    await captureOrionV2(caseId, captureRoot);
  } else if (mode === "storyboard-r912") {
    await captureStoryboardR912(caseId, captureRoot);
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }

  console.log(`[capture] done → ${captureRoot}`);
}

main().catch((error) => {
  console.error("[capture] failed", error);
  process.exit(1);
});
