import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function file(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf-8");
}

function main() {
  const route = "src/app/api/digital-profile/cases/[id]/report/orion-v2/route.ts";
  const downloadRoute =
    "src/app/api/digital-profile/cases/[id]/report/orion-v2/download/route.ts";
  const panel = "src/modules/digital-profile/client/OrionV2ReportPanel.tsx";
  const api = "src/modules/digital-profile/client/api.ts";
  const cfg = "src/modules/digital-profile/config.ts";
  const oldReport = "src/modules/digital-profile/client/ReportPreviewPanel.tsx";
  const ru = "src/modules/digital-profile/i18n/dictionaries/ru.ts";
  const en = "src/modules/digital-profile/i18n/dictionaries/en.ts";

  check("ORION v2 route exists", existsSync(join(process.cwd(), route)));
  check("ORION v2 download route exists", existsSync(join(process.cwd(), downloadRoute)));
  check("ORION v2 panel exists", existsSync(join(process.cwd(), panel)));
  check("client API wrapper exists", existsSync(join(process.cwd(), api)));

  const routeSrc = file(route);
  check("ORION v2 route has POST", routeSrc.includes("export const POST"));
  check("ORION v2 route has GET", routeSrc.includes("export const GET"));
  check(
    "ORION v2 route keeps role check",
    routeSrc.includes("requireRole(user, \"report.generateInternal\")")
  );

  const cfgSrc = file(cfg);
  check(
    "feature flag DIGITAL_PROFILE_ORION_V2_UI_ENABLED wired",
    cfgSrc.includes("DIGITAL_PROFILE_ORION_V2_UI_ENABLED")
  );

  const panelSrc = file(panel);
  check(
    "panel uses generate action label",
    panelSrc.includes("report.orionV2Generate")
  );
  check(
    "panel keeps old report path separate",
    !panelSrc.includes("report.generateReport")
  );

  const apiSrc = file(api);
  check(
    "client API has generateOrionV2Report",
    apiSrc.includes("generateOrionV2Report")
  );
  check(
    "client API has getOrionV2ReportStatus",
    apiSrc.includes("getOrionV2ReportStatus")
  );

  const oldReportSrc = file(oldReport);
  check(
    "old report controls still present",
    oldReportSrc.includes("report.generateReport")
  );
  check(
    "old report render endpoint usage remains",
    oldReportSrc.includes("renderReport(")
  );

  const ruSrc = file(ru).toLowerCase();
  const enSrc = file(en).toLowerCase();
  const forbid = ["providerinternal", "runtimeinternal", "rawprompt", "rawmodelresponse"];
  const bad = forbid.filter((token) => ruSrc.includes(token) || enSrc.includes(token));
  check("ORION labels avoid forbidden internals", bad.length === 0, bad.join(", "));

  process.exit(failures ? 1 : 0);
}

main();

