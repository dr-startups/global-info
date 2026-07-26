import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Шаг 11.2, пункт 2 (docs/rework/11-workflow-ux-and-false-failures.md).
 *
 * Вкладка «Агенты» предлагала ручной запуск четырнадцати реальных агентов,
 * которые на деле — внутренние шаги одного оркеструемого прогона. Именно эта
 * панель и породила привычку «дожимать» отчёт руками: заказчик жал повтор по
 * нескольку раз, пока сбор не двигался.
 *
 * Наблюдение отделено от управления: статусы, диагностика и история остаются
 * всегда, ручной запуск — режим отладки.
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("ручной запуск агента — режим отладки", () => {
  it("флаг есть в конфиге и вне mock-режима выключен по умолчанию", async () => {
    const src = read("src/modules/digital-profile/config.ts");
    expect(src).toMatch(/manualAgentRun/u);
    expect(src).toMatch(/DIGITAL_PROFILE_MANUAL_AGENT_RUN/u);

    const prev = { manual: process.env.DIGITAL_PROFILE_MANUAL_AGENT_RUN, mock: process.env.DIGITAL_PROFILE_MOCK_AGENTS };
    try {
      delete process.env.DIGITAL_PROFILE_MANUAL_AGENT_RUN;
      process.env.DIGITAL_PROFILE_MOCK_AGENTS = "false";
      vi.resetModules();
      const fresh = await import("../../src/modules/digital-profile/config");
      expect(fresh.digitalProfileConfig.manualAgentRun).toBe(false);
      // В mock-режиме остаётся включённым: офлайн-контур и смоки не ломаются.
      process.env.DIGITAL_PROFILE_MOCK_AGENTS = "true";
      vi.resetModules();
      const mock = await import("../../src/modules/digital-profile/config");
      expect(mock.digitalProfileConfig.manualAgentRun).toBe(true);
    } finally {
      if (prev.manual == null) delete process.env.DIGITAL_PROFILE_MANUAL_AGENT_RUN;
      else process.env.DIGITAL_PROFILE_MANUAL_AGENT_RUN = prev.manual;
      if (prev.mock == null) delete process.env.DIGITAL_PROFILE_MOCK_AGENTS;
      else process.env.DIGITAL_PROFILE_MOCK_AGENTS = prev.mock;
      vi.resetModules();
    }
  });

  it("сервер закрыт, а не только кнопка", () => {
    // Урок пункта 1 того же шага: `runAgent` запускал любого агента по имени
    // мимо проверки доступности, и скрытие кнопки ничего не гарантировало.
    const route = read(
      "src/app/api/digital-profile/cases/[id]/agents/[agentName]/run/route.ts"
    );
    expect(route).toMatch(/manualAgentRun/u);
    expect(route).toMatch(/AGENT_MANUAL_RUN_DISABLED/u);
    // Отказ стоит до запуска, а не после.
    expect(route.indexOf("AGENT_MANUAL_RUN_DISABLED")).toBeLessThan(route.indexOf("await runAgent("));
  });

  it("вкладка без режима отладки кнопку не рисует, но объясняет почему", () => {
    const tab = read("src/modules/digital-profile/client/AgentsTab.tsx");
    expect(tab).toMatch(/const canRun = can\("agents\.run"\) && manualAgentRun;/u);
    expect(tab).toMatch(/observationOnlyHint/u);
    // Пустой колонки на месте кнопки не остаётся.
    expect(tab).toMatch(/\{canRun \? <th \/> : null\}/u);
  });

  it("наблюдение остаётся при выключенном режиме", () => {
    const tab = read("src/modules/digital-profile/client/AgentsTab.tsx");
    // Статусы, диагностика и история под флаг не уходят.
    for (const marker of ["agents.availability", "agents.lastRun", "agents.recentRuns"]) {
      const idx = tab.indexOf(marker);
      expect(idx, marker).toBeGreaterThan(0);
    }
  });

  it("флаг доходит от конфига до вкладки", () => {
    expect(read("src/app/admin/digital-profile/[caseId]/page.tsx")).toMatch(
      /manualAgentRun=\{digitalProfileConfig\.manualAgentRun\}/u
    );
    expect(read("src/modules/digital-profile/client/CaseDetailView.tsx")).toMatch(
      /manualAgentRun=\{manualAgentRun\}/u
    );
    expect(read("src/modules/digital-profile/client/CaseTabs.tsx")).toMatch(
      /manualAgentRun=\{manualAgentRun\}/u
    );
  });

  it("подсказка переведена на оба языка", () => {
    expect(read("src/modules/digital-profile/i18n/dictionaries/ru.ts")).toMatch(
      /observationOnlyHint/u
    );
    expect(read("src/modules/digital-profile/i18n/dictionaries/en.ts")).toMatch(
      /observationOnlyHint/u
    );
    expect(read("src/modules/digital-profile/i18n/types.ts")).toMatch(/observationOnlyHint/u);
  });
});
