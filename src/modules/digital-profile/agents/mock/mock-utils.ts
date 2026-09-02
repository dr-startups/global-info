/**
 * Shared helpers for mock agents: a deterministic RNG (so the same case yields
 * stable demo data across re-runs), a subject loader, and a BaseMockAgent that
 * implements the validateInput -> run -> normalizeOutput -> saveEvidence
 * lifecycle. No external APIs, no scraping, no LLM calls.
 */

import { createHash } from "node:crypto";
import { prisma } from "@/server/prisma/client";
import { NotFoundError } from "../../http/errors";
import { normalizeUrl } from "../../services/evidence-service";
import { digitalProfileConfig } from "../../config";
import type {
  AgentAvailability,
  AgentContext,
  AgentKind,
  AgentRunResult,
  CaseAgent,
  SavedEvidenceSummary,
} from "../types";
import type { AgentNameValue } from "../../types";

export const DEMO_TAG = "[DEMO]";

/** Deterministic 32-bit RNG (mulberry32) seeded from a string. */
export function seededRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface CaseSubjectInfo {
  caseId: string;
  fullName: string;
  aliases: string[];
  targetRegions: string[];
  /** Stage N1 — optional location term (subject country) for query building. */
  location: string | null;
  /**
   * Date of birth as `YYYY-MM-DD`, and the subject's declared nationality.
   *
   * Both are entered by the operator and stored on the subject, and both are
   * screening features: OpenSanctions penalises a record whose birth date
   * disagrees with ours and leaves records without one alone. While the loader
   * did not select them, the paid `/match` call carried a name and nothing
   * else — and the 25.08 run brought back a record about a different person.
   */
  dateOfBirth: string | null;
  nationality: string | null;
  /** Stage N1 — compliance gating for adverse (negative) queries. */
  lawfulBasis: string | null;
  consentStatus: string | null;
  /**
   * Кейс заведён смоком, а не оператором. Читается здесь, потому что ворота
   * выбора персоны спрашивают о кейсе и о субъекте одновременно, а второй
   * загрузчик кейса ради одного булева был бы вторым ответом на вопрос «кто
   * субъект этого кейса».
   */
  isFixture: boolean;
}

/** Loads the case's first subject + scope. Throws NotFound if the case is gone. */
export async function loadCaseSubject(caseId: string): Promise<CaseSubjectInfo> {
  const row = await prisma.case.findFirst({
    where: { id: caseId, deletedAt: null },
    select: {
      id: true,
      targetRegions: true,
      lawfulBasis: true,
      consentStatus: true,
      isFixture: true,
      subjects: {
        select: {
          fullName: true,
          aliases: true,
          country: true,
          dateOfBirth: true,
          nationality: true,
        },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
  });
  if (!row) throw new NotFoundError("Case not found");
  const subject = row.subjects[0];
  return {
    caseId: row.id,
    fullName: subject?.fullName ?? "Unknown Subject",
    aliases: subject?.aliases ?? [],
    targetRegions: row.targetRegions,
    location: subject?.country ?? null,
    // Time and zone only get in the way: the provider expects `YYYY-MM-DD`.
    dateOfBirth: subject?.dateOfBirth ? subject.dateOfBirth.toISOString().slice(0, 10) : null,
    nationality: subject?.nationality ?? null,
    lawfulBasis: row.lawfulBasis ?? null,
    consentStatus: row.consentStatus ?? null,
    isFixture: row.isFixture,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Base class implementing the agent lifecycle. Subclasses provide metadata and
 * the three steps (collect raw demo data, normalize, persist). `run` never
 * throws — failures are captured into a FAILED AgentRunResult.
 */
export abstract class BaseMockAgent<Raw, Norm> implements CaseAgent {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly description: string;
  readonly kind: AgentKind = "MOCK";

  /** Mock agents map their slug 1:1 to the DB enum. */
  get agentName(): AgentNameValue {
    return this.name as AgentNameValue;
  }

  /**
   * Mock agents exist only for the demo/offline mode.
   *
   * They used to report ENABLED unconditionally, so on a live case the Agents
   * tab listed «Yandex Search (mock)», «Compliance Databases (mock)» and five
   * more beside the real ones with a working "Run audit" button. One click
   * wrote synthetic results about a real person into the evidence base — the
   * contamination step 01 removed from the collection path, still reachable
   * from the UI.
   */
  availability(): AgentAvailability {
    if (!digitalProfileConfig.mockAgents) {
      return {
        status: "DISABLED",
        message:
          "Демо-агент доступен только в mock-режиме (DIGITAL_PROFILE_MOCK_AGENTS=true).",
      };
    }
    return { status: "ENABLED" };
  }

  /** Generate raw mock data (deterministic via the case-seeded RNG). */
  protected abstract collect(
    ctx: AgentContext,
    subject: CaseSubjectInfo,
    rng: () => number
  ): Promise<Raw>;

  abstract normalizeOutput(raw: Raw): Promise<Norm>;

  abstract saveEvidence(
    ctx: AgentContext,
    normalized: Norm
  ): Promise<SavedEvidenceSummary>;

  async validateInput(ctx: AgentContext): Promise<void> {
    await loadCaseSubject(ctx.caseId);
  }

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const startedAt = nowIso();
    try {
      const subject = await loadCaseSubject(ctx.caseId);
      const rng = seededRng(`${this.name}:${ctx.caseId}`);
      const raw = await this.collect(ctx, subject, rng);
      const normalized = await this.normalizeOutput(raw);
      const saved = await this.saveEvidence(ctx, normalized);
      return {
        agentName: this.agentName,
        status: "SUCCEEDED",
        output: { saved, demo: true },
        saved,
        startedAt,
        finishedAt: nowIso(),
      };
    } catch (err) {
      return {
        agentName: this.agentName,
        status: "FAILED",
        saved: {},
        error: err instanceof Error ? err.message : "Agent failed",
        startedAt,
        finishedAt: nowIso(),
      };
    }
  }
}

/** Builds a normalized search-result row ready for createMany (with dedup hash). */
export function buildSearchResultRow(params: {
  caseId: string;
  engine: "GOOGLE" | "YANDEX" | "BING" | "OTHER";
  url: string;
  title: string;
  snippet: string;
  rank: number;
  classification:
    | "UNCLASSIFIED"
    | "RELEVANT"
    | "IRRELEVANT"
    | "ADVERSE_MEDIA"
    | "SOCIAL_PROFILE"
    | "CORPORATE"
    | "LEGAL"
    | "DUPLICATE";
  source?: string;
}) {
  const normalizedUrl = normalizeUrl(params.url);
  return {
    caseId: params.caseId,
    engine: params.engine,
    url: params.url,
    normalizedUrl,
    dedupHash: sha256(normalizedUrl),
    title: params.title,
    snippet: `${DEMO_TAG} ${params.snippet}`,
    rank: params.rank,
    classification: params.classification,
    source: params.source ?? "mock",
    rawMetadata: { demo: true },
  };
}
