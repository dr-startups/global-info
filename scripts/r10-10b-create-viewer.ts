/**
 * R10.10b — Create CLIENT_VIEWER for unauthorized-role smoke (demo only).
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/modules/digital-profile/auth/password";

const prisma = new PrismaClient();
const email = "r10b-viewer@demo.local";

async function main() {
  const existing = await prisma.dpUser.findUnique({ where: { email } });
  if (existing) {
    console.log(`viewer exists role=${existing.role}`);
    return;
  }
  await prisma.dpUser.create({
    data: {
      email,
      name: "R10b Viewer",
      role: "CLIENT_VIEWER",
      passwordHash: await hashPassword("R10b-Demo-Viewer-12345"),
      isActive: true,
    },
  });
  console.log("created CLIENT_VIEWER");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
