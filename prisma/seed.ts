/**
 * Demo seed data for the Digital Profile Audit module.
 *
 * Creates THREE clearly-labelled demo cases so the module can be shown end-to-end:
 *
 *   A. DPA-2026-0001  Rich mock case     — full mock audit, ready to generate v3.
 *   B. DPA-2026-0002  Empty / clean case — minimal data, shows data-quality warnings.
 *   C. DPA-2026-0003  Mixed real-safe    — Wikipedia-ready + manual evidence; keyed
 *                                          SERP providers disabled/not configured.
 *
 * All subjects are FICTIONAL. No real persons, no real identifiers, no real
 * compliance records. Every record is marked as demo/mock where the schema allows
 * (SearchSurfaceItem.demo, RiskFinding.demo, SearchResult.source = "mock:SEED").
 *
 * Idempotent: re-running deletes the three demo cases by caseNumber (cascade
 * removes all related evidence) and recreates them.
 *
 * Run with: npm run db:seed
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SEED_ACTOR = "seed-script";
const CASE_RICH = "DPA-2026-0001";
const CASE_EMPTY = "DPA-2026-0002";
const CASE_MIXED = "DPA-2026-0003";

async function seedRichMockCase() {
  const c = await prisma.case.create({
    data: {
      caseNumber: CASE_RICH,
      title: "Digital Profile Audit — Maria Demidova (DEMO mock)",
      status: "REVIEW",
      lawfulBasis: "LEGITIMATE_INTEREST",
      consentStatus: "NOT_REQUIRED",
      targetRegions: ["RU", "AE"],
      createdBy: SEED_ACTOR,
      notes: "DEMO rich mock case. All evidence is fictional/mock — for demos only.",
    },
  });

  const subject = await prisma.subject.create({
    data: {
      caseId: c.id,
      fullName: "Maria Demidova",
      aliases: ["M. Demidova", "Мария Демидова"],
      nationality: "Russian",
      country: "United Arab Emirates",
      emails: ["maria.demidova@example.com"],
      identifiers: { note: "Fictional subject — no real identifiers." },
    },
  });

  const ruQuery = await prisma.searchQuery.create({
    data: {
      caseId: c.id,
      engine: "YANDEX",
      queryText: '"Мария Демидова" расследование',
      source: "GENERATED",
      createdBy: SEED_ACTOR,
    },
  });

  const adverse = await prisma.searchResult.create({
    data: {
      caseId: c.id,
      queryId: ruQuery.id,
      engine: "YANDEX",
      url: "https://news.example/ru/demidova-rassledovanie",
      normalizedUrl: "news.example/ru/demidova-rassledovanie",
      dedupHash: "seed-rich-ru-adverse",
      title: "[DEMO] Мария Демидова — расследование о финансовых нарушениях",
      snippet: "[DEMO] Публикация описывает спорные корпоративные сделки.",
      rank: 1,
      classification: "ADVERSE_MEDIA",
      reviewStatus: "PENDING",
      source: "mock:SEED",
    },
  });

  await prisma.searchResult.create({
    data: {
      caseId: c.id,
      engine: "YANDEX",
      url: "https://corp.example/ru/demidova",
      normalizedUrl: "corp.example/ru/demidova",
      dedupHash: "seed-rich-ru-corp",
      title: "[DEMO] Мария Демидова — корпоративный профиль",
      snippet: "[DEMO] Директор Example Holdings.",
      rank: 2,
      classification: "CORPORATE",
      reviewStatus: "REVIEWED",
      source: "mock:SEED",
    },
  });

  await prisma.searchResult.create({
    data: {
      caseId: c.id,
      engine: "GOOGLE",
      url: "https://corp.example/en/demidova",
      normalizedUrl: "corp.example/en/demidova",
      dedupHash: "seed-rich-en-corp",
      title: "[DEMO] Maria Demidova — corporate profile",
      snippet: "[DEMO] Listed as a director of Example Holdings Ltd.",
      rank: 1,
      classification: "CORPORATE",
      reviewStatus: "REVIEWED",
      source: "mock:SEED",
    },
  });

  const surfaces: Array<{
    type:
      | "SUGGESTION"
      | "RELATED_QUERY"
      | "IMAGE_RESULT"
      | "VIDEO_RESULT"
      | "KNOWLEDGE_BLOCK";
    region: string;
    query?: string;
    title?: string;
    snippet?: string;
    url?: string;
    classification?: string;
    dedup: string;
  }> = [
    { type: "SUGGESTION", region: "RU", query: "мария демидова мошенничество", classification: "NEGATIVE", dedup: "rich-sug-1" },
    { type: "SUGGESTION", region: "RU", query: "мария демидова суд", classification: "NEGATIVE", dedup: "rich-sug-2" },
    { type: "RELATED_QUERY", region: "RU", query: "мария демидова example holdings", dedup: "rich-rel-1" },
    { type: "IMAGE_RESULT", region: "RU", title: "[DEMO] негативное изображение", url: "https://img.example/ru/1", classification: "NEGATIVE", dedup: "rich-img-1" },
    { type: "VIDEO_RESULT", region: "RU", title: "[DEMO] репортаж", url: "https://video.example/ru/1", classification: "NEUTRAL", dedup: "rich-vid-1" },
    { type: "KNOWLEDGE_BLOCK", region: "RU", title: "[DEMO] Мария Демидова", snippet: "[DEMO] described entity", url: "https://kb.example/ru", dedup: "rich-kb-1" },
  ];
  for (const s of surfaces) {
    await prisma.searchSurfaceItem.create({
      data: {
        caseId: c.id,
        type: s.type,
        source: "MOCK",
        provider: "YANDEX",
        region: s.region,
        language: "ru",
        query: s.query,
        title: s.title,
        snippet: s.snippet,
        url: s.url,
        classification: s.classification,
        dedupHash: `seed-${s.dedup}`,
        demo: true,
        reviewStatus: "PENDING",
      },
    });
  }

  await prisma.wikipediaCheck.create({
    data: {
      caseId: c.id,
      exists: false,
      language: "ru",
      checkedBy: SEED_ACTOR,
      snapshot: { searchedTitle: "Мария Демидова", matches: 0, demo: true },
    },
  });

  await prisma.databaseProfile.create({
    data: {
      caseId: c.id,
      provider: "WORLD_CHECK",
      importMethod: "MANUAL_IMPORT",
      matchType: "SANCTIONS",
      matchScore: 95,
      rawPayload: { note: "[DEMO] manual import placeholder — fictional match." },
      evidenceRefs: [{ type: "IMPORTED_FILE", label: "[DEMO] World-Check manual export" }],
      importedBy: SEED_ACTOR,
    },
  });
  await prisma.databaseProfile.create({
    data: {
      caseId: c.id,
      provider: "LEXISNEXIS",
      importMethod: "MANUAL_IMPORT",
      matchType: "PEP",
      matchScore: 80,
      rawPayload: { note: "[DEMO] manual import placeholder — fictional PEP." },
      evidenceRefs: [{ type: "IMPORTED_FILE", label: "[DEMO] LexisNexis manual export" }],
      importedBy: SEED_ACTOR,
    },
  });

  await prisma.riskFinding.create({
    data: {
      caseId: c.id,
      category: "Adverse media",
      severity: "HIGH",
      title: "[DEMO] Adverse media: financial-misconduct allegations",
      summary: "[DEMO] Negative publication describing disputed corporate dealings. Requires manual verification.",
      evidenceRefs: [{ type: "URL", refId: adverse.id, url: adverse.url, label: adverse.title }],
      reviewStatus: "PENDING",
      createdBy: "RISK_CLASSIFIER",
      signalType: "ADVERSE_MEDIA",
      riskTheme: "ADVERSE_MEDIA",
      confidence: 0.6,
      rationale: "[DEMO] One adverse-media classified result found in RU search.",
      demo: true,
      dedupHash: "seed-rich-finding-adverse",
    },
  });

  await prisma.reportVersion.create({
    data: {
      caseId: c.id,
      version: 1,
      status: "DRAFT",
      watermark: "DRAFT",
      createdBy: SEED_ACTOR,
      reportJson: {
        meta: {
          caseNumber: c.caseNumber,
          title: c.title,
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
      caseId: c.id,
      actorId: SEED_ACTOR,
      action: "CASE_SEEDED",
      targetType: "Case",
      targetId: c.id,
      metadata: { source: "prisma/seed.ts", demo: true, kind: "rich-mock" },
    },
  });

  return c.caseNumber;
}

async function seedEmptyCase() {
  const c = await prisma.case.create({
    data: {
      caseNumber: CASE_EMPTY,
      title: "Digital Profile Audit — Ivan Pustov (DEMO empty)",
      status: "DRAFT",
      lawfulBasis: "LEGITIMATE_INTEREST",
      consentStatus: "NOT_REQUIRED",
      targetRegions: ["RU"],
      createdBy: SEED_ACTOR,
      notes: "DEMO empty/clean case. Minimal data — demonstrates data-quality warnings.",
    },
  });

  await prisma.subject.create({
    data: {
      caseId: c.id,
      fullName: "Ivan Pustov",
      nationality: "Russian",
      country: "Russia",
      identifiers: { note: "Fictional subject — no real identifiers." },
    },
  });

  // A single neutral corporate result; no compliance, no surfaces, no findings.
  await prisma.searchResult.create({
    data: {
      caseId: c.id,
      engine: "GOOGLE",
      url: "https://corp.example/en/pustov",
      normalizedUrl: "corp.example/en/pustov",
      dedupHash: "seed-empty-corp",
      title: "[DEMO] Ivan Pustov — minimal corporate listing",
      snippet: "[DEMO] Sparse public footprint.",
      rank: 1,
      classification: "CORPORATE",
      reviewStatus: "REVIEWED",
      source: "mock:SEED",
    },
  });

  await prisma.auditLog.create({
    data: {
      caseId: c.id,
      actorId: SEED_ACTOR,
      action: "CASE_SEEDED",
      targetType: "Case",
      targetId: c.id,
      metadata: { source: "prisma/seed.ts", demo: true, kind: "empty" },
    },
  });

  return c.caseNumber;
}

async function seedMixedRealSafeCase() {
  const c = await prisma.case.create({
    data: {
      caseNumber: CASE_MIXED,
      title: "Digital Profile Audit — Sven Andersson (DEMO real-safe)",
      status: "REVIEW",
      lawfulBasis: "LEGITIMATE_INTEREST",
      consentStatus: "NOT_REQUIRED",
      targetRegions: ["EU"],
      createdBy: SEED_ACTOR,
      notes:
        "DEMO mixed real-safe case. Wikipedia-ready + manual evidence. Keyed SERP " +
        "providers (Google/Yandex) are disabled/not configured by default.",
    },
  });

  const subject = await prisma.subject.create({
    data: {
      caseId: c.id,
      fullName: "Sven Andersson",
      nationality: "Swedish",
      country: "Sweden",
      emails: ["sven.andersson@example.com"],
      identifiers: { note: "Fictional subject — no real identifiers." },
    },
  });

  // Manual evidence (analyst-entered), explicitly sourced as manual import.
  await prisma.searchResult.create({
    data: {
      caseId: c.id,
      engine: "GOOGLE",
      url: "https://corp.example/eu/andersson",
      normalizedUrl: "corp.example/eu/andersson",
      dedupHash: "seed-mixed-manual-corp",
      title: "[DEMO] Sven Andersson — board member (manual entry)",
      snippet: "[DEMO] Manually entered corporate reference.",
      rank: 1,
      classification: "CORPORATE",
      reviewStatus: "REVIEWED",
      source: "manual:SEED",
    },
  });

  await prisma.searchSurfaceItem.create({
    data: {
      caseId: c.id,
      type: "MANUAL_NOTE",
      source: "MANUAL_IMPORT",
      provider: "MANUAL",
      region: "EU",
      language: "en",
      title: "[DEMO] Analyst note",
      snippet: "[DEMO] Manual analyst note. No scraping or automation used.",
      dedupHash: "seed-mixed-note-1",
      demo: true,
      reviewStatus: "REVIEWED",
    },
  });

  // Wikipedia-ready: a positive public-API style check (still requires review).
  await prisma.wikipediaCheck.create({
    data: {
      caseId: c.id,
      exists: true,
      language: "en",
      url: "https://en.wikipedia.org/wiki/Example_Sven_Andersson",
      pageTitle: "Example Sven Andersson",
      checkedBy: SEED_ACTOR,
      snapshot: { searchedTitle: "Sven Andersson", matches: 1, demo: true },
    },
  });

  await prisma.auditLog.create({
    data: {
      caseId: c.id,
      actorId: SEED_ACTOR,
      action: "CASE_SEEDED",
      targetType: "Case",
      targetId: c.id,
      metadata: { source: "prisma/seed.ts", demo: true, kind: "mixed-real-safe" },
    },
  });

  return c.caseNumber;
}

async function main() {
  // Idempotent reset of the three demo cases (cascade removes related evidence).
  await prisma.case.deleteMany({
    where: { caseNumber: { in: [CASE_RICH, CASE_EMPTY, CASE_MIXED] } },
  });

  const rich = await seedRichMockCase();
  const empty = await seedEmptyCase();
  const mixed = await seedMixedRealSafeCase();

  console.log("Seeded demo cases:");
  console.log(`  - ${rich}  (rich mock — ready for Template v3 generation)`);
  console.log(`  - ${empty}  (empty/clean — data-quality warnings)`);
  console.log(`  - ${mixed}  (mixed real-safe — Wikipedia-ready + manual evidence)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
