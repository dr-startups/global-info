/**
 * Seed data for the Digital Profile Audit module.
 *
 * Creates ONE sample case + subject with a small set of evidence-backed records,
 * so the module can be developed/tested against realistic data. Idempotent:
 * re-running upserts the same case by its unique caseNumber.
 *
 * Run with: npm run db:seed
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SAMPLE_CASE_NUMBER = "DPA-2026-0001";
const SEED_ACTOR = "seed-script";

async function main() {
  // Reset prior seed case (cascade removes all related evidence).
  await prisma.case.deleteMany({ where: { caseNumber: SAMPLE_CASE_NUMBER } });

  const dpaCase = await prisma.case.create({
    data: {
      caseNumber: SAMPLE_CASE_NUMBER,
      title: "Digital Profile Audit — John A. Sample",
      status: "REVIEW",
      lawfulBasis: "LEGITIMATE_INTEREST",
      consentStatus: "NOT_REQUIRED",
      createdBy: SEED_ACTOR,
      notes: "Sample case for development. All evidence is fictional.",
    },
  });

  const subject = await prisma.subject.create({
    data: {
      caseId: dpaCase.id,
      fullName: "John A. Sample",
      aliases: ["J. Sample", "Johnny Sample"],
      dateOfBirth: new Date("1984-05-12"),
      nationality: "British",
      country: "United Kingdom",
      emails: ["john.sample@example.com"],
      phones: ["+44 20 7946 0000"],
      identifiers: { note: "Fictional subject — no real identifiers." },
    },
  });

  const query = await prisma.searchQuery.create({
    data: {
      caseId: dpaCase.id,
      engine: "GOOGLE",
      queryText: '"John A. Sample" United Kingdom',
      source: "GENERATED",
      createdBy: SEED_ACTOR,
    },
  });

  const result = await prisma.searchResult.create({
    data: {
      caseId: dpaCase.id,
      queryId: query.id,
      engine: "GOOGLE",
      url: "https://example.com/news/john-sample-profile",
      normalizedUrl: "example.com/news/john-sample-profile",
      dedupHash: "seed-hash-john-sample-profile",
      title: "John A. Sample — company director profile",
      snippet: "John A. Sample is listed as a director of Example Holdings Ltd.",
      rank: 1,
      classification: "CORPORATE",
      reviewStatus: "REVIEWED",
    },
  });

  const screenshot = await prisma.screenshot.create({
    data: {
      caseId: dpaCase.id,
      resultId: result.id,
      storageKey: `digital-profile/${dpaCase.id}/screenshots/seed-corporate.png`,
      mimeType: "image/png",
      sha256:
        "0000000000000000000000000000000000000000000000000000000000000000",
      sizeBytes: 102400,
      sourceUrl: result.url,
      capturedBy: SEED_ACTOR,
    },
  });

  await prisma.wikipediaCheck.create({
    data: {
      caseId: dpaCase.id,
      exists: false,
      language: "en",
      checkedBy: SEED_ACTOR,
      snapshot: { searchedTitle: "John A. Sample", matches: 0 },
    },
  });

  await prisma.databaseProfile.create({
    data: {
      caseId: dpaCase.id,
      provider: "WORLD_CHECK",
      importMethod: "MANUAL_IMPORT",
      matchType: "no-match",
      matchScore: 0,
      rawPayload: { note: "Manual import placeholder — no PEP/sanction match." },
      evidenceRefs: [
        {
          type: "IMPORTED_FILE",
          label: "World-Check manual export (sample)",
        },
      ],
      importedBy: SEED_ACTOR,
    },
  });

  await prisma.aiProfile.create({
    data: {
      caseId: dpaCase.id,
      model: "mock-llm",
      summary:
        "Subject appears associated with Example Holdings Ltd. No adverse media found in collected evidence.",
      classifications: { sentiment: "neutral", adverseMedia: false },
      evidenceRefs: [
        { type: "URL", refId: result.id, url: result.url, label: result.title },
      ],
      createdBy: SEED_ACTOR,
    },
  });

  await prisma.riskFinding.create({
    data: {
      caseId: dpaCase.id,
      category: "Corporate affiliation",
      severity: "LOW",
      title: "Director of Example Holdings Ltd.",
      summary:
        "Subject is publicly listed as a company director. Informational only.",
      evidenceRefs: [
        { type: "URL", refId: result.id, url: result.url, label: result.title },
        {
          type: "SCREENSHOT",
          refId: screenshot.id,
          storageKey: screenshot.storageKey,
          label: "Corporate profile screenshot",
        },
      ],
      reviewStatus: "PENDING",
      createdBy: "RISK_CLASSIFIER",
    },
  });

  await prisma.reportVersion.create({
    data: {
      caseId: dpaCase.id,
      version: 1,
      status: "DRAFT",
      watermark: "DRAFT",
      createdBy: SEED_ACTOR,
      reportJson: {
        meta: {
          caseNumber: dpaCase.caseNumber,
          title: dpaCase.title,
          generatedAt: new Date().toISOString(),
          version: 1,
          status: "DRAFT",
          watermark: "DRAFT",
          language: "en",
        },
        subject: { fullName: subject.fullName, country: subject.country },
        dynamicPages: [],
        staticPages: [],
        pricing: [],
      },
    },
  });

  await prisma.auditLog.create({
    data: {
      caseId: dpaCase.id,
      actorId: SEED_ACTOR,
      action: "CASE_SEEDED",
      targetType: "Case",
      targetId: dpaCase.id,
      metadata: { source: "prisma/seed.ts" },
    },
  });

  console.log(`Seeded case ${dpaCase.caseNumber} (subject: ${subject.fullName}).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
