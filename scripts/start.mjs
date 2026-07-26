/**
 * Точка входа контейнера.
 *
 * ## Что было не так
 *
 * Контейнер запускался цепочкой `npm run start:railway` → `tsx` → `npx next
 * start`. Замер: после SIGTERM в `npm run` внуки остаются живы — npm сигнал
 * вниз не передаёт. При деплое Railway просит контейнер остановиться, PID 1
 * умирает, сервер Next сигнала не получает вовсе: ни дренажа соединений, ни
 * штатного выхода. Контейнер добивается по таймауту, и это записывается как
 * Crashed — на **каждом** деплое.
 *
 * Вдобавок тот же скрипт до старта сервера синхронно гонял проверку готовности
 * БД Arsenkin (порт в это время не слушался, а healthcheck уже опрашивали) и
 * заводил два `setInterval` по пять секунд с возобновлением прогонов — работу
 * двигали одновременно они и воркер шагов из шага 12.
 *
 * ## Что здесь
 *
 * Обычный Node-процесс без `npm` и `npx` в цепочке: он сам PID 1, сам получает
 * сигнал и передаёт его детям, дожидается их выхода и выходит с их кодом.
 * Возобновление прогонов переехало к воркеру (`workflow/deploy-resume.ts`),
 * проверка готовности БД — за старт сервера, чтобы никогда не задерживать
 * healthcheck.
 *
 * Запуск: `node scripts/start.mjs`
 */

import { spawn } from "node:child_process";
import { once } from "node:events";

const PORT = process.env.PORT ?? "3000";
/** Сколько ждать штатного выхода детей, прежде чем добить. */
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS ?? 15_000);
const WORKER_INLINE = String(process.env.WORKFLOW_WORKER_INLINE ?? "").toLowerCase() === "true";

/** @type {{name: string, child: import("node:child_process").ChildProcess}[]} */
const children = [];
let shuttingDown = false;

/**
 * @param {string} name
 * @param {string[]} args аргументы node
 * @param {{essential?: boolean}} [opts] essential=false — выход не роняет контейнер
 */
function start(name, args, opts = {}) {
  const essential = opts.essential ?? true;
  const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
  child.on("error", (err) => {
    console.error(`[start] не удалось запустить ${name}:`, err.message);
    if (essential) void shutdown(1);
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (!essential) {
      console.error(`[start] ${name} завершился (код ${code})`);
      return;
    }
    // Один из основных процессов упал — контейнер уходит целиком, а не остаётся
    // наполовину живым: половина без второй половины отчёт не соберёт.
    console.error(`[start] ${name} завершился (код ${code}, сигнал ${signal ?? "нет"})`);
    void shutdown(signal ? 1 : (code ?? 0));
  });
  children.push({ name, child });
  return child;
}

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { name, child } of children) {
    if (child.exitCode === null && child.signalCode === null) {
      console.error(`[start] останавливаю ${name}`);
      child.kill("SIGTERM");
    }
  }
  const waits = children.map(({ child }) =>
    child.exitCode === null && child.signalCode === null ? once(child, "exit") : Promise.resolve()
  );
  const timer = setTimeout(() => {
    for (const { name, child } of children) {
      if (child.exitCode === null && child.signalCode === null) {
        console.error(`[start] ${name} не завершился за ${SHUTDOWN_GRACE_MS} мс — добиваю`);
        child.kill("SIGKILL");
      }
    }
  }, SHUTDOWN_GRACE_MS);
  timer.unref?.();
  await Promise.all(waits);
  clearTimeout(timer);
  process.exit(code);
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.error(`[start] ${signal} — останавливаю процессы`);
    // 0, а не 143: остановку попросили снаружи, и это штатный выход, а не сбой.
    void shutdown(0);
  });
}

const TSX = "node_modules/tsx/dist/cli.mjs";

// Сервер поднимается первым и без предварительной работы: healthcheck отвечает
// сразу, а не после проверок, до которых ему дела нет.
start("next", ["node_modules/next/dist/bin/next", "start", "-p", PORT]);

if (WORKER_INLINE) {
  // Пока артефакты лежат на томе, отдельный сервис-воркер отдать отчёт не может:
  // том Railway монтируется к одному сервису. До переезда артефактов в общее
  // хранилище воркер живёт здесь же — но отдельным процессом, которому сигнал
  // доходит.
  console.error("[start] встроенный воркер: шаги исполняет отдельный процесс в этом контейнере");
  start("worker", [TSX, "scripts/worker.ts"]);
}

// Проверка готовности БД Arsenkin — рядом со стартом, а не до него, и её исход
// контейнер не роняет: она про допуск к платным вызовам, а не про способность
// отвечать на HTTP. Гейт всё равно fail-closed на стороне самих вызовов.
if (process.env.ARSENKIN_DB_INTEGRATION_REQUIRED === "1") {
  start("arsenkin-readiness", [TSX, "scripts/generate-arsenkin-db-readiness.ts"], {
    essential: false,
  });
}
