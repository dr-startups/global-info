import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function file(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf-8");
}

function main() {
  const apiRoute = "src/app/api/digital-profile/cases/[id]/report/orion-v2/route.ts";
  const downloadRoute =
    "src/app/api/digital-profile/cases/[id]/report/orion-v2/download/route.ts";
  const clientApi = "src/modules/digital-profile/client/api.ts";
  const panel = "src/modules/digital-profile/client/OrionV2ReportPanel.tsx";
  const config = "src/modules/digital-profile/config.ts";
  const ruDict = "src/modules/digital-profile/i18n/dictionaries/ru.ts";
  const enDict = "src/modules/digital-profile/i18n/dictionaries/en.ts";
  const existingReportRoute = "src/app/api/digital-profile/cases/[id]/report/route.ts";

  check("ORION v2 route exists", existsSync(join(process.cwd(), apiRoute)));
  check("ORION v2 download route exists", existsSync(join(process.cwd(), downloadRoute)));
  check("ORION v2 panel exists", existsSync(join(process.cwd(), panel)));

  const apiRouteText = file(apiRoute);
  check("ORION v2 route has POST", apiRouteText.includes("export const POST"));
  check("ORION v2 route has GET", apiRouteText.includes("export const GET"));

  const configText = file(config);
  check(
    "feature flag wired",
    configText.includes("DIGITAL_PROFILE_ORION_V2_UI_ENABLED")
  );
  check(
    "feature flag default safe",
    configText.includes("process.env.NODE_ENV !== \"production\"")
  );

  const clientApiText = file(clientApi);
  check(
    "client API has generateOrionV2Report",
    clientApiText.includes("generateOrionV2Report")
  );
  check(
    "client API has getOrionV2ReportStatus",
    clientApiText.includes("getOrionV2ReportStatus")
  );

  const ru = file(ruDict);
  const en = file(enDict);
  for (const key of [
    "orionV2Title",
    "orionV2Generate",
    "orionV2Refresh",
    "orionV2DownloadPdf",
    "orionV2DownloadPptx",
    "orionV2DownloadInternalDraft",
  ]) {
    check(`ru dictionary has ${key}`, ru.includes(`${key}:`));
    check(`en dictionary has ${key}`, en.includes(`${key}:`));
  }

  const oldRouteText = file(existingReportRoute);
  check("existing report route still present", oldRouteText.includes("getLatestReport"));
  check(
    "existing report route unchanged semantics",
    oldRouteText.includes("requireRole(user, \"evidence.viewRaw\")")
  );

  process.exit(failures ? 1 : 0);
}

main();

