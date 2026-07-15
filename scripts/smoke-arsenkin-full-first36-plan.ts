import { buildArsenkinSubjectQueryPlan } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-subject-query-plan";
import { planArsenkinExactTasks } from "../src/modules/digital-profile/orion-golden/classic/plan-arsenkin-exact-tasks";

let failures = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
};

const q = buildArsenkinSubjectQueryPlan({
  fullName: "Глинка Сергей Михайлович",
  aliases: ["Сергей Глинка", "Sergey Glinka", "Glinka Sergey"],
});
const planned = planArsenkinExactTasks({
  queriesRu: q.queriesRu,
  queriesUae: q.queriesUae,
  tools: ["check-top", "suggest", "paa", "ai-serp", "check-h", "indexation"],
  urlsEnrichment: Array.from({ length: 12 }, (_, i) => `https://example.org/page-${i + 1}`),
});

const has = (tool: string) => planned.some((p) => p.tool === tool);
check("query plan has RU queries", q.queriesRu.length > 0, `ru=${q.queriesRu.length}`);
check("query plan has UAE queries", q.queriesUae.length > 0, `uae=${q.queriesUae.length}`);
check("check-top planned", has("check-top"));
check("suggest planned", has("suggest"));
check("paa planned", has("paa"));
check("ai-serp planned", has("ai-serp"));
check("check-h planned", has("check-h"));
check("indexation planned", has("indexation"));
check(
  "check-top depth=20 noreask=true",
  planned
    .filter((p) => p.tool === "check-top")
    .every((p) => Number((p.data as Record<string, unknown>)["depth"]) === 20 && (p.data as Record<string, unknown>)["noreask"] === true)
);
check(
  "URL audit limited to 10 URLs",
  planned
    .filter((p) => p.tool === "check-h" || p.tool === "indexation")
    .every((p) => {
      const urls = (p.data as { urls?: string[] }).urls ?? [];
      return urls.length <= 10;
    })
);

if (failures > 0) process.exitCode = 1;
console.log(failures ? `FAILED ${failures}` : "ALL PASS");
