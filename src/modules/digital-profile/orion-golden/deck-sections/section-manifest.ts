/**
 * report-section-manifest.json — validated registry of all SectionPacks in
 * deck order. Required FAILED section blocks the build; optional EMPTY_VALID
 * may be omitted; INSUFFICIENT_DATA is never replaced by a stale pack.
 */

import type {
  FragmentKey,
  ManifestEntry,
  ReportSectionManifest,
  SectionPackV2,
  SectionType,
} from "./contracts";
import {
  DEFAULT_SECTION_ORDER,
  FRAGMENT_ARTIFACT_PATHS,
  REPORT_SECTION_MANIFEST_VERSION,
  REQUIRED_SECTIONS,
  SECTION_FRAGMENTS,
} from "./contracts";
import type { SectionValidationReport } from "./section-validation";

/**
 * Причина отказа секции — коротко и по существу.
 *
 * Берутся первые две претензии проверки: их достаточно, чтобы понять класс
 * проблемы, и они не превращают сообщение об ошибке в простыню. Когда отчёта о
 * проверке нет вовсе, это тоже сказано словом, а не пустотой.
 */
function describeSectionFailure(report: SectionValidationReport | undefined): string {
  if (!report) return " (нет отчёта проверки секции)";
  const issues = report.issues.filter((i) => String(i ?? "").trim());
  if (issues.length === 0) return "";
  const shown = issues.slice(0, 2).join("; ");
  const rest = issues.length > 2 ? ` и ещё ${issues.length - 2}` : "";
  return ` (${shown}${rest})`;
}

export function buildReportSectionManifest(input: {
  caseId: string;
  reportRunId: string;
  sourceDatasetId: string;
  packs: SectionPackV2[];
  validationReports: Map<FragmentKey, SectionValidationReport>;
}): ReportSectionManifest {
  const byKey = new Map(input.packs.map((p) => [p.fragmentKey, p]));
  const entries: ManifestEntry[] = [];
  let order = 0;

  for (const sectionType of DEFAULT_SECTION_ORDER) {
    for (const fragmentKey of SECTION_FRAGMENTS[sectionType]) {
      const pack = byKey.get(fragmentKey);
      if (!pack) continue; // fragment not built (e.g. appendix skipped)
      order += 1;
      const validation = input.validationReports.get(fragmentKey);
      entries.push({
        order,
        sectionType,
        fragmentKey,
        artifactPath: FRAGMENT_ARTIFACT_PATHS[fragmentKey],
        required: pack.required,
        status: validation && !validation.passed ? "FAILED" : pack.status,
        contentHash: pack.contentHash,
        slideCount: pack.slides.length,
        validationPassed: validation?.passed ?? false,
      });
    }
  }

  /*
   * Отказ называет причину, а не только имя секции.
   *
   * Прежде здесь оставалось `EXECUTIVE/EXECUTIVE_SUMMARY:FAILED`, и это всё,
   * что видели оператор и журнал. Причина при этом была известна проверке
   * секций и лежала в артефакте на диске — «bullet over budget on
   * p03_executive: 916>900». Чтобы её узнать, приходилось лезть в файлы
   * прогона; на живом отказе это стоило часа, а сама строка была готова.
   *
   * Диагноз должен ехать вместе с отказом, а не ждать, пока за ним придут.
   */
  const requiredSectionsFailed = entries
    .filter(
      (e) =>
        e.required &&
        REQUIRED_SECTIONS.includes(e.sectionType) &&
        (e.status === "FAILED" || e.status === "INSUFFICIENT_DATA" || !e.validationPassed)
    )
    .map((e) => {
      const why = describeSectionFailure(input.validationReports.get(e.fragmentKey));
      return `${e.sectionType}/${e.fragmentKey}:${e.status}${why}`;
    });

  return {
    schemaVersion: REPORT_SECTION_MANIFEST_VERSION,
    caseId: input.caseId,
    reportRunId: input.reportRunId,
    sourceDatasetId: input.sourceDatasetId,
    generatedAt: new Date().toISOString(),
    sectionOrder: DEFAULT_SECTION_ORDER.filter((s: SectionType) =>
      entries.some((e) => e.sectionType === s)
    ),
    entries,
    requiredSectionsFailed,
    buildBlocked: requiredSectionsFailed.length > 0,
  };
}
