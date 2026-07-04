import { existsSync, readFileSync } from "node:fs";
import { ru } from "../src/modules/digital-profile/i18n/dictionaries/ru";
import { en } from "../src/modules/digital-profile/i18n/dictionaries/en";
import { FULL_AUDIT_DEFAULT_RUNTIME_MODE } from "../src/modules/digital-profile/agents/runtime-strategy";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function main() {
  check("Compliance tab exists", existsSync("src/modules/digital-profile/client/ComplianceTab.tsx"));
  check("R7.5 QA script exists", existsSync("scripts/qa-r7-5-ui-lexisnexis-e2e.ts"));
  check("RU upload label exact", ru.compliance.uploadLexisNexis === "Загрузить отчёт LexisNexis");
  check("EN upload label exact", en.compliance.uploadLexisNexis === "Upload LexisNexis Report");
  check("RU status: uploaded", ru.compliance.lexisUploaded === "Загружен");
  check("RU status: converting", ru.compliance.lexisConverting === "Конвертируется");
  check("RU status: parsing", ru.compliance.lexisParsing === "Анализируется");
  check("RU status: ready", ru.compliance.lexisReady === "Готов к включению в отчёт");
  check("RU status: review required", ru.compliance.lexisReviewRequired === "Требуется ручная проверка");
  check("RU status: processing error", ru.compliance.lexisError === "Ошибка обработки");
  check(
    "RU conversion warning message exact",
    ru.compliance.lexisConversionWarningMessage ===
      "Документ загружен, но визуальные страницы пока не сформированы."
  );
  check(
    "RU success message exact",
    ru.compliance.lexisReadyMessage === "Документ готов к включению в отчёт."
  );
  check(
    "full audit default mode is real_first_with_fallback",
    FULL_AUDIT_DEFAULT_RUNTIME_MODE === "real_first_with_fallback"
  );

  const complianceTab = readFileSync("src/modules/digital-profile/client/ComplianceTab.tsx", "utf-8");
  check(
    "ComplianceTab calls UI upload API path",
    complianceTab.includes("importLexisNexisDocx(caseId, file)")
  );
  check("ComplianceTab accepts docx input", complianceTab.includes("accept=\".docx"));
  check(
    "ComplianceTab maps conversion warning message",
    complianceTab.includes("lexisConversionWarningMessage")
  );

  const caseDetail = readFileSync("src/modules/digital-profile/client/CaseDetailView.tsx", "utf-8");
  check(
    "Case detail calls unified full audit endpoint client",
    caseDetail.includes("runFullAudit(caseId,") && caseDetail.includes("runtimeMode: \"real_first_with_fallback\"")
  );
  check("Case detail renders audit run stats with mode", caseDetail.includes("auditRunStats"));

  console.log(`\n${failures ? `FAILED (${failures})` : "PASSED (0 failures)"}`);
  process.exit(failures ? 1 : 0);
}

main();

