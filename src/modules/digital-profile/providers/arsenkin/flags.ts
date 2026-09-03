/**
 * Feature flags for ARSENKIN TOOLS integration (First36 pilot).
 * Token must never appear in logs/report — only via env.
 */

import { boolSetting } from "../../config/defaults";
import { serpCollectionMode } from "../config";

export type ArsenkinToolName =
  | "check-top"
  | "suggest"
  | "paa"
  | "ai-serp"
  | "check-h"
  | "indexation";

/**
 * По умолчанию — только первая стадия (ADR-0005).
 *
 * Вторая стадия — `ai-serp`, `check-h`, `indexation` — в эталонном прогоне не
 * дала ни одного наблюдения: все 15 ячеек покрытия по ним вернулись со
 * статусом NO_RESULTS, включая все три AI-ответа, ради которых её и терпели
 * (`baselines/report-72/artifacts/analytics/composite-serp-provenance.json`).
 * При этом она удлиняет прогон на отдельную волну опросов: предел аккаунта —
 * пять задач одновременно и 30 запросов в минуту на всё вместе, а инструменты
 * идут минутами.
 *
 * Отключение по умолчанию, а не удаление: состав по-прежнему задаётся
 * переменной `ARSENKIN_TOOLS`, и вернуть стадию можно, ничего не пересобирая.
 * Решение по первой стадии ADR-0005 откладывает до замера на 5–10 субъектах —
 * она остаётся единственным источником органической выдачи.
 */
const DEFAULT_TOOLS: ArsenkinToolName[] = ["check-top", "suggest", "paa"];

/** Полный состав — для замеров «до/после» и для явного включения второй стадии. */
export const ALL_ARSENKIN_TOOLS: ArsenkinToolName[] = [
  "check-top",
  "suggest",
  "paa",
  "ai-serp",
  "check-h",
  "indexation",
];

function parseTools(raw: string | undefined): ArsenkinToolName[] {
  const parts = String(raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return [...DEFAULT_TOOLS];
  const allowed = new Set<ArsenkinToolName>([
    "check-top",
    "suggest",
    "paa",
    "ai-serp",
    "check-h",
    "indexation",
  ]);
  const out: ArsenkinToolName[] = [];
  for (const p of parts) {
    if (allowed.has(p as ArsenkinToolName)) out.push(p as ArsenkinToolName);
  }
  return out.length > 0 ? out : [...DEFAULT_TOOLS];
}

/**
 * Обогащение Arsenkin включено по умолчанию.
 *
 * Разрешением служит токен, а не флаг: без `ARSENKIN_API_TOKEN` клиент не
 * создаётся и ни одного платного вызова не происходит. Держать флаг
 * выключенным значило требовать переменную, без которой отчёт теряет пять
 * поверхностей.
 */
export function isArsenkinEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return boolSetting("ARSENKIN_ENABLED", env);
}

/** Acceptance/CEO renders must fail rather than silently omit requested Arsenkin surfaces. */
export function isArsenkinRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARSENKIN_REQUIRED === "1" || env.ARSENKIN_REQUIRED === "true";
}

/**
 * Состав инструментов Arsenkin.
 *
 * В режиме `topvisor` позиции и подсказки собирает Topvisor, и Arsenkin
 * остаётся ради единственной поверхности, которой у Topvisor нет, — «люди
 * также спрашивают». Два источника одного и того же означали бы два ответа на
 * один вопрос и двойную оплату. Явный `ARSENKIN_TOOLS` сильнее режима: это
 * рычаг на один прогон, и молча отменять его нельзя.
 */
export function arsenkinTools(env: NodeJS.ProcessEnv = process.env): ArsenkinToolName[] {
  const explicit = String(env.ARSENKIN_TOOLS ?? "").trim();
  if (!explicit && serpCollectionMode(env) === "topvisor") return ["paa"];
  return parseTools(env.ARSENKIN_TOOLS);
}

export function isArsenkinToolEnabled(
  tool: ArsenkinToolName,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return isArsenkinEnabled(env) && arsenkinTools(env).includes(tool);
}

export function arsenkinApiToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = String(env.ARSENKIN_API_TOKEN ?? "").trim();
  return t || null;
}

export function isArsenkinConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return isArsenkinEnabled(env) && Boolean(arsenkinApiToken(env));
}

// Пределы аккаунта — одновременные обращения и запросы в минуту — заданы в
// `account-rate-limit.ts`: там они общие на все процессы, а не на экземпляр
// клиента. Здесь стояли их вторые копии, с другим значением по умолчанию
// (3 против 2), и не вызывались ниоткуда.
