/**
 * Client-safe evidence gate — apply BEFORE building any ReportAssetV1.
 */

const DEMO_RE = /\[DEMO\]|\bDEMO\b/i;
const EXAMPLE_HOST_RE = /\.example(?:\.[a-z]+)?(?:\/|$)/i;
const LOCAL_HOST_RE = /(?:^|\/\/)(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/|$)/i;
const ENCODED_INTERNAL_RE = /%[0-9A-Fa-f]{2}.*(?:storage|internal|service|localhost)/i;
const INTERNAL_TOKEN_RE =
  /\b(?:API|SUGGESTION|provider|manifest|synthetic|reconstruction|rawPrompt|ORION_STATIC)\b/i;

export type ClientSafeEvidenceInput = {
  title?: string | null;
  snippet?: string | null;
  url?: string | null;
  displayUrl?: string | null;
  domain?: string | null;
  sourceLabel?: string | null;
  clientSafeSummary?: string | null;
};

export function isClientSafeEvidence(input: ClientSafeEvidenceInput): boolean {
  const blob = [
    input.title,
    input.snippet,
    input.url,
    input.displayUrl,
    input.domain,
    input.sourceLabel,
    input.clientSafeSummary,
  ]
    .map((s) => String(s ?? ""))
    .join("\n");

  if (!blob.trim()) return false;
  if (DEMO_RE.test(blob)) return false;
  if (EXAMPLE_HOST_RE.test(blob)) return false;
  if (LOCAL_HOST_RE.test(blob)) return false;
  if (ENCODED_INTERNAL_RE.test(blob)) return false;
  // Encoded-only URL with no human title is not client-safe.
  if (/%[0-9A-Fa-f]{2}/.test(String(input.url ?? "")) && !String(input.title ?? "").trim()) {
    return false;
  }
  if (INTERNAL_TOKEN_RE.test(blob) && DEMO_RE.test(blob)) return false;
  return true;
}

/** Tokens forbidden in client-visible sidebar / main panel copy. */
export const CLIENT_FORBIDDEN_VISIBLE_RE =
  /\[DEMO\]|\.example\b|\bAPI\b|\bSUGGESTION\b|knowledge-строк|не\s+live|\bprovider\b|\bmanifest\b|\bsynthetic\b|\breconstruction\b|\bдвижок\b/i;

export function containsForbiddenClientVisibleText(text: string): boolean {
  return CLIENT_FORBIDDEN_VISIBLE_RE.test(String(text || ""));
}
