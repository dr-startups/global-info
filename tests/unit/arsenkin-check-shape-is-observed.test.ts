/**
 * Форма ответа Arsenkin `/check` — по наблюдению, а не по догадке.
 *
 * Документация тел ответа не приводит. Живой прогон 20.08 отдал
 * `arsenkin_check_shape_unknown` с телом
 * `{"code":"TASK_STATUS","status":"finish","progress":100,"msg":"Статус состояния задачи!"}`
 * — это первое, что о форме известно достоверно.
 *
 * Слово `finish` не знал ни список узнаваемых форм, ни отображение состояния:
 * готовность распознавалась окольно, через `progress >= 100`. Ответ выходил
 * верным, но вторым путём — пропади `progress` из тела, и завершённая задача
 * читалась бы как «ещё считается» до конца бюджета ожидания (пункт CE).
 *
 * Форма отказа не наблюдалась ни разу и здесь не выдумывается: неизвестное
 * тело по-прежнему читается как `RUNNING` — осознанный запасной вариант,
 * ограниченный временем шага, а не числом попыток, — и видно в логе.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArsenkinClient, isRecognizedCheckShape } from "@/modules/digital-profile/providers/arsenkin/client";

/** Наблюдено на живом прогоне 20.08: задача завершена. */
const OBSERVED_FINISH = {
  code: "TASK_STATUS",
  status: "finish",
  progress: 100,
  msg: "Статус состояния задачи!",
};
/** Наблюдено там же: результат уже в ответе. */
const OBSERVED_RESULT = { code: "TASK_RESULT", task_id: "31048135", result: { top: [] } };
/** Наблюдено ранее: задача считается. */
const OBSERVED_PROCESS = {
  code: "TASK_STATUS",
  status: "process",
  progress: 5,
  msg: "Статус состояния задачи!",
};

function clientReturning(body: unknown): ArsenkinClient {
  return new ArsenkinClient({
    token: "test-token",
    skipLiveAuthorizationCheck: true,
    fetchImpl: (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  });
}

const infoCalls: unknown[][] = [];
let restoreInfo: (() => void) | undefined;

beforeEach(() => {
  infoCalls.length = 0;
  const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    infoCalls.push(args);
  });
  restoreInfo = () => spy.mockRestore();
});
afterEach(() => {
  restoreInfo?.();
});

function unknownShapeLogs(): string[] {
  return infoCalls
    .map((call) => String(call[0] ?? ""))
    .filter((line) => line.includes("arsenkin_check_shape_unknown"));
}

describe("наблюдённые формы ответа /check", () => {
  it("«finish» читается как готовность", async () => {
    const res = await clientReturning(OBSERVED_FINISH).checkTask("31048135");
    expect(res.state).toBe("DONE");
    expect(unknownShapeLogs()).toHaveLength(0);
  });

  it("«finish» читается как готовность и без поля progress", async () => {
    // Ради этого шаг и делается: пока готовность держалась на `progress >= 100`,
    // тело без него читалось бы как «ещё считается».
    const { progress: _drop, ...noProgress } = OBSERVED_FINISH;
    const res = await clientReturning(noProgress).checkTask("31048135");
    expect(res.state).toBe("DONE");
    expect(unknownShapeLogs()).toHaveLength(0);
  });

  it("TASK_RESULT — тоже готовность и тоже узнаваемая форма", async () => {
    const res = await clientReturning(OBSERVED_RESULT).checkTask("31048135");
    expect(res.state).toBe("DONE");
    expect(unknownShapeLogs()).toHaveLength(0);
  });

  it("«process» остаётся работой и сторожа не будит", async () => {
    const res = await clientReturning(OBSERVED_PROCESS).checkTask("31048130");
    expect(res.state).toBe("RUNNING");
    expect(unknownShapeLogs()).toHaveLength(0);
  });

  it("тело только с кодом TASK_STATUS узнаётся по коду", () => {
    expect(isRecognizedCheckShape({ code: "TASK_STATUS" })).toBe(true);
  });

  it("незнакомое тело по-прежнему объявляется незнакомым и ждёт", async () => {
    // Форма отказа не наблюдалась: выдумывать её нельзя, а видеть — нужно.
    const res = await clientReturning({ code: "SOMETHING_ELSE" }).checkTask("31048170");
    expect(res.state).toBe("RUNNING");
    expect(unknownShapeLogs()).toHaveLength(1);
  });
});

describe("фикстуры формы /check", () => {
  it("описывают наблюдённые тела, а не выдуманные", async () => {
    const { readFileSync } = await import("node:fs");
    const dir = "src/modules/digital-profile/providers/arsenkin/fixtures";
    const done = JSON.parse(readFileSync(`${dir}/check-done.json`, "utf8"));
    const pending = JSON.parse(readFileSync(`${dir}/check-pending.json`, "utf8"));
    expect(done).toEqual(OBSERVED_FINISH);
    expect(pending).toEqual(OBSERVED_PROCESS);
    for (const body of [done, pending]) {
      expect(isRecognizedCheckShape(body)).toBe(true);
    }
  });
});
