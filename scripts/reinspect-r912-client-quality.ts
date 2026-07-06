import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectR912ClientQuality } from "../src/modules/digital-profile/orion-client-storyboard/r912-client-quality-inspection";

const root = join(process.cwd(), "storage/digital-profile/qa-r9-12-client-quality-storyboard");
const storyboard = JSON.parse(readFileSync(join(root, "client-storyboard.json"), "utf8"));
const relevance = JSON.parse(readFileSync(join(root, "evidence-relevance-inspection.json"), "utf8"));
const gpt = JSON.parse(readFileSync(join(root, "gpt-section-analyses.json"), "utf8"));
const cq = inspectR912ClientQuality({
  outputRoot: root,
  storyboard,
  relevanceReport: relevance,
  gptAnalyses: gpt,
  generatedBy: "gpt-5.5",
});
writeFileSync(join(root, "client-quality-inspection.json"), JSON.stringify(cq, null, 2));
const qa = JSON.parse(readFileSync(join(root, "qa-summary.json"), "utf8"));
qa.clientQuality = cq;
qa.verdict = cq.verdict;
writeFileSync(join(root, "qa-summary.json"), JSON.stringify(qa, null, 2));
console.log(`VERDICT: ${cq.verdict}`);
