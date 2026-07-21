/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { FragmentKey, SectionType, SlideBody } from "../contracts";
import { SLIDE_CONTENT_SCHEMA_VERSION } from "../contracts";
import type { ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import { ADVERSE_PATTERNS } from "../../analytics/surface-analyzers";
import { isMockClientDomain } from "../../../services/composite-serp-merge";
import type { FragmentBuildOutput } from "./shared";
import {
  buildPageEvidenceView,
  claimText,
  clampClientText,
  coverageContent,
  emptyStatusForReason,
  fitClientSentences,
  makeSlotSlide,
  pageFindingBlocks,
  sourceLine,
  splitClientParagraphs,
  uniqueRefs,
  withContinuations,
} from "./shared";

export function buildIdentityFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput
): FragmentBuildOutput {
  const [slot] = slotsForFragment(key);
  const units = scoped.surfaceUnits.filter((u) => u.surface === "wikipedia");
  const subjectClaims = units.flatMap((u) => u.claims.filter((c) => c.subjectMatch === "SUBJECT_MATCH"));
  const foreignClaims = units.flatMap((u) => u.claims.filter((c) => c.subjectMatch === "OTHER_SUBJECT"));

  // §1.4 — prefer factual WikipediaCheck over SERP-domain inference.
  const regionHint = /ОАЭ|UAE|международ/i.test(regionLabel) ? "UAE" : "RU";
  const wikiCheckEntries = Object.entries(scoped.evidenceIndex).filter(([, e]) => {
    if (e.kind !== "wikipedia_check") return false;
    const lang = String(e.language ?? "").toLowerCase();
    const er = String(e.region ?? "").toUpperCase();
    if (regionHint === "RU") {
      return lang.startsWith("ru") || er === "RU";
    }
    // UAE / intl: non-ru languages (en, ar, …).
    return Boolean(lang) && !lang.startsWith("ru");
  });
  // Prefer an exists=true check when several languages/entries match the region.
  const wikiCheck =
    wikiCheckEntries.find(([, e]) => e.wikipediaExists === true) ?? wikiCheckEntries[0];
  const checkExists = wikiCheck ? Boolean(wikiCheck[1].wikipediaExists) : null;
  const checkRef = wikiCheck?.[0];

  if (units.length === 0 && checkExists === false) {
    return {
      slides: [
        makeSlotSlide({
          slot,
          sectionId,
          templateId: "coverage-empty-state",
          content: {
            ...coverageContent("no-identity-data", { kind: "MEASURED_EMPTY" }),
            narrative:
              "Фактическая проверка Wikipedia выполнена: статья о проверяемом субъекте не найдена — это результат проверки. В составном наборе энциклопедических материалов по этому контуру также нет.",
            whatWasFound: "Статья Wikipedia не найдена (проверка выполнена).",
          },
          evidenceRefs: checkRef ? [checkRef] : [],
          findingIds: [],
          emptyStateReason: "wikipedia-not-found",
          metrics: { wikipediaCheckExists: 0 },
        }),
      ],
      status: "READY",
    };
  }

  if (units.length === 0 && checkExists !== true) {
    return {
      slides: [
        makeSlotSlide({
          slot,
          sectionId,
          templateId: "coverage-empty-state",
          content: coverageContent(
            "no-identity-data",
            emptyStatusForReason(scoped, "no-identity-data")
          ),
          evidenceRefs: [],
          findingIds: [],
          emptyStateReason: "no-identity-data",
        }),
      ],
      status: "READY",
    };
  }

  const identityRefs = [
    ...units.flatMap((u) => u.evidenceRefs),
    ...(checkRef ? [checkRef] : []),
  ];
  // Encyclopedia rows actually captured (titles + domains) — shown to the
  // client even when none of them is adverse, so the page reflects reality
  // ("article exists, content neutral") instead of an empty claim list.
  const referenceEntries = identityRefs
    .map((r) => scoped.evidenceIndex[r])
    .filter((e): e is NonNullable<typeof e> => Boolean(e?.title))
    .slice(0, 6)
    .map((e) => clampClientText(`${e.title}${e.domain ? ` — ${e.domain}` : ""}`, 400));
  const checkBullet =
    wikiCheck && checkExists === true
      ? clampClientText(
          `Проверка Wikipedia (${wikiCheck[1].language ?? "—"}): статья найдена${
            wikiCheck[1].url ? ` — ${wikiCheck[1].url}` : ""
          }${wikiCheck[1].title ? ` «${wikiCheck[1].title}»` : ""}.`,
          400
        )
      : wikiCheck && checkExists === false
        ? "Проверка Wikipedia: статья не найдена."
        : null;
  const bullets = [
    ...(checkBullet ? [checkBullet] : []),
    ...subjectClaims.slice(0, 5).map((c) => clampClientText(c.text, 400)),
    // OTHER_SUBJECT is identity pollution, never a neutral subject signal.
    ...foreignClaims
      .slice(0, 3)
      .map((c) => clampClientText(`Риск смешения с другим лицом (не относится к субъекту): ${c.text}`, 400)),
  ];
  const shownBullets = bullets.length > 0 ? bullets : referenceEntries;
  const wikiDomains = [
    ...new Set(
      identityRefs
        .map((r) => scoped.evidenceIndex[r]?.domain)
        .filter((d): d is string => Boolean(d) && !isMockClientDomain(d))
    ),
  ].slice(0, 4);
  const hasAdverseRow = identityRefs.some((r) =>
    ADVERSE_PATTERNS.test(String(scoped.evidenceIndex[r]?.title ?? ""))
  );
  const checkNarrative =
    checkExists === true
      ? `Фактическая проверка Wikipedia подтверждает наличие статьи о проверяемом субъекте${
          wikiCheck?.[1].url ? ` (${wikiCheck[1].url})` : ""
        }. `
      : checkExists === false
        ? "Фактическая проверка Wikipedia: статья не найдена. "
        : "";
  const presenceNarrative = `${checkNarrative}В выдаче зафиксированы энциклопедические материалы о проверяемом субъекте${wikiDomains.length ? ` (${wikiDomains.join(", ")})` : ""}. ${
    hasAdverseRow
      ? "Отдельные карточки содержат чувствительные формулировки — их содержание отражено в темах повышенного внимания."
      : "Существенных негативных или спорных формулировок в этих карточках не выявлено."
  } Материалов об одноимённых лицах в контуре ${regionLabel} не зафиксировано.`;
  // When only the check exists (no SERP wiki rows), narrate from the check alone.
  const checkOnlyNarrative =
    units.length === 0 && checkExists === true
      ? `${checkNarrative}Энциклопедических строк в составной выдаче по контуру ${regionLabel} не зафиксировано; статус страницы опирается на проверку WikipediaCheck.`
      : null;
  const whatWasFoundFromCheck =
    checkExists === true
      ? clampClientText(
          `Проверка Wikipedia (${wikiCheck?.[1].language ?? "—"}): статья найдена` +
            (wikiCheck?.[1].title ? ` «${wikiCheck[1].title}»` : "") +
            (wikiCheck?.[1].url ? `. URL: ${wikiCheck[1].url}` : ".") +
            (wikiDomains.length
              ? ` В выдаче также есть энциклопедические домены: ${wikiDomains.join(", ")}.`
              : ""),
          500
        )
      : checkExists === false
        ? "Проверка Wikipedia: статья не найдена."
        : undefined;
  // Sidebar strictly scoped to the identity materials displayed on this page.
  const view = buildPageEvidenceView(scoped, identityRefs);
  const pageBlocks = pageFindingBlocks(scoped, view);
  const base = makeSlotSlide({
    slot,
    sectionId,
    content: {
      narrative:
        foreignClaims.length > 0
          ? `Справочные ресурсы (${regionLabel}) содержат материалы об одноимённом лице; ниже они отделены от данных проверяемого субъекта.`
          : checkOnlyNarrative ?? presenceNarrative,
      bullets: shownBullets,
      ...pageBlocks,
      // Factual WikipediaCheck wins over GPT/page-finding blurbs in whatWasFound.
      whatWasFound: whatWasFoundFromCheck ?? pageBlocks.whatWasFound,
    },
    evidenceRefs: identityRefs,
    findingIds: view.findings.map((f) => f.findingId),
    metrics: {
      subjectClaims: subjectClaims.length,
      identityPollution: foreignClaims.length,
      wikipediaCheckExists: checkExists === true ? 1 : checkExists === false ? 0 : -1,
    },
  });
  return { slides: withContinuations(base, "wikipedia-knowledge"), status: "READY" };
}

// ---------------------------------------------------------------------------
// KNOWLEDGE / AI (RU p18 panel + p19 AI; UAE p31 combined)
// ---------------------------------------------------------------------------
