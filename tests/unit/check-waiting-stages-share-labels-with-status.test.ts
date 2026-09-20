import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RUN_STAGE_LABELS } from "@/modules/self-check/run-stages";
import { publicSelfCheckStatus } from "@/modules/self-check/public-dto";
import { formatElapsed, waitingView, type RunJson } from "@/modules/site/check/waiting-view";
import type { PublicStatusJson } from "@/modules/site/check/types";
import { selfCheckRow } from "../support/self-check-fakes";

/** Что браузер получает после `JSON.stringify`: даты становятся строками. */
type Jsonify<T> = T extends Date
  ? string
  : T extends Array<infer U>
    ? Array<Jsonify<U>>
    : T extends object
      ? { [K in keyof T]: Jsonify<T[K]> }
      : T;

const jsonify = <T,>(value: T): Jsonify<T> => JSON.parse(JSON.stringify(value)) as Jsonify<T>;

/**
 * Экран ожидания перечисляет обе стадии, а ручка называет текущую. Если у
 * экрана своя таблица подписей, текущая строка списка и объявление для
 * скринридера (`stageLabel`) однажды назовут стадию по-разному. Таблица одна —
 * `run-stages.ts`, без серверных зависимостей, чтобы её собирал и браузер.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const STARTED = "2026-09-15T10:00:00.000Z";

const run = (over: Partial<RunJson>): RunJson => ({
  stage: "collecting",
  stageLabel: RUN_STAGE_LABELS.collecting,
  progress: 0.2,
  nextPollMs: 7000,
  startedAt: STARTED,
  ...over,
});

describe("подписи стадий — один ответ", () => {
  it("подписи — из макета, в форме двух стадий (решение владельца об «AI-анализ» 15.09)", () => {
    expect(RUN_STAGE_LABELS).toEqual({
      collecting: "Поиск упоминаний и сверка с открытыми источниками и санкционными списками",
      verdict: "AI-анализ размечает находки и формирует результат",
    });
  });

  it("ручка и экран называют стадию одними словами", () => {
    const row = selfCheckRow({ status: "RUNNING", runStartedAt: new Date(STARTED), jobId: "unified-1" });
    for (const stage of ["collecting", "verdict"] as const) {
      const status = publicSelfCheckStatus(row, null, { kind: "running", stage, progress: 0.5 });
      const view = waitingView(run({ stage, stageLabel: status.run!.stageLabel }), Date.parse(STARTED));
      expect(view.currentLabel).toBe(status.run!.stageLabel);
      expect(view.stages.find((s) => s.state === "current")?.label).toBe(status.run!.stageLabel);
    }
  });

  it("JSON проекции статуса подходит под типы экрана — форма ответа описана один раз", () => {
    const row = selfCheckRow({ status: "RUNNING", runStartedAt: new Date(STARTED), jobId: "unified-1" });
    const dto = publicSelfCheckStatus(row, null, { kind: "running", stage: "verdict", progress: 0.5 });
    // Проверка типов: разойдись проекция сервера с типами экрана, `npm run
    // typecheck` не соберёт эту строку.
    const json: PublicStatusJson = jsonify(dto);
    expect(json.run?.stage).toBe("verdict");
  });

  it("у проекции статуса своей таблицы подписей нет, а общая собирается в браузере", () => {
    const dto = read("src/modules/self-check/public-dto.ts");
    expect(dto).toMatch(/from "\.\/run-stages"/u);
    expect(dto).not.toMatch(/RUN_STAGE_LABELS = \{/u);
    expect(read("src/modules/self-check/run-stages.ts")).not.toMatch(/\bimport\b/u);
  });
});

describe("экран ожидания", () => {
  it("сбор идёт — первая стадия текущая, вторая ожидает", () => {
    const view = waitingView(run({}), Date.parse("2026-09-15T10:01:23.000Z"));
    expect(view.elapsedText).toBe("1:23");
    expect(view.percent).toBe(20);
    expect(view.currentLabel).toBe(RUN_STAGE_LABELS.collecting);
    expect(view.stages.map((s) => [s.key, s.state, s.stateWord])).toEqual([
      ["collecting", "current", "идёт"],
      ["verdict", "pending", "ожидает"],
    ]);
    expect(view.stages.every((s) => s.tags.length > 0)).toBe(true);
  });

  it("вердикт идёт — сбор готов", () => {
    const view = waitingView(run({ stage: "verdict", progress: 0.5 }), Date.parse(STARTED));
    expect(view.percent).toBe(50);
    expect(view.stages.map((s) => [s.state, s.stateWord])).toEqual([
      ["done", "готово"],
      ["current", "идёт"],
    ]);
  });

  it("проценты в пределах 0–100, время запуска неизвестно — «0:00»", () => {
    expect(waitingView(run({ progress: 1.2 }), 0).percent).toBe(100);
    expect(waitingView(run({ progress: -1 }), 0).percent).toBe(0);
    expect(waitingView(run({ startedAt: null }), Date.parse(STARTED)).elapsedText).toBe("0:00");
  });

  it("прошедшее время — минуты и секунды", () => {
    expect(formatElapsed(59_999)).toBe("0:59");
    expect(formatElapsed(3_723_000)).toBe("62:03");
    expect(formatElapsed(-5_000)).toBe("0:00");
  });
});
