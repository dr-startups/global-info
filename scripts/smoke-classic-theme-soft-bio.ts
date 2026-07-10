/**
 * Offline smoke: soft-bio domains must not spawn Moldova politics themes.
 *
 * Run: npm run smoke:classic-theme-soft-bio
 */

import type { FullEvidenceInventory } from "../src/modules/digital-profile/orion-golden/evidence/full-evidence-inventory";
import type { RawInventoryItem } from "../src/modules/digital-profile/orion-golden/types";
import {
  buildAnnotatedLinkCards,
  buildOrionThemeSet,
  orionStyleRiskMatrixRows,
} from "../src/modules/digital-profile/orion-golden/classic/orion-classic-theme-set";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

function makeItem(partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title" | "sourceUrl">): RawInventoryItem {
  return {
    inventoryId: "inv-smoke",
    caseId: "case-smoke",
    reportRunId: "run-smoke",
    source: "serp",
    provider: "yandex",
    region: "RU",
    collectedAt: new Date().toISOString(),
    evidenceType: "search_result",
    snippet: "",
    ...partial,
  };
}

function makeInventory(items: RawInventoryItem[]): FullEvidenceInventory {
  return {
    version: "r10-full-evidence-inventory-v1",
    caseId: "case-smoke",
    reportRunId: "run-smoke",
    inspectedAt: new Date().toISOString(),
    subject: { fullName: "Глинка Сергей Михайлович", aliases: [] },
    counts: {
      searchResults: items.length,
      searchSurfaces: 0,
      databaseProfiles: 0,
      riskFindings: 0,
      wikiChecks: 0,
      screenshots: 0,
    },
    countsBySource: {},
    countsByRegion: { RU: items.length },
    countsByEvidenceType: { search_result: items.length },
    mediaAvailability: {
      images: 0,
      videos: 0,
      knowledgePanels: 0,
      serpScreenshots: 0,
      suggestions: 0,
      relatedQueries: 0,
      manualNotes: 0,
      organicResults: items.length,
    },
    lexisNexis: {
      uploadExists: false,
      latestReady: false,
      visualPageCount: 0,
      parsedSignals: 0,
      status: "absent",
    },
    missingSources: [],
    warnings: [],
    items,
  };
}

function main() {
  console.log("Smoke: classic theme soft-bio (forbes.ru birthplace vs Moldova politics)\n");

  const subjectName = "Глинка Сергей Михайлович";

  const forbesBirthplace = makeInventory([
    makeItem({
      title: "Глинка Сергей Михайлович — биография",
      sourceUrl: "https://www.forbes.ru/profile/glinka",
      snippet: "Место рождения: Молдавия. Дата рождения: 12.03.1968.",
    }),
  ]);
  const forbesThemeSet = buildOrionThemeSet({ inventory: forbesBirthplace, subjectName });
  const forbesPolitical = forbesThemeSet.themes.filter((t) => t.id === "political_exposure");
  const forbesCards = buildAnnotatedLinkCards(forbesThemeSet, "RU");
  const forbesMatrix = orionStyleRiskMatrixRows(forbesThemeSet);
  const forbesMoldovaClaims = forbesThemeSet.executiveBullets.filter((b) => /молдав/i.test(b));

  check("forbes.ru birthplace: no political_exposure theme", forbesPolitical.length === 0);
  check(
    "forbes.ru birthplace: no Tema forbes card",
    !forbesCards.some((c) => /forbes\.ru/i.test(c))
  );
  check(
    "forbes.ru birthplace: no Moldova politics matrix row",
    !forbesMatrix.some((r) => /политическая деятельность.*молдав/i.test(r.theme))
  );
  check("forbes.ru birthplace: no Moldova politics executive bullet", forbesMoldovaClaims.length === 0);

  const hardPolitics = makeInventory([
    makeItem({
      title: "Спонсорство политической кампании в Молдавии",
      sourceUrl: "https://www.kommersant.ru/doc/moldova-politics-glinka",
      snippet:
        "Авторы утверждают, что Глинка спонсировал политическую активность; И. Махмудов лоббировал выдвижение на пост Президента Молдовы.",
    }),
  ]);
  const hardThemeSet = buildOrionThemeSet({ inventory: hardPolitics, subjectName });
  const hardPolitical = hardThemeSet.themes.filter((t) => t.id === "political_exposure");
  const hardMatrix = orionStyleRiskMatrixRows(hardThemeSet);

  check("hard source Moldova politics: political_exposure theme kept", hardPolitical.length >= 1);
  check(
    "hard source Moldova politics: matrix row present",
    hardMatrix.some((r) => /молдав/i.test(r.theme) || /политич/i.test(r.summary))
  );

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  if (failures > 0) process.exitCode = 1;
}

main();
