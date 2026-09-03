/**
 * Подсказки Topvisor → строки автодополнения отчёта.
 *
 * Пилот T0: подсказки собирает `edit/keywords_2/collect/go` (0,90 ₽ за
 * исходную фразу), а результат сервис кладёт в **свою** группу
 * «DI (регион): фраза» — переданный `group_id` он игнорирует. Группа приходит
 * выключенной (`on: 0`), и это важно деньгами: включённая группа попала бы в
 * следующую проверку позиций, а фраз в ней вчетверо больше исходных.
 *
 * Здесь закреплено: строки автодополнения несут исходную фразу как запрос и
 * собранную как подсказку; собранные фразы не идут в набор позиций; повтор
 * оборота не оплачивает подбор дважды.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isCollectGroupName,
  suggestionsFromKeywords,
} from "@/modules/digital-profile/providers/topvisor/adapters/suggestions";
import { TOPVISOR_AUDIT_REGIONS } from "@/modules/digital-profile/providers/topvisor/regions";
import { runTopvisorPositionsTick, topvisorReportRunId } from "@/modules/digital-profile/services/topvisor-positions-tick";
import { createMemoryTopvisorTaskStore } from "@/modules/digital-profile/providers/topvisor/task-store";
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";
import { createTopvisorFixtureCall, loadTopvisorFixture, PILOT_KEYWORDS } from "@/modules/digital-profile/providers/topvisor/fixtures/fixture-call";

const region = (key: string) => TOPVISOR_AUDIT_REGIONS.find((r) => r.key === key)!;
const PROVENANCE = {
  caseId: "case-1",
  unifiedJobId: "job-1",
  enrichmentRunId: "topvisor-positions-job-1",
  providerTaskId: "pt-1",
  externalTaskId: "32742967:2026-09-03",
};

describe("имя группы подсказок", () => {
  it("узнаётся, но защитой от двойной оплаты быть не может", () => {
    // В имени нет поисковика: подбор по одной фразе в Яндексе и Google Москвы
    // даст две группы с одинаковым именем. Плюс сервис пишет фразу без «ё».
    expect(isCollectGroupName("DI (Москва): кремлев умар назарович")).toBe(true);
    expect(isCollectGroupName("RU")).toBe(false);
  });
});

describe("собранные подсказки", () => {
  it("становятся строками автодополнения со своим движком и регионом", () => {
    const out = suggestionsFromKeywords({
      body: loadTopvisorFixture("read-after-go"),
      groupId: 74606293,
      region: region("yandex-moscow"),
      sourceQuery: "Кремлёв Умар Назарович",
      provenance: PROVENANCE,
    });

    expect(out.observations.length).toBeGreaterThan(0);
    for (const o of out.observations) {
      expect(o.kind).toBe("suggestion");
      expect(o.surface).toBe("autocomplete");
      expect(o.region).toBe("RU");
      expect(o.engine).toBe("YANDEX");
      expect(o.provider).toBe("topvisor-yandex");
      // Запрос — наше написание исходной фразы, подсказка — то, что вернул сервис.
      expect(o.query).toBe("Кремлёв Умар Назарович");
      expect(String(o.suggestion ?? "").length).toBeGreaterThan(0);
    }
    expect(out.observations.map((o) => o.suggestion)).toContain("кремлев умар назарович биография");
  });

  it("берутся только фразы своей группы: чужие остаются набором позиций", () => {
    const out = suggestionsFromKeywords({
      body: loadTopvisorFixture("read-after-go"),
      groupId: 74606293,
      region: region("yandex-moscow"),
      sourceQuery: "Кремлёв Умар Назарович",
      provenance: PROVENANCE,
    });

    // В фикстуре есть фразы групп RU/UAE — это наш набор позиций, не подсказки.
    expect(out.observations.map((o) => o.suggestion)).not.toContain("umar kremlev boxing");
  });

  it("пустая группа — названная пустота, а не молчание", () => {
    const out = suggestionsFromKeywords({
      body: { result: [] },
      groupId: 74606293,
      region: region("yandex-moscow"),
      sourceQuery: "Кремлёв Умар Назарович",
      provenance: PROVENANCE,
    });

    expect(out.observations).toEqual([]);
    expect(out.warnings.join(" ")).toMatch(/suggestions-empty/);
  });
});

const ENV = {
  SERP_COLLECTION_PROVIDER: "topvisor",
  TOPVISOR_API_KEY: "k",
  TOPVISOR_USER_ID: "100001",
} as Record<string, string | undefined>;

function job(state: UnifiedCollectionJob["topvisorEnrichmentState"] = null): UnifiedCollectionJob {
  return { caseId: "pilot-2026-09-03", unifiedJobId: "job-1", topvisorEnrichmentState: state } as unknown as UnifiedCollectionJob;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Прогнать тик до заданной фазы, отдавая ему собственное состояние. */
async function drive(
  call: ReturnType<typeof createTopvisorFixtureCall>["call"],
  taskStore: ReturnType<typeof createMemoryTopvisorTaskStore>,
  env: Record<string, string | undefined>,
  turns = 4
) {
  let out = await runTopvisorPositionsTick({ job: job(), keywords: PILOT_KEYWORDS, call, taskStore, env });
  for (let i = 1; i < turns; i += 1) {
    if (out.state.phase === "DONE" || out.blockPipeline) break;
    out = await runTopvisorPositionsTick({ job: job(out.state), keywords: PILOT_KEYWORDS, call, taskStore, env });
  }
  return out;
}

describe("подбор подсказок в тике", () => {
  it("после проверки позиций идёт подбор, и только потом прогон готов", async () => {
    const { call, log } = createTopvisorFixtureCall({
      projectExists: true,
      checkPollsUntilDone: 0,
      collectGroupExists: false,
    });
    const taskStore = createMemoryTopvisorTaskStore();

    const first = await runTopvisorPositionsTick({ job: job(), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV });
    expect(first.state.phase).toBe("CHECKING");
    const afterCheck = await runTopvisorPositionsTick({ job: job(first.state), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV });

    // Позиции прочитаны, но прогон ещё не готов: подсказки в работе.
    expect(afterCheck.state.phase).toBe("COLLECTING");
    expect(afterCheck.waiting).toBe(true);
    // Две поверхности, не три: подсказки Google по российским регионам Topvisor
    // не отдаёт (живой прогон 03.09.2026), и умолчание их не заказывает.
    expect(log.filter((e) => e.method === "collect/go")).toHaveLength(2);
    const collectTask = await taskStore.findByReportRun(topvisorReportRunId("job-1"), "collect");
    expect(collectTask?.state).toBe("RUNNING");

    const done = await runTopvisorPositionsTick({ job: job(afterCheck.state), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV });
    expect(done.state.phase).toBe("DONE");
    const suggestions = done.observations.filter((o) => o.surface === "autocomplete");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(done.state.suggestionCount).toBe(suggestions.length);
    // Подсказки идут в отчёт вместе с выдачей и AI-ответами.
    expect(new Set(done.observations.map((o) => o.surface))).toEqual(
      new Set(["organic", "ai_answer", "autocomplete"])
    );
  });

  it("группа подбора остаётся выключенной: её фразы не попадают в проверку позиций", async () => {
    /*
     * Включённая группа удорожила бы следующую проверку вчетверо: собранных
     * фраз больше, чем исходных. Сервис отдаёт её выключенной, но полагаться
     * на это нельзя — проверяем и выключаем сами.
     */
    const { call, log } = createTopvisorFixtureCall({
      projectExists: true,
      checkPollsUntilDone: 0,
      collectGroupOn: true,
    });
    const out = await drive(call, createMemoryTopvisorTaskStore(), ENV);

    expect(out.state.phase).toBe("DONE");
    const off = log.filter((e) => e.method === "groups/on");
    expect(off.length).toBeGreaterThan(0);
    expect(off[0]!.payload).toMatchObject({ on: 0 });
  });

  it("обрыв после заказа подбора не оплачивает его заново", async () => {
    /*
     * Якорь — строка задачи `collect`: она заводится до платного вызова и
     * дополняется идентификатором группы сразу после каждого. Имя группы
     * якорем быть не может — в нём нет поисковика.
     */
    const taskStore = createMemoryTopvisorTaskStore();
    await taskStore.create({
      caseId: "pilot-2026-09-03",
      reportRunId: topvisorReportRunId("job-1"),
      toolName: "collect",
      externalTaskId: "74606293",
      requestJson: {
        projectId: 32742967,
        planned: [
          { key: "yandex-moscow", sourceQuery: "Кремлёв Умар Назарович", groupId: 74606293, ready: false },
        ],
      },
      submittedAt: new Date(),
    });
    const { call, log } = createTopvisorFixtureCall({ projectExists: true, checkPollsUntilDone: 0 });
    const out = await drive(call, taskStore, ENV);

    expect(out.state.phase).toBe("DONE");
    expect(log.filter((e) => e.method === "collect/go")).toHaveLength(0);
    expect(out.observations.filter((o) => o.surface === "autocomplete").length).toBeGreaterThan(0);
  });

  it("пустой список поверхностей — подсказки не собираются и не оплачиваются", async () => {
    const { call, log } = createTopvisorFixtureCall({ projectExists: true, checkPollsUntilDone: 0 });
    const out = await drive(call, createMemoryTopvisorTaskStore(), {
      ...ENV,
      TOPVISOR_SUGGEST_REGIONS: "none",
    });

    expect(out.state.phase).toBe("DONE");
    expect(log.filter((e) => e.method === "collect/go")).toHaveLength(0);
    expect(out.observations.filter((o) => o.surface === "autocomplete")).toEqual([]);
  });

  it("отказ подбора не роняет уже оплаченную выдачу", async () => {
    /*
     * Позиции оплачены и прочитаны; сбой подбора — повод сказать о нём, а не
     * потерять собранное. Правило продукта: отказ одного источника не обнуляет
     * оплаченный сбор.
     */
    const { call } = createTopvisorFixtureCall({
      projectExists: true,
      checkPollsUntilDone: 0,
      collectGroupExists: false,
      failCollectGo: true,
    });
    const out = await drive(call, createMemoryTopvisorTaskStore(), ENV);

    expect(out.state.phase).toBe("DONE");
    expect(out.blockPipeline).toBe(false);
    expect(out.observations.filter((o) => o.surface === "organic").length).toBeGreaterThan(0);
    expect(out.warnings.join(" ")).toMatch(/collect-start-failed/);
    expect(out.state.suggestionCount).toBe(0);
  });
});

