/**
 * Offline smoke: observation highlights + Yandex mapping + dual-engine view model.
 * Run: npx tsx scripts/smoke-serp-observation-themes-yandex.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSyntheticSerpViewModelFromObservations,
  classifyObservationHighlight,
  mapYandexOrganicToObservationDrafts,
  mapSerperOrganicToObservationDrafts,
  type PersistedSerpObservation,
} from "../src/modules/digital-profile/serp-observation";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

function asPersisted(
  draft: ReturnType<typeof mapSerperOrganicToObservationDrafts>[number],
  id: string
): PersistedSerpObservation {
  return { ...draft, id, searchDocumentId: null };
}

function main() {
  console.log("Smoke: SERP observation themes + Yandex map\n");

  const baseItem = {
    query: "Глинка Сергей Михайлович",
    region: "RU" as const,
    language: "ru",
    thumbnailUrl: null,
    imageUrl: null,
    videoUrl: null,
    sourcePageUrl: null,
    rawMetadataSafe: {},
  };
  const googleDrafts = mapSerperOrganicToObservationDrafts({
    caseId: "c1",
    auditRunId: "run1",
    queryText: "Глинка Сергей Михайлович",
    region: "RU",
    language: "ru",
    items: [
      {
        ...baseItem,
        kind: "organic",
        rank: 1,
        title: "PEP: Глинка Сергей Михайлович",
        url: "https://rupep.org/person/glinka",
        domain: "rupep.org",
        snippet: "PEP профиль",
      },
      {
        ...baseItem,
        kind: "organic",
        rank: 2,
        title: "Бизнесмен Сергей Глинка",
        url: "https://klerk.ru/boss/glinka",
        domain: "klerk.ru",
        snippet: "биография",
      },
      {
        ...baseItem,
        kind: "organic",
        rank: 3,
        title: "Makhmudov and Bokarev",
        url: "https://rucriminal.info/article/glinka",
        domain: "rucriminal.info",
        snippet: "санкции Трансмашхолдинг",
      },
    ],
  });

  const yandexDrafts = mapYandexOrganicToObservationDrafts({
    caseId: "c1",
    auditRunId: "run1",
    queryText: "Глинка Сергей Михайлович",
    region: "RU",
    language: "ru",
    results: [
      {
        provider: "YANDEX",
        query: "Глинка Сергей Михайлович",
        rank: 1,
        title: "Глинка Сергей — Яндекс",
        snippet: "профиль",
        url: "https://yandex.ru/search/?text=glinka",
        domain: "yandex.ru",
        rawMetadata: {},
        capturedAt: new Date().toISOString(),
      },
      {
        provider: "YANDEX",
        query: "Глинка Сергей Михайлович",
        rank: 2,
        title: "Азбука Компромата",
        snippet: "компромат",
        url: "https://acompromat.net/glinka",
        domain: "acompromat.net",
        rawMetadata: {},
        capturedAt: new Date().toISOString(),
      },
    ],
  });

  check("yandex drafts mapped", yandexDrafts.length === 2);
  check(
    "yandex engine/provider",
    yandexDrafts.every((d) => d.engine === "YANDEX" && d.provider === "yandex")
  );

  const rupep = classifyObservationHighlight(asPersisted(googleDrafts[0]!, "o1"));
  const klerk = classifyObservationHighlight(asPersisted(googleDrafts[1]!, "o2"));
  const criminal = classifyObservationHighlight(asPersisted(googleDrafts[2]!, "o3"));
  check("rupep highlighted", rupep.isHighlighted);
  check("klerk not highlighted", !klerk.isHighlighted);
  check("rucriminal highlighted", criminal.isHighlighted);

  const observations = [
    ...googleDrafts.map((d, i) => asPersisted(d, `g${i}`)),
    ...yandexDrafts.map((d, i) => asPersisted(d, `y${i}`)),
  ];
  const vm = buildSyntheticSerpViewModelFromObservations({
    observations,
    subjectName: "Глинка Сергей Михайлович",
    queryText: "Глинка Сергей Михайлович",
  });

  check("themes present", vm.themes.length > 0, `count=${vm.themes.length}`);
  check("noNegatives false", vm.noNegatives === false);
  check("google column filled", vm.engines.google.results.length === 3);
  check("yandex column filled", vm.engines.yandex.results.length === 2);
  check("google has red frames", vm.engines.google.results.some((r) => r.isHighlighted));
  check("yandex has red frames", vm.engines.yandex.results.some((r) => r.isHighlighted));
  check(
    "dual source label",
    /Yandex/i.test(vm.sourceLabel) && /Serper/i.test(vm.sourceLabel),
    vm.sourceLabel
  );

  const outDir = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-serp-observation-themes-yandex"
  );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "qa-result.json"),
    JSON.stringify(
      {
        stage: "serp-observation-themes-yandex",
        passed: failures === 0,
        failures,
        themes: vm.themes.map((t) => ({ n: t.themeNumber, title: t.title, count: t.count })),
        sourceLabel: vm.sourceLabel,
        generatedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    "utf-8"
  );

  console.log(failures ? `\nFAILED (${failures})` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
}

main();
