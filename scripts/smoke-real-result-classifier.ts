/**
 * Smoke test for Stage N1.3 — real search-result classifier + ORION highlights.
 *
 * Pure/offline unit checks — NO API keys, NO dev server, NO DB, NO network, NO
 * real allegations about real people (fictional fixtures only):
 *   - deterministic classifier (wikipedia/news neutral; sanctions/fraud risky);
 *   - conservative confidence (single weak term ⇒ LOW, no highlight);
 *   - highlight resolver precedence (manual > findings > auto > enum);
 *   - manual adverse/neutral override;
 *   - dismissed findings suppress highlights;
 *   - theme grouping assigns Theme N + counts; empty ⇒ no red frames;
 *   - classifier output never leaks secret-like tokens.
 *
 * Run:  npm run smoke:real-result-classifier   (uses tsx)
 */

import {
  classifySearchResultRecord,
  isRiskyResultClass,
  type StoredRiskClassification,
} from "../src/modules/digital-profile/risk-classifier/result-classifier";
import { resolveHighlight } from "../src/modules/digital-profile/serp-snapshot/highlight-resolver";
import { groupThemes } from "../src/modules/digital-profile/serp-snapshot/theme-grouper";
import type { LoadedResult } from "../src/modules/digital-profile/serp-snapshot/types";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

function loaded(partial: Partial<LoadedResult> & { id: string }): LoadedResult {
  return {
    id: partial.id,
    engine: partial.engine ?? "YANDEX",
    rank: partial.rank ?? 1,
    title: partial.title ?? null,
    url: partial.url ?? "https://example.test/",
    domain: partial.domain ?? "example.test",
    snippet: partial.snippet ?? null,
    classification: partial.classification ?? "UNCLASSIFIED",
    riskTheme: partial.riskTheme ?? null,
    region: null,
    language: null,
    source: partial.source ?? "real:YANDEX",
    createdAt: new Date(0),
    isHighlighted: partial.isHighlighted ?? false,
    themeTitle: partial.themeTitle ?? null,
  };
}

function main() {
  console.log("Smoke testing N1.3 result classifier + highlights (offline)\n");

  // --- 1. Wikipedia / biography ⇒ RELEVANT, not risky ---
  const wiki = classifySearchResultRecord({
    title: "Test Person — Wikipedia",
    url: "https://ru.wikipedia.org/wiki/Test_Person",
    snippet: "Биография вымышленного публичного деятеля.",
  });
  check("wikipedia ⇒ RELEVANT", wiki.classification === "RELEVANT", wiki.classification);
  check("wikipedia not risky", !isRiskyResultClass(wiki.classification));

  // --- 2. Plain news without adverse words ⇒ NEWS/NEUTRAL ---
  const news = classifySearchResultRecord({
    title: "Test Person opened a new cultural centre",
    url: "https://news.example.test/article",
    snippet: "A routine announcement with no negative terms.",
  });
  check("plain news ⇒ NEWS/NEUTRAL", ["NEWS", "NEUTRAL"].includes(news.classification), news.classification);
  check("plain news not risky", !isRiskyResultClass(news.classification));

  // --- 3. Sanctions keywords ⇒ SANCTIONS, HIGH ---
  const sanc = classifySearchResultRecord({
    title: "Test Person added to sanctions list (fictional example)",
    url: "https://gov.example.test/sdn",
    snippet: "Fictional OFAC sanctions example for testing.",
  });
  check("sanctions ⇒ SANCTIONS", sanc.classification === "SANCTIONS", sanc.classification);
  check("sanctions HIGH confidence", sanc.confidence === "HIGH", sanc.confidence);

  // --- 4. Fraud/investigation ⇒ ADVERSE_MEDIA (or LEGAL_DISPUTE) ---
  const fraud = classifySearchResultRecord({
    title: "Test Person — fictional fraud investigation example",
    url: "https://news.example.test/fraud",
    snippet: "Fictional fraud and corruption investigation for testing.",
  });
  check("fraud ⇒ ADVERSE_MEDIA", fraud.classification === "ADVERSE_MEDIA", fraud.classification);
  check("fraud MEDIUM/HIGH", ["MEDIUM", "HIGH"].includes(fraud.confidence), fraud.confidence);

  // --- 4b. Single weak legal term ⇒ LOW, not highlighting ---
  const weak = classifySearchResultRecord({
    title: "Test Person attended a court hearing as a witness",
    url: "https://news.example.test/court",
    snippet: "Mentions суд once; no adverse claim.",
  });
  const weakHi = resolveHighlight({ enumClassification: null, riskClassification: { auto: { ...weak, classifiedAt: "" } }, findings: [] });
  check("single weak term ⇒ not highlighted", !weakHi.isHighlighted, `${weak.classification}/${weak.confidence}`);

  // --- 5. Manual adverse overrides neutral auto ---
  const neutralAuto: StoredRiskClassification = {
    auto: { classification: "NEUTRAL", riskTheme: null, confidence: "LOW", rationale: "", matchedTerms: [], classifiedAt: "" },
    manual: { classification: "ADVERSE_MEDIA", riskTheme: "adverse_media", rationale: null, reviewedBy: "analyst", reviewedAt: "" },
  };
  const m1 = resolveHighlight({ enumClassification: null, riskClassification: neutralAuto, findings: [] });
  check("manual adverse overrides neutral auto", m1.isHighlighted && m1.source === "manual", `${m1.source}`);

  // --- 6. Manual neutral overrides automatic adverse ---
  const adverseAuto: StoredRiskClassification = {
    auto: { classification: "ADVERSE_MEDIA", riskTheme: "adverse_media", confidence: "HIGH", rationale: "", matchedTerms: [], classifiedAt: "" },
    manual: { classification: "NEUTRAL", riskTheme: null, rationale: null, reviewedBy: "analyst", reviewedAt: "" },
  };
  const m2 = resolveHighlight({ enumClassification: null, riskClassification: adverseAuto, findings: [] });
  check("manual neutral overrides auto adverse", !m2.isHighlighted && m2.source === "manual", `${m2.source}`);

  // --- 7. Auto MEDIUM/HIGH highlights; LOW does not ---
  const autoHi = resolveHighlight({
    enumClassification: null,
    riskClassification: { auto: { classification: "SANCTIONS", riskTheme: "sanctions", confidence: "HIGH", rationale: "", matchedTerms: [], classifiedAt: "" } },
    findings: [],
  });
  check("auto HIGH sanctions ⇒ highlight", autoHi.isHighlighted && autoHi.source === "auto");
  const autoLo = resolveHighlight({
    enumClassification: null,
    riskClassification: { auto: { classification: "PEP", riskTheme: "political_exposure", confidence: "LOW", rationale: "", matchedTerms: [], classifiedAt: "" } },
    findings: [],
  });
  check("auto LOW ⇒ not highlighted", !autoLo.isHighlighted);

  // --- 8. Findings: active highlights, all-dismissed suppresses ---
  const active = resolveHighlight({ enumClassification: null, riskClassification: null, findings: [{ reviewStatus: "PENDING", riskTheme: "criminal" }] });
  check("active finding ⇒ highlight (theme criminal)", active.isHighlighted && active.riskTheme === "criminal");
  const dismissed = resolveHighlight({
    enumClassification: "ADVERSE_MEDIA",
    riskClassification: { auto: { classification: "ADVERSE_MEDIA", riskTheme: "adverse_media", confidence: "HIGH", rationale: "", matchedTerms: [], classifiedAt: "" } },
    findings: [{ reviewStatus: "DISMISSED", riskTheme: "adverse_media" }],
  });
  check("all-dismissed finding ⇒ suppressed", !dismissed.isHighlighted && dismissed.source === "finding");

  // --- 8b. Legacy enum fallback ---
  const legacy = resolveHighlight({ enumClassification: "ADVERSE_MEDIA", riskClassification: null, findings: [] });
  check("legacy enum ADVERSE_MEDIA ⇒ highlight", legacy.isHighlighted && legacy.source === "enum");

  // --- 9. Theme grouping: red frames + Theme N labels; empty ⇒ none ---
  const rows: LoadedResult[] = [
    loaded({ id: "a", isHighlighted: true, riskTheme: "adverse_media" }),
    loaded({ id: "b", isHighlighted: true, riskTheme: "adverse_media" }),
    loaded({ id: "c", isHighlighted: true, riskTheme: "sanctions" }),
    loaded({ id: "d", isHighlighted: false, riskTheme: null }),
  ];
  const grouping = groupThemes(rows, "ru");
  check("grouping highlightedCount = 3", grouping.highlightedCount === 3, String(grouping.highlightedCount));
  check("grouping themes = 2", grouping.themes.length === 2, String(grouping.themes.length));
  check("theme 1 = most frequent (adverse_media, count 2)", grouping.themes[0].count === 2 && grouping.themes[0].themeNumber === 1);
  check("theme label localized", grouping.themes[0].themeLabel === "Тема 1", grouping.themes[0].themeLabel);
  const empty = groupThemes([loaded({ id: "x", isHighlighted: false })], "en");
  check("no highlights ⇒ no themes", empty.highlightedCount === 0 && empty.themes.length === 0);

  // --- 10. No secret-like tokens in classifier output ---
  const serialized = JSON.stringify([wiki, news, sanc, fraud]);
  check(
    "classifier output has no secret-like tokens",
    !/api[-_ ]?key|folder|secret|YANDEX_SEARCH/i.test(serialized)
  );

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
