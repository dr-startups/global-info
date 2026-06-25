/**
 * Aggregate health for the Digital Profile module (Stage M2).
 *
 * Combines the Prisma DB ping with the Prisma-free storage/renderer checks.
 * Reveals component status + authEnabled only — never secrets or connection
 * strings.
 */

import { prisma } from "@/server/prisma/client";
import { isAuthEnabled } from "../auth/auth-config";
import {
  checkRendererHealth,
  checkStorageHealth,
  composeHealth,
  type ComponentStatus,
  type HealthReport,
} from "./health-checks";

export async function checkDatabaseHealth(): Promise<ComponentStatus> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return "ok";
  } catch {
    return "error";
  }
}

export async function getDigitalProfileHealth(): Promise<HealthReport> {
  const [database, storage, renderer] = await Promise.all([
    checkDatabaseHealth(),
    checkStorageHealth(),
    checkRendererHealth(),
  ]);
  return composeHealth({
    database,
    storage,
    renderer,
    authEnabled: isAuthEnabled(),
  });
}
