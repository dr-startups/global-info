/**
 * Independent surface fragment builders — canonical-slot aware.
 *
 * Each builder owns one or more of the 36 canonical First36 base slots and
 * produces SlideContentContract[] for exactly those slots (plus continuations)
 * from its scoped input. Builders never see final page numbers, other
 * sections' content or layout coordinates.
 *
 * Visual assets: builders bind typed `visualAssetRefs` (existing report
 * assets). A text card is allowed only as an explicit
 * `VISUAL_ASSET_UNAVAILABLE` fallback when the underlying asset is missing.
 */

import type {
  FragmentKey,
  SectionType,
  SlideBody,
  SlideContentContract,
} from "./contracts";
import { SLIDE_CONTENT_SCHEMA_VERSION } from "./contracts";
import { DECK_TEMPLATE_REGISTRY, RED_MARKER_LABEL, type DeckTemplateId } from "./template-registry";
import { normalizeEvidenceRef, regionMatches, type ScopedFragmentInput } from "./scoped-input";
import {
  slotsForFragment,
  type CanonicalSlotDef,
  type VisibleAssetItem,
  type VisualAssetsBySlot,
} from "./canonical-slots";
import type { Finding } from "../contracts/finding";
import type { SurfaceClaim } from "../contracts/surface-analysis";
import { ADVERSE_PATTERNS } from "../analytics/surface-analyzers";

export type ExecutiveSummaryExtras = {
  verdict: string;
  executiveConclusion: string;
  keyFindings: Array<{
    findingId: string;
    title: string;
    factualBasis: string;
    clientImpact: string;
    recommendedAction: string;
  }>;
  priorityActions: string[];
  identityCaveats: string[];
  dataLimitations: string[];
};

/**
 * Sanitized stage-1 GPT case analysis (already client-safe): a holistic
 * assessment of the whole verified corpus. Used to write the executive
 * summary and to expand each risk theme with a client-language explanation
 * and concrete advice.
 */
export type GptCaseAnalysisExtras = {
  overallRiskLevel: string;
  executiveConclusion: string;
  digitalPortrait?: string;
  keyRisks: Array<{ theme: string; severity: string; explanation: string; advice: string }>;
  positiveSignals: string[];
  recommendations: string[];
};

export type FragmentExtras = {
  executiveSummary?: ExecutiveSummaryExtras;
  /** Existing compliance client copy (no source expansion). */
  complianceNarrative?: string[];
  /** Typed visual assets bound per canonical slot. */
  visualAssets?: VisualAssetsBySlot;
  /** Holistic GPT case analysis (client-safe, optional). */
  gptCaseAnalysis?: GptCaseAnalysisExtras;
};

/** Loose theme match: token overlap between a finding theme and a GPT risk theme. */
export function matchGptKeyRisk(
  theme: string,
  risks: GptCaseAnalysisExtras["keyRisks"] | undefined
): GptCaseAnalysisExtras["keyRisks"][number] | undefined {
  if (!risks?.length) return undefined;
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-zа-яё0-9]+/iu)
        .filter((w) => w.length > 3)
    );
  const a = tokens(theme);
  if (a.size === 0) return undefined;
  let best: { risk: GptCaseAnalysisExtras["keyRisks"][number]; score: number } | null = null;
  for (const risk of risks) {
    const b = tokens(risk.theme);
    let hit = 0;
    for (const w of a) if (b.has(w)) hit += 1;
    const score = hit / Math.max(1, Math.min(a.size, b.size));
    if (score >= 0.5 && (!best || score > best.score)) best = { risk, score };
  }
  return best?.risk;
}

export type FragmentBuildOutput = {
  slides: SlideContentContract[];
  status: "READY" | "EMPTY_VALID" | "INSUFFICIENT_DATA";
  emptyStateReason?: string;
};

export const VISUAL_ASSET_UNAVAILABLE = "VISUAL_ASSET_UNAVAILABLE" as const;

const RISK_ORDER: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

function isAdverse(f: Finding): boolean {
  return (RISK_ORDER[f.riskLevel] ?? 0) >= 2;
}

function assetsFor(extras: FragmentExtras, slotId: string): string[] {
  return (extras.visualAssets?.[slotId] ?? []).filter((a) => a.hasImage).map((a) => a.assetRef);
}

function makeSlotSlide(input: {
  slot: CanonicalSlotDef;
  sectionId: SectionType;
  templateId?: DeckTemplateId;
  title?: string;
  subtitle?: string;
  content: SlideBody;
  evidenceRefs: string[];
  findingIds: string[];
  metrics?: Record<string, number | string>;
  visualAssetRefs?: string[];
  emptyStateReason?: string;
}): SlideContentContract {
  return {
    schemaVersion: SLIDE_CONTENT_SCHEMA_VERSION,
    slideId: input.slot.slotId,
    baseSlotId: input.slot.slotId,
    sectionId: input.sectionId,
    isContinuation: false,
    continuationOf: null,
    continuationIndex: null,
    templateId: input.templateId ?? input.slot.templateId,
    title: input.title ?? input.slot.title,
    subtitle: input.subtitle,
    content: input.content,
    evidenceRefs: input.evidenceRefs,
    findingIds: input.findingIds,
    metrics: input.metrics ?? {},
    visualAssetRefs: input.visualAssetRefs ?? [],
    emptyStateReason: input.emptyStateReason,
  };
}

/** Chunk oversized bullets/table rows into adjacent continuation slides. */
function withContinuations(base: SlideContentContract, templateId: DeckTemplateId): SlideContentContract[] {
  const tpl = DECK_TEMPLATE_REGISTRY[templateId];
  const slides: SlideContentContract[] = [];
  const bullets = base.content.bullets ?? [];
  const rows = base.content.table?.rows ?? [];

  const bulletChunks =
    tpl.maxBulletsPerSlide > 0 && bullets.length > tpl.maxBulletsPerSlide
      ? chunk(bullets, tpl.maxBulletsPerSlide)
      : [bullets];
  const rowChunks =
    tpl.maxTableRowsPerSlide > 0 && rows.length > tpl.maxTableRowsPerSlide
      ? chunk(rows, tpl.maxTableRowsPerSlide)
      : [rows];
  const total = Math.max(bulletChunks.length, rowChunks.length);

  for (let i = 0; i < total; i += 1) {
    const content: SlideBody = {
      ...base.content,
      bullets: bulletChunks[i] ?? [],
      table: base.content.table
        ? { headers: base.content.table.headers, rows: rowChunks[i] ?? [] }
        : undefined,
    };
    if (i === 0) {
      slides.push({ ...base, content });
    } else {
      slides.push({
        ...base,
        slideId: `${base.slideId}__cont${i}`,
        isContinuation: true,
        continuationOf: base.slideId,
        continuationIndex: i,
        title: `${base.title} (продолжение ${i + 1}/${total})`,
        content: { ...content, narrative: undefined, whatWasFound: undefined, whyItMatters: undefined },
      });
    }
  }
  return slides;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Distribute items across N slots as evenly-sized contiguous chunks. */
function distribute<T>(items: T[], slots: number): T[][] {
  const out: T[][] = Array.from({ length: slots }, () => []);
  items.forEach((item, i) => out[Math.min(Math.floor((i * slots) / Math.max(items.length, 1)), slots - 1)].push(item));
  return out;
}

function domainOfUrl(url: string | undefined): string {
  if (!url || !/^https?:\/\//iu.test(url)) return "—";
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return "—";
  }
}

/**
 * Compose client text from whole sentences of the given parts, appending
 * sentences while they fit the budget — never a mid-sentence cut.
 */
export function fitClientSentences(parts: string[], max: number): string {
  const sentences = parts
    .flatMap((p) => p.split(/(?<=[.!?…])\s+/u))
    .map((s) => s.trim())
    .filter(Boolean);
  let out = "";
  for (const s of sentences) {
    const trial = out ? `${out} ${s}` : s;
    if (trial.length > max) break;
    out = trial;
  }
  if (!out && sentences[0]) return clampClientText(sentences[0], max);
  return /[.!?…]$/u.test(out) ? out : `${out}.`;
}

/**
 * Split client text into complete-sentence paragraphs of at most `maxPerPara`
 * characters (for renderer layouts that draw one card per paragraph).
 */
export function splitClientParagraphs(text: string, maxPerPara: number, maxParas: number): string[] {
  const sentences = text.split(/(?<=[.!?…])\s+/u).map((s) => s.trim()).filter(Boolean);
  const paras: string[] = [];
  let buf = "";
  for (const s of sentences) {
    const trial = buf ? `${buf} ${s}` : s;
    if (trial.length > maxPerPara && buf) {
      paras.push(buf);
      if (paras.length >= maxParas) return paras;
      buf = s.length > maxPerPara ? clampClientText(s, maxPerPara) : s;
    } else {
      buf = trial.length > maxPerPara ? clampClientText(trial, maxPerPara) : trial;
    }
  }
  if (buf && paras.length < maxParas) paras.push(buf);
  return paras;
}

/**
 * Clamp client text to its budget at a sentence/list boundary — a complete
 * phrase, never an ellipsis or a mid-word cut.
 */
export function clampClientText(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const boundaries = [slice.lastIndexOf(". "), slice.lastIndexOf(" · "), slice.lastIndexOf("; ")];
  const cut = Math.max(...boundaries);
  let out = cut > max * 0.4 ? slice.slice(0, cut) : slice.slice(0, slice.lastIndexOf(" "));
  out = out.replace(/[\s·;,.]+$/u, "");
  return `${out}.`;
}

/**
 * Region-level finding blocks — used ONLY by summary-level slides whose page
 * content IS the regional dataset (regional summary, full SERP table).
 * Visual/per-page fragments must use `pageFindingBlocks` instead.
 */
function findingBlocks(scoped: ScopedFragmentInput, extraCheck?: string): Partial<SlideBody> {
  const adverse = scoped.findings.filter(isAdverse);
  const top = [...scoped.findings].sort(
    (a, b) => (RISK_ORDER[b.riskLevel] ?? 0) - (RISK_ORDER[a.riskLevel] ?? 0)
  )[0];
  return {
    whatWasFound: clampClientText(
      top ? top.claim : "Существенных материалов по данной поверхности не обнаружено.",
      400
    ),
    whyItMatters: clampClientText(
      adverse.length
        ? `Обнаружено сигналов повышенного внимания: ${adverse.length}. Они влияют на восприятие субъекта при первичной проверке.`
        : "Поверхность не формирует негативного фона вокруг субъекта.",
      320
    ),
    whatToCheck: clampClientText(
      top?.recommendedAction ?? extraCheck ?? "Мониторить изменения выдачи.",
      220
    ),
    statusNote: statusLine(top),
    sourceNote: sourceLine(scoped),
  };
}

/** Confidence/status line: confirmed theme vs preliminary signal + level. */
function statusLine(top: Finding | undefined): string {
  if (!top) return "Статус: по данной поверхности выводов о рисках нет.";
  const kind = top.confidence >= 0.7 ? "подтверждённая тема" : "предварительный сигнал";
  return `Статус: ${kind}; уровень: ${riskLabel(top.riskLevel).toLowerCase()}; уверенность ${Math.round(
    top.confidence * 100
  )}%.`;
}

function normalizeEvidenceUrl(url: string | undefined): string {
  return (url ?? "")
    .replace(/^https?:\/\/(www\.)?/u, "")
    .replace(/[?#].*$/u, "")
    .replace(/\/+$/u, "")
    .toLowerCase();
}

/**
 * Page-scoped evidence view: which of this fragment's findings are actually
 * supported by the evidence displayed on ONE page (refs/URLs of the shown
 * rows/cards), and which domains that support comes from. This is the ONLY
 * source for dynamic sidebar copy on visual pages — no fallback to region- or
 * bundle-level findings/domains.
 */
export type PageEvidenceView = {
  refs: string[];
  /** Domains derivable from the page's own evidence refs. */
  domains: string[];
  /** Fragment findings supported by the page's evidence. */
  findings: Finding[];
  /** findingId → domains of its on-page supporting evidence. */
  supportDomains: Map<string, string[]>;
};

function buildPageEvidenceView(scoped: ScopedFragmentInput, pageRefs: string[]): PageEvidenceView {
  const entries = pageRefs.map((ref) => ({ ref, e: scoped.evidenceIndex[ref] }));
  const domainByNormRef = new Map<string, string>();
  const urlToDomain = new Map<string, string>();
  const domains = new Set<string>();
  for (const { ref, e } of entries) {
    const domain = e?.domain && e.domain !== "—" ? e.domain : undefined;
    if (domain) {
      domains.add(domain);
      domainByNormRef.set(normalizeEvidenceRef(ref), domain);
      const u = normalizeEvidenceUrl(e?.url);
      if (u) urlToDomain.set(u, domain);
    } else {
      domainByNormRef.set(normalizeEvidenceRef(ref), "");
    }
  }
  const findings: Finding[] = [];
  const supportDomains = new Map<string, string[]>();
  for (const f of scoped.findings) {
    const support = new Set<string>();
    let hit = false;
    for (const r of f.evidenceRefs) {
      const norm = normalizeEvidenceRef(r);
      const e = scoped.evidenceIndex[r];
      if (domainByNormRef.has(norm)) {
        hit = true;
        // Page entry may lack a resolvable domain (opaque asset ref); the
        // finding's own evidence entry names the same source then.
        const d = domainByNormRef.get(norm) || (e?.domain && e.domain !== "—" ? e.domain : "");
        if (d) support.add(d);
        continue;
      }
      const u = normalizeEvidenceUrl(e?.url);
      if (u && urlToDomain.has(u)) {
        hit = true;
        support.add(urlToDomain.get(u)!);
      }
    }
    if (hit) {
      findings.push(f);
      supportDomains.set(f.findingId, [...support]);
      // Support domains name the same on-page rows (resolved through the
      // finding's evidence entry when the page ref itself is opaque).
      for (const d of support) domains.add(d);
    }
  }
  findings.sort((a, b) => (RISK_ORDER[b.riskLevel] ?? 0) - (RISK_ORDER[a.riskLevel] ?? 0));
  return { refs: pageRefs, domains: [...domains], findings, supportDomains };
}

/**
 * Page-specific conclusion for one finding: theme + risk + the on-page
 * source domains. Deliberately NOT the finding's global claim text — the
 * claim may cite evidence from other pages/regions.
 */
function pageScopedConclusion(f: Finding, view: PageEvidenceView): string {
  const where = (view.supportDomains.get(f.findingId) ?? []).slice(0, 3);
  const src = where.length ? ` — материалы на этой странице: ${where.join(", ")}` : "";
  return clampClientText(
    `«${f.theme}»: уровень внимания — ${riskLabel(f.riskLevel).toLowerCase()}${src}.`,
    400
  );
}

/**
 * Finding blocks strictly scoped to ONE page's displayed evidence.
 * Dynamic conclusion, significance, status and the source footer are derived
 * only from the page's own refs/domains; static methodology stays in the
 * template layer.
 */
function pageFindingBlocks(
  scoped: ScopedFragmentInput,
  view: PageEvidenceView,
  extraCheck?: string
): Partial<SlideBody> {
  const adverse = view.findings.filter(isAdverse);
  const top = view.findings[0];
  return {
    whatWasFound: top
      ? pageScopedConclusion(top, view)
      : "Существенных материалов среди показанных на этой странице элементов не обнаружено.",
    whyItMatters: clampClientText(
      adverse.length
        ? `Материалы этой страницы затрагивают тем повышенного внимания: ${adverse.length}. Они видны при первичной проверке субъекта.`
        : "Показанные на странице материалы не формируют негативного фона вокруг субъекта.",
      320
    ),
    whatToCheck: clampClientText(
      top?.recommendedAction ?? extraCheck ?? "Мониторить изменения выдачи.",
      220
    ),
    statusNote: statusLine(top),
    sourceNote: pageSourceLine(view),
  };
}

/** Source footer derived ONLY from the page's own evidence refs. */
function pageSourceLine(view: PageEvidenceView): string {
  const list = view.domains.slice(0, 5);
  return list.length
    ? `Источники: ${list.join(", ")}`
    : "Источники: поисковая выдача (см. приложение).";
}

/** «Тема» — claim; skip the prefix when the claim already names the theme. */
function themedClaim(f: Finding): string {
  return f.claim.toLowerCase().startsWith(f.theme.toLowerCase())
    ? f.claim
    : `«${f.theme}» — ${f.claim}`;
}

/** Region-level source line — summary pages only (page IS the region). */
function sourceLine(scoped: ScopedFragmentInput): string {
  const domains = new Set<string>();
  for (const f of scoped.findings) for (const d of f.sourceDomains ?? []) domains.add(d);
  for (const e of Object.values(scoped.evidenceIndex)) if (e.domain) domains.add(e.domain);
  const list = [...domains].filter((d) => d && d !== "—").sort().slice(0, 6);
  return list.length ? `Источники: ${list.join(", ")}` : "Источники: поисковая выдача (см. приложение).";
}

/**
 * ORION-style client copy for surfaces with no collected material: what the
 * surface is, why it matters for the subject's reputation, and what to do.
 * Internal reason keys never leak into client text.
 */
const COVERAGE_EMPTY_COPY: Record<string, { what: string; why: string; check: string }> = {
  "no-suggestions": {
    what: "Поисковые подсказки (автодополнение) по запросам о субъекте в текущем сборе не зафиксированы.",
    why: "Подсказки формируются поисковыми системами на основе массовых запросов пользователей; негативные формулировки в подсказках видны ещё до просмотра результатов и напрямую влияют на первое впечатление.",
    check:
      "Рекомендуем повторить проверку подсказок при следующем обновлении: эта поверхность меняется быстрее остальных.",
  },
  "no-images": {
    what: "Изображения по запросам о субъекте в текущем сборе не зафиксированы.",
    why: "Блок «Картинки» — одна из первых точек контакта: пользователь видит фотографии и связанные с ними заголовки ещё до перехода на сайты-источники.",
    check:
      "Рекомендуем проверить блок изображений вручную и обеспечить присутствие качественных официальных фотографий.",
  },
  "no-identity-data": {
    what: "Статья о субъекте в Википедии и связанные энциклопедические материалы в текущем сборе не зафиксированы.",
    why: "Википедия и энциклопедические карточки — ключевой источник «официальной» биографии: их содержимое поисковые системы используют в панелях знаний и ответах ИИ.",
    check:
      "Рекомендуем проверить наличие статьи вручную; при отсутствии — рассмотреть создание нейтральной биографической статьи, при наличии — контролировать корректность её содержимого.",
  },
  "no-ai-answers": {
    what: "Ответы ИИ-поиска (AI Overview, нейро-ответы) по запросам о субъекте в текущем сборе не зафиксированы.",
    why: "Ответы ИИ всё чаще заменяют пользователю классическую выдачу: он получает готовый вывод о человеке, не открывая источники, поэтому их содержание критично для репутации.",
    check:
      "Рекомендуем отслеживать появление ИИ-ответов при следующих обновлениях: они формируются на основе тех же источников, что и обычная выдача.",
  },
  "no-related": {
    what: "Связанные запросы и вопросы «Люди также спрашивают» по субъекту в текущем сборе не зафиксированы.",
    why: "Связанные запросы подсказывают пользователю, что искать дальше; негативные формулировки в этом блоке расширяют охват нежелательного контента.",
    check: "Рекомендуем повторить сбор связанных запросов при следующем обновлении.",
  },
  "no-organic-data": {
    what: "Результаты органической поисковой выдачи по данному контуру в текущем сборе не зафиксированы.",
    why: "Органическая выдача — основная поверхность: первые страницы результатов формируют репутационную картину для большинства пользователей.",
    check: "Рекомендуем проверить региональные настройки сбора и повторить проверку.",
  },
  "no-regional-findings": {
    what: "По данному региональному контуру материалы в текущем сборе не зафиксированы.",
    why: "Региональный контур показывает, как субъект представлен в локальной выдаче; отсутствие материалов — это статус покрытия, а не вывод об отсутствии рисков.",
    check: "Рекомендуем повторить сбор по региону при следующем обновлении.",
  },
  // Follow-up pages of a multi-slot block with no data: short reference back
  // instead of repeating the same full-page explanation three more times.
  "no-images-continued": {
    what: "Продолжение блока изображений: дополнительных материалов по этой поверхности в текущем сборе не зафиксировано.",
    why: "Статус и рекомендации по блоку изображений приведены на первой странице раздела.",
    check: "См. рекомендации на первой странице блока изображений.",
  },
};

function coverageContent(reason: string): SlideBody {
  const copy = COVERAGE_EMPTY_COPY[reason];
  if (!copy) {
    return {
      narrative:
        "Материалы по данной поверхности в рамках текущего сбора не зафиксированы. Это статус покрытия, а не вывод об отсутствии рисков.",
      bullets: ["Отсутствие материалов отражает состояние сбора на дату отчёта."],
      whatToCheck: "Повторить сбор по данной поверхности при следующем обновлении.",
    };
  }
  return {
    narrative: copy.what,
    bullets: [
      copy.why,
      "Отсутствие материалов в текущем сборе — это статус покрытия на дату отчёта, а не вывод об отсутствии рисков.",
    ],
    whatToCheck: copy.check,
  };
}

function claimText(c: SurfaceClaim): string {
  return c.subjectMatch === "OTHER_SUBJECT" ? `Относится к другому лицу: ${c.text}` : c.text;
}

function uniqueRefs(scoped: ScopedFragmentInput): string[] {
  const s = new Set<string>();
  for (const f of scoped.findings) for (const r of f.evidenceRefs) s.add(r);
  for (const u of scoped.surfaceUnits) for (const r of u.evidenceRefs) s.add(r);
  if (!scoped.scope.regions) return [...s];
  return [...s].filter((ref) => {
    const region = scoped.evidenceIndex[ref]?.region;
    if (!region) return true;
    return scoped.scope.regions!.some((r) => regionMatches(r, region));
  });
}

function riskLabel(level: string): string {
  const map: Record<string, string> = {
    critical: "Критический",
    high: "Высокий",
    medium: "Средний",
    low: "Низкий",
    none: "Нет",
  };
  return map[level] ?? level;
}

/** Executive verdict → client label. Raw enum (HIGH/ELEVATED/…) never leaks. */
function verdictClientLabel(verdict: string): string {
  const map: Record<string, string> = {
    HIGH: "Высокий риск",
    ELEVATED: "Повышенный риск",
    MIXED: "Смешанный фон",
    LOW: "Низкий риск",
    INSUFFICIENT_DATA: "Недостаточно данных",
  };
  return map[String(verdict).toUpperCase()] ?? verdict;
}

/**
 * Visual slide helper: binds the slot's asset when available; otherwise emits
 * the explicit VISUAL_ASSET_UNAVAILABLE fallback text card.
 */
function visualSlide(input: {
  slot: CanonicalSlotDef;
  sectionId: SectionType;
  extras: FragmentExtras;
  scoped: ScopedFragmentInput;
  content: SlideBody;
  evidenceRefs: string[];
  findingIds: string[];
  metrics?: Record<string, number | string>;
  /** True when the underlying surface genuinely has no data (not just no image). */
  noUnderlyingData?: boolean;
  noDataReason?: string;
}): SlideContentContract {
  const refs = assetsFor(input.extras, input.slot.slotId);
  if (refs.length > 0) {
    return makeSlotSlide({
      slot: input.slot,
      sectionId: input.sectionId,
      content: input.content,
      evidenceRefs: input.evidenceRefs,
      findingIds: input.findingIds,
      metrics: input.metrics,
      visualAssetRefs: refs,
    });
  }
  if (input.noUnderlyingData) {
    return makeSlotSlide({
      slot: input.slot,
      sectionId: input.sectionId,
      templateId: "coverage-empty-state",
      content: coverageContent(input.noDataReason ?? "нет данных по поверхности"),
      evidenceRefs: [],
      findingIds: [],
      metrics: { datasetCount: 0 },
      emptyStateReason: input.noDataReason ?? "no-data",
    });
  }
  return makeSlotSlide({
    slot: input.slot,
    sectionId: input.sectionId,
    content: input.content,
    evidenceRefs: input.evidenceRefs,
    findingIds: input.findingIds,
    metrics: input.metrics,
    visualAssetRefs: [],
    emptyStateReason: VISUAL_ASSET_UNAVAILABLE,
  });
}

// ---------------------------------------------------------------------------
// FRONT MATTER (p01, p02)
// ---------------------------------------------------------------------------

export function buildFrontMatterFragment(
  sectionId: SectionType,
  scoped: ScopedFragmentInput
): FragmentBuildOutput {
  const [cover, toc] = slotsForFragment("FRONT_MATTER_MAIN");
  return {
    slides: [
      makeSlotSlide({
        slot: cover,
        sectionId,
        title: `Отчёт о цифровом профиле — ${scoped.subject.displayName}`,
        content: { narrative: "Конфиденциально. Подготовлено для внутреннего использования клиента." },
        evidenceRefs: [],
        findingIds: [],
      }),
      // TOC content (titles/pages) is assembler-owned; slot only reserved here.
      makeSlotSlide({
        slot: toc,
        sectionId,
        content: { bullets: [] },
        evidenceRefs: [],
        findingIds: [],
      }),
    ],
    status: "READY",
  };
}

// ---------------------------------------------------------------------------
// EXECUTIVE (p03, p04, p05)
// ---------------------------------------------------------------------------

export function buildExecutiveSummaryFragment(
  sectionId: SectionType,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const es = extras.executiveSummary;
  if (!es) {
    // Missing artifact is a technical defect — not an honest sparse-data page.
    return { slides: [], status: "INSUFFICIENT_DATA", emptyStateReason: "executive-summary-artifact-missing" };
  }
  const [slot] = slotsForFragment("EXECUTIVE_SUMMARY");
  const gpt = extras.gptCaseAnalysis;
  // Each key finding: factual basis + (when the GPT case analysis knows this
  // theme) a client-language explanation of WHY it is risky and what to do
  // about it — instead of a bare publication count. Top cards are narrow, so
  // they lead with the first factual sentence and the explanation; the
  // continuation page carries the full detail.
  const cardTexts = es.keyFindings.map((k) => {
    const risk = matchGptKeyRisk(k.title, gpt?.keyRisks);
    if (!risk) return clampClientText(`${k.title}: ${k.factualBasis}`, 340) + ` [${k.findingId}]`;
    // The top card's job is to explain the risk; the full factual basis
    // follows on the continuation page.
    return (
      fitClientSentences([`${k.title}: ${risk.explanation}`, `Что делать: ${risk.advice}`], 340) +
      ` [${k.findingId}]`
    );
  });
  const bullets = es.keyFindings.map((k) => {
    const risk = matchGptKeyRisk(k.title, gpt?.keyRisks);
    const text = risk
      ? fitClientSentences(
          [`${k.title}: ${k.factualBasis}`, `Почему это важно: ${risk.explanation}`, `Что делать: ${risk.advice}`],
          380
        )
      : clampClientText(`${k.title}: ${k.factualBasis}`, 380);
    return text + ` [${k.findingId}]`;
  });
  // Sparse but complete collection: keep a client-safe page that states
  // there are no confirmed findings — never invent risks.
  const sparse =
    es.keyFindings.length === 0 ||
    /INSUFFICIENT|недостат/i.test(es.verdict) ||
    /недостат|insufficient|no confirmed/i.test(es.executiveConclusion);
  // Narrative: prefer the holistic GPT conclusion + digital portrait. The
  // renderer draws one card per paragraph (up to 3 incl. the subtitle line),
  // clipping each at ~420 chars — split on sentence boundaries to never lose
  // mid-sentence text.
  const gptParagraphs =
    !sparse && gpt
      ? gpt.digitalPortrait
        ? [
            ...splitClientParagraphs(gpt.executiveConclusion, 400, 1),
            ...splitClientParagraphs(gpt.digitalPortrait, 400, 1),
          ]
        : splitClientParagraphs(gpt.executiveConclusion, 400, 2)
      : [];
  const narrative = sparse
    ? clampClientText(
        es.executiveConclusion ||
          "Подтверждённых adverse-находок по собранным источникам недостаточно для риск-выводов. Выводы не выдуманы.",
        600
      )
    : gptParagraphs.length > 0
      ? gptParagraphs.join("\n")
      : es.executiveConclusion;
  // Base slide feeds the executive dashboard layout (conclusion + top risk
  // cards); the remaining key findings continue on an adjacent slide so no
  // finding is lost visually.
  const TOP_CARDS = 2;
  const ms = scoped.metricSnapshot;
  const base = makeSlotSlide({
    slot,
    sectionId,
    subtitle: `Итоговая оценка: ${verdictClientLabel(es.verdict)}`,
    content: {
      narrative,
      // Right-column KPI cards on the executive dashboard: the headline
      // numbers of the whole audit at a glance (short labels — narrow cards).
      kpis: [
        { label: "Материалов", value: String(ms.compositeCount), tone: "neutral" },
        { label: "О субъекте", value: String(ms.subjectMatchCount), tone: "good" },
        { label: "Тем риска", value: String(ms.adverseFindingCount), tone: "risk" },
        { label: "Выводов", value: String(es.keyFindings.length), tone: "accent" },
      ],
      bullets:
        cardTexts.length > 0
          ? cardTexts.slice(0, TOP_CARDS)
          : [
              "Подтверждённых наблюдений с привязкой к источникам нет — сводные показатели не заполняются предположениями.",
            ],
      whatToCheck:
        gpt && gpt.recommendations.length > 0
          ? clampClientText(gpt.recommendations.slice(0, 2).join(" "), 220)
          : es.priorityActions.length > 0
            ? clampClientText(es.priorityActions.slice(0, 3).join(" "), 220)
            : "Повторите сбор после расширения источников; не интерпретируйте отсутствие данных как отсутствие риска.",
      sourceNote: sourceLine(scoped),
    },
    evidenceRefs: uniqueRefs(scoped),
    findingIds: es.keyFindings.map((k) => k.findingId),
    metrics: { keyFindings: es.keyFindings.length, sparse: sparse ? 1 : 0 },
  });
  const slides: SlideContentContract[] = [base];
  const contBullets = bullets.slice(TOP_CARDS);
  if (gpt && !sparse && gpt.positiveSignals.length > 0) {
    contBullets.push(
      clampClientText(`Позитивные сигналы: ${gpt.positiveSignals.slice(0, 3).join(" ")}`, 380)
    );
  }
  if (contBullets.length > 0) {
    slides.push({
      ...base,
      slideId: `${base.slideId}__cont1`,
      isContinuation: true,
      continuationOf: base.slideId,
      continuationIndex: 1,
      templateId: "continuation",
      title: "Резюме — ключевые факты (продолжение)",
      subtitle: undefined,
      content: {
        bullets: contBullets,
        whatToCheck: undefined,
        sourceNote: sourceLine(scoped),
      },
    });
  }
  return { slides, status: "READY" };
}

export function buildRiskMatrixFragment(
  sectionId: SectionType,
  scoped: ScopedFragmentInput,
  extras?: FragmentExtras
): FragmentBuildOutput {
  const [slot] = slotsForFragment("RISK_MATRIX");
  if (scoped.findings.length === 0) {
    // Honest empty-valid page after completed collection — not a lost required section.
    const base = makeSlotSlide({
      slot,
      sectionId,
      subtitle: "Недостаточно подтверждённых данных",
      content: {
        narrative:
          "Подтверждённых adverse findings с evidenceRefs нет. Матрица рисков не заполняется предположениями или OTHER_SUBJECT сигналами.",
        table: {
          headers: ["Тема", "Уровень", "Приоритет", "Идентификатор"],
          rows: [["Нет подтверждённых тем", "Нет данных", "—", "—"]],
        },
        sourceNote: sourceLine(scoped),
      },
      evidenceRefs: uniqueRefs(scoped),
      findingIds: [],
      metrics: { themes: 0, adverse: 0, sparse: 1 },
    });
    return { slides: [base], status: "READY", emptyStateReason: "no-verified-findings" };
  }
  const sorted = [...scoped.findings].sort(
    (a, b) => (RISK_ORDER[b.riskLevel] ?? 0) - (RISK_ORDER[a.riskLevel] ?? 0)
  );
  const rows = sorted.map((f) => [f.theme, riskLabel(f.riskLevel), f.promotionPriority, f.findingId]);
  // Per-theme detail (same order as rows): what exactly was found + why it is
  // risky + what to do — the matrix card explains the risk instead of only
  // repeating its level. GPT case analysis expands; the claim is the fallback.
  const details = sorted.map((f) => {
    const risk = matchGptKeyRisk(f.theme, extras?.gptCaseAnalysis?.keyRisks);
    return risk
      ? fitClientSentences([themedClaim(f), risk.explanation, `Что делать: ${risk.advice}`], 400)
      : fitClientSentences([themedClaim(f), `Рекомендация: ${f.recommendedAction}`], 400);
  });
  const base = makeSlotSlide({
    slot,
    sectionId,
    content: {
      table: { headers: ["Тема", "Уровень", "Приоритет", "Идентификатор"], rows },
      bullets: details,
    },
    evidenceRefs: uniqueRefs(scoped),
    findingIds: scoped.findings.map((f) => f.findingId),
    metrics: { themes: rows.length, adverse: scoped.findings.filter(isAdverse).length },
  });
  return { slides: withContinuations(base, "risk-matrix"), status: "READY" };
}

export function buildDigitalProfileOverviewFragment(
  sectionId: SectionType,
  scoped: ScopedFragmentInput
): FragmentBuildOutput {
  const [slot] = slotsForFragment("DIGITAL_PROFILE_OVERVIEW");
  const s = scoped.metricSnapshot;
  const regions = Object.entries(s.perRegionCounts);
  const adverseThemes = scoped.findings
    .filter(isAdverse)
    .sort((a, b) => (RISK_ORDER[b.riskLevel] ?? 0) - (RISK_ORDER[a.riskLevel] ?? 0))
    .slice(0, 4)
    .map((f) => clampClientText(themedClaim(f), 260) + ` [${f.findingId}]`);
  return {
    slides: [
      makeSlotSlide({
        slot,
        sectionId,
        content: {
          narrative: `Составной набор данных: ${s.compositeCount} материалов из ${regions.length} региональных контуров (${regions
            .map(([r, n]) => `${r}: ${n}`)
            .join(", ")}). Идентификация субъекта выполнена для каждого материала.`,
          // Labels fit the KPI card budget (28 chars) without clipping.
          kpis: [
            { label: "Материалов проанализировано", value: String(s.compositeCount), tone: "neutral" },
            { label: "Связаны с проверяемым лицом", value: String(s.subjectMatchCount), tone: "good" },
            { label: "Требуют идентификации", value: String(s.ambiguousCount), tone: "warn" },
            { label: "Относятся к другим лицам", value: String(s.otherSubjectCount), tone: "warn" },
            { label: "Тем повышенного внимания", value: String(s.adverseFindingCount), tone: "risk" },
            { label: "Региональные контуры", value: regions.map(([r]) => r).join(" · "), tone: "accent" },
          ],
          bullets: adverseThemes,
          whatToCheck:
            "Детализация каждой темы повышенного внимания приведена в матрице рисков и региональных разделах.",
          sourceNote: sourceLine(scoped),
        },
        evidenceRefs: [],
        findingIds: scoped.findings.map((f) => f.findingId),
        metrics: {
          compositeCount: s.compositeCount,
          subjectMatchCount: s.subjectMatchCount,
          adverseFindingCount: s.adverseFindingCount,
        },
      }),
    ],
    status: "READY",
  };
}

// ---------------------------------------------------------------------------
// REGIONAL SUMMARY (RU: p06 divider, p07 summary, p08 metrics/url-audit;
//                   UAE: p23 divider, p24 summary, p25 metrics)
// ---------------------------------------------------------------------------

export function buildRegionalSummaryFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput
): FragmentBuildOutput {
  const slots = slotsForFragment(key);
  const divider = slots.find((s) => s.templateId === "section-divider")!;
  const summarySlot = slots.find((s) => s.templateId === "regional-summary")!;
  const metricsSlot = slots.find((s) => s.templateId === "serp-table")!;
  const regionKey = key.startsWith("RU_") ? "RU" : "UAE";
  const materialCount = scoped.metricSnapshot.perRegionCounts[regionKey] ?? 0;

  const slides: SlideContentContract[] = [
    makeSlotSlide({
      slot: divider,
      sectionId,
      content: {
        narrative: `Раздел описывает цифровой профиль субъекта в регионе: ${regionLabel}.`,
      },
      evidenceRefs: [],
      findingIds: [],
    }),
  ];

  if (scoped.findings.length === 0 && materialCount === 0) {
    slides.push(
      makeSlotSlide({
        slot: summarySlot,
        sectionId,
        templateId: "coverage-empty-state",
        content: coverageContent("no-regional-findings"),
        evidenceRefs: [],
        findingIds: [],
        emptyStateReason: "no-regional-findings",
      })
    );
  } else if (scoped.findings.length === 0) {
    // Materials exist but none reached a verified finding: an honest summary
    // (ORION style) instead of a coverage placeholder.
    const ambiguous = scoped.metricSnapshot.ambiguousCount;
    slides.push(
      makeSlotSlide({
        slot: summarySlot,
        sectionId,
        content: {
          narrative: `По региону ${regionLabel} собрано и проанализировано материалов: ${materialCount}. Подтверждённых тем повышенного внимания, однозначно связанных с проверяемым лицом, по итогам идентификации не выявлено.`,
          bullets: [
            "Каждый материал прошёл проверку принадлежности: учитываются только публикации, уверенно связанные с проверяемым лицом.",
            ...(ambiguous > 0
              ? [
                  `Часть материалов (${ambiguous} по всему набору) требует дополнительной идентификации — они не включаются в выводы, пока принадлежность не подтверждена.`,
                ]
              : []),
            "Отсутствие подтверждённых тем — результат идентификации на дату отчёта, а не гарантия отсутствия рисков.",
          ],
          whatToCheck:
            "Рекомендуем плановое обновление мониторинга: состав выдачи и подсказок меняется, а материалы, требующие идентификации, могут быть подтверждены при появлении дополнительных признаков.",
          sourceNote: sourceLine(scoped),
        },
        evidenceRefs: [],
        findingIds: [],
        metrics: { materials: materialCount, findings: 0 },
      })
    );
  } else {
    const bullets = scoped.findings
      .slice(0, 8)
      .map((f) => clampClientText(themedClaim(f), 340) + ` [${f.findingId}]`);
    const base = makeSlotSlide({
      slot: summarySlot,
      sectionId,
      content: {
        narrative: `По региону ${regionLabel} собрано материалов: ${materialCount}; подтверждённых тем: ${scoped.findings.length}.`,
        bullets,
        ...findingBlocks(scoped),
      },
      evidenceRefs: uniqueRefs(scoped),
      findingIds: scoped.findings.map((f) => f.findingId),
      metrics: {
        materials: materialCount,
        findings: scoped.findings.length,
        adverse: scoped.findings.filter(isAdverse).length,
      },
    });
    slides.push(...withContinuations(base, "regional-summary"));
  }

  // Metrics slot: full per-surface coverage breakdown (what was collected on
  // each search surface and how much of it is negative), plus URL-audit and
  // region totals — a nearly empty two-row table reads as a defect to clients.
  const urlAuditUnits = scoped.surfaceUnits.filter((u) => u.surface === "url_audit");
  const rows: string[][] = [];
  // Provider tokens (e.g. enrichment vendor names) are internal — client sees
  // only search-engine labels.
  const engineLabel = (raw: string | undefined): string => {
    const e = String(raw ?? "").toUpperCase();
    if (/YANDEX/.test(e)) return "Яндекс";
    if (/GOOGLE|SERPER/.test(e)) return "Google";
    return "Поисковые системы";
  };
  const SURFACE_TABLE_LABELS: Record<string, string> = {
    organic: "Результаты поиска",
    suggestions: "Поисковые подсказки",
    paa_related: "Связанные запросы",
    images: "Изображения в поиске",
    wikipedia: "Википедия и справочники",
    ai_answers: "ИИ-ответы и панели знаний",
  };
  const metricOf = (u: (typeof scoped.surfaceUnits)[number], key: string): number => {
    const m = u.metrics.find((x) => x.key === key);
    return typeof m?.value === "number" ? m.value : Number(m?.value ?? 0) || 0;
  };
  for (const u of scoped.surfaceUnits) {
    const label = SURFACE_TABLE_LABELS[u.surface];
    if (!label) continue;
    const total = metricOf(u, "totalCount");
    if (total === 0) continue;
    const adverse = metricOf(u, "adverseSubjectCount");
    const matched = metricOf(u, "subjectMatchCount");
    const comment =
      adverse > 0
        ? `негативных: ${adverse}; подтверждена связь с лицом: ${matched}`
        : matched > 0
          ? `подтверждена связь с лицом: ${matched}`
          : "негативных сигналов не выявлено";
    rows.push([engineLabel(u.engine), label, String(total), comment]);
  }
  for (const u of urlAuditUnits) {
    const checked = u.evidenceRefs.length;
    // Metric keys are internal (totalCount/…); the client sees a plain summary.
    const audited = metricOf(u, "totalCount");
    rows.push([
      engineLabel(u.engine),
      "Проверка URL / индексация",
      String(checked),
      audited > 0 ? `проверено адресов: ${audited}` : "—",
    ]);
  }
  rows.push(["Все системы", "Материалы региона", String(materialCount), "по составному набору данных"]);
  rows.push([
    "Все системы",
    "Темы повышенного внимания",
    String(scoped.findings.filter(isAdverse).length),
    "см. матрицу рисков",
  ]);
  slides.push(
    makeSlotSlide({
      slot: metricsSlot,
      sectionId,
      content: {
        table: { headers: ["Система", "Показатель", "Объём", "Комментарий"], rows },
        sourceNote: sourceLine(scoped),
      },
      evidenceRefs: urlAuditUnits.flatMap((u) => u.evidenceRefs),
      findingIds: [],
      metrics: { urlAuditRows: urlAuditUnits.length, materials: materialCount },
    })
  );

  return { slides, status: "READY" };
}

// ---------------------------------------------------------------------------
// SERP (p09 / p26) + SCREENSHOT (p10 / p27)
// ---------------------------------------------------------------------------

export function buildSerpFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput
): FragmentBuildOutput {
  const [slot] = slotsForFragment(key);
  const organic = scoped.surfaceUnits.filter((u) => u.surface === "organic");
  const refs = organic.flatMap((u) => u.evidenceRefs);
  if (refs.length === 0) {
    return {
      slides: [
        makeSlotSlide({
          slot,
          sectionId,
          templateId: "coverage-empty-state",
          content: coverageContent("no-organic-data"),
          evidenceRefs: [],
          findingIds: [],
          emptyStateReason: "no-organic-data",
        }),
      ],
      status: "READY",
    };
  }
  const adverseRefSet = new Set<string>();
  for (const f of scoped.findings.filter(isAdverse)) for (const r of f.evidenceRefs) adverseRefSet.add(r);
  const displayedRefs = refs.slice(0, 36);
  const rows = displayedRefs.map((ref, i) => {
    const e = scoped.evidenceIndex[ref] ?? {};
    // A row is marked when its evidence backs an adverse finding OR its own
    // title carries an adverse pattern (sanctions/criminal/court wording) —
    // clearly negative rows must never show a green "Нейтральный" badge.
    const adverse =
      e.adverse === true ||
      adverseRefSet.has(ref) ||
      ADVERSE_PATTERNS.test(String(e.title ?? ""));
    // Red marker must always carry its label; domain comes from evidence URL.
    return [
      String(i + 1),
      e.domain ?? domainOfUrl(e.url),
      e.title ?? "(без заголовка)",
      adverse ? RED_MARKER_LABEL : "Нейтральный",
    ];
  });
  // Dynamic blocks derive from the rows displayed on this page only.
  const view = buildPageEvidenceView(scoped, displayedRefs);
  const base = makeSlotSlide({
    slot,
    sectionId,
    content: {
      table: { headers: ["№", "Домен", "Заголовок", "Оценка"], rows },
      ...pageFindingBlocks(scoped, view),
    },
    evidenceRefs: refs,
    findingIds: view.findings.map((f) => f.findingId),
    metrics: {
      datasetCount: refs.length,
      displayedCount: rows.length,
      adverseDisplayed: rows.filter((r) => r[3] === RED_MARKER_LABEL).length,
    },
  });
  return { slides: withContinuations(base, "serp-table"), status: "READY" };
}

/**
 * Match one red-framed snapshot row to the fragment finding it represents.
 * Specificity order: exact observation ref → exact URL → source domain.
 * Adverse findings win over non-adverse; ties resolve by risk level.
 */
function findingForVisibleRow(row: VisibleAssetItem, scoped: ScopedFragmentInput): Finding | undefined {
  const rowNorm = normalizeEvidenceRef(row.ref);
  const rowUrl = normalizeEvidenceUrl(row.url);
  let best: { f: Finding; score: number } | undefined;
  for (const f of scoped.findings) {
    let specificity = 0;
    for (const r of f.evidenceRefs) {
      if (normalizeEvidenceRef(r) === rowNorm) {
        specificity = Math.max(specificity, 3);
        continue;
      }
      const e = scoped.evidenceIndex[r];
      if (rowUrl && normalizeEvidenceUrl(e?.url) === rowUrl) specificity = Math.max(specificity, 2);
    }
    if (specificity === 0 && row.domain && (f.sourceDomains ?? []).includes(row.domain)) {
      specificity = 1;
    }
    if (specificity === 0) continue;
    const score =
      specificity * 100 + (isAdverse(f) ? 50 : 0) + (RISK_ORDER[f.riskLevel] ?? 0);
    if (!best || score > best.score) best = { f, score };
  }
  return best?.f;
}

export function buildSerpScreenshotFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const [slot] = slotsForFragment(key);
  const screenshots = Object.entries(scoped.evidenceIndex).filter(
    ([, e]) => e.kind === "serp_screenshot"
  );
  // Rows actually rendered on the bound snapshot, with the SAME red-frame
  // marking the snapshot generator produced. Sidebar copy is derived from
  // these rows only — never from region- or bundle-level findings.
  const visibleRows = (extras.visualAssets?.[slot.slotId] ?? []).flatMap(
    (a) => a.visibleItems ?? []
  );
  const adverseRows = visibleRows.filter((v) => v.adverse);

  // One explanation per red-framed row, attributed to the finding whose
  // evidence that row is (dedup by finding+domain).
  const seenExplanation = new Set<string>();
  const explanations: NonNullable<SlideBody["highlightExplanations"]> = [];
  const explainedFindings: Finding[] = [];
  const explainedDomains: string[] = [];
  const explainedRefs: string[] = [];
  for (const row of adverseRows) {
    const f = findingForVisibleRow(row, scoped);
    const theme = f?.theme ?? row.themeTitle ?? "Потенциально нежелательный материал";
    const domain = row.domain ?? "—";
    const dedupKey = `${f?.findingId ?? theme}|${domain}`;
    if (seenExplanation.has(dedupKey)) continue;
    seenExplanation.add(dedupKey);
    const level = f
      ? `уровень: ${riskLabel(f.riskLevel).toLowerCase()}`
      : "требует ручной проверки";
    explanations.push({
      clientReason: clampClientText(`«${theme}» — выделенный результат ${domain}; ${level}.`, 300),
      frameTone: "red" as const,
    });
    if (f && !explainedFindings.some((x) => x.findingId === f.findingId)) explainedFindings.push(f);
    if (row.domain && !explainedDomains.includes(row.domain)) explainedDomains.push(row.domain);
    if (scoped.evidenceIndex[row.ref]) explainedRefs.push(row.ref);
  }
  explainedFindings.sort((a, b) => (RISK_ORDER[b.riskLevel] ?? 0) - (RISK_ORDER[a.riskLevel] ?? 0));
  const top = explainedFindings[0];

  // Engine coverage limitation visible on the snapshot itself (e.g. Google
  // holds the highlighted result while the Yandex panel has no stored rows).
  const engines = new Set(visibleRows.map((v) => (v.engine ?? "").toUpperCase()).filter(Boolean));
  const engineNote = !engines.has("YANDEX")
    ? " Выделенные результаты — в выдаче Google; по Яндексу сохранённых результатов в наборе нет."
    : !engines.has("GOOGLE")
      ? " Выделенные результаты — в выдаче Яндекса; по Google сохранённых результатов в наборе нет."
      : "";

  // Headline: page-specific summary of what is framed on THIS snapshot —
  // details per theme live in the highlight explanations (no duplication).
  const headlineDomains = explainedDomains.slice(0, 4);
  const whatWasFound = adverseRows.length
    ? clampClientText(
        `На снимке выделено результатов повышенного внимания: ${explanations.length}` +
          (headlineDomains.length
            ? ` (${headlineDomains.join(", ")}${explainedDomains.length > headlineDomains.length ? " и др." : ""})`
            : "") +
          "; остальные результаты — нейтральные или деловые.",
        400
      )
    : "Выделенных результатов повышенного внимания на этом снимке нет; зафиксированы деловые и справочные материалы.";

  const neutralVisibleDomains = [
    ...new Set(visibleRows.map((v) => v.domain).filter((d): d is string => Boolean(d))),
  ].slice(0, 3);
  // The sidebar footer is narrow: cap the listed domains so the note always
  // ends with a complete phrase instead of clipping mid-sentence.
  const listedDomains = explainedDomains.slice(0, 3);
  const moreDomains = explainedDomains.length - listedDomains.length;
  const sourceNote = explainedDomains.length
    ? `Источники: ${listedDomains.join(", ")}${moreDomains > 0 ? ` и ещё ${moreDomains}` : ""} — результаты на снимке.`
    : neutralVisibleDomains.length
      ? `Источники: ${neutralVisibleDomains.join(", ")} (видимые результаты снимка).`
      : "Источники: снимок поисковой выдачи.";

  const slide = visualSlide({
    slot,
    sectionId,
    extras,
    scoped,
    content: {
      narrative: `Состояние первой страницы выдачи (${regionLabel}).${engineNote}`,
      whatWasFound,
      // Coverage limitation is part of "why it matters": it is rendered in the
      // sidebar on adverse pages, unlike the narrative (dropped there).
      whyItMatters: clampClientText(
        (explanations.length
          ? `Выделенные материалы (${explanations.length}) видны при первичной проверке субъекта в этом регионе.`
          : "Первая страница выдачи не формирует негативного фона вокруг субъекта в этом регионе.") +
          engineNote,
        320
      ),
      whatToCheck: clampClientText(
        top?.recommendedAction ?? "Проверить первоисточники выделенных результатов.",
        220
      ),
      statusNote: statusLine(top),
      sourceNote,
      // Every red highlight on the snapshot is explained by the finding whose
      // evidence that row is — strictly page-scoped.
      highlightExplanations: explanations.length ? explanations : undefined,
    },
    evidenceRefs: [
      ...new Set([
        ...screenshots.map(([ref]) => ref),
        ...visibleRows.map((v) => v.ref).filter((r) => Boolean(scoped.evidenceIndex[r])),
        ...explainedRefs,
      ]),
    ],
    findingIds: explainedFindings.map((f) => f.findingId),
    metrics: {
      screenshots: screenshots.length,
      adverseHighlights: explanations.length,
    },
    noUnderlyingData: false,
  });
  return { slides: [slide], status: "READY" };
}

// ---------------------------------------------------------------------------
// SUGGESTIONS (RU p11/p12 per engine; UAE p28)
// ---------------------------------------------------------------------------

/**
 * Sidebar material for red-framed rows on a slot's bound visual asset:
 * one client-language explanation per highlighted row (theme + destination +
 * level), plus the refs the visual actually draws. Shared by the image grids
 * and the suggestion/related panels (ORION style: every red frame explained).
 */
function adverseVisualSidebar(
  slotId: string,
  extras: FragmentExtras,
  scoped: ScopedFragmentInput,
  rowNoun: string
): {
  visibleRows: VisibleAssetItem[];
  adverseRows: VisibleAssetItem[];
  gridRefs: string[];
  explanations: NonNullable<SlideBody["highlightExplanations"]>;
  explainedFindingIds: string[];
} {
  const visibleRows = (extras.visualAssets?.[slotId] ?? []).flatMap((a) => a.visibleItems ?? []);
  const adverseRows = visibleRows.filter((v) => v.adverse);
  const seen = new Set<string>();
  const explanations: NonNullable<SlideBody["highlightExplanations"]> = [];
  const explainedFindingIds: string[] = [];
  for (const row of adverseRows) {
    const f = findingForVisibleRow(row, scoped);
    const theme = f?.theme ?? row.themeTitle ?? "Потенциально нежелательный материал";
    const target = row.domain ? ` — ${rowNoun} ведёт на ${row.domain}` : "";
    const dedupKey = `${f?.findingId ?? theme}|${row.domain ?? row.title ?? ""}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    explanations.push({
      clientReason: clampClientText(
        `«${theme}»${target}${f ? `; уровень: ${riskLabel(f.riskLevel).toLowerCase()}` : "; требует ручной проверки"}.`,
        300
      ),
      frameTone: "red" as const,
    });
    if (f && !explainedFindingIds.includes(f.findingId)) explainedFindingIds.push(f.findingId);
  }
  const gridRefs = visibleRows.map((v) => v.ref).filter((r) => Boolean(scoped.evidenceIndex[r]));
  return { visibleRows, adverseRows, gridRefs, explanations, explainedFindingIds };
}

export function buildSuggestionsFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const slots = slotsForFragment(key);
  const units = scoped.surfaceUnits.filter((u) => u.surface === "suggestions");
  const slides: SlideContentContract[] = [];
  for (const slot of slots) {
    const engine = slot.slotId.includes("yandex")
      ? "YANDEX"
      : slot.slotId.includes("google")
        ? "GOOGLE"
        : null;
    const slotUnits = engine ? units.filter((u) => (u.engine ?? "").toUpperCase() === engine) : units;
    const refs = slotUnits.flatMap((u) => u.evidenceRefs);
    const bullets = slotUnits
      .flatMap((u) => u.claims)
      .map((c) => clampClientText(claimText(c), 400));
    const suggestionLines = refs
      .map((r) => scoped.evidenceIndex[r]?.title)
      .filter((t): t is string => Boolean(t))
      .slice(0, 10);
    // Sidebar strictly scoped to the queries displayed on THIS page.
    const view = buildPageEvidenceView(scoped, refs);
    const sidebar = adverseVisualSidebar(slot.slotId, extras, scoped, "подсказка");
    slides.push(
      visualSlide({
        slot,
        sectionId,
        extras,
        scoped,
        content: {
          bullets: bullets.length ? bullets : suggestionLines,
          ...pageFindingBlocks(scoped, view),
          ...(sidebar.explanations.length
            ? {
                whatWasFound: clampClientText(
                  `Подсказок на панели: ${sidebar.visibleRows.length}; выделено красным (негативные формулировки): ${sidebar.adverseRows.length}.`,
                  400
                ),
                whyItMatters: clampClientText(
                  "Негативные подсказки видны пользователю ещё до просмотра результатов: они формируют первое впечатление и подталкивают к поиску компрометирующих материалов.",
                  320
                ),
                highlightExplanations: sidebar.explanations,
              }
            : {}),
        },
        evidenceRefs: [...new Set([...refs, ...sidebar.gridRefs])],
        findingIds: [
          ...new Set([...view.findings.map((f) => f.findingId), ...sidebar.explainedFindingIds]),
        ],
        metrics: { items: refs.length, adverseSuggestions: sidebar.adverseRows.length },
        noUnderlyingData: refs.length === 0,
        noDataReason: "no-suggestions",
      })
    );
  }
  return { slides, status: "READY" };
}

// ---------------------------------------------------------------------------
// IMAGES (RU p14..p17; UAE p30)
// ---------------------------------------------------------------------------

export function buildImagesFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const slots = slotsForFragment(key);
  const units = scoped.surfaceUnits.filter((u) => u.surface === "images");
  // Same normalized claim text must not repeat across the image slides.
  const seenClaimText = new Set<string>();
  const claims = units
    .flatMap((u) => u.claims)
    .filter((c) => {
      const norm = c.text.trim().toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "");
      if (seenClaimText.has(norm)) return false;
      seenClaimText.add(norm);
      return true;
    });
  const refs = units.flatMap((u) => u.evidenceRefs);
  const claimChunks = distribute(claims, slots.length);
  const refChunks = distribute(refs, slots.length);
  const slides = slots.map((slot, i) => {
    // Sidebar strictly scoped to the image cards carried by THIS page's slice
    // of the evidence (the slide's own evidenceRefs).
    const view = buildPageEvidenceView(scoped, refChunks[i]);

    // Red-framed image cards on THIS page's bound grid are explained in the
    // sidebar (ORION style: highlighted image → which theme and why), exactly
    // like the SERP snapshot page does for its red frames.
    const sidebar = adverseVisualSidebar(slot.slotId, extras, scoped, "изображение");

    const pageBlocks = pageFindingBlocks(scoped, view);
    return visualSlide({
      slot,
      sectionId,
      extras,
      scoped,
      content: {
        bullets: claimChunks[i].map((c) => clampClientText(claimText(c), 400)),
        ...pageBlocks,
        ...(sidebar.explanations.length
          ? {
              whatWasFound: clampClientText(
                `Изображения на этой странице: ${Math.min(sidebar.visibleRows.length, 6)}; выделено красным (ведут на негативные источники): ${sidebar.adverseRows.length}.`,
                400
              ),
              // Consistent with the red frames: the page DOES carry adverse
              // visual signals, so the meaning block must not claim otherwise.
              whyItMatters: clampClientText(
                "Выделенные изображения связаны с негативными источниками и формируют нежелательный визуальный фон в блоке «Картинки»: пользователь видит их до перехода на сайты.",
                320
              ),
              // The generic page status says "no risk conclusions" when the
              // page findings are empty — contradicting the red frames above.
              statusNote: `Статус: изображений с привязкой к негативным источникам — ${sidebar.adverseRows.length}; требуется проверка первоисточников.`,
              whatToCheck: clampClientText(
                "Проверить сайты-источники выделенных изображений и подготовить позицию по каждому негативному материалу.",
                220
              ),
              highlightExplanations: sidebar.explanations,
            }
          : {}),
      },
      // The bound grid draws its own rows; the slide must carry those refs
      // too, otherwise the domain gate rejects the sidebar explanations.
      evidenceRefs: [...new Set([...refChunks[i], ...sidebar.gridRefs])],
      findingIds: [
        ...new Set([...view.findings.map((f) => f.findingId), ...sidebar.explainedFindingIds]),
      ],
      metrics: { items: refChunks[i].length, adverseImages: sidebar.adverseRows.length },
      noUnderlyingData: refs.length === 0,
      noDataReason: i === 0 ? "no-images" : "no-images-continued",
    });
  });
  return { slides, status: "READY" };
}

// ---------------------------------------------------------------------------
// IDENTITY / WIKIPEDIA (p13 / p29)
// ---------------------------------------------------------------------------

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
  if (units.length === 0) {
    return {
      slides: [
        makeSlotSlide({
          slot,
          sectionId,
          templateId: "coverage-empty-state",
          content: coverageContent("no-identity-data"),
          evidenceRefs: [],
          findingIds: [],
          emptyStateReason: "no-identity-data",
        }),
      ],
      status: "READY",
    };
  }
  const identityRefs = units.flatMap((u) => u.evidenceRefs);
  // Encyclopedia rows actually captured (titles + domains) — shown to the
  // client even when none of them is adverse, so the page reflects reality
  // ("article exists, content neutral") instead of an empty claim list.
  const referenceEntries = identityRefs
    .map((r) => scoped.evidenceIndex[r])
    .filter((e): e is NonNullable<typeof e> => Boolean(e?.title))
    .slice(0, 6)
    .map((e) => clampClientText(`${e.title}${e.domain ? ` — ${e.domain}` : ""}`, 400));
  const bullets = [
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
        .filter((d): d is string => Boolean(d))
    ),
  ].slice(0, 4);
  const hasAdverseRow = identityRefs.some((r) =>
    ADVERSE_PATTERNS.test(String(scoped.evidenceIndex[r]?.title ?? ""))
  );
  const presenceNarrative = `В выдаче зафиксированы энциклопедические материалы о проверяемом субъекте${wikiDomains.length ? ` (${wikiDomains.join(", ")})` : ""}. ${
    hasAdverseRow
      ? "Отдельные карточки содержат чувствительные формулировки — их содержание отражено в темах повышенного внимания."
      : "Существенных негативных или спорных формулировок в этих карточках не выявлено."
  } Материалов об одноимённых лицах в контуре ${regionLabel} не зафиксировано.`;
  // Sidebar strictly scoped to the identity materials displayed on this page.
  const view = buildPageEvidenceView(scoped, identityRefs);
  const base = makeSlotSlide({
    slot,
    sectionId,
    content: {
      narrative:
        foreignClaims.length > 0
          ? `Справочные ресурсы (${regionLabel}) содержат материалы об одноимённом лице; ниже они отделены от данных проверяемого субъекта.`
          : presenceNarrative,
      bullets: shownBullets,
      ...pageFindingBlocks(scoped, view),
    },
    evidenceRefs: identityRefs,
    findingIds: view.findings.map((f) => f.findingId),
    metrics: { subjectClaims: subjectClaims.length, identityPollution: foreignClaims.length },
  });
  return { slides: withContinuations(base, "wikipedia-knowledge"), status: "READY" };
}

// ---------------------------------------------------------------------------
// KNOWLEDGE / AI (RU p18 panel + p19 AI; UAE p31 combined)
// ---------------------------------------------------------------------------

export function buildKnowledgeAiFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const slots = slotsForFragment(key);
  const aiUnits = scoped.surfaceUnits.filter((u) => u.surface === "ai_answers");
  const aiClaims = aiUnits.flatMap((u) => u.claims);
  // Source answers are never truncated: full claim text; pagination is done
  // via continuations, not by cutting text.
  const aiBullets = aiClaims.map(claimText);
  const aiTitles = aiUnits
    .flatMap((u) => u.evidenceRefs)
    .map((r) => scoped.evidenceIndex[r]?.title)
    .filter((t): t is string => Boolean(t));
  const slides: SlideContentContract[] = [];

  const panelSlot = slots.find((s) => s.templateId === "wikipedia-knowledge");
  const aiSlot = slots.find((s) => s.templateId === "ai-overview") ?? slots[0];

  if (panelSlot) {
    const knowledgeRefs = Object.entries(scoped.evidenceIndex)
      .filter(([, e]) => e.kind === "knowledge_block")
      .map(([ref]) => ref);
    // Sidebar strictly scoped to this surface's own observations.
    const panelView = buildPageEvidenceView(scoped, knowledgeRefs);
    slides.push(
      visualSlide({
        slot: panelSlot,
        sectionId,
        extras,
        scoped,
        content: {
          narrative:
            "Панель знаний и структурированные блоки поисковых систем по проверяемому субъекту.",
          ...pageFindingBlocks(scoped, panelView),
        },
        evidenceRefs: knowledgeRefs,
        findingIds: panelView.findings.map((f) => f.findingId),
        metrics: { knowledgeBlocks: knowledgeRefs.length },
        noUnderlyingData: false,
      })
    );
  }

  const aiRefs = aiUnits.flatMap((u) => u.evidenceRefs);
  const aiView = buildPageEvidenceView(scoped, aiRefs);
  const aiBase = visualSlide({
    slot: aiSlot,
    sectionId,
    extras,
    scoped,
    content: {
      bullets: aiBullets.length ? aiBullets : aiTitles,
      ...pageFindingBlocks(scoped, aiView),
    },
    evidenceRefs: aiRefs,
    findingIds: aiView.findings.map((f) => f.findingId),
    metrics: { answers: Math.max(aiClaims.length, aiTitles.length) },
    noUnderlyingData: aiUnits.length === 0,
    noDataReason: "no-ai-answers",
  });
  slides.push(...withContinuations(aiBase, "ai-overview"));

  return { slides, status: "READY" };
}

// ---------------------------------------------------------------------------
// RELATED (RU p20..p22; UAE p32)
// ---------------------------------------------------------------------------

export function buildRelatedQueriesFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const slots = slotsForFragment(key);
  const units = scoped.surfaceUnits.filter((u) => u.surface === "paa_related");
  const claims = units.flatMap((u) => u.claims);
  const refs = units.flatMap((u) => u.evidenceRefs);
  const claimChunks = distribute(claims, slots.length);
  const refChunks = distribute(refs, slots.length);
  const slides = slots.map((slot, i) => {
    const lines = refChunks[i]
      .map((r) => scoped.evidenceIndex[r]?.title)
      .filter((t): t is string => Boolean(t))
      .slice(0, 10);
    // Sidebar strictly scoped to the related queries displayed on THIS page.
    const view = buildPageEvidenceView(scoped, refChunks[i]);
    return visualSlide({
      slot,
      sectionId,
      extras,
      scoped,
      content: {
        bullets: claimChunks[i].length
          ? claimChunks[i].map((c) => clampClientText(claimText(c), 400))
          : lines,
        ...pageFindingBlocks(scoped, view),
      },
      evidenceRefs: refChunks[i],
      findingIds: view.findings.map((f) => f.findingId),
      metrics: { items: refChunks[i].length },
      noUnderlyingData: refs.length === 0,
      noDataReason: "no-related",
    });
  });
  return { slides, status: "READY" };
}

// ---------------------------------------------------------------------------
// COMPLIANCE (p33..p36) — existing content, no source expansion
// ---------------------------------------------------------------------------

const COMPLIANCE_PROVIDER_LABELS: Record<string, string> = {
  DOW_JONES: "Dow Jones",
  LEXISNEXIS: "LexisNexis",
  WORLD_CHECK: "World-Check",
};
const COMPLIANCE_CATEGORY_LABELS: Record<string, string> = {
  PEP: "PEP (политически значимое лицо)",
  ADVERSE_MEDIA: "Негативные публикации",
  SANCTIONS: "Санкционные списки",
};
const COMPLIANCE_STATUS_LABELS: Record<string, string> = {
  PENDING: "Требует ручной проверки",
  CONFIRMED: "Подтверждено",
  DISMISSED: "Отклонено",
};

export function buildComplianceFragment(
  sectionId: SectionType,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const slots = slotsForFragment("COMPLIANCE_MAIN");
  const [summarySlot, dowSlot, lexisSlot] = slots;
  // p36_lexis_visual_2 is covered via EXPLICIT_SLOT_MERGES → p35_lexis_visual:
  // its v72 content does not justify a standalone page in this dataset.
  const complianceUnits = scoped.surfaceUnits.filter((u) => u.surface === "compliance");
  const refs = complianceUnits.flatMap((u) => u.evidenceRefs);
  const narrative = extras.complianceNarrative ?? [];
  const hits = Object.entries(scoped.evidenceIndex).filter(([, e]) => e.kind === "compliance_hit");
  const checkedCount = complianceUnits
    .flatMap((u) => u.metrics)
    .find((m) => m.key === "totalCount")?.value;

  const hitLabel = ([, e]: (typeof hits)[number]) => ({
    provider: COMPLIANCE_PROVIDER_LABELS[e.providerLabel ?? ""] ?? e.providerLabel ?? "База данных",
    category: COMPLIANCE_CATEGORY_LABELS[e.matchCategory ?? ""] ?? e.matchCategory ?? "—",
    score: e.matchScore != null ? `${e.matchScore}/100` : "—",
    status: COMPLIANCE_STATUS_LABELS[e.reviewStatus ?? ""] ?? e.reviewStatus ?? "—",
    name: e.title ?? "Совпадение в базе",
  });

  const summaryRows = hits.map((h) => {
    const l = hitLabel(h);
    return [l.provider, l.category, l.score, l.status];
  });

  const dowHits = hits.filter(([, e]) => (e.providerLabel ?? "").toUpperCase() === "DOW_JONES");
  const lexisHits = hits.filter(([, e]) => (e.providerLabel ?? "").toUpperCase() === "LEXISNEXIS");

  const slides: SlideContentContract[] = [
    makeSlotSlide({
      slot: summarySlot,
      sectionId,
      templateId: "serp-table",
      content: {
        narrative:
          narrative.join(" ") ||
          `Проверено записей комплаенс-контура: ${String(checkedCount ?? refs.length)}. Потенциальных совпадений в базах: ${hits.length}; подтверждённых совпадений нет — каждое требует ручной верификации.`,
        table: {
          headers: ["База данных", "Тип совпадения", "Оценка совпадения", "Статус проверки"],
          rows: summaryRows,
        },
        whatToCheck:
          "Верифицировать каждое потенциальное совпадение вручную: сопоставить идентификаторы субъекта с записью базы.",
        sourceNote: "Источник: комплаенс-базы (существующий контур, без расширения источников).",
      },
      evidenceRefs: [...refs, ...hits.map(([r]) => r)],
      findingIds: scoped.findings.map((f) => f.findingId),
      metrics: { complianceItems: refs.length, hits: hits.length },
    }),
    makeSlotSlide({
      slot: dowSlot,
      sectionId,
      templateId: "serp-table",
      content: {
        narrative:
          "Профиль по данным Dow Jones: существующий комплаенс-контент, источники не расширялись.",
        table: {
          headers: ["Параметр", "Значение"],
          rows: [
            ...dowHits.flatMap((h) => {
              const l = hitLabel(h);
              return [
                ["Совпадение по имени", l.name],
                ["Категория", l.category],
                ["Оценка совпадения", l.score],
                ["Статус", l.status],
              ];
            }),
            [
              "Почему важно",
              "Категория PEP влияет на уровень комплаенс-контроля при онбординге и мониторинге клиента.",
            ],
            ["Что сделать", "Запросить полную запись Dow Jones и сверить идентификаторы субъекта."],
          ],
        },
        whatWasFound: dowHits.length
          ? clampClientText(
              `Потенциальное совпадение категории «${hitLabel(dowHits[0]).category}» с оценкой ${hitLabel(dowHits[0]).score}; совпадение не подтверждено и требует ручной проверки.`,
              400
            )
          : "Совпадений в базе Dow Jones не зафиксировано.",
        whyItMatters:
          "Категория PEP влияет на уровень комплаенс-контроля при онбординге и мониторинге клиента.",
        whatToCheck: "Запросить полную запись Dow Jones и сверить идентификаторы субъекта.",
        sourceNote: "Источник: Dow Jones (существующий контур).",
      },
      evidenceRefs: dowHits.map(([r]) => r),
      findingIds: [],
      metrics: { hits: dowHits.length },
    }),
    makeSlotSlide({
      slot: lexisSlot,
      sectionId,
      templateId: "serp-table",
      content: {
        narrative:
          "Страница профиля LexisNexis. Визуальный экспорт страницы в текущем офлайн-наборе недоступен (VISUAL_ASSET_UNAVAILABLE); содержимое записи приведено в текстовом виде без потерь. Вторая страница профиля из отчёта v72 объединена с этой: отдельного содержимого у неё нет.",
        table: {
          headers: ["Параметр", "Значение"],
          rows: [
            ...lexisHits.flatMap((h) => {
              const l = hitLabel(h);
              return [
                ["Совпадение по имени", l.name],
                ["Категория", l.category],
                ["Оценка совпадения", l.score],
                ["Статус", l.status],
              ];
            }),
            [
              "Почему важно",
              "Негативные публикации в базе увеличивают репутационный риск и требуют проверки первоисточников.",
            ],
            ["Что сделать", "Запросить полную запись LexisNexis и проверить первоисточники публикаций."],
            [
              "Визуальный экспорт",
              "Недоступен в текущем офлайн-наборе (VISUAL_ASSET_UNAVAILABLE); данные приведены в текстовом виде без потерь.",
            ],
          ],
        },
        whatWasFound: lexisHits.length
          ? clampClientText(
              `Потенциальное совпадение категории «${hitLabel(lexisHits[0]).category}» с оценкой ${hitLabel(lexisHits[0]).score}; совпадение не подтверждено и требует ручной проверки.`,
              400
            )
          : "Совпадений в базе LexisNexis не зафиксировано.",
        whyItMatters:
          "Негативные публикации в базе увеличивают репутационный риск и требуют проверки первоисточников.",
        whatToCheck: "Запросить полную запись LexisNexis и проверить первоисточники публикаций.",
        sourceNote: "Источник: LexisNexis (существующий контур).",
      },
      evidenceRefs: lexisHits.map(([r]) => r),
      findingIds: [],
      metrics: { hits: lexisHits.length },
      emptyStateReason: VISUAL_ASSET_UNAVAILABLE,
    }),
  ];
  return { slides, status: "READY" };
}

// ---------------------------------------------------------------------------
// APPENDIX (non-canonical, optional)
// ---------------------------------------------------------------------------

export function buildAppendixFragment(
  sectionId: SectionType,
  scoped: ScopedFragmentInput
): FragmentBuildOutput {
  const ambiguous = scoped.findings.filter((f) => f.subjectMatch !== "SUBJECT_MATCH");
  if (ambiguous.length === 0) {
    return { slides: [], status: "EMPTY_VALID", emptyStateReason: "no-appendix-material" };
  }
  const base: SlideContentContract = {
    schemaVersion: SLIDE_CONTENT_SCHEMA_VERSION,
    slideId: "appendix_main_base",
    baseSlotId: "slot_appendix_main",
    sectionId,
    isContinuation: false,
    continuationOf: null,
    continuationIndex: null,
    templateId: "finding-cards",
    title: "Приложение: материалы, требующие идентификации",
    content: {
      bullets: ambiguous.map(
        (f) => clampClientText(themedClaim(f), 340) + ` [${f.findingId}]`
      ),
      sourceNote: sourceLine(scoped),
    },
    evidenceRefs: uniqueRefs(scoped),
    findingIds: ambiguous.map((f) => f.findingId),
    metrics: { items: ambiguous.length },
    visualAssetRefs: [],
  };
  return { slides: withContinuations(base, "finding-cards"), status: "READY" };
}
