/**
 * Single source of truth for the client-facing sidebar text contract.
 *
 * Mirrors the banned-token regex enforced by the Python renderer
 * (renderer/orion_golden_renderer.py :: _sidebar_analysis). Keeping this in one
 * TS module lets composer / acceptance / render preflight fail BEFORE the HTTP
 * renderer call, closing the TS↔Python parity gap that let "API" reach p10.
 *
 * IMPORTANT: this must stay byte-for-byte aligned with the Python regex. If you
 * change one, change both and update smoke:first36-sidebar-client-policy.
 */

/** Fields shown to the client in the visual sidebar. Technical provenance must
 * live only in asset.meta / evidenceRefs / provenance artifacts — never here. */
export const SIDEBAR_CLIENT_FIELDS = [
  "headlineConclusion",
  "whatIsVisible",
  "whyItMatters",
  "clientMeaning",
  "recommendedActions",
] as const;

export type SidebarClientField = (typeof SIDEBAR_CLIENT_FIELDS)[number];

/**
 * Banned client-facing tokens. Kept aligned with the Python renderer regex:
 *   (\[DEMO\]|\.example\b|\bAPI\b|\bSUGGESTION\b|knowledge-строк|не\s+live|
 *    \bprovider\b|\bmanifest\b|\bsynthetic\b|\breconstruction\b|\bдвижок\b)
 *
 * NOTE: Python 3 `re` treats \b as Unicode-aware for str patterns, so `\bдвижок\b`
 * matches Cyrillic. JS `\b` is ASCII-only, so we use Unicode letter lookarounds
 * (with the `u` flag) for the Cyrillic term to preserve exact parity.
 */
const RENDERER_BANNED_SOURCE =
  "(\\[DEMO\\]|\\.example\\b|\\bAPI\\b|\\bSUGGESTION\\b|knowledge-строк|не\\s+live|\\bprovider\\b|\\bmanifest\\b|\\bsynthetic\\b|\\breconstruction\\b|(?<!\\p{L})движок(?!\\p{L}))";

/** Extra internal identifiers that must never appear in client sidebar copy. */
const INTERNAL_LEAK_SOURCE =
  "(\\breportRunId\\b|\\bproviderTaskId\\b|\\bauditRunId\\b|orion-r10-\\d+|serp_observation:|provider_task:|arsenkin-suggest-canary)";

export const SIDEBAR_CLIENT_POLICY_REGEX = new RegExp(RENDERER_BANNED_SOURCE, "iu");
export const SIDEBAR_INTERNAL_LEAK_REGEX = new RegExp(INTERNAL_LEAK_SOURCE, "iu");

export type SidebarPolicyViolation = {
  page: number;
  field: SidebarClientField;
  token: string;
  preview: string;
};

function safePreview(text: string, matchIndex: number): string {
  const start = Math.max(0, matchIndex - 20);
  const slice = text.slice(start, matchIndex + 40).replace(/\s+/g, " ").trim();
  return slice.length > 60 ? `${slice.slice(0, 60)}…`.replace(/…$/, "…") : slice;
}

/** Scan a single string for any banned token. Returns first match or null. */
export function scanSidebarText(text: string): { token: string; preview: string } | null {
  const raw = String(text ?? "");
  if (!raw) return null;
  for (const re of [SIDEBAR_CLIENT_POLICY_REGEX, SIDEBAR_INTERNAL_LEAK_REGEX]) {
    const m = re.exec(raw);
    if (m) {
      return { token: m[0], preview: safePreview(raw, m.index) };
    }
  }
  return null;
}

type VisualAnalysisLike = {
  headlineConclusion?: string;
  whatIsVisible?: string;
  whyItMatters?: string;
  clientMeaning?: string;
  recommendedActions?: string[];
} | null | undefined;

type SlideLike = {
  pageNumber?: number;
  clientTakeaway?: string;
  visualAnalysis?: VisualAnalysisLike;
};

/** Scan one slide's sidebar fields. */
export function scanSlideSidebar(slide: SlideLike): SidebarPolicyViolation[] {
  const page = Number(slide.pageNumber ?? 0);
  const va = slide.visualAnalysis;
  if (!va) return [];
  const violations: SidebarPolicyViolation[] = [];
  const fieldValues: Array<[SidebarClientField, string]> = [
    ["headlineConclusion", String(va.headlineConclusion ?? slide.clientTakeaway ?? "")],
    ["whatIsVisible", String(va.whatIsVisible ?? "")],
    ["whyItMatters", String(va.whyItMatters ?? "")],
    ["clientMeaning", String(va.clientMeaning ?? "")],
  ];
  for (const action of va.recommendedActions ?? []) {
    fieldValues.push(["recommendedActions", String(action ?? "")]);
  }
  for (const [field, value] of fieldValues) {
    const hit = scanSidebarText(value);
    if (hit) {
      violations.push({ page, field, token: hit.token, preview: hit.preview });
    }
  }
  return violations;
}

/** Scan every slide's sidebar. Returns all violations. */
export function inspectSidebarClientPolicy(
  slides: SlideLike[]
): SidebarPolicyViolation[] {
  const out: SidebarPolicyViolation[] = [];
  for (const slide of slides) {
    out.push(...scanSlideSidebar(slide));
  }
  return out;
}

/** Format a violation exactly like the desired preflight error contract. */
export function formatSidebarPolicyViolation(v: SidebarPolicyViolation): string {
  return `SIDEBAR_CLIENT_POLICY: page=${v.page} field=${v.field} token=${v.token} preview="${v.preview}"`;
}

/** Throw a fail-closed error if any sidebar field violates client policy. */
export function assertSidebarClientPolicy(slides: SlideLike[]): void {
  const violations = inspectSidebarClientPolicy(slides);
  if (violations.length > 0) {
    throw new SidebarClientPolicyError(violations);
  }
}

export class SidebarClientPolicyError extends Error {
  readonly violations: SidebarPolicyViolation[];
  constructor(violations: SidebarPolicyViolation[]) {
    super(violations.map(formatSidebarPolicyViolation).join("; "));
    this.name = "SidebarClientPolicyError";
    this.violations = violations;
  }
}
