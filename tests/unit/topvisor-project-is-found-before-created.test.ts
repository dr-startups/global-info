/**
 * Проект Topvisor — один на кейс, и состояние его живёт в API.
 *
 * Повторный прогон того же кейса не создаёт второго проекта; регионы и их
 * индексы читаются из проекта; настройки после записи **читаются обратно**
 * (сервис принимает несуществующие поля молча — урок пилота); фразы
 * добавляются только недостающие.
 */

import { describe, expect, it } from "vitest";
import {
  ensureTopvisorProject,
  TopvisorProjectError,
  topvisorProjectName,
} from "@/modules/digital-profile/providers/topvisor/project";
import { createTopvisorFixtureCall, PILOT_KEYWORDS } from "../support/topvisor-fixture-call";

// Идентификатор кейса совпадает с именем проекта пилота — так фикстура поиска по имени настоящая.
const CASE = "pilot-2026-09-03";

describe("проект Topvisor на кейс", () => {
  it("имя проекта не содержит ФИО: проект виден в чужом кабинете", () => {
    expect(topvisorProjectName(CASE)).toBe(`orion-${CASE}`);
  });

  it("существующий проект находится по имени и не создаётся второй раз", async () => {
    const { call, log } = createTopvisorFixtureCall({ projectExists: true });
    const project = await ensureTopvisorProject({ caseId: CASE, keywords: PILOT_KEYWORDS, call });

    expect(project.projectId).toBe(32742967);
    expect(project.created).toBe(false);
    expect(log.filter((e) => e.action === "add" && e.service === "projects_2")).toHaveLength(0);
  });

  it("отсутствующий проект создаётся ровно один раз", async () => {
    const { call, log } = createTopvisorFixtureCall({ projectExists: false });
    const project = await ensureTopvisorProject({ caseId: CASE, keywords: PILOT_KEYWORDS, call });

    expect(project.created).toBe(true);
    expect(project.projectId).toBe(32742967);
    expect(log.filter((e) => e.action === "add" && e.service === "projects_2")).toHaveLength(1);
  });

  it("индексы регионов берутся из проекта: Дубай — 2520, не третий", async () => {
    const { call } = createTopvisorFixtureCall({ projectExists: true });
    const project = await ensureTopvisorProject({ caseId: CASE, keywords: PILOT_KEYWORDS, call });

    expect(project.regions).toEqual([
      { key: "yandex-moscow", index: 1 },
      { key: "google-moscow", index: 2 },
      { key: "google-dubai", index: 2520 },
    ]);
  });

  it("настройки пишутся и сразу читаются обратно", async () => {
    const { call, log } = createTopvisorFixtureCall({ projectExists: true });
    await ensureTopvisorProject({ caseId: CASE, keywords: PILOT_KEYWORDS, call });

    const edit = log.findIndex((e) => e.action === "edit" && e.method === "settings");
    const readBack = log.findIndex(
      (e, i) =>
        i > edit &&
        e.action === "get" &&
        e.service === "projects_2" &&
        Array.isArray(e.payload?.fields) &&
        (e.payload!.fields as string[]).includes("do_snapshots")
    );
    expect(edit).toBeGreaterThanOrEqual(0);
    expect(readBack).toBeGreaterThan(edit);
  });

  it("не применённая настройка — отказ с её именем, до платного запуска", async () => {
    const { call, log } = createTopvisorFixtureCall({ projectExists: true, settingsApplied: false });

    await expect(ensureTopvisorProject({ caseId: CASE, keywords: PILOT_KEYWORDS, call })).rejects.toMatchObject({
      name: "TopvisorProjectError",
      code: "TOPVISOR_SETTINGS_NOT_APPLIED",
      message: expect.stringContaining("with_ai_overview_full"),
    });
    expect(log.some((e) => e.method === "checker/go")).toBe(false);
    expect(TopvisorProjectError).toBeDefined();
  });

  it("добавляются только недостающие фразы, в группу своего региона", async () => {
    const { call, log } = createTopvisorFixtureCall({ projectExists: true });
    const project = await ensureTopvisorProject({
      caseId: CASE,
      keywords: { ru: [...PILOT_KEYWORDS.ru, "новая фраза"], uae: PILOT_KEYWORDS.uae },
      call,
    });

    const adds = log.filter((e) => e.action === "add" && e.service === "keywords_2" && e.method === "keywords");
    expect(adds).toHaveLength(1);
    expect(adds[0]!.payload).toMatchObject({ name: "новая фраза", to_id: 74601421 });
    expect(project.keywordsAdded).toBe(1);
  });
});
