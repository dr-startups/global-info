process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
process.env.NETWORK_CALLS = "0";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteUnifiedCollectionJobForTests,
  loadUnifiedCollectionJob,
  findOrCreateUnifiedCollectionJob,
  patchUnifiedCollectionJob,
} from "@/modules/digital-profile/services/unified-collection-job-store";
import { startUnifiedOrionCollection } from "@/modules/digital-profile/services/unified-orion-collection-orchestrator";
import { ARSENKIN_REAL_AGENT_NAMES } from "@/modules/digital-profile/agents/real/real-arsenkin-agents";
import { AppError } from "@/modules/digital-profile/http/errors";
import type { UnifiedOrchestratorDeps } from "@/modules/digital-profile/services/unified-orion-collection-orchestrator";
import type { PersonaGateInput } from "@/modules/digital-profile/services/subject-persona-check";

/**
 * Новый платный прогон не рождается, пока оператор не ответил, про кого
 * собирать. Ворота стоят ровно там, где прогон возникает, — после всех веток
 * продолжения: начатую работу они не трогают.
 *
 * Состояние ворот подставлено через `deps`: у этого сценария нет ни строки
 * `Case`, ни базы, и спрашивать её здесь нечего.
 */

const CASE_ID = "case-persona-gate-start";

const HASH = "hash-of-current-subject";

function gate(input: Partial<PersonaGateInput>): PersonaGateInput {
  return {
    isFixture: false,
    subjectInputHash: HASH,
    decidedHashes: [],
    // Признак субъекта у этих кейсов есть: проверяется решение, а не он.
    hasSubjectAnchor: true,
    ...input,
  };
}

/*
 * Каст здесь не нужен и вреден: `as never` гасил ровно ту проверку типов,
 * которая держит подстановку. Переименуют `loadPersonaGateInput` в типе
 * зависимостей — и проверки «идущий прогон ворот не спрашивает» станут
 * проходить впустую: они утверждают `calls === 0`, а при неподставленном поле
 * счётчик и так нулевой.
 */
function depsWith(
  loader: (caseId: string) => Promise<PersonaGateInput>
): UnifiedOrchestratorDeps {
  return { autoSchedule: false, loadPersonaGateInput: loader };
}

async function conflictOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("ожидался отказ, но запуск был принят");
}

beforeEach(async () => {
  await deleteUnifiedCollectionJobForTests(CASE_ID);
});

afterEach(async () => {
  await deleteUnifiedCollectionJobForTests(CASE_ID);
});

describe("старт не создаётся, пока решения нет", () => {
  it("PENDING — отказ CONFLICT с причиной, и джобы в хранилище не появилось", async () => {
    const err = await conflictOf(
      startUnifiedOrionCollection({
        caseId: CASE_ID,
        requestedBy: "test",
        deps: depsWith(async () => gate({})),
      })
    );
    expect(err.code).toBe("CONFLICT");
    expect(err.details).toMatchObject({ reason: "PERSONA_NOT_CONFIRMED" });
    expect(await loadUnifiedCollectionJob(CASE_ID)).toBeNull();
  });

  it("STALE — отказ называет устаревшее решение, а не отсутствие решения", async () => {
    const err = await conflictOf(
      startUnifiedOrionCollection({
        caseId: CASE_ID,
        requestedBy: "test",
        deps: depsWith(async () => gate({ decidedHashes: ["hash-of-old-subject"] })),
      })
    );
    expect(err.code).toBe("CONFLICT");
    expect(err.details).toMatchObject({ reason: "PERSONA_DECISION_STALE" });
    expect(await loadUnifiedCollectionJob(CASE_ID)).toBeNull();
  });

  it("платный перезапуск ворот не обходит", async () => {
    const err = await conflictOf(
      startUnifiedOrionCollection({
        caseId: CASE_ID,
        requestedBy: "test",
        confirmPaidRecollection: true,
        deps: depsWith(async () => gate({})),
      })
    );
    expect(err.details).toMatchObject({ reason: "PERSONA_NOT_CONFIRMED" });
    expect(await loadUnifiedCollectionJob(CASE_ID)).toBeNull();
  });

  it("отказ загрузчика ворота закрывает, а не открывает", async () => {
    const err = await conflictOf(
      startUnifiedOrionCollection({
        caseId: CASE_ID,
        requestedBy: "test",
        deps: depsWith(async () => {
          throw new Error("база недоступна");
        }),
      })
    );
    expect(err.code).toBe("CONFLICT");
    expect(err.details).toMatchObject({ reason: "PERSONA_GATE_UNAVAILABLE" });
    expect(await loadUnifiedCollectionJob(CASE_ID)).toBeNull();
  });

  it("отказ загрузчика не теряет причину: она попадает в консоль сервера", async () => {
    /*
     * Одинаковый 409 без единой строки в логе делает первый же сбой ворот
     * неотлаживаемым: недоступность базы, удалённое дело и опечатка в коде
     * выглядят одинаково, а останавливают они **все** прогоны в системе.
     */
    const cause = new Error("база недоступна");
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    try {
      await conflictOf(
        startUnifiedOrionCollection({
          caseId: CASE_ID,
          requestedBy: "test",
          deps: depsWith(async () => {
            throw cause;
          }),
        })
      );
    } finally {
      spy.mockRestore();
    }
    expect(logged.some((args) => args.includes(cause))).toBe(true);
  });

  it("CONFIRMED — старт как сегодня", async () => {
    const started = await startUnifiedOrionCollection({
      caseId: CASE_ID,
      requestedBy: "test",
      deps: depsWith(async () => gate({ decidedHashes: [HASH] })),
    });
    expect(started.created).toBe(true);
    expect(started.stage).toBe("BASE_COLLECTION");
    expect(await loadUnifiedCollectionJob(CASE_ID)).not.toBeNull();
  });

  it("фикстурный кейс проходит без решения", async () => {
    const started = await startUnifiedOrionCollection({
      caseId: CASE_ID,
      requestedBy: "test",
      deps: depsWith(async () => gate({ isFixture: true })),
    });
    expect(started.created).toBe(true);
  });
});

describe("идущий прогон ворот не спрашивает", () => {
  it("ожидание импорта Arsenkin возобновляется, а загрузчик ворот не зовётся ни разу", async () => {
    await findOrCreateUnifiedCollectionJob({
      caseId: CASE_ID,
      requestedBy: "test",
      arsenkinMode: "full-first36",
    });
    await patchUnifiedCollectionJob(CASE_ID, {
      stage: "ARSENKIN_ENRICHMENT",
      status: "WAITING",
      resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
      enrichmentRunIds: ARSENKIN_REAL_AGENT_NAMES.map((n) => `run-${n}`),
    });

    let calls = 0;
    const started = await startUnifiedOrionCollection({
      caseId: CASE_ID,
      requestedBy: "test",
      deps: depsWith(async () => {
        calls += 1;
        return gate({});
      }),
    });
    expect(started.created).toBe(false);
    expect(started.stage).toBe("ARSENKIN_ENRICHMENT");
    expect(calls).toBe(0);
  });

  it("прогон с сохранёнными стадиями отвечает как прежде, а не про персону", async () => {
    await findOrCreateUnifiedCollectionJob({
      caseId: CASE_ID,
      requestedBy: "test",
      arsenkinMode: "full-first36",
    });
    await patchUnifiedCollectionJob(CASE_ID, {
      stage: "REPORT_READY",
      status: "COMPLETED",
      baseReportRunId: "base-run-1",
    });

    let calls = 0;
    const err = await conflictOf(
      startUnifiedOrionCollection({
        caseId: CASE_ID,
        requestedBy: "test",
        deps: depsWith(async () => {
          calls += 1;
          return gate({});
        }),
      })
    );
    expect(err.code).toBe("CONFLICT");
    expect(String(err.details ?? "")).not.toContain("PERSONA");
    expect(calls).toBe(0);
  });
});
