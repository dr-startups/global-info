/**
 * Small request helpers shared by Digital Profile route handlers.
 */

import { ForbiddenError, ValidationError } from "./errors";
import type { ActorContext } from "../services/case-service";

/**
 * Derives the actor context from request headers. No auth yet — we read an
 * optional `x-actor-id` header so callers can attribute actions during testing.
 * Returns `{ actorId: null }` when absent.
 */
export function getActorContext(req: Request): ActorContext {
  const actorId = req.headers.get("x-actor-id");
  return { actorId: actorId && actorId.trim() !== "" ? actorId : null };
}

/** Parses a JSON body, mapping malformed JSON to a 400 validation error. */
export async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
}

/**
 * Guards admin-only actions (e.g. deleting evidence). No auth yet — we check an
 * `x-actor-role: admin` header as a placeholder. Replace with real RBAC later.
 */
export function requireAdmin(req: Request): void {
  const role = req.headers.get("x-actor-role");
  if (role !== "admin") {
    throw new ForbiddenError("Admin role required for this action");
  }
}
