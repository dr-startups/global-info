import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SRC = join(process.cwd(), "storage/digital-profile/qa-r7-7-visual-orion-qa");
const OUT = join(process.cwd(), "storage/digital-profile/qa-r8-3-gpt55-analyst-narrative");

function runChecked(cmd: string, args: string[], env?: Record<string, string>): string {
  const bin = process.platform === "win32" && cmd === "npm" ? "npm.cmd" : cmd;
  const spawnArgs = {
    cwd: process.cwd(),
    encoding: "utf-8" as const,
    env: { ...process.env, ...(env ?? {}) },
    maxBuffer: 64 * 1024 * 1024,
  };
  const res =
    process.platform === "win32"
      ? spawnSync(
          `${bin} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}`,
          { ...spawnArgs, shell: true }
        )
      : spawnSync(bin, args, spawnArgs);
  if (res.error) {
    throw new Error(`${bin} ${args.join(" ")} failed: ${res.error.message}`);
  }
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) {
    throw new Error(`${bin} ${args.join(" ")} failed with code ${res.status}`);
  }
  return String(res.stdout ?? "");
}

function copyTree(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    const st = statSync(from);
    if (st.isDirectory()) {
      copyTree(from, to);
      continue;
    }
    copyFileSync(from, to);
  }
}

function readJson<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function containsRawThemeKey(text: string): boolean {
  return /\b(sanctions_watchlist|political_exposure|legal_dispute|adverse_media|corporate_ownership|pep_political_exposure|pep_rca)\b/.test(
    text
  );
}

function main() {
  runChecked("npm", ["run", "qa:r7-7-visual-orion-qa"], { PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" });

  rmSync(OUT, { recursive: true, force: true });
  copyTree(SRC, OUT);

  const internalJsonPath = join(OUT, "report-json-ru-internal.json");
  const clientJsonPath = join(OUT, "report-json-ru-client.json");
  if (!existsSync(internalJsonPath) || !existsSync(clientJsonPath)) {
    throw new Error("R8.3 QA requires report-json-ru-internal.json and report-json-ru-client.json");
  }

  const internalJson = readJson<Record<string, unknown>>(internalJsonPath);
  const clientJson = readJson<Record<string, unknown>>(clientJsonPath);
  const aiInternal = (internalJson.aiAnalystNarrative ?? {}) as Record<string, unknown>;
  const aiClient = (clientJson.aiAnalystNarrative ?? {}) as Record<string, unknown>;

  const internalExec = (aiInternal.executiveSummary ?? {}) as Record<string, unknown>;
  const overallRisk = String((internalJson.auditSummary as Record<string, unknown> | undefined)?.overallRiskLevel ?? "");
  const rawClientStr = JSON.stringify(clientJson);
  const repeatedThemeCount = (rawClientStr.match(/Тема требует классификации/g) ?? []).length;
  const hasApiKey = Boolean(process.env.OPENAI_API_KEY);

  const checks = [
    {
      id: "ai_narrative_internal_exists",
      ok: Boolean(internalJson.aiAnalystNarrative),
      detail: "",
    },
    {
      id: "ai_narrative_client_exists",
      ok: Boolean(clientJson.aiAnalystNarrative),
      detail: "",
    },
    {
      id: "plain_language_conclusion_present",
      ok: String(internalExec.plainConclusion ?? "").trim().length > 0,
      detail: "",
    },
    {
      id: "medium_risk_has_explanation",
      ok:
        overallRisk.toUpperCase() !== "MEDIUM" ||
        String((internalExec.riskExplanation ?? "")).toLowerCase().includes("medium") ||
        String((internalExec.whyNotLow ?? "")).toLowerCase().includes("manual"),
      detail: "",
    },
    {
      id: "no_repeated_generic_theme_phrase",
      ok: repeatedThemeCount <= 1,
      detail: `count=${repeatedThemeCount}`,
    },
    {
      id: "no_raw_theme_keys_in_client_json",
      ok: !containsRawThemeKey(rawClientStr),
      detail: "",
    },
    {
      id: "no_prompt_or_model_raw_leaks_in_client_json",
      ok:
        !rawClientStr.includes("rawModelResponse") &&
        !rawClientStr.includes("prompt") &&
        !rawClientStr.includes("OPENAI_API_KEY"),
      detail: "",
    },
    {
      id: "fallback_without_api_key",
      ok: hasApiKey ? true : String(aiInternal.generatedBy ?? "") === "deterministic",
      detail: hasApiKey ? "skipped (OPENAI_API_KEY present)" : String(aiInternal.generatedBy ?? ""),
    },
    {
      id: "lexis_narrative_when_hybrid_present",
      ok:
        !internalJson.lexisNexisHybrid ||
        Boolean((aiInternal.lexisNexisNarrative as Record<string, unknown> | undefined)?.importStatus),
      detail: "",
    },
  ];

  const failed = checks.filter((c) => !c.ok);
  const inspection = {
    status: failed.length === 0 ? "PASS" : "BLOCKED",
    checks,
    fallbackExpected: !hasApiKey,
    generatedBy: String(aiInternal.generatedBy ?? ""),
    generatedStatus: String(aiInternal.status ?? ""),
  };
  writeFileSync(join(OUT, "ai-analyst-narrative-inspection.json"), JSON.stringify(inspection, null, 2));

  if (failed.length > 0) {
    for (const f of failed) {
      console.error(`[FAIL] ${f.id}${f.detail ? ` — ${f.detail}` : ""}`);
    }
    process.exit(1);
  }
}

main();
