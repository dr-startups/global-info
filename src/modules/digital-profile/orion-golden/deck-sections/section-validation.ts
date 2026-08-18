import { domainToASCII } from "node:url";
/**
 * Section-level QA — every SectionPack must pass before assembly.
 * A failed pack never reaches the DeckAssembler.
 */

import { SectionPackV2Schema, type SectionPackV2 } from "./contracts";
import { clientLink } from "./fragment-builders/serp";
import { normalizeEvidenceRef, type ScopedEvidenceIndex } from "./scoped-input";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";
import {
  getClientTextFieldBudgets,
  matchInternalClientToken,
} from "../client/load-client-text-contract";

export type SectionValidationReport = {
  fragmentKey: string;
  passed: boolean;
  issues: string[];
};

/**
 * Templates whose dynamic sidebar/what-found copy must be strictly derived
 * from the slide's own evidence refs (page scope) — never from region- or
 * bundle-level findings/domains.
 */
const PAGE_SCOPED_TEMPLATES = new Set([
  "serp-screenshot-analysis",
  "suggestions",
  "image-grid",
  "wikipedia-knowledge",
  "wikipedia-check",
  "ai-overview",
  "related-queries",
  "serp-table",
]);

/** Fragments whose serp-table slides carry region-level summary rows. */
const REGION_SUMMARY_FRAGMENTS = new Set(["RU_SUMMARY", "UAE_SUMMARY", "COMPLIANCE_MAIN"]);

/**
 * Домены в клиентском тексте. Зона — буквы **или** punycode (`xn--…`).
 *
 * Требование «зона состоит только из букв» отсекало кириллические зоны: у
 * `.рф` она выглядит как `xn--p1ai`, с цифрами и дефисами. На боевом прогоне
 * 28.07 из строки «Источники — … xn--h1ajim.xn--p1ai …» вырезался обрезок
 * `xn--h1ajim.xn`; такого домена не существует, среди доказательств страницы
 * его не было, и обязательная секция `RU_SERP` получила отказ
 * «sidebar domain not derived from page evidence». Дека не собралась вовсе —
 * `pageCount: 0`. То есть отчёт с любым источником в зоне `.рф` до клиента не
 * доходил.
 *
 * Буквенная зона требовалась, чтобы не считать доменами даты и числа
 * («28.07.2026», «3.14»), — это свойство сохранено: punycode-зона обязана
 * начинаться с `xn--`.
 */
// Границы заданы просмотрами, а не `\b`: в JS `\b` считает словом только
// ASCII, поэтому перед кириллической буквой она не срабатывает вовсе и
// «руни.рф» не опознавался как домен.
export const DOMAIN_TOKEN_RE =
  /(?<![\p{L}0-9.-])[\p{L}0-9][\p{L}0-9-]*(?:\.[\p{L}0-9-]+)*\.(?:xn--[a-z0-9-]+|\p{L}{2,})(?![\p{L}0-9-])/giu;

const TEXT_BUDGETS = getClientTextFieldBudgets();

export function validateSectionPack(input: {
  pack: SectionPackV2;
  expectedCaseId: string;
  expectedReportRunId: string;
  expectedDatasetId: string;
  bundle: VerifiedFindingBundle;
  knownEvidenceRefs: Set<string>;
  /** Full run evidence index for the sidebar domain-derivation gate. */
  evidenceIndex?: ScopedEvidenceIndex;
}): SectionValidationReport {
  const issues: string[] = [];
  const { pack } = input;

  // 1. Schema valid (v3 self-contained: caseId/datasetId/sourceFindingIds/
  // evidenceRefs required; superRefine enforces datasetId==sourceDatasetId and
  // sourceFindingIds/evidenceRefs == inputs.*).
  const parsed = SectionPackV2Schema.safeParse(pack);
  if (!parsed.success) {
    issues.push(`schema: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }

  // 2/3. Lineage matches — explicit self-contained fields, never inferred.
  if (!pack.caseId) {
    issues.push("missing caseId");
  } else if (pack.caseId !== input.expectedCaseId) {
    issues.push(`foreign caseId: ${pack.caseId}`);
  }
  if (pack.reportRunId !== input.expectedReportRunId) {
    issues.push(`foreign reportRunId: ${pack.reportRunId}`);
  }
  if (pack.datasetId !== input.expectedDatasetId) {
    issues.push(`stale datasetId: ${pack.datasetId}`);
  }
  if (pack.sourceDatasetId !== input.expectedDatasetId) {
    issues.push(`stale sourceDatasetId: ${pack.sourceDatasetId}`);
  }

  // 4/5. All findingIds and evidenceRefs must exist.
  const knownFindings = new Set([
    ...input.bundle.findings.map((f) => f.findingId),
    ...(input.bundle.excludedFindingIds ?? []),
  ]);
  for (const slide of pack.slides) {
    for (const id of slide.findingIds) {
      if (!knownFindings.has(id)) issues.push(`unknown findingId on ${slide.slideId}: ${id}`);
    }
    for (const ref of slide.evidenceRefs) {
      if (!input.knownEvidenceRefs.has(ref)) {
        issues.push(`unknown evidenceRef on ${slide.slideId}: ${ref}`);
      }
    }
  }

  // 6. OTHER_SUBJECT never enters subject KPI slides.
  const otherSubjectIds = new Set(
    input.bundle.findings
      .filter((f) => f.subjectMatch === "OTHER_SUBJECT")
      .map((f) => f.findingId)
  );
  if (pack.fragmentKey !== "APPENDIX_MAIN") {
    for (const slide of pack.slides) {
      for (const id of slide.findingIds) {
        if (otherSubjectIds.has(id)) {
          issues.push(`OTHER_SUBJECT finding in subject KPI slide ${slide.slideId}: ${id}`);
        }
      }
    }
  }

  // 7. Client text within budgets; 8. no internal tokens; unsupported claims
  // guard: any narrative sentence naming a findingId must reference a known one
  // (covered by findingIds check + bullets carry [findingId] markers).
  for (const slide of pack.slides) {
    checkText(issues, slide.slideId, "title", slide.title, TEXT_BUDGETS.title);
    checkText(issues, slide.slideId, "narrative", slide.content.narrative, TEXT_BUDGETS.narrative);
    checkText(issues, slide.slideId, "whatWasFound", slide.content.whatWasFound, TEXT_BUDGETS.whatWasFound);
    checkText(issues, slide.slideId, "whyItMatters", slide.content.whyItMatters, TEXT_BUDGETS.whyItMatters);
    checkText(issues, slide.slideId, "whatToCheck", slide.content.whatToCheck, TEXT_BUDGETS.whatToCheck);
    for (const b of slide.content.bullets ?? []) {
      // AI answers are exempt from the bullet budget (no truncation allowed),
      // but never from the internal-token check.
      const budget = slide.templateId === "ai-overview" ? Number.MAX_SAFE_INTEGER : TEXT_BUDGETS.bullet;
      checkText(issues, slide.slideId, "bullet", b, budget);
    }
    for (const row of slide.content.table?.rows ?? []) {
      for (const cell of row) {
        if (matchInternalClientToken(stripFindingMarkers(cell))) {
          issues.push(`internal token in table cell on ${slide.slideId}: "${cell.slice(0, 60)}"`);
        }
      }
    }
  }

  // 9. Local metrics reconcile.
  if (pack.metrics.adverseDisplayedCount > pack.metrics.adverseDatasetCount) {
    issues.push("metrics: adverseDisplayedCount > adverseDatasetCount");
  }
  if (pack.metrics.displayedCount > pack.metrics.datasetCount && pack.metrics.datasetCount > 0) {
    issues.push("metrics: displayedCount > datasetCount");
  }

  // 10. Continuation structure valid: each continuation references an earlier
  // base slide in the same pack and indexes are sequential.
  const baseIds = new Set(pack.slides.filter((s) => !s.isContinuation).map((s) => s.slideId));
  const contByBase = new Map<string, number[]>();
  for (const slide of pack.slides) {
    if (!slide.isContinuation) continue;
    if (!slide.continuationOf || !baseIds.has(slide.continuationOf)) {
      issues.push(`continuation ${slide.slideId} has no base slide in pack`);
      continue;
    }
    const list = contByBase.get(slide.continuationOf) ?? [];
    list.push(slide.continuationIndex ?? -1);
    contByBase.set(slide.continuationOf, list);
  }
  for (const [b, idx] of contByBase) {
    const sorted = [...idx].sort((a, z) => a - z);
    for (let i = 0; i < sorted.length; i += 1) {
      if (sorted[i] !== i + 1) {
        issues.push(`continuation indexes for ${b} not sequential: ${sorted.join(",")}`);
        break;
      }
    }
  }

  // Status/slide coherence.
  if (pack.status === "READY" && pack.slides.length === 0) {
    issues.push("READY pack has no slides");
  }
  if (pack.status === "EMPTY_VALID" && pack.slides.length > 0) {
    issues.push("EMPTY_VALID pack must not carry slides");
  }

  // 11. Sidebar scope subsets (fail closed): every slide's findingIds and
  // evidenceRefs must stay inside the fragment's own scoped inputs — no
  // fallback to global VerifiedFindingBundle findings or global domains.
  const inputFindingIds = new Set(pack.inputs.findingIds);
  const inputRefs = new Set(pack.inputs.evidenceRefs);
  for (const slide of pack.slides) {
    for (const id of slide.findingIds) {
      if (!inputFindingIds.has(id)) {
        issues.push(`sidebar findingId outside fragment scope on ${slide.slideId}: ${id}`);
      }
    }
    for (const ref of slide.evidenceRefs) {
      if (!inputRefs.has(ref)) {
        issues.push(`sidebar evidenceRef outside fragment scope on ${slide.slideId}: ${ref}`);
      }
    }
  }

  // 12. Page-scope domain derivation (fail closed): on page-scoped templates
  // every source domain named in the dynamic conclusion, source footer or
  // highlight explanations must be derivable from that slide's OWN evidence
  // refs — never from an unrelated global domain list.
  if (input.evidenceIndex && !REGION_SUMMARY_FRAGMENTS.has(pack.fragmentKey)) {
    for (const slide of pack.slides) {
      if (!PAGE_SCOPED_TEMPLATES.has(slide.templateId)) continue;
      const normRefs = new Set(slide.evidenceRefs.map(normalizeEvidenceRef));
      const allowed = new Set<string>();
      for (const [ref, e] of Object.entries(input.evidenceIndex)) {
        if (!e.domain || e.domain === "—") continue;
        if (normRefs.has(normalizeEvidenceRef(ref))) allowed.add(normalizeDomainForCompare(e.domain));
      }
      const dynamicTexts = [
        slide.content.whatWasFound,
        slide.content.sourceNote,
        ...(slide.content.highlightExplanations ?? []).map((h) => h.clientReason),
      ].filter((t): t is string => Boolean(t));
      for (const text of dynamicTexts) {
        for (const m of text.matchAll(DOMAIN_TOKEN_RE)) {
          // Сверяется нормализованная форма: клиенту домен показывается
          // читаемым («руни.рф»), а в индексе доказательств он лежит в
          // punycode. Без приведения к одной форме читаемая запись выглядела
          // бы «не выведенной из доказательств» — той же ценой, что уже стоил
          // обрезок `xn--h1ajim.xn`: отказ обязательной секции и пустая дека.
          const domain = normalizeDomainForCompare(m[0]);
          if (!allowed.has(domain)) {
            issues.push(
              `sidebar domain not derived from page evidence on ${slide.slideId}: ${domain}`
            );
          }
        }
      }
    }
  }

  // 13. Утверждение «не найдено» не спорит с собственными наблюдениями отчёта.
  if (input.evidenceIndex) {
    for (const slide of pack.slides) {
      const issue = wikipediaDenialIssue(slide, input.evidenceIndex);
      if (issue) issues.push(issue);
    }
  }

  return { fragmentKey: pack.fragmentKey, passed: issues.length === 0, issues };
}

/**
 * Слайд, чья проверка Википедии ничего не нашла, обязан назвать статью,
 * которая лежит в его же доказательствах.
 *
 * На прогоне 76 страница ОАЭ утверждала «статья в англоязычной Википедии не
 * найдена», а `en.wikipedia.org/wiki/Viktor_Rashnikov` стоял первой строкой
 * таблицы выдачи того же отчёта: проверка ушла кириллическим запросом. Признак
 * — данные слайда, а не слова: строка о субъекте в том же языковом разделе,
 * что и проверка. Проверяется независимо от построителя намеренно — ворота,
 * повторяющие его вывод, подтверждают сами себя.
 */
function wikipediaDenialIssue(
  slide: SectionPackV2["slides"][number],
  evidenceIndex: ScopedEvidenceIndex
): string | null {
  const entries = slide.evidenceRefs.map((ref) => evidenceIndex[ref]);
  const checks = entries.filter((e) => e?.kind === "wikipedia_check");
  // Страница отрицает статью только там, где ни одна проверка её не нашла.
  if (checks.length === 0 || checks.some((e) => e?.wikipediaExists === true)) return null;
  const deniedDomains = new Set(
    checks
      .filter((e) => e?.wikipediaExists === false)
      .map((e) =>
        String(e?.language ?? "")
          .toLowerCase()
          .split(/[-_]/u)[0]
      )
      .filter(Boolean)
      .map((language) => `${language}.wikipedia.org`)
  );
  if (deniedDomains.size === 0) return null;
  const text = [
    slide.content.narrative,
    slide.content.whatWasFound,
    slide.content.whyItMatters,
    slide.content.whatToCheck,
    slide.content.sourceNote,
    ...(slide.content.bullets ?? []),
  ]
    .filter(Boolean)
    .join(" ");
  const unnamed = entries
    .filter(
      (e) =>
        e?.kind !== "wikipedia_check" &&
        e?.subjectDecision === "SUBJECT_MATCH" &&
        deniedDomains.has(String(e?.domain ?? "").toLowerCase()) &&
        /\/wiki\//u.test(String(e?.url ?? ""))
    )
    .map((e) => clientLink(e!.url, e!.domain))
    .filter((link) => !text.includes(link));
  return unnamed.length === 0
    ? null
    : `wikipedia denial contradicts page evidence on ${slide.slideId}: ${unnamed.join(", ")}`;
}

/** Одна форма домена для сверки: нижний регистр и punycode. */
function normalizeDomainForCompare(domain: string): string {
  const d = String(domain ?? "").trim().toLowerCase();
  if (!d) return "";
  return domainToASCII(d) || d;
}

function stripFindingMarkers(text: string): string {
  return (
    text
      .replace(/\[finding-[^\]]+\]/gu, "")
      // Domains from evidence URLs are legitimate client-facing content
      // (e.g. audit-it.ru); the technical-token check must not match them.
      .replace(/\b[\w-]+(?:\.[\w-]+)+\b/gu, "")
  );
}

function checkText(
  issues: string[],
  slideId: string,
  field: string,
  value: string | undefined,
  budget: number
): void {
  if (!value) return;
  if (value.length > budget) {
    issues.push(`${field} over budget on ${slideId}: ${value.length}>${budget}`);
  }
  if (matchInternalClientToken(stripFindingMarkers(value))) {
    issues.push(`internal token in ${field} on ${slideId}: "${value.slice(0, 60)}"`);
  }
}
