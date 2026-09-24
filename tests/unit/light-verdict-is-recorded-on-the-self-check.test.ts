import { describe, expect, it } from "vitest";
import { recordLightVerdict } from "@/modules/self-check/light-run";
import type { LightVerdictInput } from "@/modules/self-check/verdict";
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";
import { TEST_NOW, fakeDb, selfCheckRow } from "../support/self-check-fakes";
import { ALL_ANSWERED, CRIMINAL, FIXTURE_SUBJECT, NEUTRAL, SCREENED, serpItems } from "../support/light-run-fixtures";

/**
 * Шаг вердикта пишет результат в запись проверки — и только туда, где его ждут.
 *
 * Запись — источник правды для посетителя: полный прогон из админки заменяет
 * строку джобы дела, и результат, который читался бы из джобы, пропал бы у
 * посетителя вместе с ней. Поздний вердикт после превышения ожидания всё равно
 * записывается: результат лучше отказа. Прогон, признанный упавшим по другой
 * причине, запись не переписывает. Аудит пишется всегда и без материалов:
 * журнал обезличиванием не чистится.
 */

const JOB = {
  caseId: "case-1",
  unifiedJobId: "unified-1",
  requestedBy: "self-check:check-1",
  mode: "light",
  actualProviders: [],
  warnings: [],
} as unknown as UnifiedCollectionJob;

const NEGATIVE: LightVerdictInput = {
  items: serpItems(NEUTRAL, CRIMINAL),
  providers: ALL_ANSWERED,
  screenings: SCREENED,
  subject: FIXTURE_SUBJECT,
};

function setup(check: ReturnType<typeof selfCheckRow> | null, input: LightVerdictInput = NEGATIVE) {
  const { db, state } = fakeDb({ selfChecks: check ? [check] : [] });
  const seen: UnifiedCollectionJob[] = [];
  const deps = {
    db: db as never,
    now: () => TEST_NOW,
    loadVerdictInput: async (job: UnifiedCollectionJob) => {
      seen.push(job);
      return input;
    },
  };
  return { db, state, deps, seen };
}

describe("запись вердикта", () => {
  it("идущая проверка получает результат и становится DONE", async () => {
    const s = setup(selfCheckRow({ status: "RUNNING", runStartedAt: TEST_NOW, jobId: "unified-1" }));
    await recordLightVerdict(JOB, s.deps);
    expect(s.seen).toEqual([JOB]);
    expect(s.state.selfChecks[0]).toMatchObject({
      status: "DONE",
      verdict: "NEGATIVE_FOUND",
      riskLevel: "critical",
      materialsFound: 1,
      findingsTotal: 1,
      themesJson: [{ id: "criminal_legal", label: "Суд и криминал", count: 1, level: "critical" }],
      partial: false,
      sourcesJson: ["search", "surfaces", "open_sources", "sanctions"],
      verdictAt: TEST_NOW,
      runFinishedAt: TEST_NOW,
      verdictSource: "light-verdict-v3",
      blockedReason: null,
    });
  });

  it("аудит называет вердикт и прогон, но не материалы", async () => {
    const s = setup(selfCheckRow({ status: "RUNNING" }));
    await recordLightVerdict(JOB, s.deps);
    const audit = s.state.audits.find((a) => a.action === "SELF_CHECK_VERDICT");
    expect(audit).toMatchObject({
      caseId: "case-1",
      actorId: "self-check:check-1",
      metadata: {
        verdict: "NEGATIVE_FOUND",
        riskLevel: "critical",
        materialsFound: 1,
        findingsTotal: 1,
        partial: false,
        jobId: "unified-1",
      },
    });
    expect(JSON.stringify(audit)).not.toContain("lenta.ru");
    expect(JSON.stringify(audit)).not.toContain("уголовное");
  });

  it("поздний вердикт после превышения ожидания всё равно записывается", async () => {
    const s = setup(selfCheckRow({ status: "FAILED", blockedReason: "RUN_TIMEOUT" }));
    await recordLightVerdict(JOB, s.deps);
    expect(s.state.selfChecks[0]).toMatchObject({ status: "DONE", verdict: "NEGATIVE_FOUND", blockedReason: null });
  });

  it("проверку, признанную упавшей по другой причине, вердикт не переписывает", async () => {
    const s = setup(selfCheckRow({ status: "FAILED", blockedReason: "RUN_FAILED" }));
    await recordLightVerdict(JOB, s.deps);
    expect(s.state.selfChecks[0]).toMatchObject({ status: "FAILED", verdict: null });
    expect(s.state.audits.some((a) => a.action === "SELF_CHECK_VERDICT")).toBe(true);
  });

  it("записи проверки нет — вердикт остаётся в аудите, шаг не падает", async () => {
    const s = setup(null);
    await expect(recordLightVerdict(JOB, s.deps)).resolves.toBeUndefined();
    expect(s.state.audits.find((a) => a.action === "SELF_CHECK_VERDICT")).toMatchObject({ caseId: "case-1" });
  });
});
