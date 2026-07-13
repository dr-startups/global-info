/**
 * First36 acceptance command: compose/render (optional) + qa.json gate.
 *
 * Usage:
 *   npx tsx scripts/accept-first36-report.ts --caseId=... [--fromDir=...] [--render=0]
 *
 * Exit code 1 when gate fails.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { inspectFirst36Acceptance } from "../src/modules/digital-profile/orion-golden/classic/first36-acceptance-gate";

type Args = {
  caseId?: string;
  fromDir?: string;
  render?: boolean;
  outRoot?: string;
};

function parseArgs(argv: string[]): Args {
  const out: Args = { render: false };
  for (const a of argv) {
    if (a.startsWith("--caseId=")) out.caseId = a.slice("--caseId=".length);
    else if (a.startsWith("--fromDir=")) out.fromDir = a.slice("--fromDir=".length);
    else if (a.startsWith("--outRoot=")) out.outRoot = a.slice("--outRoot=".length);
    else if (a === "--render=1" || a === "--render") out.render = true;
  }
  return out;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function latestCheckpoint(): string | null {
  const root = join(process.cwd(), "storage", "digital-profile", "qa-first36-v57-checkpoint");
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => /^\d+$/.test(name))
    .sort();
  for (let i = dirs.length - 1; i >= 0; i -= 1) {
    const candidate = join(root, dirs[i]!);
    if (existsSync(join(candidate, "final-deck-manifest.json"))) return candidate;
  }
  return null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fromDir = args.fromDir || latestCheckpoint();
  if (!fromDir || !existsSync(fromDir)) {
    throw new Error("accept-first36: provide --fromDir=... with final-deck-manifest.json");
  }

  if (args.render && args.caseId) {
    process.env.ORION_FIRST36_CEO_MODE = "1";
    process.env.ORION_CLASSIC_AUDIT_MODE = "1";
    process.env.ORION_FIRST36_RUN_SCOPED = "1";
    const { renderFirst36Report } = await import(
      "../src/modules/digital-profile/orion-golden/classic/render-first36-report"
    );
    const rendered = await renderFirst36Report({
      caseId: args.caseId,
      mode: "acceptance",
      outputRoot: args.outRoot,
    });
    console.log(JSON.stringify({ rendered }, null, 2));
  }

  const deck = readJson<{
    slideCount: number;
    finalSlides: Array<Record<string, unknown>>;
  }>(join(fromDir, "final-deck-manifest.json"));

  const themeSet = existsSync(join(fromDir, "orion-theme-set.json"))
    ? readJson<Record<string, unknown>>(join(fromDir, "orion-theme-set.json"))
    : undefined;
  const runScopedMerge = existsSync(join(fromDir, "run-scoped-serp-merge.json"))
    ? readJson<Record<string, unknown>>(join(fromDir, "run-scoped-serp-merge.json"))
    : undefined;
  const assets = existsSync(join(fromDir, "report-assets.json"))
    ? readJson<Array<{ kind?: string }>>(join(fromDir, "report-assets.json"))
    : [];

  const result = inspectFirst36Acceptance({
    slideCount: deck.slideCount,
    slides: (deck.finalSlides ?? []).map((s) => ({
      pageNumber: Number(s.pageNumber ?? 0),
      title: String(s.title ?? ""),
      narrative: s.narrative ? String(s.narrative) : undefined,
      bullets: Array.isArray(s.bullets) ? s.bullets.map(String) : undefined,
      template: s.template ? String(s.template) : undefined,
      table: s.table as { headers?: string[]; rows?: string[][] } | undefined,
      clientTakeaway: s.clientTakeaway ? String(s.clientTakeaway) : undefined,
      visualAnalysis: s.visualAnalysis as
        | {
            whatIsVisible?: string;
            whyItMatters?: string;
            clientMeaning?: string;
            headlineConclusion?: string;
          }
        | undefined,
      statusBadge: s.statusBadge as { label?: string } | undefined,
    })),
    themeSet: themeSet as {
      ru?: { linksTotal?: number; linksAdverse?: number; wikipediaStatus?: string };
      uae?: { linksTotal?: number; linksAdverse?: number; wikipediaStatus?: string };
    },
    runScopedMerge: runScopedMerge as {
      usedRunScoped?: boolean;
      duplicateKeys?: string[];
      observationCount?: number;
    },
    assetKinds: assets.map((a) => String(a.kind ?? "")),
  });

  const outRoot =
    args.outRoot ||
    join(process.cwd(), "storage", "digital-profile", "qa-first36-acceptance", String(Date.now()));
  mkdirSync(outRoot, { recursive: true });
  const qaPath = join(outRoot, "qa.json");
  writeFileSync(
    qaPath,
    `${JSON.stringify(
      {
        fromDir,
        passed: result.passed,
        issueCount: result.issues.length,
        issues: result.issues,
        pdf: existsSync(join(fromDir, "rendered-client.pdf"))
          ? join(fromDir, "rendered-client.pdf")
          : null,
        contactSheetDir: existsSync(join(fromDir, "pages-png")) ? join(fromDir, "pages-png") : null,
      },
      null,
      2
    )}\n`,
    "utf-8"
  );

  if (existsSync(join(fromDir, "rendered-client.pdf"))) {
    copyFileSync(join(fromDir, "rendered-client.pdf"), join(outRoot, "rendered-client.pdf"));
  }

  console.log(
    JSON.stringify(
      {
        passed: result.passed,
        issueCount: result.issues.length,
        qaPath,
        issues: result.issues.slice(0, 30),
      },
      null,
      2
    )
  );

  if (!result.passed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
