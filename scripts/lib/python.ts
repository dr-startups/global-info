/**
 * Поиск интерпретатора Python — один ответ на весь репозиторий.
 *
 * `python` есть не везде: в образах и на машинах разработчиков часто стоит
 * только `python3`. Жёстко зашитое имя роняло проверку по причине, не имеющей
 * отношения к тому, что она проверяет.
 *
 * Дефект чинился уже трижды и каждый раз отдельно: в смоке контракта текста, в
 * смоке сборки деки и в пересборке эталона report-72, где `python` был зашит в
 * пяти вызовах. Это ровно тот случай, который в `docs/ENGINEERING.md` записан
 * как «один вопрос — один ответ»: пока ответов несколько, они расходятся.
 *
 * Порядок кандидатов: `$PYTHON` (явное указание сильнее догадки), затем
 * `python3`, затем `python`. Кандидат проверяется запуском `--version`, а не
 * наличием файла: на PATH встречается обёртка, которая существует, но не
 * работает.
 */

import { spawnSync } from "node:child_process";

let cached: string | null | undefined;

/** Возвращает найденный интерпретатор либо `null`, если его нет. */
export function findPythonInterpreter(): string | null {
  if (cached !== undefined) return cached;
  for (const candidate of [process.env.PYTHON, "python3", "python"]) {
    if (!candidate) continue;
    try {
      if (spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0) {
        cached = candidate;
        return cached;
      }
    } catch {
      // Кандидат не запустился — пробуем следующий.
    }
  }
  cached = null;
  return cached;
}

/**
 * То же, но для вызывающих, которым без Python работать нечем: отсутствие
 * интерпретатора должно быть внятной ошибкой, а не падением `spawnSync ENOENT`
 * где-то ниже по стеку.
 */
export function pythonInterpreter(): string {
  const found = findPythonInterpreter();
  if (!found) {
    throw new Error("интерпретатор Python не найден (проверены $PYTHON, python3, python)");
  }
  return found;
}

/** Только для тестов: сбросить запомненный результат. */
export function resetPythonInterpreterCache(): void {
  cached = undefined;
}
