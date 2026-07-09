/**
 * R10.10b — Probe DB connectivity / list users (no secrets printed).
 */
import { PrismaClient } from "@prisma/client";

const raw = process.env.DATABASE_URL ?? "";
const rewritten = raw.replace("@postgres:", "@dp-postgres:");
if (rewritten !== raw) {
  process.env.DATABASE_URL = rewritten;
  console.log("[INFO] rewrote DATABASE_URL host postgres -> dp-postgres");
}
console.log(
  "[INFO] dbHost",
  ((process.env.DATABASE_URL ?? "").match(/@([^:/]+)/) || [])[1] || "none"
);

const prisma = new PrismaClient();
async function main() {
  await prisma.$queryRaw`SELECT 1`;
  console.log("[INFO] db_ok");
  const users = await prisma.dpUser.findMany({
    select: { id: true, email: true, role: true, isActive: true },
    take: 10,
  });
  console.log(
    JSON.stringify({
      userCount: users.length,
      users: users.map((u) => ({ email: u.email, role: u.role, active: u.isActive })),
    })
  );
}
main()
  .catch((e) => {
    console.error("[ERR]", e instanceof Error ? e.message.slice(0, 300) : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
