import { existsSync, readFileSync } from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function mustContain(path: string, token: string): boolean {
  return readFileSync(path, "utf-8").includes(token);
}

function mustNotContain(path: string, token: string): boolean {
  return !readFileSync(path, "utf-8").includes(token);
}

function main() {
  check("R7.6 QA script exists", existsSync("scripts/qa-r7-6-orion-content-polish.ts"));
  check("report mapper has domain fallback label", mustContain("renderer/report_mapper.py", "domain_unavailable"));
  check("report mapper no raw theme-key fallback", mustNotContain("renderer/report_mapper.py", "k.replace(\"_\", \" \")"));
  check(
    "search surfaces no raw theme fallback",
    mustNotContain("src/modules/digital-profile/report/search-surfaces-report-builder.ts", "key.replace(/_/g, \" \")")
  );
  check(
    "report builder no raw theme fallback",
    mustNotContain("src/modules/digital-profile/services/report-builder-service.ts", "key.replace(/_/g, \" \")")
  );
  check(
    "top themes include adverse/regulatory/corporate labels",
    mustContain("renderer/report_i18n.py", "risk_topic_adverse_media")
      && mustContain("renderer/report_i18n.py", "risk_topic_regulatory")
      && mustContain("renderer/report_i18n.py", "risk_topic_corporate_ownership")
  );
  check(
    "template uses localized source prefix",
    mustContain("renderer/report_template_v3.py", "T.set_note_strings(L.get(\"source_prefix\"")
  );
  check(
    "theme note source prefix is configurable",
    mustContain("renderer/theme.py", "def set_note_strings(source_prefix: str | None)")
  );
  check("ui full audit keeps explicit runtime mode", mustContain("src/modules/digital-profile/client/CaseDetailView.tsx", "runtimeMode: \"real_first_with_fallback\""));
  check("lexis ui e2e smoke still exists", existsSync("scripts/smoke-ui-lexisnexis-e2e-r75.ts"));

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main();

