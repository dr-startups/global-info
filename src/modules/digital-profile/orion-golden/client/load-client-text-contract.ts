/**
 * REMEDIATION §6.1 — single source of truth for client-facing text rules.
 * TS sanitizer / GPT budgets / section QA / Python renderer all read this.
 */

import { z } from "zod";
import rawContract from "./client-text-contract.json";

const FieldBudgetsSchema = z.object({
  title: z.number().int().positive(),
  narrative: z.number().int().positive(),
  bullet: z.number().int().positive(),
  whatWasFound: z.number().int().positive(),
  whyItMatters: z.number().int().positive(),
  whatToCheck: z.number().int().positive(),
});

export const ClientTextContractSchema = z.object({
  version: z.string().min(1),
  forbiddenRawTokens: z.array(z.string().min(1)).min(1),
  allowedSnakeTokens: z.array(z.string().min(1)),
  internalTokenPattern: z.string().min(1),
  /**
   * Наши слова, которые встречаются и в мире («audit», «pipeline», «arsenkin»).
   * Проверяются только в тексте, который пишем мы; цитируемый материал
   * источников ими не судится — см. `matchInternalClientToken`.
   */
  ownVocabularyPattern: z.string().min(1),
  fieldBudgets: FieldBudgetsSchema,
  sidebarBannedPattern: z.string().min(1),
  sidebarEllipsisForbidden: z.boolean(),
  rawCaseIdPattern: z.string().min(1),
  rendererStripPattern: z.string().min(1),
  notes: z.record(z.string()).optional(),
});

export type ClientTextContract = z.infer<typeof ClientTextContractSchema>;

export type ClientTextIssue = {
  code: string;
  detail?: string;
};

export type ClientTextVerdict = {
  ok: boolean;
  issues: ClientTextIssue[];
  contractVersion: string;
};

let cached: ClientTextContract | null = null;
let internalRe: RegExp | null = null;
let ownVocabularyRe: RegExp | null = null;
let sidebarBannedRe: RegExp | null = null;
let rawCaseIdRe: RegExp | null = null;

/** Validate and return the bundled contract (cached). */
export function getClientTextContract(): ClientTextContract {
  if (cached) return cached;
  cached = ClientTextContractSchema.parse(rawContract);
  return cached;
}

/** Accept an embedded payload contract (renderer / tests); fall back to bundle. */
export function resolveClientTextContract(raw?: unknown): ClientTextContract {
  if (raw == null) return getClientTextContract();
  return ClientTextContractSchema.parse(raw);
}

function internalTokenRegex(c: ClientTextContract): RegExp {
  if (!internalRe || internalRe.source !== c.internalTokenPattern) {
    internalRe = new RegExp(c.internalTokenPattern, "iu");
  }
  return internalRe;
}

function ownVocabularyRegex(c: ClientTextContract): RegExp {
  if (!ownVocabularyRe || ownVocabularyRe.source !== c.ownVocabularyPattern) {
    ownVocabularyRe = new RegExp(c.ownVocabularyPattern, "iu");
  }
  return ownVocabularyRe;
}

function sidebarBannedRegex(c: ClientTextContract): RegExp {
  if (!sidebarBannedRe || sidebarBannedRe.source !== c.sidebarBannedPattern) {
    sidebarBannedRe = new RegExp(c.sidebarBannedPattern, "i");
  }
  return sidebarBannedRe;
}

function rawCaseIdRegex(c: ClientTextContract): RegExp {
  if (!rawCaseIdRe || rawCaseIdRe.source !== c.rawCaseIdPattern) {
    rawCaseIdRe = new RegExp(c.rawCaseIdPattern, "i");
  }
  return rawCaseIdRe;
}

/**
 * Чей это текст — решает, каким списком его судить.
 *
 * Машинные идентификаторы (`reportRunId`, `datasetId`, `serp_obs`, …) не могут
 * появиться ни в каком клиентском тексте — ни в нашем, ни в цитате. Слова
 * нашего словаря («audit», «pipeline», «arsenkin») — тоже наши коды, но они же
 * обычные слова и части чужих названий: Google в ответе о регистрации ИП
 * цитирует сайт Audit-it, и живой прогон 03.09.2026 лёг на этом слове. Поэтому
 * словарь применяется только к тексту, который пишем мы; цитируемый материал
 * источников (`quoted: true` — буллеты и ячейки таблиц) судится по машинному
 * списку.
 */
export function matchInternalClientToken(
  text: string,
  contract: ClientTextContract = getClientTextContract(),
  opts: { quoted?: boolean } = {}
): boolean {
  if (internalTokenRegex(contract).test(text)) return true;
  return opts.quoted ? false : ownVocabularyRegex(contract).test(text);
}

/**
 * Shared verdict used by TS QA and the Python parity smoke.
 * `surface: "sidebar"` applies ellipsis + sidebar bans; `"body"` uses
 * forbidden-raw + internal + raw case-id checks.
 */
export function evaluateClientText(
  text: string,
  opts?: { surface?: "sidebar" | "body"; contract?: ClientTextContract; quoted?: boolean }
): ClientTextVerdict {
  const contract = opts?.contract ?? getClientTextContract();
  const surface = opts?.surface ?? "body";
  const issues: ClientTextIssue[] = [];
  const value = String(text ?? "");

  if (surface === "sidebar") {
    if (contract.sidebarEllipsisForbidden && (value.includes("…") || value.includes("..."))) {
      issues.push({ code: "sidebar-ellipsis" });
    }
    const m = sidebarBannedRegex(contract).exec(value);
    if (m) {
      issues.push({ code: "sidebar-forbidden", detail: m[0] });
    }
  } else {
    const lower = value.toLowerCase();
    for (const token of contract.forbiddenRawTokens) {
      if (lower.includes(token.toLowerCase())) {
        issues.push({ code: "forbidden", detail: token });
      }
    }
    if (matchInternalClientToken(value, contract, { quoted: Boolean(opts?.quoted) })) {
      issues.push({ code: "internal-token" });
    }
    if (rawCaseIdRegex(contract).test(value)) {
      issues.push({ code: "forbidden", detail: "raw-case-id" });
    }
  }

  return { ok: issues.length === 0, issues, contractVersion: contract.version };
}

/** Field budgets for GPT slide copy / section validation. */
export function getClientTextFieldBudgets(
  contract: ClientTextContract = getClientTextContract()
): ClientTextContract["fieldBudgets"] {
  return contract.fieldBudgets;
}
