/**
 * §1.2 / F6 — DatabaseProfile → canonical RawInventoryItem.
 *
 * Active compliance hits enter the analytics inventory as `compliance_hit`
 * so surface analyzers and p33–p36 fragments can render real LexisNexis /
 * Dow Jones / World-Check rows. Soft-delete lives on Case; dismissed /
 * false-positive hits are filtered here.
 */

import type { RawInventoryItem } from "../orion-golden/types";
import type { ComplianceScreeningRecord } from "../orion-golden/deck-sections/scoped-input";

/** Subset of DatabaseProfile columns needed for inventory adaptation. */
export type DatabaseProfileHitInput = {
  id: string;
  provider: string;
  importMethod?: string | null;
  hitSource?: string | null;
  importedBy?: string | null;
  matchedName?: string | null;
  subjectName?: string | null;
  matchType?: string | null;
  matchScore?: number | null;
  reviewStatus?: string | null;
  riskTypes?: unknown;
  aliases?: unknown;
  countries?: unknown;
  datesOfBirth?: unknown;
  confidence?: string | null;
  profileId?: string | null;
  summary?: string | null;
  profileUrl?: string | null;
  evidenceRefs?: unknown;
  rawMetadataSafe?: unknown;
  importedAt?: Date | string | null;
};

export type ComplianceInventoryPrisma = {
  databaseProfile: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: (args: any) => Promise<DatabaseProfileHitInput[]>;
  };
};

/** Review statuses that must not appear as active report hits. */
const EXCLUDED_REVIEW = new Set(["DISMISSED", "FALSE_POSITIVE"]);

function asObj(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function riskTypesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((x) => String(x)).filter(Boolean);
}

/** Строковый список из Json-колонки; пустой список не пишется в артефакт. */
function stringListOf(value: unknown): string[] | undefined {
  const list = riskTypesOf(value).map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/** Мастер-документ гибридного импорта LexisNexis — не совпадение, а сам отчёт. */
function isLexisHybridMaster(row: DatabaseProfileHitInput): boolean {
  const hybrid = asObj(asObj(row.rawMetadataSafe).lexisNexisHybrid);
  return String(hybrid.kind ?? "") === "lexisnexis_report";
}

/** Мастер-строка загруженных снимков страниц Dow Jones / World-Check. */
function isComplianceVisualMaster(row: DatabaseProfileHitInput): boolean {
  const kind = String(asObj(asObj(row.rawMetadataSafe).complianceVisual).kind ?? "");
  return kind === "dow_jones_report" || kind === "world_check_report";
}

/** Демонстрационная строка: посеяна для показа продукта, а не собрана по делу. */
function isDemoRow(row: DatabaseProfileHitInput): boolean {
  return (
    String(row.hitSource ?? "").toUpperCase() === "MOCK" ||
    String(row.importedBy ?? "").startsWith("mock:") ||
    asObj(row.rawMetadataSafe).demo === true
  );
}

/**
 * Строка комплаенса, относящаяся к делу: не демонстрация и не мастер-документ.
 *
 * Отделена от «материала отчёта» намеренно: разбор аналитика (сколько записей
 * снято как ложные срабатывания) считается по строкам дела, а печатается —
 * материал отчёта. Пока ответ был один, счётчик разобранных записей оказывался
 * структурно нулевым, потому что считался уже после их отсева.
 *
 * `includeDemo` существует только для служебного просмотра классической сводки
 * («показать демо-данные»); в деку демо не попадает никогда.
 */
export function isComplianceCaseRow(
  row: DatabaseProfileHitInput,
  options: { includeDemo?: boolean } = {}
): boolean {
  if (isLexisHybridMaster(row) || isComplianceVisualMaster(row)) return false;
  if (!options.includeDemo && isDemoRow(row)) return false;
  return true;
}

/**
 * Строка комплаенса, которая является материалом отчёта.
 *
 * Один ответ на вопрос «какие строки печатаются» для обоих путей: классической
 * сводки и канонического инвентаря деки. Пока ответов было два, канонический
 * пропускал то, что классический отбрасывал: демо-строки и мастер-документы
 * импорта. Разница была невидимой, пока слайд печатал счётчик; как только
 * карточка печатает поля записи дословно, мастер-строка импортированного PDF
 * превращается в «Совпадение по имени: Потенциальное совпадение», а демо-строка
 * — в синтетическое совпадение на деле живого человека.
 */
export function isComplianceReportMaterial(
  row: DatabaseProfileHitInput,
  options: { includeDemo?: boolean } = {}
): boolean {
  const status = String(row.reviewStatus ?? "PENDING").toUpperCase();
  if (EXCLUDED_REVIEW.has(status)) return false;
  return isComplianceCaseRow(row, options);
}

/** Persist-only matchType values — prefer riskTypes for client category. */
const INTERNAL_MATCH_TYPES = new Set([
  "LEXISNEXIS_SIGNAL",
  "LEXISNEXIS_IMPORTED_REPORT",
]);

function matchCategoryOf(row: DatabaseProfileHitInput): string | undefined {
  const firstRisk = riskTypesOf(row.riskTypes)[0];
  if (firstRisk) return firstRisk.toUpperCase();
  const fromType = String(row.matchType ?? "").trim().toUpperCase();
  if (fromType && !INTERNAL_MATCH_TYPES.has(fromType)) return fromType;
  return fromType || undefined;
}

function collectedAtOf(row: DatabaseProfileHitInput): string {
  if (!row.importedAt) return new Date(0).toISOString();
  if (row.importedAt instanceof Date) return row.importedAt.toISOString();
  const d = new Date(row.importedAt);
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString();
}

/**
 * Reject placeholders and English narrative blobs that must not appear as
 * «Совпадение по имени» in the client PDF (PDF review p41).
 */
export function isNarrativeOrPlaceholderMatchName(name: string): boolean {
  const n = String(name ?? "").trim();
  if (!n) return true;
  if (/^(potential\s+match|потенциальное совпадение)$/i.test(n)) return true;
  if (/^imported\s+lexisnexis/i.test(n)) return true;
  if (/^additional information\b/i.test(n)) return true;
  if (n.length > 90) return true;
  const words = n.split(/\s+/).filter(Boolean);
  const mostlyLatin = /^[\x00-\x7F]+$/.test(n);
  if (mostlyLatin && words.length >= 8) return true;
  if (
    mostlyLatin &&
    words.length >= 5 &&
    /\b(designated|supervisory|council|december|january|february|march|april|may|june|july|august|september|october|november)\b/i.test(
      n
    )
  ) {
    return true;
  }
  return false;
}

/** Pick a short client-safe match label (FIO / entity), never a snippet. */
export function pickComplianceClientMatchTitle(input: {
  matchedName?: string | null;
  subjectName?: string | null;
  summary?: string | null;
  fallback?: string | null;
}): string {
  const candidates = [input.matchedName, input.subjectName, input.fallback]
    .map((s) => String(s ?? "").trim())
    .filter(Boolean);
  for (const c of candidates) {
    if (!isNarrativeOrPlaceholderMatchName(c)) return c;
  }
  return "Потенциальное совпадение";
}

/**
 * Map a DatabaseProfile row (or fixture DTO) to a RawInventoryItem for the
 * canonical analytics pipeline. Identity is decided from reviewStatus later
 * (skipTextClassifier marker) — not by the surname/token classifier.
 */
export function adaptDatabaseProfileToInventoryItem(input: {
  row: DatabaseProfileHitInput;
  caseId: string;
  reportRunId: string;
}): RawInventoryItem | null {
  const { row, caseId, reportRunId } = input;
  if (!row.id || !isComplianceReportMaterial(row)) return null;

  const provider = String(row.provider ?? "OTHER").toUpperCase();
  const matchCategory = matchCategoryOf(row);
  const reviewStatus = String(row.reviewStatus ?? "PENDING").toUpperCase();
  const riskTypes = riskTypesOf(row.riskTypes);
  const safeMeta = asObj(row.rawMetadataSafe);
  const profileUrl = String(row.profileUrl ?? "").trim();
  const title = pickComplianceClientMatchTitle({
    matchedName: row.matchedName,
    subjectName: row.subjectName,
    summary: row.summary,
  });

  return {
    inventoryId: `db-${row.id}`,
    caseId,
    reportRunId,
    source: "database_profile",
    provider,
    region: "GLOBAL",
    collectedAt: collectedAtOf(row),
    evidenceType: "compliance_hit",
    title,
    snippet: String(row.summary ?? ""),
    sourceUrl: profileUrl || undefined,
    classification: reviewStatus,
    rawMetadata: {
      ...safeMeta,
      surface: "compliance_hit",
      provider,
      matchType: matchCategory,
      matchCategory,
      matchScore: row.matchScore ?? undefined,
      reviewStatus,
      riskTypes,
      importMethod: row.importMethod ?? undefined,
      hitSource: row.hitSource ?? undefined,
      matchedName: row.matchedName ?? undefined,
      profileUrl: profileUrl || undefined,
      // Поля карточки записи. До этого они оставались в базе: артефакт нёс
      // пять полей из двенадцати, и страница базы печатала счётчик со
      // статусом там, где эталон отрасли печатает профиль.
      aliases: stringListOf(row.aliases),
      countries: stringListOf(row.countries),
      datesOfBirth: stringListOf(row.datesOfBirth),
      confidence: row.confidence ?? undefined,
      profileId: row.profileId ?? undefined,
      summary: String(row.summary ?? "").trim() || undefined,
      evidenceRefs: [`databaseProfile:${row.id}`],
      /** Identity branch: do not run surname/token F1 classifier. */
      skipTextClassifier: true,
      identityFromReview: true,
    },
  };
}

export function adaptDatabaseProfilesToInventory(input: {
  rows: DatabaseProfileHitInput[];
  caseId: string;
  reportRunId: string;
}): RawInventoryItem[] {
  const out: RawInventoryItem[] = [];
  for (const row of input.rows) {
    const item = adaptDatabaseProfileToInventoryItem({
      row,
      caseId: input.caseId,
      reportRunId: input.reportRunId,
    });
    if (item) out.push(item);
  }
  return out;
}

/** Load active DatabaseProfile rows for a case (live path). */
export async function loadComplianceHitsFromPrisma(input: {
  prisma: ComplianceInventoryPrisma;
  caseId: string;
}): Promise<DatabaseProfileHitInput[]> {
  const rows = await input.prisma.databaseProfile.findMany({
    where: { caseId: input.caseId },
    orderBy: [{ importedAt: "desc" }],
  });
  return rows.filter((row) => isComplianceReportMaterial(row));
}

/**
 * Resolve compliance inventory items: explicit fixture/deps wins; otherwise
 * load from prisma when available.
 */
export async function resolveComplianceInventoryItems(input: {
  caseId: string;
  reportRunId: string;
  complianceHits?: DatabaseProfileHitInput[] | null;
  prisma?: ComplianceInventoryPrisma | null;
}): Promise<RawInventoryItem[]> {
  let rows: DatabaseProfileHitInput[] = [];
  if (input.complianceHits != null) {
    rows = input.complianceHits;
  } else if (input.prisma?.databaseProfile) {
    rows = await loadComplianceHitsFromPrisma({
      prisma: input.prisma,
      caseId: input.caseId,
    });
  }
  return adaptDatabaseProfilesToInventory({
    rows,
    caseId: input.caseId,
    reportRunId: input.reportRunId,
  });
}

/** Строка `dp_compliance_screening_runs` в том виде, в каком её отдаёт prisma. */
export type ComplianceScreeningRunRow = {
  provider: string;
  status: string;
  hitCount?: number | null;
  errorCode?: string | null;
  startedAt?: Date | string | null;
  finishedAt?: Date | string | null;
};

export type ComplianceScreeningPrisma = {
  complianceScreeningRun: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: (args: any) => Promise<ComplianceScreeningRunRow[]>;
  };
};

function isoOf(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Последний ран по каждой базе.
 *
 * Отчёт отвечает на вопрос «проверяли ли эту базу в этом прогоне», и отвечает
 * на него самая свежая запись: более ранняя неудача не отменяет успешной
 * проверки, сделанной после неё. Порядок вывода фиксирован по имени базы —
 * артефакт обязан быть побайтово воспроизводимым.
 */
export function latestScreeningPerProvider(
  rows: ComplianceScreeningRunRow[]
): ComplianceScreeningRecord[] {
  const byProvider = new Map<string, ComplianceScreeningRecord>();
  const finishedMs = new Map<string, number>();
  for (const row of rows) {
    const provider = String(row.provider ?? "").trim().toUpperCase();
    if (!provider) continue;
    const finishedAt = isoOf(row.finishedAt) ?? isoOf(row.startedAt);
    const ms = finishedAt ? Date.parse(finishedAt) : 0;
    if (byProvider.has(provider) && ms <= (finishedMs.get(provider) ?? 0)) continue;
    byProvider.set(provider, {
      provider,
      status: String(row.status ?? "").toUpperCase(),
      hitCount: Number(row.hitCount ?? 0),
      finishedAt,
      errorCode: row.errorCode ?? null,
    });
    finishedMs.set(provider, ms);
  }
  return [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * Итоги скринингов для артефакта: фикстура сильнее базы, база — сильнее пустоты.
 * Пусто означает «в этом прогоне проверок не было», и страница базы говорит
 * именно это.
 */
export async function resolveComplianceScreenings(input: {
  caseId: string;
  screenings?: ComplianceScreeningRunRow[] | null;
  prisma?: ComplianceScreeningPrisma | null;
}): Promise<ComplianceScreeningRecord[]> {
  if (input.screenings != null) return latestScreeningPerProvider(input.screenings);
  if (!input.prisma?.complianceScreeningRun) return [];
  const rows = await input.prisma.complianceScreeningRun.findMany({
    where: { caseId: input.caseId },
    orderBy: [{ startedAt: "desc" }],
  });
  return latestScreeningPerProvider(rows);
}
