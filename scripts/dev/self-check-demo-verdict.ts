/**
 * Стендовый вердикт для проверки с сайта — чтобы посмотреть экран результата.
 *
 * Зачем он есть. Демо-агенты стенда намеренно не считаются ответившими
 * (`providerAnswered` в `self-check/verdict.ts`), а их строки так же намеренно
 * не доходят до материалов отчёта (`isMockBaseRow` в `composite-serp-merge.ts`):
 * без этих двух правил демо-сбор выглядел бы настоящей проверкой, и приёмка
 * 15.09.2026 уже получала ложное «чисто». Поэтому на стенде вердикт всегда
 * «данных недостаточно» — экран результата пустой.
 *
 * Скрипт эти правила не трогает: он считает вердикт **рядом** с продакшн-путём
 * и пишет результат с пометкой источника `demo-stand`, по которой стендовую
 * запись видно в базе и в админке. На живом кейсе так делать нельзя — скрипт
 * отказывается работать при `NODE_ENV=production`.
 *
 *   npm run demo:self-check-verdict -- <publicId>            # по тому, что собрали демо-агенты
 *   npm run demo:self-check-verdict -- <publicId> --sample   # образец «негатив найден»
 *   npm run demo:self-check-verdict -- --reset               # снять лимит по адресу на стенде
 *
 * Первый режим честный: он берёт строки выдачи, записанные демо-агентами в базу
 * этого дела, и судит их теми же предикатами, что отчёт. Заголовки у демо-строк
 * английские и заведомо нейтральные, поэтому обычно выходит «чисто». Второй
 * режим пишет образец с темами — им смотрят экран «негатив найден» целиком.
 */

import { PrismaClient, type Prisma } from "@prisma/client";
import { lightVerdict, type LightVerdict, type LightVerdictInput } from "../../src/modules/self-check/verdict";
import type { RawInventoryItem } from "../../src/modules/digital-profile/orion-golden/types";

const prisma = new PrismaClient();

/** Образец результата: числа и темы из утверждённого макета экрана «найдено». */
const SAMPLE: Pick<
  LightVerdict,
  "verdict" | "riskLevel" | "materialsFound" | "findingsTotal" | "themes" | "partial" | "sourcesChecked"
> = {
  verdict: "NEGATIVE_FOUND",
  riskLevel: "medium",
  materialsFound: 7,
  findingsTotal: 3,
  themes: [
    { id: "criminal_legal", label: "Суд и криминал", count: 4, level: "high" },
    { id: "financial_claims", label: "Финансовые претензии и долги", count: 2, level: "medium" },
    { id: "political_exposure", label: "Политика и публичность", count: 1, level: "low" },
  ],
  partial: false,
  sourcesChecked: ["search", "surfaces", "open_sources", "sanctions"],
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * Материалы из строк выдачи этого дела. Это тот же перевод, что делает
 * подготовка отчёта, но без фильтра демо-строк: строки стенда и есть то, что мы
 * хотим показать.
 */
async function itemsFromSearchResults(caseId: string, reportRunId: string): Promise<RawInventoryItem[]> {
  const rows = await prisma.searchResult.findMany({ where: { caseId }, orderBy: { rank: "asc" } });
  return rows.map((row) => ({
    inventoryId: row.id,
    caseId,
    reportRunId,
    source: "serp_observation",
    provider: row.source ?? String(row.engine).toLowerCase(),
    region: "RU",
    collectedAt: row.createdAt.toISOString(),
    evidenceType: "serp_result",
    title: row.title ?? "",
    snippet: row.snippet ?? undefined,
    sourceUrl: row.url,
    classification: String(row.classification),
  }));
}

async function verdictFromStand(caseId: string): Promise<LightVerdict> {
  const { loadUnifiedCollectionJob } = await import(
    "../../src/modules/digital-profile/services/unified-collection-job-store"
  );
  const { resolveComplianceScreenings } = await import(
    "../../src/modules/digital-profile/services/compliance-inventory-adapter"
  );
  const { resolveJobSubjectProfile } = await import(
    "../../src/modules/digital-profile/services/job-subject-profile"
  );
  const { subjectIdentityFromProfile } = await import(
    "../../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier"
  );
  const job = await loadUnifiedCollectionJob(caseId);
  if (!job) fail("У дела нет прогона: сначала дождитесь, пока проверка дойдёт до результата.");
  // Принадлежность материала субъекту — тем же профилем, что у продакшн-пути.
  const profile = await resolveJobSubjectProfile({ caseId });
  if (!profile) fail("У дела нет профиля субъекта: его пишет создание проверки с сайта.");
  const screenings = await resolveComplianceScreenings({
    caseId,
    prisma: { complianceScreeningRun: prisma.complianceScreeningRun } as never,
  });
  // Единственная поблажка стенда: демо-прогон считается ответом источника.
  // Правило продакшна (`runtime !== "mock"`) при этом остаётся как было.
  const providers = job.actualProviders.map((provider) => ({
    ...provider,
    runtime: provider.runtime === "mock" ? "demo" : provider.runtime,
  }));
  const input: LightVerdictInput = {
    items: await itemsFromSearchResults(caseId, job.baseReportRunId ?? `${caseId}-base`),
    providers,
    screenings,
    subject: subjectIdentityFromProfile(profile),
  };
  return lightVerdict(input);
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    fail("Это стендовый скрипт: при NODE_ENV=production он не работает.");
  }
  const args = process.argv.slice(2);
  const publicId = args.find((arg) => !arg.startsWith("-"));
  const sample = args.includes("--sample");

  // Лимит по адресу (3 в час, 5 в сутки) считается строками таблицы проверок, а
  // не счётчиком в памяти, — на стенде он упирается уже на пятой попытке.
  if (args.includes("--reset")) {
    const removed = await prisma.selfCheck.deleteMany({});
    console.log(`Стендовые проверки удалены: ${removed.count}. Лимит по адресу снят.`);
    return;
  }

  if (!publicId) {
    fail("Укажите publicId проверки: npm run demo:self-check-verdict -- <publicId> [--sample]");
  }

  const check = await prisma.selfCheck.findUnique({ where: { publicId } });
  if (!check) fail(`Проверка ${publicId} не найдена.`);
  if (!check.caseId) fail("У проверки нет дела — записывать вердикт не к чему.");

  const verdict = sample ? SAMPLE : await verdictFromStand(check.caseId);
  const now = new Date();
  await prisma.selfCheck.update({
    where: { id: check.id },
    data: {
      status: "DONE",
      blockedReason: null,
      verdict: verdict.verdict,
      riskLevel: verdict.riskLevel,
      materialsFound: verdict.materialsFound,
      findingsTotal: verdict.findingsTotal,
      themesJson: verdict.themes as unknown as Prisma.InputJsonValue,
      sourcesJson: verdict.sourcesChecked as unknown as Prisma.InputJsonValue,
      partial: verdict.partial,
      verdictAt: now,
      // По этой пометке стендовый вердикт отличим от настоящего
      verdictSource: "demo-stand",
      runFinishedAt: check.runFinishedAt ?? now,
    },
  });

  const themes = verdict.themes.map((theme) => `${theme.label} — ${theme.count}`).join("; ") || "тем нет";
  console.log(
    [
      `Проверка ${publicId}: записан стендовый вердикт (verdictSource=demo-stand).`,
      `  вердикт: ${verdict.verdict}${verdict.riskLevel ? `, уровень: ${verdict.riskLevel}` : ""}`,
      `  материалов: ${verdict.materialsFound}, темы: ${themes}`,
      `  ответили группы источников: ${verdict.sourcesChecked.join(", ") || "нет"}`,
      verdict.verdict === "INSUFFICIENT_DATA" && !sample
        ? "  Материалов в базе стенда не нашлось. Экран «найдено» целиком покажет ключ --sample."
        : verdict.verdict === "CLEAN" && !sample
          ? "  Демо-строки нейтральны, поэтому «чисто». Экран «найдено» покажет ключ --sample."
          : "  Откройте /check/<publicId> — результат уже там.",
    ].join("\n")
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
