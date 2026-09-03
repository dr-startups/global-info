/**
 * Topvisor «из фикстур»: тот же вызов, что и живой, но ответы — сырые ответы
 * пилота T0 с диска.
 *
 * **Это дубль для тестов и офлайн-смоков, не рабочий путь.** Лежит он рядом с
 * фикстурами, которые читает, и внутри `src` по одной причине: смоки живут в
 * `scripts/` и едут в образ, а `tests/` в образ намеренно не едет
 * (`.dockerignore`), и импорт оттуда ломает сборку на Railway, оставаясь
 * зелёным локально. Прибор на это — `scripts-do-not-import-tests.test.ts`.
 *
 * Случайное подключение к рабочему пути безвредно: настоящий клиент при
 * `NETWORK_CALLS=0` в сеть не идёт, а этот дубль на незнакомый запрос отвечает
 * ошибкой `fixture missing`, а не молчанием. Маршрутизация по действию, службе и нагрузке — ровно по
 * тем признакам, по которым различаются настоящие запросы. Незнакомый запрос
 * не молчит: отвечает ошибкой `fixture missing`, и тест краснеет там, где путь
 * пошёл не туда.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  TopvisorCallFn,
  TopvisorCallInput,
  TopvisorCallResult,
} from "@/modules/digital-profile/providers/topvisor/client";

const DIR = join(process.cwd(), "src/modules/digital-profile/providers/topvisor/fixtures");

export function loadTopvisorFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as T;
}

export type FixtureCallLogEntry = {
  action: string;
  service: string;
  method?: string;
  payload?: Record<string, unknown>;
};

export type FixtureCallOptions = {
  /** Проект `orion-<caseId>` уже есть в кабинете. */
  projectExists?: boolean;
  /** Сколько опросов статуса вернут «идёт», прежде чем придёт 100 %. */
  checkPollsUntilDone?: number;
  /** Настройки проекта после записи читаются целиком (иначе одной не хватает). */
  settingsApplied?: boolean;
  /** Запуск проверки отвечает ошибкой сервиса. */
  failCheckerGo?: boolean;
  /** Запуск подбора подсказок отвечает ошибкой сервиса. */
  failCollectGo?: boolean;
  /** Группа подбора уже есть в проекте (возобновление после обрыва). */
  collectGroupExists?: boolean;
  /** Группа подбора пришла включённой — её надо выключить, иначе она попадёт в проверку. */
  collectGroupOn?: boolean;
  /** Сколько чтений групп подбор ещё «идёт» (status 1), прежде чем завершиться. */
  collectPollsUntilDone?: number;
};

function ok<T>(body: T): TopvisorCallResult<T> {
  return { ok: true, httpStatus: 200, body, errors: [] };
}

function fail<T>(message: string): TopvisorCallResult<T> {
  return {
    ok: false,
    httpStatus: 200,
    body: { result: null, errors: [{ code: 1003, string: message }] } as T,
    errors: [message],
  };
}

export function createTopvisorFixtureCall(options: FixtureCallOptions = {}): {
  call: TopvisorCallFn;
  log: FixtureCallLogEntry[];
} {
  const log: FixtureCallLogEntry[] = [];
  const untilDone = options.checkPollsUntilDone ?? 1;
  let statusPolls = 0;
  // Группа подбора появляется в проекте после платного вызова — как в жизни,
  // и какое-то время значится незавершённой (`status: 1`).
  let collectStarted = false;
  let groupReads = 0;
  const collectUntilDone = options.collectPollsUntilDone ?? 1;

  const route = (input: TopvisorCallInput): TopvisorCallResult<unknown> => {
    // Ключ маршрута — тот же путь, что уходит в сервис: действие/служба/метод.
    const key = [input.action, input.service, input.method].filter(Boolean).join("/");
    const payload = (input.payload ?? {}) as Record<string, unknown>;
    const fields = Array.isArray(payload.fields) ? (payload.fields as string[]) : [];

    if (key === "get/projects_2/projects") {
      if (fields.includes("status_positions")) {
        statusPolls += 1;
        return ok(loadTopvisorFixture(statusPolls > untilDone ? "check-status-10" : "check-status-00"));
      }
      if (payload.show_searchers_and_regions) return ok(loadTopvisorFixture("probe-project-regions-indexes"));
      if (fields.includes("do_snapshots")) {
        const body = loadTopvisorFixture<{ result: Array<Record<string, unknown>> }>("read-settings");
        if (options.settingsApplied === false) delete body.result[0]!.with_ai_overview_full;
        return ok(body);
      }
      if (Array.isArray(payload.filters)) {
        return ok(loadTopvisorFixture(options.projectExists ? "read-project-by-name" : "probe-projects"));
      }
      return fail(`fixture missing: ${key} ${JSON.stringify(payload)}`);
    }
    if (key === "add/projects_2/projects") return ok(loadTopvisorFixture("setup-project-add"));
    if (key === "add/positions_2/searchers") return ok(loadTopvisorFixture("setup-searcher-0"));
    if (key === "add/positions_2/searchers/regions") return ok(loadTopvisorFixture("setup-region-google-moscow"));
    if (key === "edit/positions_2/settings") return ok(loadTopvisorFixture("setup-settings-correct"));
    if (key === "get/keywords_2/groups") {
      const body = loadTopvisorFixture<{ result: Array<Record<string, unknown>> }>("read-groups-now");
      const rows = body.result.filter((g) => !String(g.name ?? "").startsWith("DI ("));
      const di = body.result.filter((g) => String(g.name ?? "").startsWith("DI ("));
      for (const g of di) g.on = options.collectGroupOn ? 1 : 0;
      const hidden = options.collectGroupExists === false && !collectStarted;
      if (!hidden) {
        groupReads += 1;
        for (const g of di) g.status = groupReads > collectUntilDone ? 0 : 1;
      }
      return ok({ ...body, result: hidden ? rows : [...rows, ...di] });
    }
    if (key === "add/keywords_2/groups") return ok(loadTopvisorFixture("setup-group-add-UAE"));
    if (key === "get/keywords_2/keywords") {
      // Чтение группы подбора отличается фильтром по ней: набор позиций и
      // собранные подсказки живут в одном списке фраз проекта.
      const byGroup = Array.isArray(payload.filters)
        ? (payload.filters as Array<{ name?: unknown }>).some((f) => String(f?.name ?? "") === "group_id")
        : false;
      return ok(loadTopvisorFixture(byGroup ? "read-suggest-group" : "setup-keywords-after"));
    }
    if (key === "edit/keywords_2/collect/go") {
      collectStarted = true;
      return options.failCollectGo
        ? fail("Ошибка сервиса при запуске подбора")
        : ok(loadTopvisorFixture("probe-collect-go"));
    }
    if (key === "edit/keywords_2/groups/on") return ok({ result: 1 });
    if (key === "add/keywords_2/keywords") return ok(loadTopvisorFixture("setup-keyword-RU-1"));
    if (key === "edit/positions_2/checker/go") {
      return options.failCheckerGo ? fail("Ошибка сервиса при запуске проверки") : ok(loadTopvisorFixture("check-go"));
    }
    if (key === "get/positions_2/history") return ok(loadTopvisorFixture("read-positions-correct"));
    if (key === "get/snapshots_2/history") {
      const searcher = Number(payload.searcher_key);
      const region = Number(payload.region_key);
      if (searcher === 0 && region === 213) return ok(loadTopvisorFixture("read-snapshot-yandex-moscow"));
      if (searcher === 1 && region === 213) return ok(loadTopvisorFixture("read-snapshot-google-moscow"));
      if (searcher === 1 && region === 11499) return ok(loadTopvisorFixture("read-snapshot-google-dubai"));
    }
    return fail(`fixture missing: ${key} ${JSON.stringify(payload)}`);
  };

  const call = (async (input: TopvisorCallInput) => {
    log.push({ action: input.action, service: input.service, method: input.method, payload: input.payload });
    return route(input);
  }) as TopvisorCallFn;

  return { call, log };
}

/** Фразы пилота — те же, что лежат в проекте фикстур, в нашем написании. */
export const PILOT_KEYWORDS = {
  ru: [
    "Кремлёв Умар Назарович",
    "Умар Кремлёв",
    "Кремлёв Умар Назарович биография",
    "Кремлёв Умар Назарович компании",
    "Кремлёв Умар Назарович расследование",
    "Кремлёв Умар Назарович суд",
    "Кремлёв федерация бокса",
    "Умар Кремлёв IBA",
  ],
  uae: ["Umar Kremlev", "Umar Kremlev IBA", "Umar Kremlev investigation", "Umar Kremlev boxing"],
};
