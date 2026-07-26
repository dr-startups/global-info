import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

/**
 * Вход в контейнер: остановка обязана быть штатной.
 *
 * Контейнер запускался цепочкой `npm run start:railway` → `tsx` → `npx next
 * start`. Замер показал, что после SIGTERM в `npm run` внуки остаются живы:
 * npm сигнал вниз не передаёт. При деплое Railway просил контейнер
 * остановиться, PID 1 умирал, сервер Next сигнала не получал вовсе, контейнер
 * добивался по таймауту — и это записывалось как Crashed на **каждом** деплое.
 *
 * Здесь проверяется само свойство, а не его отсутствие в конфиге: процесс
 * поднимается, слушает порт, получает SIGTERM и уходит с нулём, никого за собой
 * не оставив.
 */

const ROOT = process.cwd();
const PORT = 3971;

const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(400, () => done(false));
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("вход в контейнер", () => {
  it("в цепочке запуска нет npm и npx", () => {
    // Причина дефекта была именно здесь: обёртки не передают сигнал.
    const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
    const cmd = dockerfile.match(/^CMD\s+(\[.*\])/mu)?.[1] ?? "";
    expect(cmd).toBe('["node", "scripts/start.mjs"]');
    expect(dockerfile).toMatch(/^STOPSIGNAL SIGTERM$/mu);

    const start = readFileSync(join(ROOT, "scripts/start.mjs"), "utf8");
    expect(start).not.toMatch(/spawn\(\s*["'](?:npm|npx)["']/u);
    // Дети запускаются тем же интерпретатором, а не через оболочку.
    expect(start).toMatch(/spawn\(process\.execPath/u);
  });

  it("сигнал доходит до детей и они дожидаются выхода", () => {
    const start = readFileSync(join(ROOT, "scripts/start.mjs"), "utf8");
    for (const signal of ["SIGTERM", "SIGINT"]) {
      expect(start).toContain(signal);
    }
    expect(start).toMatch(/child\.kill\("SIGTERM"\)/u);
    expect(start).toMatch(/once\(child, "exit"\)/u);
    // Просьба остановиться — не сбой: код выхода 0, иначе Railway снова
    // запишет Crashed.
    expect(start).toMatch(/void shutdown\(0\)/u);
  });

  it(
    "поднимается, слушает порт и уходит по SIGTERM с нулём",
    { timeout: 90_000, skip: !existsSync(join(ROOT, ".next")) },
    async () => {
      const child = spawn(process.execPath, ["scripts/start.mjs"], {
        cwd: ROOT,
        env: {
          ...process.env,
          PORT: String(PORT),
          WORKFLOW_WORKER_INLINE: "false",
          ARSENKIN_DB_INTEGRATION_REQUIRED: "",
        },
        stdio: "ignore",
      });
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
        child.once("exit", (code, signal) => resolve({ code, signal }))
      );

      let listening = false;
      for (let i = 0; i < 100 && !listening; i += 1) {
        listening = await portOpen(PORT);
        if (!listening) await sleep(300);
      }
      expect(listening, "сервер должен слушать порт").toBe(true);

      child.kill("SIGTERM");
      const result = await Promise.race([
        exited,
        sleep(25_000).then(() => ({ code: "таймаут" as never, signal: null })),
      ]);
      // Ключевое: штатный выход, а не смерть по сигналу и не таймаут.
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      expect(await portOpen(PORT), "порт должен освободиться").toBe(false);
    }
  );
});
