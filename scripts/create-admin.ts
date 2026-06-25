/**
 * Create the first SUPER_ADMIN user (Stage M3) — production-safe.
 *
 * Reads credentials from env (never from args, so the password is not stored in
 * shell history) and never logs the password:
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='strong-pass' ADMIN_NAME='Admin' \
 *     npm run admin:create
 *
 * If a user with that email already exists, this is a no-op (it will NOT change
 * an existing user's role or password).
 *
 * Relative imports (no path alias / app prisma client) so it runs under tsx.
 */

import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/modules/digital-profile/auth/password";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = (process.env.ADMIN_EMAIL ?? "").toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD ?? "";
  const name = (process.env.ADMIN_NAME ?? "Administrator").trim();

  if (!email || !email.includes("@")) {
    throw new Error("ADMIN_EMAIL is required (a valid email).");
  }
  if (password.length < 12) {
    throw new Error("ADMIN_PASSWORD is required and must be at least 12 characters.");
  }

  const existing = await prisma.dpUser.findUnique({ where: { email } });
  if (existing) {
    console.log(
      `User ${email} already exists (role=${existing.role}); leaving it unchanged.`
    );
    return;
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.dpUser.create({
    data: {
      email,
      name,
      role: "SUPER_ADMIN",
      passwordHash,
      isActive: true,
    },
    select: { id: true, email: true, role: true },
  });

  console.log(`Created SUPER_ADMIN: ${user.email} (id=${user.id}).`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    // Never print the password; only the error message.
    console.error(`admin:create failed: ${err instanceof Error ? err.message : String(err)}`);
    await prisma.$disconnect();
    process.exit(1);
  });
