import { describe, it, expect } from "vitest";
import {
  isPollOverdue,
  POLL_STALL_GRACE_MS,
} from "../../src/modules/digital-profile/services/unified-collection-recovery";

/**
 * Шаг 11.1-bis плана (docs/rework/11-workflow-ux-and-false-failures.md).
 *
 * Восстановление блокировалось только при status === "RUNNING", а нормальное
 * состояние durable-импорта Arsenkin — "WAITING". Поэтому во время здорового
 * прогона оператору предлагалась кнопка «Продолжить импорт Arsenkin»: система
 * приглашала вмешаться в то, что и так работает.
 */

const NOW = new Date("2026-07-25T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

describe("isPollOverdue", () => {
  it("следующий тик в будущем — не просрочено", () => {
    expect(isPollOverdue({ nextPollAt: at(15_000) }, NOW)).toBe(false);
  });

  it("тик только что прошёл, в пределах допуска — не просрочено", () => {
    expect(isPollOverdue({ nextPollAt: at(-30_000) }, NOW)).toBe(false);
  });

  it("тишина дольше допуска — просрочено", () => {
    expect(isPollOverdue({ nextPollAt: at(-POLL_STALL_GRACE_MS - 1_000) }, NOW)).toBe(true);
  });

  it("расписания нет вовсе — просрочено", () => {
    expect(isPollOverdue({}, NOW)).toBe(true);
    expect(isPollOverdue({ nextPollAt: null }, NOW)).toBe(true);
  });

  it("при отсутствии nextPollAt опирается на updatedAt", () => {
    expect(isPollOverdue({ updatedAt: at(-10_000) }, NOW)).toBe(false);
    expect(isPollOverdue({ updatedAt: at(-POLL_STALL_GRACE_MS - 1_000) }, NOW)).toBe(true);
  });

  it("некорректная дата трактуется как просрочка, а не как исправность", () => {
    expect(isPollOverdue({ nextPollAt: "не дата" }, NOW)).toBe(true);
  });
});
