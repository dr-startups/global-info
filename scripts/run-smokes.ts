/**
 * Прогон смоков одной командой, с общей картиной вместо первого падения.
 *
 * Раньше смоки шли цепочкой `&&` в package.json. У такой цепочки три свойства,
 * из-за которых она плохо работает как приёмочный контур:
 *
 * - она останавливается на первом падении, и об остальных семи проверках
 *   узнаёшь по одной за прогон;
 * - каждый смок печатает свои пропуски сам, общей картины нет — а пропуск,
 *   которого никто не видит, ничем не отличается от невыполненной проверки;
 * - «ноль выполненных проверок» выглядит как успех: процесс завершился нулём,
 *   значит зелено.
 *
 * Раннер закрывает все три. Он выполняет **все** смоки уровня, считает провалом
 * не только ненулевой код возврата, но и отменённые подтесты и прогон, в котором
 * не выполнилось ни одной проверки, и печатает сводку пропусков.
 *
 * Уровни:
 *   offline — обязаны проходить на чистой машине: без сети, без базы, без
 *             рендерера. Это то, что гоняет CI и что должно быть зелёным всегда.
 *   full    — дополнительно требуют поднятых зависимостей (Python-пакеты
 *             рендерера, Postgres). Гоняются там, где эти зависимости есть.
 *
 * Запуск:
 *   tsx scripts/run-smokes.ts --tier offline
 *   tsx scripts/run-smokes.ts --tier full
 */

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { findPythonInterpreter } from "./lib/python";

type Tier = "offline" | "full";

type Smoke = {
  name: string;
  /** Команда и аргументы. `PYTHON` подставляется найденным интерпретатором. */
  argv: string[];
  tier: Tier;
  /** Чем занят смок — печатается в сводке, чтобы список читался без кода. */
  about: string;
};

/** Один прогон не должен висеть вечно: CI-таймаут не объясняет, кто именно встал. */
const SMOKE_TIMEOUT_MS = 10 * 60 * 1000;

const SMOKES: Smoke[] = [
  {
    name: "report-quality-summary",
    argv: ["tsx", "--test", "scripts/smoke-report-quality-summary.ts"],
    tier: "offline",
    about: "сводка качества отчёта",
  },
  {
    name: "golden-case",
    argv: ["tsx", "--test", "scripts/smoke-golden-case-report.ts"],
    tier: "offline",
    about: "золотой кейс: детерминизм и эталон",
  },
  {
    name: "unified-orion-collection",
    argv: ["tsx", "--test", "scripts/smoke-unified-orion-collection.ts"],
    tier: "offline",
    about: "оркестрация unified-сбора",
  },
  {
    name: "gpt-call-queue",
    argv: ["tsx", "--test", "scripts/smoke-gpt-call-queue.ts"],
    tier: "offline",
    about: "очередь вызовов модели",
  },
  {
    name: "render-http-retry",
    argv: ["tsx", "--test", "scripts/smoke-render-http-retry.ts"],
    tier: "offline",
    about: "повторы обращений к рендереру",
  },
  {
    name: "client-text-contract",
    argv: ["tsx", "--test", "scripts/smoke-client-text-contract.ts"],
    tier: "offline",
    about: "контракт клиентского текста (TS ↔ Python)",
  },
  {
    name: "orion-deck-sections",
    argv: ["tsx", "--test", "scripts/smoke-orion-deck-sections.ts"],
    tier: "offline",
    about: "сборка деки по независимым секциям",
  },
  {
    name: "orion-golden-render-imports",
    argv: ["PYTHON", "scripts/smoke-orion-golden-render-imports.py"],
    tier: "offline",
    about: "импорты пакета рендерера",
  },
  {
    name: "renderer-text",
    argv: ["PYTHON", "renderer/smoke_text_measurement.py"],
    tier: "full",
    about: "замер текста рендерером (нужны Python-пакеты)",
  },
  {
    name: "search-table-layout",
    argv: ["PYTHON", "renderer/smoke_search_table_layout.py"],
    tier: "full",
    about: "ширины колонок и высоты строк клиентских таблиц (нужны Python-пакеты)",
  },
  {
    name: "risk-matrix-cards",
    argv: ["PYTHON", "renderer/smoke_risk_matrix_cards.py"],
    tier: "full",
    about: "карточки матрицы рисков: нарисовано всё, потеря слышна (нужны Python-пакеты)",
  },
  {
    name: "bullet-clip",
    argv: ["PYTHON", "renderer/smoke_bullet_clip_keeps_head.py"],
    tier: "full",
    about:
      "рендерер не печатает пустоту: ножницы буллета, телеметрия потери, карточки страницы проверки (нужны Python-пакеты)",
  },
  {
    name: "reading-lines-on-page",
    argv: ["PYTHON", "renderer/smoke_reading_lines_reach_the_page.py"],
    tier: "full",
    about: "слова о чтении на листе: покрытие над таблицей тем и доля на странице региона (нужны Python-пакеты)",
  },
  {
    name: "deck-raster-layout",
    argv: ["PYTHON", "renderer/smoke_deck_raster_layout.py"],
    tier: "full",
    about: "вёрстка по растру: второе мнение о странице (нужны отрендеренные страницы)",
  },
];

type Verdict = "PASS" | "FAIL" | "SKIP";

export type SmokeCounters = {
  tests?: number;
  pass?: number;
  fail?: number;
  cancelled?: number;
  skipped?: number;
};

type Result = {
  smoke: Smoke;
  verdict: Verdict;
  reason: string;
  counters: SmokeCounters;
  skips: string[];
  output: string;
  durationMs: number;
};

function tapCounter(output: string, key: string): number | undefined {
  const m = output.match(new RegExp(`^# ${key} (\\d+)$`, "mu"));
  return m ? Number(m[1]) : undefined;
}

export function parseCounters(output: string): SmokeCounters {
  return {
    tests: tapCounter(output, "tests"),
    pass: tapCounter(output, "pass"),
    fail: tapCounter(output, "fail"),
    cancelled: tapCounter(output, "cancelled"),
    skipped: tapCounter(output, "skipped"),
  };
}

/**
 * Решение об исходе смока — отдельно от запуска процесса, чтобы правила гейта
 * можно было проверить тестом. Раннер сам стал приёмочным контуром: ошибка в
 * этих четырёх правилах красит в зелёный весь проект.
 */
export function decideVerdict(input: {
  status: number | null;
  timedOut?: boolean;
  spawnError?: string;
  counters: SmokeCounters;
}): { verdict: "PASS" | "FAIL"; reason: string } {
  const { counters } = input;
  if (input.timedOut) {
    return { verdict: "FAIL", reason: `превышен таймаут ${SMOKE_TIMEOUT_MS / 1000}с` };
  }
  if (input.spawnError) {
    return { verdict: "FAIL", reason: `не удалось запустить: ${input.spawnError}` };
  }
  if (input.status !== 0) {
    return { verdict: "FAIL", reason: `код возврата ${input.status}` };
  }
  // Отменённый подтест — это невыполненная проверка. Node сообщает о ней
  // отдельным счётчиком и не всегда попадает в `fail`.
  if ((counters.cancelled ?? 0) > 0) {
    return { verdict: "FAIL", reason: `отменено проверок: ${counters.cancelled}` };
  }
  if ((counters.fail ?? 0) > 0) {
    return { verdict: "FAIL", reason: `провалено проверок: ${counters.fail}` };
  }
  // Пустой прогон не считается успехом: гейт не имеет права рапортовать
  // «зелено», не выполнив ни одной проверки.
  if (counters.tests !== undefined && (counters.pass ?? 0) === 0) {
    return { verdict: "FAIL", reason: "не выполнено ни одной проверки" };
  }
  return { verdict: "PASS", reason: "" };
}

/**
 * Пропуски собираются из двух источников.
 *
 * 1. Строка `# SKIP <что и почему>` — явное объявление смока. Только так можно
 *    передать причину: node в TAP печатает признак пропуска, но не причину.
 * 2. Штатный маркер node — `ok N - <имя> # SKIP`. Он есть всегда и не требует
 *    правок в смоках, поэтому пропуск не потеряется, даже если смок забыл
 *    объявить его явно.
 *
 * Объявленный пропуск вытесняет штатный маркер того же теста: иначе одна
 * невыполненная проверка считалась бы дважды.
 */
export function collectSkips(output: string): string[] {
  const declared: string[] = [];
  const tapNames: string[] = [];
  for (const line of output.split("\n")) {
    // Node пропускает посторонний stdout теста через TAP-комментарий и
    // экранирует ведущую решётку: `# SKIP …` приезжает как `# \# SKIP …`.
    // Поэтому необязательная приставка `\#` — часть признака, а не опечатка.
    const explicit = line.match(/^\s*#\s*(?:\\#\s*)?SKIP\s+(.*\S)\s*$/u);
    if (explicit) {
      declared.push(explicit[1]!);
      continue;
    }
    const tap = line.match(/^\s*ok\s+\d+\s+-\s+(.*\S)\s+#\s*SKIP\b\s*(.*)$/u);
    if (tap) {
      const name = tap[1]!;
      const reason = tap[2]?.trim();
      tapNames.push(reason ? `${name} — ${reason}` : name);
    }
  }
  const covered = (name: string): boolean =>
    declared.some((d) => d.includes(name.split(" — ")[0]!));
  return [...declared, ...tapNames.filter((n) => !covered(n))];
}

function runSmoke(smoke: Smoke, python: string | null): Result {
  const base = {
    smoke,
    counters: {},
    skips: [] as string[],
    output: "",
    durationMs: 0,
  };

  const argv = [...smoke.argv];
  if (argv[0] === "PYTHON") {
    if (!python) {
      return {
        ...base,
        verdict: "SKIP",
        reason: "интерпретатор Python не найден (PYTHON, python3, python)",
      };
    }
    argv[0] = python;
  }

  const started = Date.now();
  const proc = spawnSync(argv[0]!, argv.slice(1), {
    encoding: "utf8",
    timeout: SMOKE_TIMEOUT_MS,
    env: process.env,
    // tsx резолвится через npx-окружение npm-скрипта; PATH уже содержит .bin.
  });
  const durationMs = Date.now() - started;
  const output = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;

  const counters = parseCounters(output);
  const skips = collectSkips(output);
  const decision = decideVerdict({
    status: proc.status,
    timedOut: (proc.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    spawnError:
      proc.error && (proc.error as NodeJS.ErrnoException).code !== "ETIMEDOUT"
        ? proc.error.message
        : undefined,
    counters,
  });
  return { smoke, counters, skips, output, durationMs, ...decision };
}

function main(): void {
  const tierArg = process.argv.includes("--tier")
    ? process.argv[process.argv.indexOf("--tier") + 1]
    : "offline";
  if (tierArg !== "offline" && tierArg !== "full") {
    console.error(`Неизвестный уровень: ${tierArg}. Ожидается offline или full.`);
    process.exit(2);
  }
  const tier: Tier = tierArg;
  // full — это надмножество: смысл уровня в том, что он проверяет больше.
  const selected = SMOKES.filter((s) => (tier === "full" ? true : s.tier === "offline"));
  const python = findPythonInterpreter();

  console.log(`Смоки, уровень «${tier}»: ${selected.length}\n`);
  const results: Result[] = [];
  for (const smoke of selected) {
    process.stdout.write(`  ${smoke.name} … `);
    const result = runSmoke(smoke, python);
    results.push(result);
    const c = result.counters;
    const counts =
      c.tests !== undefined ? ` (${c.pass ?? 0}/${c.tests} за ${result.durationMs} мс)` : "";
    if (result.verdict === "PASS") console.log(`ок${counts}`);
    else if (result.verdict === "SKIP") console.log(`пропущен целиком — ${result.reason}`);
    else console.log(`ПРОВАЛ — ${result.reason}${counts}`);
  }

  const failed = results.filter((r) => r.verdict === "FAIL");
  for (const r of failed) {
    console.log(`\n${"─".repeat(72)}\nВывод смока ${r.smoke.name}:\n${"─".repeat(72)}`);
    console.log(r.output.trimEnd());
  }

  // Сводка пропусков. Пропуск — это «проверка не выполнялась», и он обязан быть
  // виден в конце прогона, а не только в середине чужого вывода.
  const skipped = results.flatMap((r) =>
    r.verdict === "SKIP"
      ? [`${r.smoke.name}: ${r.reason}`]
      : r.skips.map((s) => `${r.smoke.name}: ${s}`)
  );
  console.log(`\n${"═".repeat(72)}`);
  if (skipped.length === 0) {
    console.log("Пропущено проверок: нет");
  } else {
    console.log(`Пропущено проверок: ${skipped.length}`);
    for (const s of skipped) console.log(`  · ${s}`);
  }

  const totalPass = results.reduce((a, r) => a + (r.counters.pass ?? 0), 0);
  console.log(
    `Смоков: ${results.length} · пройдено ${results.filter((r) => r.verdict === "PASS").length} · ` +
      `провалено ${failed.length} · пропущено целиком ${results.filter((r) => r.verdict === "SKIP").length} · ` +
      `проверок пройдено ${totalPass}`
  );
  console.log("═".repeat(72));

  if (failed.length > 0) {
    console.error(`\nПровалено смоков: ${failed.map((r) => r.smoke.name).join(", ")}`);
    process.exit(1);
  }
}

// Запуск только при прямом вызове: правила исхода проверяются юнит-тестом,
// который импортирует этот файл, и запускать при импорте все смоки незачем.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
