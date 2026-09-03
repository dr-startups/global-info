/**
 * Пилот Topvisor (шаг 0052, T0) — снимает сырые ответы API в фикстуры.
 *
 * Зачем скрипт, а не разовые curl: фикстуры, на которых потом стоят офлайн-тесты
 * провайдера, обязаны быть **ответами настоящих вызовов**, снятыми тем же кодом,
 * каким пойдёт рабочий путь. На выдуманных из документации фикстурах проект уже
 * обжигался на Arsenkin.
 *
 * Платное отделено от бесплатного явно: шаги `check` и `tasks` тратят деньги и
 * требуют `--spend`. Без ключа скрипт печатает, чего не хватает, и выходит —
 * ничего не делая.
 *
 * Запуск (из корня репозитория):
 *   npx tsx scripts/topvisor-pilot.ts --step=probe
 *   npx tsx scripts/topvisor-pilot.ts --step=setup
 *   npx tsx scripts/topvisor-pilot.ts --step=check --spend
 *   npx tsx scripts/topvisor-pilot.ts --step=read
 *   npx tsx scripts/topvisor-pilot.ts --step=tasks --spend
 *   npx tsx scripts/topvisor-pilot.ts --step=read-tasks
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { topvisorCall, TopvisorNotConfiguredError } from "@/modules/digital-profile/providers/topvisor/client";
import { redactSecrets } from "@/modules/digital-profile/providers/topvisor/redact";
import { topvisorSecrets, serpCollectionMode } from "@/modules/digital-profile/providers/config";
import { projectRegionIndex } from "@/modules/digital-profile/providers/topvisor/regions";

const FIXTURES = join(
  process.cwd(),
  "src/modules/digital-profile/providers/topvisor/fixtures"
);
/** Состояние пилота между шагами: идентификаторы проекта и задач. */
const STATE = join(FIXTURES, "pilot-state.json");

type PilotState = {
  projectId?: number;
  regionIndexes?: Record<string, number>;
  taskIds?: Record<string, string | number>;
  startedAt?: string;
};

function loadState(): PilotState {
  if (!existsSync(STATE)) return {};
  return JSON.parse(readFileSync(STATE, "utf8")) as PilotState;
}

function saveState(next: PilotState): void {
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(STATE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const [, value] = hit.split("=");
  return value ?? "";
}

/** Сохранить сырой ответ фикстурой — уже без секретов. */
function saveFixture(name: string, body: unknown): string {
  mkdirSync(FIXTURES, { recursive: true });
  const secrets = topvisorSecrets();
  const path = join(FIXTURES, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(redactSecrets(body, secrets), null, 2)}\n`, "utf8");
  return path;
}

async function call(
  name: string,
  input: Parameters<typeof topvisorCall>[0]
): Promise<{ ok: boolean; body: unknown; errors: string[] }> {
  const started = Date.now();
  const res = await topvisorCall(input);
  const path = saveFixture(name, res.body);
  const ms = Date.now() - started;
  console.log(
    `${res.ok ? "OK  " : "ERR "} ${input.action}/${input.service}${input.method ? `/${input.method}` : ""} ` +
      `— ${ms} мс, HTTP ${res.httpStatus}${res.errors.length ? `, ошибки: ${res.errors.join("; ")}` : ""}`
  );
  console.log(`     фикстура: ${path}`);
  return { ok: res.ok, body: res.body, errors: res.errors };
}

/** Запросы пилота: субъект прогона 92, восемь российских и четыре латинских. */
const QUERIES_RU = [
  "Кремлёв Умар Назарович",
  "Умар Кремлёв",
  "Кремлёв Умар Назарович биография",
  "Кремлёв Умар Назарович компании",
  "Кремлёв Умар Назарович расследование",
  "Кремлёв Умар Назарович суд",
  "Кремлёв федерация бокса",
  "Умар Кремлёв IBA",
];
const QUERIES_UAE = [
  "Umar Kremlev",
  "Umar Kremlev IBA",
  "Umar Kremlev investigation",
  "Umar Kremlev boxing",
];

function requireSpend(step: string): void {
  if (arg("spend") === undefined) {
    console.error(
      `Шаг «${step}» тратит деньги аккаунта Topvisor. Запускать только с разрешения владельца ` +
        `на этот прогон и с флагом --spend.`
    );
    process.exit(2);
  }
}

async function stepProbe(): Promise<void> {
  // Бесплатное чтение: что уже есть в аккаунте и какие лимиты.
  await call("probe-projects", { action: "get", service: "projects_2", method: "projects" });
  await call("probe-limits", { action: "get", service: "bank_2", method: "info" });
}

async function stepRegions(): Promise<void> {
  // Справочник регионов: ключи Яндекса и Google не совпадают между собой и с
  // ключами других провайдеров — брать их можно только отсюда.
  // `search` — обязательный параметр справочника: сервис назвал его сам на
  // первом же вызове пилота. Ключи ПС: 0 — Яндекс, 1 — Google.
  await call("regions-yandex-moscow", {
    action: "get",
    service: "system_2",
    method: "common/regions",
    payload: { searcher_key: 0, search: "Москва" },
  });
  await call("regions-google-moscow", {
    action: "get",
    service: "system_2",
    method: "common/regions",
    payload: { searcher_key: 1, search: "Moscow" },
  });
  await call("regions-google-uae", {
    action: "get",
    service: "system_2",
    method: "common/regions",
    payload: { searcher_key: 1, search: "Dubai" },
  });
}

/**
 * Регионы пилота.
 *
 * Ключи взяты из справочника самого Topvisor (`--step=regions`), а не угаданы:
 * у Яндекса и Google они разные, и «Москва» в обоих — это `213`, тогда как
 * Дубай у Google — `11499`. Глубина: Google `region_depth: 2` — это ТОП-20,
 * ровно та глубина, которую обещает клиенту таблица выдачи; у Яндекса первая
 * ступень уже глубже двадцати.
 */
const PILOT_REGIONS = [
  { key: "yandex-moscow", searcher_key: 0, region_key: 213, region_lang: "ru", region_device: 0, region_depth: 1 },
  { key: "google-moscow", searcher_key: 1, region_key: 213, region_lang: "ru", region_device: 0, region_depth: 2 },
  { key: "google-dubai", searcher_key: 1, region_key: 11499, region_lang: "en", region_device: 0, region_depth: 2 },
] as const;

async function stepSetup(): Promise<void> {
  const state = loadState();
  let projectId = state.projectId;

  if (!projectId) {
    const name = `orion-pilot-${new Date().toISOString().slice(0, 10)}`;
    const created = await call("setup-project-add", {
      action: "add",
      service: "projects_2",
      method: "projects",
      payload: { url: "https://example.org/", name, on: 1 },
    });
    projectId = Number((created.body as { result?: unknown })?.result ?? 0) || undefined;
  }
  if (!projectId) {
    console.error("Идентификатор проекта не получен — дальше идти нельзя.");
    process.exit(1);
  }
  console.log(`     проект: ${projectId}`);

  // Папки различают контуры: российский набор и латинский проверяются в своих
  // регионах, и смешивать их в одном списке нельзя.
  const groups: Record<string, number> = {};
  const existing = await call("setup-groups-list", {
    action: "get",
    service: "keywords_2",
    method: "groups",
    payload: { project_id: projectId },
  });
  for (const row of ((existing.body as { result?: Array<{ id: number; name: string }> })?.result ?? [])) {
    groups[row.name] = row.id;
  }
  for (const name of ["RU", "UAE"]) {
    if (groups[name]) continue;
    await call(`setup-group-add-${name}`, {
      action: "add",
      service: "keywords_2",
      method: "groups",
      // `name` — массив: форму назвал сам сервис, отказав на строке.
      payload: { project_id: projectId, name: [name] },
    });
  }
  const after = await call("setup-groups-list-after", {
    action: "get",
    service: "keywords_2",
    method: "groups",
    payload: { project_id: projectId },
  });
  for (const row of ((after.body as { result?: Array<{ id: number; name: string }> })?.result ?? [])) {
    groups[row.name] = row.id;
  }

  const known = new Set(
    (
      (
        await call("setup-keywords-before", {
          action: "get",
          service: "keywords_2",
          method: "keywords",
          payload: { project_id: projectId, fields: ["id", "name", "group_id"] },
        })
      ).body as { result?: Array<{ name: string }> }
    )?.result?.map((k) => k.name) ?? []
  );

  for (const [groupName, queries] of [["RU", QUERIES_RU], ["UAE", QUERIES_UAE]] as const) {
    const toId = groups[groupName];
    if (!toId) continue;
    for (const query of queries) {
      if (known.has(query)) continue;
      await call(`setup-keyword-${groupName}-${queries.indexOf(query)}`, {
        action: "add",
        service: "keywords_2",
        method: "keywords",
        payload: { project_id: projectId, to_id: toId, name: query },
      });
    }
  }

  for (const searcherKey of [0, 1]) {
    await call(`setup-searcher-${searcherKey}`, {
      action: "add",
      service: "positions_2",
      method: "searchers",
      payload: { project_id: projectId, searcher_key: searcherKey },
    });
  }
  for (const region of PILOT_REGIONS) {
    await call(`setup-region-${region.key}`, {
      action: "add",
      service: "positions_2",
      method: "searchers/regions",
      payload: {
        project_id: projectId,
        searcher_key: region.searcher_key,
        region_key: region.region_key,
        region_lang: region.region_lang,
        region_device: region.region_device,
        region_depth: region.region_depth,
      },
    });
  }

  /*
   * Снимки выдачи, сниппеты в них и ответы ИИ — то, ради чего пилот затевался.
   *
   * Имена полей взяты из схемы после того, как первый прогон вернул снимок с
   * пустыми `snippet_title`/`snippet_body`: снимок и **сниппеты в снимке** —
   * разные настройки (`do_snapshots` и `do_snapshots_with_snippets`), а ответ
   * ИИ включает `with_ai_overview_full`. Придуманного `ai_snippets` в API нет
   * вовсе, и сервис молча принял его, ничего не включив.
   */
  await call("setup-settings", {
    action: "edit",
    service: "positions_2",
    method: "settings",
    payload: {
      project_id: projectId,
      do_snapshots: 1,
      do_snapshots_with_snippets: 1,
      with_snippets: 1,
      with_ai_overview_full: 1,
    },
  });

  await call("setup-keywords-after", {
    action: "get",
    service: "keywords_2",
    method: "keywords",
    payload: { project_id: projectId, fields: ["id", "name", "group_id"] },
  });

  saveState({ ...state, projectId, startedAt: state.startedAt ?? new Date().toISOString() });
}

async function stepCheck(): Promise<void> {
  requireSpend("check");
  const state = loadState();
  if (!state.projectId) {
    console.error("Нет проекта: сначала --step=setup.");
    process.exit(1);
  }
  // `filters` — обязательный параметр запуска: сервис назвал его сам. Проект
  // выбирается тем же фильтром, что и в списке проектов.
  const go = await call("check-go", {
    action: "edit",
    service: "positions_2",
    method: "checker/go",
    payload: {
      project_id: state.projectId,
      filters: [{ name: "id", operator: "EQUALS", values: [String(state.projectId)] }],
    },
  });
  if (!go.ok) {
    // Отказ запуска — не «запущено»: молча пойти дальше значит ждать проверки,
    // которой нет, и записать её пустой результат как настоящий.
    console.error("     проверка НЕ запущена — см. ошибки выше.");
    process.exit(1);
  }
  saveState({ ...state, startedAt: new Date().toISOString() });
  console.log("     проверка запущена; ожидание — отдельным шагом --step=wait");
}

/**
 * Ожидание проверки: сколько она идёт — один из вопросов пилота.
 *
 * Опрос отделён от запуска намеренно: ожидание может занять десятки минут, и
 * держать его в одном вызове значит потерять уже оплаченный запуск, если вызов
 * оборвётся.
 */
async function stepWait(): Promise<void> {
  const state = loadState();
  if (!state.projectId) {
    console.error("Нет проекта: сначала --step=setup.");
    process.exit(1);
  }
  const startedAt = state.startedAt ? Date.parse(state.startedAt) : Date.now();
  const limitMs = Number(arg("limit-min") ?? 30) * 60_000;
  for (let i = 0; ; i += 1) {
    const status = await call(`check-status-${String(i).padStart(2, "0")}`, {
      action: "get",
      service: "projects_2",
      method: "projects",
      payload: {
        filters: [{ name: "id", operator: "EQUALS", values: [String(state.projectId)] }],
        fields: ["id", "status_positions", "status_positions_percent", "status_positions_date"],
      },
    });
    const row = ((status.body as { result?: Array<Record<string, unknown>> })?.result ?? [])[0] ?? {};
    const percent = String(row.status_positions_percent ?? "");
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(
      `     ${elapsed} с: status=${String(row.status_positions ?? "")} percent=${percent || "—"}`
    );
    if (percent === "100" || Number(percent) >= 100) {
      console.log(`     проверка закончена за ${elapsed} с`);
      return;
    }
    if (Date.now() - startedAt > limitMs) {
      console.error(`     не закончилась за ${Math.round(limitMs / 60000)} мин — это ответ пилота.`);
      return;
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

/**
 * Чтение результатов проверки.
 *
 * Снимок выдачи и позиции — **разные вещи**, и пилот это выяснил: `positions_2`
 * отвечает «на каком месте стоит сайт проекта» (у нас служебный `example.org`,
 * то есть «--»), а список выдачи целиком лежит в `snapshots_2`. Именно снимок и
 * есть то, ради чего Topvisor берётся.
 *
 * Снимок запрашивается на каждый регион отдельно и требует полного адреса
 * региона (`searcher_key` + `region_key` + `region_lang` + `region_device`) —
 * каждое из этих полей сервис назвал сам, отказывая по одному за раз.
 */
async function stepRead(): Promise<void> {
  const state = loadState();
  if (!state.projectId) {
    console.error("Нет проекта: сначала --step=setup.");
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);

  for (const region of PILOT_REGIONS) {
    await call(`read-snapshot-${region.key}`, {
      action: "get",
      service: "snapshots_2",
      method: "history",
      payload: {
        project_id: state.projectId,
        date1: today,
        date2: today,
        searcher_key: region.searcher_key,
        region_key: region.region_key,
        region_lang: region.region_lang,
        region_device: region.region_device,
        depth_positions: 20,
        history_fields: ["url", "domain", "snippet_title", "snippet_body", "snippet_ext"],
      },
    });
  }

  /*
   * Ответы ИИ и признаки выдачи живут в истории позиций, и адресуются регионы
   * там **индексами проекта** — не порядковыми номерами: Дубай у пилота — 2520.
   * Чтение по `[1, 2, 3]` молча теряло его вместе с AI-ответами. Индексы
   * спрашиваются у самого проекта и сопоставляются по адресу региона.
   */
  const projectRow = (
    (
      await call("read-project-regions", {
        action: "get",
        service: "projects_2",
        method: "projects",
        payload: { id: state.projectId, show_searchers_and_regions: 1 },
      })
    ).body as { result?: unknown[] }
  )?.result?.[0];
  const regionIndexes = PILOT_REGIONS.map((region) => ({
    key: region.key,
    index: projectRegionIndex(projectRow, region),
  }));
  const missingIndex = regionIndexes.filter((r) => r.index === null).map((r) => r.key);
  if (missingIndex.length > 0) {
    console.error(`     у проекта нет регионов: ${missingIndex.join(", ")} — сначала --step=setup.`);
    process.exit(1);
  }
  console.log(
    `     индексы регионов: ${regionIndexes.map((r) => `${r.key}=${String(r.index)}`).join(", ")}`
  );

  await call("read-positions-history", {
    action: "get",
    service: "positions_2",
    method: "history",
    payload: {
      project_id: state.projectId,
      date1: today,
      date2: today,
      regions_indexes: regionIndexes.map((r) => r.index),
      show_serp_features: 1,
      history_fields: ["position", "serp_features", "relevant_url", "snippet_title", "snippet_body"],
    },
  });
}

async function stepTasks(): Promise<void> {
  requireSpend("tasks");
  const state = loadState();
  if (!state.projectId) {
    console.error("Нет проекта: сначала --step=setup.");
    process.exit(1);
  }
  /*
   * Ручки — **проектные**, а не тулбоксовые, и это стоило пилоту денег.
   *
   * `add/projects_2/tasks/keywords/collect` и `add/projects_2/tasks/volumes`
   * списывают деньги, возвращают номер задачи и **в проект не кладут ничего**:
   * это отдельный Тулбокс. Читать результат потом нечем — фразы в проекте те же,
   * частота `null`. Проверено 03.09.2026, четыре пустых списания.
   *
   * `hint_generators` обязателен: с пустым списком подбор собирает ноль фраз и
   * всё равно берёт деньги. Допустимые значения назвал сам сервис отказом:
   * `letter`, `letter_ru`, `number`, `space`.
   */
  await call("probe-collect-price", {
    action: "get",
    service: "keywords_2",
    method: "collect/price",
    payload: {
      project_id: state.projectId,
      keywords: [QUERIES_RU[0]],
      qualifiers: [{ searcher_key: 0, region_key: 213, hint_depth: 1, hint_generators: ["space"] }],
    },
  });
  await call("probe-collect-go", {
    action: "edit",
    service: "keywords_2",
    method: "collect/go",
    payload: {
      project_id: state.projectId,
      keywords: [QUERIES_RU[0]],
      qualifiers: [{ searcher_key: 0, region_key: 213, hint_depth: 1, hint_generators: ["space"] }],
    },
  });

  /*
   * Частота считается **по всему проекту**, а не по переданному списку, поэтому
   * порядок важен: после подбора подсказок фраз в проекте становится вчетверо
   * больше, и та же проверка стоит впятеро дороже. Цену спрашивать
   * непосредственно перед запуском.
   *
   * Регион — Россия целиком (`225`): Москва занижает. Тип 2 — «в кавычках»:
   * общая частота считает всех однофамильцев, а клиента интересует интерес к
   * его имени.
   */
  await call("probe-volumes-price", {
    action: "get",
    service: "keywords_2",
    method: "volumes/price",
    payload: {
      project_id: state.projectId,
      qualifiers: [{ searcher_key: 0, type: 2, region_key: 225 }],
    },
  });
  await call("probe-volumes-go", {
    action: "edit",
    service: "keywords_2",
    method: "volumes/go",
    payload: {
      project_id: state.projectId,
      qualifiers: [{ searcher_key: 0, type: 2, region_key: 225 }],
    },
  });
}

async function stepReadTasks(): Promise<void> {
  const state = loadState();
  /*
   * Подсказки сервис кладёт в **свою** группу («DI (регион): фраза»), а не в
   * переданную: `group_id` в `collect/go` он игнорирует. Поэтому читаем все
   * фразы проекта с их группами и смотрим, какая группа появилась.
   *
   * Частота читается полем с квалификаторами `volume:<ПС>:<регион>:<тип>` —
   * порядок именно такой, две другие перестановки сервис отвергает. Читать
   * можно только оплаченный квалификатор: неоплаченный — отказ, а не `null`.
   */
  await call("read-after-go", {
    action: "get",
    service: "keywords_2",
    method: "keywords",
    payload: {
      project_id: state.projectId,
      show_volumes: 1,
      fields: ["name", "group_id", "volume:0:225:1", "volume:0:225:2", "volume:0:225:3"],
    },
  });
  await call("read-groups-now", {
    action: "get",
    service: "keywords_2",
    method: "groups",
    payload: { project_id: state.projectId },
  });
}

/**
 * Произвольный вызов — инструмент разведки, а не рабочий путь.
 *
 * Формы запросов Topvisor приходится узнавать у самого сервиса: он отвечает
 * кодом 200 и называет недостающий параметр в теле. Гадать по документации
 * дороже — на выдуманных фикстурах проект уже обжигался.
 */
async function stepRaw(): Promise<void> {
  const action = arg("action") ?? "get";
  const service = arg("service") ?? "projects_2";
  const method = arg("method") || undefined;
  const payloadRaw = arg("payload") ?? "{}";
  const name = arg("name") ?? `raw-${action}-${service}-${(method ?? "root").replace(/\W+/g, "-")}`;
  await call(name, {
    action,
    service,
    method,
    payload: JSON.parse(payloadRaw) as Record<string, unknown>,
  });
}

async function main(): Promise<void> {
  const step = arg("step") ?? "probe";
  const { apiKey, userId } = topvisorSecrets();
  if (!apiKey || !userId) {
    console.error(
      `Topvisor не настроен: нет ${[!apiKey ? "TOPVISOR_API_KEY" : null, !userId ? "TOPVISOR_USER_ID" : null]
        .filter(Boolean)
        .join(", ")}. Пилот ничего не делает.`
    );
    process.exit(2);
  }
  console.log(`режим сбора: ${serpCollectionMode()}; шаг пилота: ${step}`);

  try {
    if (step === "raw") return await stepRaw();
    if (step === "probe") return await stepProbe();
    if (step === "regions") return await stepRegions();
    if (step === "setup") return await stepSetup();
    if (step === "check") return await stepCheck();
    if (step === "wait") return await stepWait();
    if (step === "read") return await stepRead();
    if (step === "tasks") return await stepTasks();
    if (step === "read-tasks") return await stepReadTasks();
    console.error(`Неизвестный шаг «${step}».`);
    process.exit(1);
  } catch (err) {
    if (err instanceof TopvisorNotConfiguredError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}

void main();
