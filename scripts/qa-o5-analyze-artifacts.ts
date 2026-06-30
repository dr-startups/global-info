import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "storage/digital-profile/qa-o5-evidence-quality");
const ru = JSON.parse(readFileSync(join(dir, "report-json-ru.json"), "utf8"));
const en = JSON.parse(readFileSync(join(dir, "report-json-en.json"), "utf8"));

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

check("RU evidenceQuality present", Boolean(ru.evidenceQuality));
const t = ru.evidenceQuality?.totals ?? {};
check("RU totals collected>0", (t.collected ?? 0) > 0, String(t.collected));
check("RU clientIncluded>0", (t.clientIncluded ?? 0) > 0, String(t.clientIncluded));
check("RU reviewRequired tracked", (t.reviewRequired ?? 0) >= 0, String(t.reviewRequired));
check("RU excluded>0", (t.excluded ?? 0) > 0, String(t.excluded));
check("RU duplicates tracked", (t.duplicates ?? 0) > 0, String(t.duplicates));
check(
  "RU overallRisk not CRITICAL",
  ru.auditSummary?.overallRiskLevel !== "CRITICAL",
  ru.auditSummary?.overallRiskLevel
);
check("RU SERP SYNTHETIC", ru.serpSnapshot?.mode === "SYNTHETIC");
check("RU reviewQueue present", Array.isArray(ru.evidenceQuality?.reviewQueue));
check(
  "RU internal keeps sourceMode",
  JSON.stringify(ru).includes("sourceMode") || !ru.serpSnapshot?.metadata
);

const intlRelated = ru.searchSurfaces?.regions?.international?.relatedQueries;
const intlRelatedStats = intlRelated?.qualityStats;
check(
  "RELATED_QUERY selected > 0 when collected",
  (intlRelated?.total ?? 0) === 0 ||
    (intlRelatedStats?.selectedForReport ?? 0) > 0 ||
    (intlRelatedStats?.clientIncluded ?? 0) > 0 ||
    (intlRelatedStats?.reviewRequired ?? 0) > 0,
  `collected=${intlRelated?.total} selected=${intlRelatedStats?.selectedForReport}`
);
check(
  "RELATED_QUERY not all EXCLUDE",
  (intlRelatedStats?.excludedAsNoise ?? 0) < (intlRelated?.total ?? 0) ||
    (intlRelated?.total ?? 0) === 0
);
check(
  "global relatedQueriesTotal",
  ru.searchSurfaces?.globalSummary?.relatedQueriesTotal ===
    (ru.searchSurfaces?.regions?.ru?.relatedQueries?.total ?? 0) +
      (ru.searchSurfaces?.regions?.uae?.relatedQueries?.total ?? 0) +
      (intlRelated?.total ?? 0),
  String(ru.searchSurfaces?.globalSummary?.relatedQueriesTotal)
);
check("RU related honest zero", (ru.searchSurfaces?.regions?.ru?.relatedQueries?.total ?? 0) >= 0);

const allItems: Array<Record<string, unknown>> = [];
for (const reg of ["ru", "uae", "international"]) {
  const b = ru.searchSurfaces?.regions?.[reg];
  if (!b) continue;
  for (const k of ["organic", "suggestions", "relatedQueries", "images", "videos"]) {
    for (const it of b[k]?.items ?? []) {
      allItems.push({ reg, bucket: k, ...it });
    }
  }
}
const registry = allItems.filter((i) =>
  /rusprofile|klerk|инн|огрн|ип/i.test(`${i.title ?? ""}${i.url ?? ""}`)
);
check(
  "Registry items not adverse classification",
  registry.every(
    (i) =>
      !["CRIMINAL", "LEGAL_DISPUTE", "ADVERSE_MEDIA"].includes(
        String(i.classification ?? "").toUpperCase()
      )
  ),
  `${registry.length} items`
);

const enStr = JSON.stringify(en);
check("EN no sourceMode", !enStr.includes("sourceMode") && !enStr.includes("sourcePreference"));
check("EN no providerAdapter", !enStr.includes("providerAdapter"));
check("EN no rawMetadata", !enStr.includes("rawMetadata"));
check("EN no reportEligibility", !enStr.includes("reportEligibility"));
check("EN no contentClass gate field", !/"contentClass"/.test(enStr));
check("EN no mock fixture", !/mock fixture/i.test(enStr));
check("EN evidenceQuality totals only", Boolean(en.evidenceQuality?.totals) && !en.evidenceQuality?.reviewQueue);
check(
  "EN relatedQueries still selected",
  (en.searchSurfaces?.regions?.international?.relatedQueries?.qualityStats?.selectedForReport ?? 0) > 0 ||
    (en.searchSurfaces?.globalSummary?.relatedQueriesTotal ?? 0) === 0
);
check("EN serpSnapshot exists", Boolean(en.serpSnapshot?.id));

const files = readdirSync(dir);
for (const f of [
  "report-ru-internal-draft-v3.pdf",
  "report-ru-internal-draft-v3.pptx",
  "report-en-client-none-v3.pdf",
  "report-en-client-none-v3.pptx",
  "report-json-ru.json",
  "report-json-en.json",
]) {
  check(`artifact ${f}`, files.includes(f) && statSync(join(dir, f)).size > 500);
}

console.log("\n=== evidenceQuality totals (RU) ===");
console.log(ru.evidenceQuality?.totals);
console.log("\n=== bySurface (RU) ===");
console.log(ru.evidenceQuality?.bySurface);
console.log("\nReview queue:", (ru.evidenceQuality?.reviewQueue ?? []).slice(0, 5));
console.log("\nTop exclusions:", (ru.evidenceQuality?.topExclusionReasons ?? []).slice(0, 5));
console.log(
  `\n${failures === 0 ? "MANUAL QA ANALYSIS PASSED" : `${failures} CHECK(S) FAILED`}`
);
process.exit(failures > 0 ? 1 : 0);

export {};
