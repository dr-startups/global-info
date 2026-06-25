-- CreateEnum
CREATE TYPE "DpRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'ANALYST', 'REVIEWER', 'CLIENT_VIEWER');

-- CreateEnum
CREATE TYPE "DpAccessLevel" AS ENUM ('OWNER', 'EDITOR', 'REVIEWER', 'VIEWER');

-- CreateTable
CREATE TABLE "dp_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "DpRole" NOT NULL DEFAULT 'ANALYST',
    "passwordHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dp_case_access" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessLevel" "DpAccessLevel" NOT NULL DEFAULT 'VIEWER',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dp_case_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dp_users_email_key" ON "dp_users"("email");

-- CreateIndex
CREATE INDEX "dp_users_role_idx" ON "dp_users"("role");

-- CreateIndex
CREATE INDEX "dp_case_access_userId_idx" ON "dp_case_access"("userId");

-- CreateIndex
CREATE INDEX "dp_case_access_caseId_idx" ON "dp_case_access"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "dp_case_access_caseId_userId_key" ON "dp_case_access"("caseId", "userId");

-- AddForeignKey
ALTER TABLE "dp_case_access" ADD CONSTRAINT "dp_case_access_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dp_case_access" ADD CONSTRAINT "dp_case_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "dp_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
