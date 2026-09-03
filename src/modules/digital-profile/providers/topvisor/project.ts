/**
 * Проект Topvisor — один на кейс, состояние живёт в API.
 *
 * Перед созданием — поиск по имени: повторный прогон кейса не заводит второй
 * проект и не платит за него. Имя без ФИО — проект виден в кабинете Topvisor.
 * Регионы и их индексы читаются из проекта после добавления: индекс — данные
 * проекта, не порядковый номер (Дубай у пилота — 2520). Настройки после записи
 * читаются обратно: сервис принимает несуществующие поля молча.
 */

import type { TopvisorCallFn } from "./client";
import { normalizeKeyword, projectSettingsApplied } from "./adapters/positions";
import { projectRegionIndex, TOPVISOR_AUDIT_REGIONS, type TopvisorAuditRegion } from "./regions";

/**
 * Настройки, без которых проверка бесполезна: снимок, сниппеты в снимке и
 * полный AI-ответ. Имена — из схемы Topvisor, подтверждены чтением на пилоте.
 */
export const TOPVISOR_PROJECT_SETTINGS: Record<string, number> = {
  do_snapshots: 1,
  do_snapshots_with_snippets: 1,
  with_snippets: 1,
  with_ai_overview_full: 1,
};

/** Служебный адрес проекта: позиции «своего сайта» нам не нужны. */
const PROJECT_URL = "https://example.org/";

/** Группы фраз по регионам: имя группы — код региона ORION. */
const GROUP_BY_REGION: Record<"RU" | "UAE", string> = { RU: "RU", UAE: "UAE" };

export class TopvisorProjectError extends Error {
  constructor(
    readonly code:
      | "TOPVISOR_PROJECT_LOOKUP_FAILED"
      | "TOPVISOR_PROJECT_CREATE_FAILED"
      | "TOPVISOR_SETTINGS_NOT_APPLIED"
      | "TOPVISOR_REGION_INDEX_MISSING"
      | "TOPVISOR_GROUP_CREATE_FAILED",
    message: string
  ) {
    super(message);
    this.name = "TopvisorProjectError";
  }
}

export function topvisorProjectName(caseId: string): string {
  return `orion-${String(caseId).trim()}`;
}

type ProjectRow = { id?: unknown; name?: unknown };
type GroupRow = { id?: unknown; name?: unknown };
type KeywordRow = { id?: unknown; name?: unknown; group_id?: unknown };

function rowsOf<T>(body: unknown): T[] {
  const result = (body as { result?: unknown } | null)?.result;
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object") return Object.values(result as Record<string, T>);
  return [];
}

function idOf(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type EnsuredTopvisorProject = {
  projectId: number;
  created: boolean;
  regions: Array<{ key: TopvisorAuditRegion["key"]; index: number }>;
  keywordsAdded: number;
  warnings: string[];
};

export async function ensureTopvisorProject(input: {
  caseId: string;
  keywords: { ru: readonly string[]; uae: readonly string[] };
  call: TopvisorCallFn;
}): Promise<EnsuredTopvisorProject> {
  const { call } = input;
  const name = topvisorProjectName(input.caseId);
  const warnings: string[] = [];

  // 1. Поиск по имени — второго проекта на кейс быть не должно.
  const found = await call({
    action: "get",
    service: "projects_2",
    method: "projects",
    payload: { filters: [{ name: "name", operator: "EQUALS", values: [name] }], fields: ["id", "name"] },
  });
  if (!found.ok) {
    throw new TopvisorProjectError("TOPVISOR_PROJECT_LOOKUP_FAILED", `Поиск проекта «${name}»: ${found.errors.join("; ")}`);
  }
  let projectId = idOf(rowsOf<ProjectRow>(found.body).find((r) => String(r.name ?? "") === name)?.id);
  let created = false;

  if (!projectId) {
    const added = await call({
      action: "add",
      service: "projects_2",
      method: "projects",
      payload: { url: PROJECT_URL, name, on: 1 },
    });
    projectId = added.ok ? idOf((added.body as { result?: unknown })?.result) : null;
    if (!projectId) {
      throw new TopvisorProjectError(
        "TOPVISOR_PROJECT_CREATE_FAILED",
        `Проект «${name}» не создан: ${added.errors.join("; ") || "сервис не вернул идентификатор"}`
      );
    }
    created = true;
  }

  // 2. Поисковики и регионы — идемпотентно: сервис отвечает «уже добавлен».
  for (const searcherKey of [...new Set(TOPVISOR_AUDIT_REGIONS.map((r) => r.searcher_key))]) {
    const res = await call({
      action: "add",
      service: "positions_2",
      method: "searchers",
      payload: { project_id: projectId, searcher_key: searcherKey },
    });
    if (!res.ok) warnings.push(`topvisor-searcher-add:${searcherKey}:${res.errors.join("; ")}`);
  }
  for (const region of TOPVISOR_AUDIT_REGIONS) {
    const res = await call({
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
    if (!res.ok) warnings.push(`topvisor-region-add:${region.key}:${res.errors.join("; ")}`);
  }

  // 3. Настройки: записать и **прочитать**. Ответ на запись ничего не доказывает.
  await call({
    action: "edit",
    service: "positions_2",
    method: "settings",
    payload: { project_id: projectId, ...TOPVISOR_PROJECT_SETTINGS },
  });
  const settingsRead = await call({
    action: "get",
    service: "projects_2",
    method: "projects",
    payload: { id: projectId, fields: ["id", ...Object.keys(TOPVISOR_PROJECT_SETTINGS)] },
  });
  const applied = projectSettingsApplied(settingsRead.body, TOPVISOR_PROJECT_SETTINGS);
  if (!applied.ok) {
    throw new TopvisorProjectError(
      "TOPVISOR_SETTINGS_NOT_APPLIED",
      `Проект ${projectId}: настройки не применились — ${applied.missing.join(", ")}. Платную проверку запускать нельзя.`
    );
  }

  // 4. Группы по регионам.
  const groups = new Map<string, number>();
  for (const g of rowsOf<GroupRow>(
    (await call({ action: "get", service: "keywords_2", method: "groups", payload: { project_id: projectId } })).body
  )) {
    const id = idOf(g.id);
    if (id && typeof g.name === "string") groups.set(g.name, id);
  }
  for (const groupName of Object.values(GROUP_BY_REGION)) {
    if (groups.has(groupName)) continue;
    // `name` — массив: форму назвал сам сервис, отказав на строке.
    const res = await call({
      action: "add",
      service: "keywords_2",
      method: "groups",
      payload: { project_id: projectId, name: [groupName] },
    });
    const id = idOf(rowsOf<GroupRow>(res.body)[0]?.id);
    if (!id) {
      throw new TopvisorProjectError(
        "TOPVISOR_GROUP_CREATE_FAILED",
        `Проект ${projectId}: группа «${groupName}» не создана: ${res.errors.join("; ")}`
      );
    }
    groups.set(groupName, id);
  }

  // 5. Фразы — только недостающие, каждая в группу своего региона.
  const existing = new Set(
    rowsOf<KeywordRow>(
      (
        await call({
          action: "get",
          service: "keywords_2",
          method: "keywords",
          payload: { project_id: projectId, fields: ["id", "name", "group_id"] },
        })
      ).body
    ).map((k) => normalizeKeyword(typeof k.name === "string" ? k.name : ""))
  );
  let keywordsAdded = 0;
  for (const [region, list] of [["RU", input.keywords.ru], ["UAE", input.keywords.uae]] as const) {
    const toId = groups.get(GROUP_BY_REGION[region])!;
    for (const query of list) {
      const key = normalizeKeyword(query);
      if (!key || existing.has(key)) continue;
      const res = await call({
        action: "add",
        service: "keywords_2",
        method: "keywords",
        payload: { project_id: projectId, to_id: toId, name: query },
      });
      if (res.ok) {
        existing.add(key);
        keywordsAdded += 1;
      } else {
        warnings.push(`topvisor-keyword-add:${key}:${res.errors.join("; ")}`);
      }
    }
  }

  // 6. Индексы регионов — из проекта, не по порядку.
  const projectRow = rowsOf<unknown>(
    (
      await call({
        action: "get",
        service: "projects_2",
        method: "projects",
        payload: { id: projectId, show_searchers_and_regions: 1 },
      })
    ).body
  )[0];
  const regions = TOPVISOR_AUDIT_REGIONS.map((region) => ({ key: region.key, index: projectRegionIndex(projectRow, region) }));
  const missing = regions.filter((r) => r.index === null).map((r) => r.key);
  if (missing.length > 0) {
    throw new TopvisorProjectError(
      "TOPVISOR_REGION_INDEX_MISSING",
      `Проект ${projectId}: у регионов ${missing.join(", ")} нет индекса — регионы не добавились.`
    );
  }

  return {
    projectId,
    created,
    regions: regions.map((r) => ({ key: r.key, index: r.index as number })),
    keywordsAdded,
    warnings,
  };
}
