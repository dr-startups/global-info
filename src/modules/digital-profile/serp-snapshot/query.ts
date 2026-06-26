/**
 * Query resolution + sanitization for SERP snapshots (Stage S1).
 *
 * The query is rendered into the snapshot image as plain text. Resolution order:
 *   explicit request.query  ->  subjectName  ->  "—"
 * The value is trimmed, collapsed and length-capped. Escaping for SVG happens in
 * the renderer; here we only normalize the human-readable string.
 */

const MAX_QUERY_LEN = 120;

export function sanitizeQueryText(value: string | null | undefined): string {
  const collapsed = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ") // drop control chars
    .replace(/\s+/g, " ")
    .trim();
  if (collapsed.length <= MAX_QUERY_LEN) return collapsed;
  return collapsed.slice(0, MAX_QUERY_LEN - 1).trimEnd() + "…";
}

/** Resolves the effective query, falling back to the subject name. */
export function resolveQuery(
  requested: string | null | undefined,
  subjectName: string | null | undefined
): string {
  const explicit = sanitizeQueryText(requested);
  if (explicit) return explicit;
  const subject = sanitizeQueryText(subjectName);
  if (subject) return subject;
  return "—";
}
