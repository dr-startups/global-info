-- CreateTable
-- Проверка с сайта самопроверки: одна строка — одна попытка посетителя. Правка
-- аддитивная — существующих таблиц и строк не касается, поэтому pre-deploy на
-- живой базе накатывает её обычным `migrate deploy`. `caseId` допускает null
-- только у записи, пойманной ловушкой формы: кейс для бота не заводится.
CREATE TABLE "dp_self_checks" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "caseId" TEXT,
    "status" TEXT NOT NULL,
    "inputJson" JSONB,
    "consentVersion" TEXT NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "ipHash" TEXT NOT NULL,
    "subjectHash" TEXT NOT NULL,
    "captchaVerifiedAt" TIMESTAMP(3),
    "honeypotTripped" BOOLEAN NOT NULL DEFAULT false,
    "blockedReason" TEXT,
    "jobId" TEXT,
    "runStartedAt" TIMESTAMP(3),
    "runFinishedAt" TIMESTAMP(3),
    "verdict" TEXT,
    "riskLevel" TEXT,
    "materialsFound" INTEGER,
    "findingsTotal" INTEGER,
    "themesJson" JSONB,
    "partial" BOOLEAN NOT NULL DEFAULT false,
    "verdictAt" TIMESTAMP(3),
    "verdictSource" TEXT,
    "leadName" TEXT,
    "leadPhone" TEXT,
    "leadEmail" TEXT,
    "leadTelegram" TEXT,
    "leadMessage" TEXT,
    "leadPreferredTime" TEXT,
    "leadAt" TIMESTAMP(3),
    "leadStatus" TEXT NOT NULL DEFAULT 'NONE',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "anonymizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dp_self_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dp_self_checks_publicId_key" ON "dp_self_checks"("publicId");

-- CreateIndex
CREATE UNIQUE INDEX "dp_self_checks_caseId_key" ON "dp_self_checks"("caseId");

-- CreateIndex
CREATE INDEX "dp_self_checks_ipHash_createdAt_idx" ON "dp_self_checks"("ipHash", "createdAt");

-- CreateIndex
CREATE INDEX "dp_self_checks_expiresAt_idx" ON "dp_self_checks"("expiresAt");

-- AddForeignKey
ALTER TABLE "dp_self_checks" ADD CONSTRAINT "dp_self_checks_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "dp_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
