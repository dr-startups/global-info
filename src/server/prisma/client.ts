/**
 * Single shared PrismaClient instance for the whole server.
 *
 * In development Next.js hot-reloads modules, which would otherwise create many
 * PrismaClient instances and exhaust the database connection pool. We cache the
 * instance on `globalThis` to avoid that. Always import `prisma` from here —
 * never instantiate `new PrismaClient()` elsewhere.
 */

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["warn", "error"]
        : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
