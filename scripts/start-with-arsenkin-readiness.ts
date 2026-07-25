/**
 * Railway/runtime startup: run Arsenkin DB readiness in the app container, then `next start`.
 * Avoids `start:railway -> start -> start:railway` recursion by spawning next directly.
 */

import { spawn } from "node:child_process";
import {
  runArsenkinDbReadiness,
  shouldRunStartupDbReadiness,
} from "../src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness-service";

async function main() {
  if (shouldRunStartupDbReadiness(process.env)) {
    console.error("[arsenkin-startup] Running DB readiness before web server…");
    const result = await runArsenkinDbReadiness();
    console.error(
      JSON.stringify(
        {
          verdict: result.verdict,
          readinessCode: result.readinessCode,
          blockers: result.blockers,
          artifactPath: result.artifactPath,
          buildCommit: result.buildCommit,
          environment: result.environment,
          networkCalls: result.networkCalls,
        },
        null,
        2
      )
    );
    if (result.verdict !== "PASS" || result.readinessCode !== "READINESS_PASS") {
      console.error(
        "[arsenkin-startup] DB readiness FAIL — starting web server with Arsenkin fail-closed gate."
      );
    } else {
      console.error("[arsenkin-startup] DB readiness PASS — starting web server.");
    }
  } else {
    console.error("[arsenkin-startup] DB readiness skipped (integration not required).");
  }

  const port = process.env.PORT ?? "3000";
  const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["next", "start", "-p", port], {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });

  // Пока артефакты прогона лежат на диске, отдельный сервис-воркер не может
  // отдать собранный отчёт: том Railway монтируется к одному сервису
  // (docs/digital-profile/RAILWAY_DEPLOYMENT.md § worker). До переноса
  // артефактов в общее хранилище воркер поднимается здесь же, рядом с
  // веб-процессом — расписание при этом всё равно живёт в БД, поэтому деплой
  // посреди сбора работу больше не теряет.
  if (String(process.env.WORKFLOW_WORKER_INLINE ?? "").toLowerCase() === "true") {
    console.error("[worker] встроенный режим: шаги исполняются в процессе приложения");
    void (async () => {
      const { runStepWorker } = await import("../src/modules/digital-profile/workflow/step-runner");
      const { reconcileStageAfterStep, unifiedStepHandlers } = await import(
        "../src/modules/digital-profile/workflow/unified-step-handlers"
      );
      await runStepWorker({
        handlers: unifiedStepHandlers(),
        idleDelayMs: Number(process.env.WORKFLOW_WORKER_IDLE_MS ?? 1_000),
        leaseMs: Number(process.env.WORKFLOW_WORKER_LEASE_MS ?? 120_000),
        onStepSettled: reconcileStageAfterStep,
        onError: (err, step) => {
          const where = step ? `${step.jobId}/${step.name}` : "цикл";
          console.error(`[worker] сбой в ${where}:`, err);
        },
      });
    })().catch((err) => {
      // Веб-процесс продолжает работать: без воркера прогоны стоят, но
      // приложение остаётся доступным, и это видно в статусе.
      console.error("[worker] встроенный воркер остановлен:", err);
    });
  }

  // Auto-resume FAILED_RETRYABLE / WAITING_PROVIDER Full jobs after deploy.
  // Runs in this Node process (outside Next instrumentation webpack graph).
  setTimeout(() => {
    void import("../src/modules/digital-profile/providers/arsenkin/full-audit-orchestrator")
      .then(({ resumeActiveArsenkinOrchestrations }) => {
        console.error("[arsenkin-startup] Resuming active/retryable Full orchestrations…");
        resumeActiveArsenkinOrchestrations();
      })
      .catch((err) => {
        console.error(
          "[arsenkin-startup] Orchestration resume skipped:",
          err instanceof Error ? err.message : err
        );
      });
    void import("../src/modules/digital-profile/services/unified-orion-collection-orchestrator")
      .then(async ({ resumeUnifiedCollectionsOnStartup, pumpResumableUnifiedCollections }) => {
        console.error("[unified-startup] Bounded resume of unified collection jobs…");
        await resumeUnifiedCollectionsOnStartup();
        // Durable pump: WAITING / ARSENKIN_RESULT_INGEST survives HTTP end + deploy.
        // Idempotent with scheduleUnifiedTick + job-scoped lease.
        setInterval(() => {
          void (async () => {
            try {
              const n = await pumpResumableUnifiedCollections();
              if (n > 0) {
                console.error(`[unified-startup] pump scheduled ${n} resumable job(s)`);
              }
            } catch (err) {
              console.error(
                "[unified-startup] pump failed:",
                err instanceof Error ? err.message : err
              );
            }
          })();
        }, 5_000);
      })
      .catch(() => undefined);
    void import("../src/modules/digital-profile/services/arsenkin-case-agent-execution")
      .then(({ resumeArsenkinCaseAgentExecutions, tickArsenkinCaseAgentFinalizations }) => {
        console.error("[arsenkin-agent] Resuming unfinished CaseAgent executions…");
        void resumeArsenkinCaseAgentExecutions()
          .then((n) => {
            console.error(`[arsenkin-agent] resume scheduled ${n} job(s)`);
          })
          .catch((err) => {
            console.error(
              "[arsenkin-agent] resume failed:",
              err instanceof Error ? err.message : err
            );
          });
        void tickArsenkinCaseAgentFinalizations().catch((err) => {
          console.error(
            "[arsenkin-agent] finalize tick failed:",
            err instanceof Error ? err.message : err
          );
        });
        setInterval(() => {
          // Pump PREPARING/COLLECTING jobs left after crash / interrupted HTTP,
          // then finalize any FINALIZING rows.
          void resumeArsenkinCaseAgentExecutions()
            .then(() => tickArsenkinCaseAgentFinalizations())
            .catch((err) => {
              console.error(
                "[arsenkin-agent] resume/finalize tick failed:",
                err instanceof Error ? err.message : err
              );
            });
        }, 5000);
      })
      .catch((err) => {
        console.error(
          "[arsenkin-agent] import failed:",
          err instanceof Error ? err.message : err
        );
      });
  }, 1500);

  child.on("error", (err) => {
    console.error("[arsenkin-startup] Failed to spawn next start:", err);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`[arsenkin-startup] next start killed by signal ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 0);
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
