/**
 * Smoke test — Stage R1.1.3 risk classifier precision (offline).
 *
 * Run: npm run smoke:risk-classifier-precision
 */

import {
  classifySearchResultRecord,
  isRiskyResultClass,
  isStrongAutoSnapshotRisk,
} from "../src/modules/digital-profile/risk-classifier/result-classifier";
import { resolveHighlight } from "../src/modules/digital-profile/serp-snapshot/highlight-resolver";

const SUBJECT = "Томилин Константин Романович";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

function highlightFor(
  result: ReturnType<typeof classifySearchResultRecord>,
  manual?: boolean
) {
  const auto = { ...result, classifiedAt: new Date().toISOString() };
  return resolveHighlight({
    enumClassification: "UNCLASSIFIED",
    riskClassification: manual
      ? {
          manual: {
            classification: result.classification,
            riskTheme: result.riskTheme,
            rationale: "manual",
            reviewedBy: "smoke",
            reviewedAt: new Date().toISOString(),
          },
        }
      : { auto },
    findings: [],
    sourceIsMock: false,
  });
}

function main() {
  console.log("Smoke testing R1.1.3 risk classifier precision\n");

  const rusprofile = classifySearchResultRecord({
    title: "ИП Томилин Константин Романович",
    url: "https://www.rusprofile.ru/ip/123",
    snippet: "ИНН 1234567890, ОГРНИП, регистрация предпринимателя",
    subjectFullName: SUBJECT,
  });
  check("Rusprofile => CORPORATE_REGISTRY", rusprofile.classification === "CORPORATE_REGISTRY", rusprofile.classification);
  check("Rusprofile not LEGAL", rusprofile.classification !== "LEGAL_DISPUTE");
  check("Rusprofile no red frame", !highlightFor(rusprofile).isHighlighted);

  const klerk = classifySearchResultRecord({
    title: "Томилин К.Р. — карточка на Klerk.ru",
    url: "https://www.klerk.ru/company/example",
    snippet: "ИНН, ликвидирован, прекратил деятельность",
    subjectFullName: SUBJECT,
  });
  check("Klerk weak registry not adverse", klerk.classification === "CORPORATE_REGISTRY", klerk.classification);
  check("Klerk no red frame", !highlightFor(klerk).isHighlighted);

  const scientist = classifySearchResultRecord({
    title: "Константин Александрович Томилин — известные ученые",
    url: "https://science.example/people",
    snippet: "СЕМЬ ИСКУССТВ, биография ученого",
    subjectFullName: SUBJECT,
  });
  check("Other patronymic => NAMESAKE", scientist.classification === "NAMESAKE", scientist.classification);
  check("Scientist no adverse", !isRiskyResultClass(scientist.classification));
  check("Scientist no red frame", !highlightFor(scientist).isHighlighted);

  const social = classifySearchResultRecord({
    title: "Константин Томилин",
    url: "https://m.ok.ru/profile/123",
    snippet: "Профиль пользователя",
    subjectFullName: SUBJECT,
  });
  check("OK.ru => SOCIAL_PROFILE", social.classification === "SOCIAL_PROFILE", social.classification);
  check("Social no red frame", !highlightFor(social).isHighlighted);

  const court = classifySearchResultRecord({
    title: "Томилин Константин Романович — судебное дело",
    url: "https://kad.arbitr.ru/card/123",
    snippet: "Иск к ответчику Томилин Константин Романович, арбитражный суд",
    subjectFullName: SUBJECT,
  });
  check("Court => LEGAL_DISPUTE", court.classification === "LEGAL_DISPUTE", court.classification);
  check("Court strong auto", isStrongAutoSnapshotRisk({ ...court, classifiedAt: "" }));
  check("Court red frame allowed", highlightFor(court).isHighlighted);

  const sanc = classifySearchResultRecord({
    title: "Томилин Константин Романович — санкционный список",
    url: "https://gov.example/sdn",
    snippet: "Под санкциями OFAC",
    subjectFullName: SUBJECT,
  });
  check("Sanctions => SANCTIONS", sanc.classification === "SANCTIONS", sanc.classification);
  check("Sanctions red frame", highlightFor(sanc).isHighlighted);

  const manualLegal = classifySearchResultRecord({
    title: "Neutral registry row",
    url: "https://lenta.ru/neutral",
    snippet: "Neutral",
    subjectFullName: SUBJECT,
  });
  const manualHl = resolveHighlight({
    enumClassification: "UNCLASSIFIED",
    riskClassification: {
      manual: {
        classification: "LEGAL_DISPUTE",
        riskTheme: "legal_dispute",
        rationale: "analyst",
        reviewedBy: "smoke",
        reviewedAt: new Date().toISOString(),
      },
    },
    findings: [],
  });
  check("Manual LEGAL => red frame", manualHl.isHighlighted);

  const cleared = resolveHighlight({
    enumClassification: "LEGAL",
    riskClassification: {
      manual: {
        classification: "NEUTRAL",
        riskTheme: null,
        rationale: "cleared",
        reviewedBy: "smoke",
        reviewedAt: new Date().toISOString(),
      },
      auto: { ...court, classifiedAt: "" },
    },
    findings: [],
  });
  check("Manual neutral clears red frame", !cleared.isHighlighted);
  void manualLegal;

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
