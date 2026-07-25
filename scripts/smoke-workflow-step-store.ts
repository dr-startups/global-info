/**
 * Шаг 12 плана — захват шага и продвижение конвейера против живого postgres.
 *
 * Проверяется то, что нельзя проверить в памяти: `FOR UPDATE SKIP LOCKED`
 * действительно не отдаёт один шаг двум процессам, а переход к следующему шагу
 * происходит в одной транзакции с закрытием предыдущего.
 *
 * Run: NETWORK_CALLS=0 npx tsx --test scripts/smoke-workflow-step-store.ts
 */

process.env.NETWORK_CALLS = "0";

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { ensureSmokeCase } from "./lib/ensure-smoke-case";
import { prisma } from "../src/server/prisma/client";
import {
  claimNextStep,
  completeStep,
  ensurePipelineSteps,
  listPipelineSteps,
  requeueStep,
} from "../src/modules/digital-profile/workflow/step-store";
import {
  UNIFIED_PIPELINE,
  deriveJobStage,
} from "../src/modules/digital-profile/workflow/step-plan";

const CASE = "smoke-workflow-steps-case";

async function freshJob(jobId: string) {
  await prisma.workflowStep.deleteMany({ where: { jobId } });
  return await ensurePipelineSteps({ caseId: CASE, jobId });
}

describe("workflow step store", () => {
  before(async () => {
    await ensureSmokeCase(CASE);
  });

  it("создаёт конвейер идемпотентно", async () => {
    const jobId = "wf-idem";
    const first = await freshJob(jobId);
    assert.equal(first.length, UNIFIED_PIPELINE.length);

    const second = await ensurePipelineSteps({ caseId: CASE, jobId });
    assert.equal(second.length, UNIFIED_PIPELINE.length);
    assert.equal(
      await prisma.workflowStep.count({ where: { jobId } }),
      UNIFIED_PIPELINE.length,
      "повторный старт не должен плодить шаги"
    );
  });

  it("к исполнению открыт только первый шаг", async () => {
    const jobId = "wf-first";
    const steps = await freshJob(jobId);
    const scheduled = steps.filter((s) => s.nextRunAt !== null);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0]!.position, 1);
  });

  it("два конкурирующих захвата не получают один шаг", async () => {
    const jobId = "wf-race";
    await freshJob(jobId);

    // Одновременно — иначе первый успел бы поставить лизу до старта второго.
    const [a, b] = await Promise.all([
      claimNextStep({ ownerId: "worker-a", jobId }),
      claimNextStep({ ownerId: "worker-b", jobId }),
    ]);

    const claimed = [a, b].filter(Boolean);
    assert.equal(claimed.length, 1, "шаг достался ровно одному воркеру");
    assert.equal(claimed[0]!.state, "RUNNING");
    assert.ok(claimed[0]!.leaseOwner === "worker-a" || claimed[0]!.leaseOwner === "worker-b");
  });

  it("завершение шага открывает следующий, и только его", async () => {
    const jobId = "wf-advance";
    await freshJob(jobId);
    const first = await claimNextStep({ ownerId: "w", jobId });
    assert.ok(first);
    await completeStep({ step: first!, outcome: { kind: "done", outputRef: "base.json" } });

    const steps = await listPipelineSteps(jobId);
    const byName = new Map(steps.map((s) => [s.name, s]));
    assert.equal(byName.get("BASE_COLLECTION")!.state, "DONE");
    assert.equal(byName.get("BASE_COLLECTION")!.outputRef, "base.json");
    assert.ok(byName.get("ARSENKIN_ENRICHMENT")!.nextRunAt, "второй шаг разбужен");
    assert.equal(byName.get("COMPOSITE_MERGE")!.nextRunAt, null, "третий шаг ещё спит");
  });

  it("ожидание возвращает шаг в очередь на будущее", async () => {
    const jobId = "wf-wait";
    await freshJob(jobId);
    const first = await claimNextStep({ ownerId: "w", jobId });
    await completeStep({ step: first!, outcome: { kind: "waiting" } });

    const [step] = await listPipelineSteps(jobId);
    assert.equal(step!.state, "WAITING");
    assert.equal(step!.attempts, 1);
    assert.ok(step!.nextRunAt! > new Date(), "разбудят позже");
    assert.equal(step!.leaseOwner, null, "лиза снята");

    // Сразу забрать нельзя — время не пришло.
    assert.equal(await claimNextStep({ ownerId: "w2", jobId }), null);
  });

  it("шаг с истёкшей лизой подбирается заново", async () => {
    const jobId = "wf-stale-lease";
    await freshJob(jobId);
    const first = await claimNextStep({ ownerId: "dead-worker", jobId });
    assert.ok(first);

    // Процесс умер, не завершив шаг: лиза истекает, работа не теряется.
    await prisma.workflowStep.update({
      where: { id: first!.id },
      data: { leaseUntil: new Date(Date.now() - 1_000) },
    });

    const again = await claimNextStep({ ownerId: "live-worker", jobId });
    assert.ok(again, "шаг должен быть подобран после смерти владельца");
    assert.equal(again!.id, first!.id);
    assert.equal(again!.leaseOwner, "live-worker");
  });

  it("упавший шаг останавливает конвейер и возвращается ручным повтором", async () => {
    const jobId = "wf-failed";
    await freshJob(jobId);
    const first = await claimNextStep({ ownerId: "w", jobId });
    await completeStep({
      step: first!,
      outcome: { kind: "failed", code: "BAD", message: "нет субъекта", retryable: false },
    });

    assert.equal(await claimNextStep({ ownerId: "w", jobId }), null, "конвейер стоит");
    assert.equal(deriveJobStage(await listPipelineSteps(jobId)).status, "FAILED");

    assert.equal(await requeueStep({ jobId, name: "BASE_COLLECTION" }), true);
    const retried = await claimNextStep({ ownerId: "w", jobId });
    assert.ok(retried, "после ручного повтора шаг снова исполняется");
    assert.equal(retried!.attempts, 0, "счётчик попыток сброшен");
  });

  it("захват не выходит за пределы своей джобы", async () => {
    const mine = "wf-scope-mine";
    const other = "wf-scope-other";
    await freshJob(mine);
    await freshJob(other);

    const claimed = await claimNextStep({ ownerId: "w", jobId: mine });
    assert.equal(claimed!.jobId, mine);
  });

  it("полный проход конвейера доводит джобу до готового отчёта", async () => {
    const jobId = "wf-full";
    await freshJob(jobId);
    for (let i = 0; i < UNIFIED_PIPELINE.length; i++) {
      const step = await claimNextStep({ ownerId: "w", jobId });
      assert.ok(step, `шаг ${i + 1} должен быть доступен`);
      await completeStep({ step: step!, outcome: { kind: "done" } });
    }
    const derived = deriveJobStage(await listPipelineSteps(jobId));
    assert.equal(derived.stage, "REPORT_READY");
    assert.equal(derived.progress, 1);
    assert.equal(await claimNextStep({ ownerId: "w", jobId }), null);
  });
});
