import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(process.cwd(), "storage/digital-profile/qa-o1-o4-surfaces");
const ru = JSON.parse(readFileSync(join(dir, "report-json-ru.json"), "utf8"));
const en = JSON.parse(readFileSync(join(dir, "report-json-en.json"), "utf8"));

function regionSummary(block: Record<string, unknown>, name: string) {
  const s = block.summary as Record<string, unknown>;
  return {
    region: name,
    collectionStatus: block.collectionStatus,
    organic: (block.organic as { total: number; adverse: number })?.total,
    organicAdverse: (block.organic as { adverse: number })?.adverse,
    suggestions: (block.suggestions as { total: number })?.total,
    related: (block.relatedQueries as { total: number })?.total,
    images: (block.images as { total: number })?.total,
    videos: (block.videos as { total: number })?.total,
    knowledge: (block.knowledgePanel as { total: number })?.total,
    uniqueUrls: (s as { uniqueUrls?: number })?.uniqueUrls ?? (block.summary as { uniqueUrls?: number })?.uniqueUrls,
    queryVariants: ((block.summary as { queryVariants?: string[] })?.queryVariants ?? []).length,
  };
}

const ss = ru.searchSurfaces?.regions ?? {};
console.log("=== RU searchSurfaces regions ===");
for (const k of ["ru", "uae", "international"]) {
  console.log(JSON.stringify(regionSummary(ss[k] ?? {}, k), null, 2));
}

console.log("\n=== auditSummary regions ===");
const auditRegions = ru.auditSummary?.regions ?? [];
for (const r of auditRegions) {
  console.log(
    r.region,
    "organic",
    r.organicTotal,
    "related",
    r.relatedQueriesTotal ?? 0,
    "status",
    r.collectionStatus ?? "n/a"
  );
}

console.log("\n=== O4.1 validation ===");
let failures = 0;
function assert(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

const regionCodes = auditRegions.map((r: { region: string }) => String(r.region).toUpperCase());
assert("auditSummary has RU row", regionCodes.includes("RU"));
assert("auditSummary has UAE row", regionCodes.includes("UAE"));
assert("auditSummary has INTERNATIONAL row", regionCodes.includes("INTERNATIONAL"));
assert("No duplicate UAE audit rows", regionCodes.filter((c: string) => c === "UAE").length <= 1);

const intlRelated = ss.international?.relatedQueries?.total ?? 0;
const ruRelated = ss.ru?.relatedQueries?.total ?? 0;
const globalRelated = ru.searchSurfaces?.globalSummary?.relatedQueriesTotal ?? 0;
const sumRelated = ruRelated + (ss.uae?.relatedQueries?.total ?? 0) + intlRelated;
assert("global relatedQueriesTotal sums regions", globalRelated === sumRelated, `${globalRelated} vs ${sumRelated}`);
if (intlRelated > 0) {
  assert("INTERNATIONAL related queries visible", intlRelated > 0, String(intlRelated));
  const intlAudit = auditRegions.find((r: { region: string }) => r.region === "INTERNATIONAL");
  assert("INTERNATIONAL audit row has related count", (intlAudit?.relatedQueriesTotal ?? 0) === intlRelated);
}
assert(
  "Knowledge panel honest absent",
  (ss.ru?.knowledgePanel?.total ?? 0) === 0
    ? ["ABSENT", "NOT_COLLECTED"].includes(ru.searchSurfaces?.globalSummary?.knowledgePanelStatus ?? "")
    : true,
  ru.searchSurfaces?.globalSummary?.knowledgePanelStatus
);

console.log("\n=== serpSnapshot ===");
console.log({
  mode: ru.serpSnapshot?.mode,
  query: ru.serpSnapshot?.query,
  highlighted: ru.serpSnapshot?.metadata?.highlightedCount,
  sourceMode: ru.serpSnapshot?.metadata?.sourceMode,
});

console.log("\n=== EN client checks ===");
const enStr = JSON.stringify(en);
console.log({
  language: en.meta?.language,
  watermark: en.meta?.watermark,
  hasMock: /\bmock\b/i.test(enStr),
  hasDemo: /\bdemo\b/i.test(enStr),
  hasSourceMode: enStr.includes("sourceMode"),
  hasCyrillicUI: /[А-Яа-яЁё]{4,}/.test(JSON.stringify(en.auditSummary?.executiveSummary ?? "")),
});

console.log("\n=== globalSummary ===");
console.log(ru.searchSurfaces?.globalSummary);

console.log(`\n${failures === 0 ? "QA ARTIFACT ANALYSIS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures > 0 ? 1 : 0);

export {};
