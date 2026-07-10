/**
 * Offline smoke: observation highlights + Yandex mapping + dual-engine view model.
 * Run: npx tsx scripts/smoke-serp-observation-themes-yandex.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSyntheticSerpViewModelFromObservations,
  classifyObservationHighlight,
  isSyntheticSerpNoiseHit,
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
      {
        ...baseItem,
        kind: "organic",
        rank: 4,
        title: "Сергей Глинка",
        url: "https://www.forbes.ru/profile/sergei-glinka",
        domain: "forbes.ru",
        snippet: "Businessman associated with transport and investments",
      },
      {
        ...baseItem,
        kind: "organic",
        rank: 5,
        title: "Глинка (дворянский род)",
        url: "https://ru.wikipedia.org/wiki/Глинка_(дворянский_род)",
        domain: "ru.wikipedia.org",
        snippet: "русский дворянский род",
      },
      {
        ...baseItem,
        kind: "organic",
        rank: 6,
        title: "Mikhail Glinka - IMSLP",
        url: "https://imslp.org/wiki/Category:Glinka,_Mikhail",
        domain: "imslp.org",
        snippet: "composer scores",
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
  const forbes = classifyObservationHighlight(asPersisted(googleDrafts[3]!, "o4"));
  check("rupep highlighted", rupep.isHighlighted);
  check("klerk not highlighted", !klerk.isHighlighted);
  check("rucriminal highlighted", criminal.isHighlighted);
  check("forbes bio not highlighted", !forbes.isHighlighted);

  const subject = "Глинка Сергей Михайлович";
  check(
    "wikipedia family is noise",
    isSyntheticSerpNoiseHit(asPersisted(googleDrafts[4]!, "o5"), subject)
  );
  check(
    "imslp composer is noise",
    isSyntheticSerpNoiseHit(asPersisted(googleDrafts[5]!, "o6"), subject)
  );
  check(
    "rupep is not noise",
    !isSyntheticSerpNoiseHit(asPersisted(googleDrafts[0]!, "o1"), subject)
  );

  const observations = [
    ...googleDrafts.map((d, i) => asPersisted(d, `g${i}`)),
    ...yandexDrafts.map((d, i) => asPersisted(d, `y${i}`)),
  ];
  const vm = buildSyntheticSerpViewModelFromObservations({
    observations,
    subjectName: subject,
    queryText: "Глинка Сергей Михайлович",
  });

  check("themes present", vm.themes.length > 0, `count=${vm.themes.length}`);
  check("noNegatives false", vm.noNegatives === false);
  check(
    "google drops wiki+imslp noise",
    vm.engines.google.results.length === 4,
    `count=${vm.engines.google.results.length}`
  );
  check(
    "google has no wikipedia/imslp urls",
    vm.engines.google.results.every(
      (r) => !/wikipedia|imslp/i.test(`${r.url} ${r.domain}`)
    )
  );
  check("yandex column filled", vm.engines.yandex.results.length === 2);
  check("google has red frames", vm.engines.google.results.some((r) => r.isHighlighted));
  check("yandex has red frames", vm.engines.yandex.results.some((r) => r.isHighlighted));
  check(
    "forbes not red-framed in vm",
    !vm.engines.google.results.some(
      (r) => /forbes/i.test(r.domain) && r.isHighlighted
    )
  );
  check(
    "dual source label",
    /Yandex/i.test(vm.sourceLabel) && /Serper/i.test(vm.sourceLabel),
    vm.sourceLabel
  );

  // Themes must only count cards that appear in the PNG columns.
  const visibleHighlighted = [
    ...vm.engines.google.results,
    ...vm.engines.yandex.results,
  ].filter((r) => r.isHighlighted).length;
  const themeCountSum = vm.themes.reduce((n, t) => n + t.count, 0);
  check(
    "theme counts match visible red frames",
    themeCountSum === visibleHighlighted,
    `themes=${themeCountSum} visibleHl=${visibleHighlighted}`
  );

  // Deep ranks: adverse below the neutral top-N must still enter the visible window.
  const deepAdverse = asPersisted(
    {
      ...googleDrafts[2]!,
      rank: 20,
      url: "https://cybercriminal.com/threats/sergei-glinka",
      domain: "cybercriminal.com",
      title: "Sergei Glinka",
      snippet: "criminal profile",
    },
    "g-deep"
  );
  const filler = Array.from({ length: 8 }, (_, i) =>
    asPersisted(
      {
        ...googleDrafts[1]!,
        rank: i + 1,
        url: `https://klerk.ru/boss/glinka-${i}`,
        domain: "klerk.ru",
        title: `Neutral bio ${i + 1}`,
        snippet: "биография",
      },
      `g-fill-${i}`
    )
  );
  const vmDeep = buildSyntheticSerpViewModelFromObservations({
    observations: [...filler, deepAdverse, ...yandexDrafts.map((d, i) => asPersisted(d, `y2${i}`))],
    subjectName: subject,
    queryText: "Глинка Сергей Михайлович",
  });
  check(
    "deep adverse preferred into visible google column",
    vmDeep.engines.google.results.some((r) => /cybercriminal/i.test(r.domain)),
    vmDeep.engines.google.results.map((r) => r.domain).join(",")
  );
  check(
    "deep adverse painted before neutrals (no clip)",
    vmDeep.engines.google.results[0]?.domain?.includes("cybercriminal") === true,
    vmDeep.engines.google.results.map((r) => r.domain).join(",")
  );
  check(
    "visible google capped to fit card",
    vmDeep.engines.google.results.length <= 5,
    `count=${vmDeep.engines.google.results.length}`
  );
  const deepThemeSum = vmDeep.themes.reduce((n, t) => n + t.count, 0);
  const deepVisibleHl = [
    ...vmDeep.engines.google.results,
    ...vmDeep.engines.yandex.results,
  ].filter((r) => r.isHighlighted).length;
  check(
    "deep themes match visible frames",
    deepThemeSum === deepVisibleHl,
    `themes=${deepThemeSum} visibleHl=${deepVisibleHl}`
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
