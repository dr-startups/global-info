/**
 * Снятая тема не возвращается утверждением по непокрытому материалу.
 *
 * Резюме клиента строится из канонических утверждений, а не из находок.
 * Построитель утверждений сначала берёт находки — их снятая тема уже покинула
 * (`dropExcludedThemesFromSynthesis`), — а потом добирает утверждения по
 * материалам, которых ни одна находка не покрыла, и темы им даёт заново по
 * тексту. Материал снятой темы как раз и остался непокрытым, поэтому на
 * прогоне DPA-2026-0002 «Офшоры и финансовая прозрачность» ушли из матрицы и
 * приложения, но остались в «Коротко по итогам аудита» и в «Следующих
 * проверках». Один вопрос — «делает ли отчёт это утверждение» — получил два
 * ответа.
 *
 * Правило: у утверждений снимаются исключённые темы; утверждение, у которого
 * тем не осталось из-за снятия, уходит целиком — печатать его нечем. Тем, у
 * кого тем не было и раньше, это не касается.
 */

import { describe, expect, it } from "vitest";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import {
  buildSubjectResolution,
  type SubjectIdentity,
} from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import { synthesizeFindings } from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import { buildObservationDispositionLedger } from "@/modules/digital-profile/orion-golden/analytics/observation-disposition-ledger";
import {
  buildCanonicalClaimsBundle,
  canonicalClaimsFingerprint,
} from "@/modules/digital-profile/orion-golden/analytics/canonical-claim-builder";
import {
  dropExcludedThemesFromSynthesis,
  type AppliedOverrideRecord,
} from "@/modules/digital-profile/services/analyst-overrides-loader";
import {
  canonicalThemeIdOfReviewKey,
  classifyCanonicalThemes,
} from "@/modules/digital-profile/orion-golden/analytics/canonical-themes";

const CASE = "case-removed-theme";
const OFFSHORE = "offshore_financial_transparency";

const SUBJECT: SubjectIdentity = {
  displayName: "Тестов Сергей Михайлович",
  lastName: "Тестов",
  lastNameVariants: ["testov"],
  firstNames: ["Сергей", "sergey"],
  patronymics: ["Михайлович"],
  aliases: ["Тестов Сергей Михайлович"],
  strongIdentifiers: ["770000000001"],
  contextIdentifiers: ["бизнесмен"],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [],
  namesakeNoise: [],
};

let seq = 0;
function item(partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `it-${seq}`,
    caseId: CASE,
    reportRunId: "base-run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-07-16T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: partial.snippet ?? "",
    sourceUrl: partial.sourceUrl ?? `https://news.example/${seq}`,
    ...partial,
  };
}

/** Материал только офшорной темы и материал двух тем — суд и офшор. */
function items(): RawInventoryItem[] {
  // Одни и те же идентификаторы в каждой сборке: по ним тест ищет материал.
  seq = 0;
  return [
    item({
      // Ровно одна тема: слово «бенефициар» цепляло бы ещё и владение, и
      // утверждение законно осталось бы с ней.
      title: "Офшор Тестова Сергея Михайловича на Кипре",
      snippet: "Офшорная схема через Панаму и BVI (ИНН 770000000001)",
      sourceUrl: "https://news.example/offshore-only",
      classification: "adverse",
    }),
    item({
      title: "Суд арестовал активы Тестова Сергея Михайловича в офшоре",
      snippet: "Арест по решению суда; офшорная структура на Кипре (ИНН 770000000001)",
      sourceUrl: "https://news.example/court-and-offshore",
      classification: "adverse",
    }),
  ];
}

function build(excludedThemeKeys: string[], form: "with-param" | "pre-0070" = "with-param") {
  const list = items();
  const resolution = buildSubjectResolution({
    caseId: CASE,
    datasetId: `ds-${CASE}`,
    subject: SUBJECT,
    items: list,
    sourceHashes: ["sha256:test"],
  });
  const byRef = new Map(
    resolution.items.map((i) => [
      i.evidenceRef,
      { ...i, decision: "SUBJECT_MATCH" as const, reasonCode: "forced:SUBJECT_MATCH" },
    ])
  );
  const raw = synthesizeFindings({
    caseId: CASE,
    datasetId: `ds-${CASE}`,
    items: list,
    resolutionByRef: byRef,
    sourceHashes: ["sha256:test"],
  });
  const applied: AppliedOverrideRecord[] = excludedThemeKeys.map((key) => ({
    kind: "review_finding_excluded",
    matchKey: key,
    effect: "finding_excluded",
  }));
  const dropped = dropExcludedThemesFromSynthesis({
    findings: raw.bundle.findings,
    ambiguousFindings: raw.ambiguousFindings,
    applied,
  });
  const synthesis = {
    ...raw,
    bundle: { ...raw.bundle, findings: dropped.findings },
    ambiguousFindings: dropped.ambiguousFindings,
  };
  const dispositionLedger = buildObservationDispositionLedger({
    caseId: CASE,
    datasetId: `ds-${CASE}`,
    inventoryReportRunId: "base-run-1",
    sourceHashes: ["sha256:test"],
    items: list,
    resolutionByRef: byRef,
    synthesis,
  });
  const excludedThemeIds = new Set(
    dropped.removedThemeKeys
      .map(canonicalThemeIdOfReviewKey)
      .filter((id): id is NonNullable<typeof id> => id !== null)
  );
  const bundle = buildCanonicalClaimsBundle({
    caseId: CASE,
    datasetId: `ds-${CASE}`,
    subjectId: SUBJECT.displayName,
    sourceHashes: ["sha256:test"],
    items: list,
    synthesis,
    dispositionLedger,
    ...(form === "with-param" ? { excludedThemeIds } : {}),
  });
  return { bundle, removedThemeKeys: dropped.removedThemeKeys, excludedThemeIds };
}

describe("снятая тема и утверждения", () => {
  it("без снятия офшорная тема стоит в утверждениях — иначе тесту нечего проверять", () => {
    const [offshoreOnly, courtAndOffshore] = items();
    expect(classifyCanonicalThemes(`${offshoreOnly!.title} ${offshoreOnly!.snippet}`)).toEqual([
      OFFSHORE,
    ]);
    expect(
      classifyCanonicalThemes(`${courtAndOffshore!.title} ${courtAndOffshore!.snippet}`)
    ).toEqual(["criminal_judicial", OFFSHORE]);
    const { bundle } = build([]);
    expect(bundle.claims.some((c) => c.themeIds.includes(OFFSHORE))).toBe(true);
  });

  it("ключ пункта листа читается в канонический идентификатор темы", () => {
    expect(canonicalThemeIdOfReviewKey("theme:offshore_structures")).toBe(OFFSHORE);
    expect(canonicalThemeIdOfReviewKey(`theme:${OFFSHORE}`)).toBe(OFFSHORE);
    expect(canonicalThemeIdOfReviewKey("theme:no_such_theme")).toBeNull();
  });

  it("после снятия ни одно утверждение не несёт снятую тему", () => {
    const { bundle, removedThemeKeys, excludedThemeIds } = build(["theme:offshore_structures"]);
    expect(removedThemeKeys).toEqual(["theme:offshore_structures"]);
    expect([...excludedThemeIds]).toEqual([OFFSHORE]);
    expect(bundle.claims.filter((c) => c.themeIds.includes(OFFSHORE))).toEqual([]);
    // Материал только снятой темы утверждения не даёт вовсе.
    expect(bundle.claims.some((c) => c.evidenceRefs.includes("inventory:it-1"))).toBe(false);
  });

  it("утверждение двух тем теряет только снятую", () => {
    const { bundle } = build(["theme:offshore_structures"]);
    const court = bundle.claims.filter((c) => c.themeIds.includes("criminal_judicial"));
    expect(court.length).toBeGreaterThanOrEqual(1);
    for (const c of court) expect(c.themeIds).not.toContain(OFFSHORE);
  });

  it("без снятых тем набор утверждений не меняется", () => {
    const withParam = build([]).bundle;
    const before0070 = build([], "pre-0070").bundle;
    expect(canonicalClaimsFingerprint(withParam)).toBe(canonicalClaimsFingerprint(before0070));
  });
});
