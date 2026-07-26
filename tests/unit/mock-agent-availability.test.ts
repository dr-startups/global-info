import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Шаг 11.2 плана.
 *
 * Демо-агенты сообщали ENABLED безусловно, поэтому на живом кейсе вкладка
 * Agents показывала «Yandex Search (mock)», «Compliance Databases (mock)» и ещё
 * пять рядом с реальными, с рабочей кнопкой «Run audit». Один клик записывал
 * синтетические результаты о реальном человеке в доказательную базу — то самое
 * загрязнение, которое шаг 01 убрал из контура сбора.
 */

async function loadRegistry(mockAgents: boolean) {
  vi.resetModules();
  vi.doMock("../../src/modules/digital-profile/config", () => ({
    digitalProfileConfig: {
      mockAgents,
      aiAnalyst: { enabled: false, openAiApiKey: undefined },
    },
    isDigitalProfileEnabled: () => true,
  }));
  return import("../../src/modules/digital-profile/agents/registry");
}

describe("доступность демо-агентов", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.doUnmock("../../src/modules/digital-profile/config"));

  it("в реальном режиме демо-агенты выключены", async () => {
    const { listAgentDefinitions } = await loadRegistry(false);
    const mocks = listAgentDefinitions().filter((d) => d.kind === "MOCK");
    expect(mocks.length).toBeGreaterThan(0);
    for (const def of mocks) {
      expect(def.enabled).toBe(false);
      expect(def.availability.status).toBe("DISABLED");
      expect(def.availability.message ?? "").toContain("mock");
    }
  });

  it("в mock-режиме демо-агенты доступны — офлайн-контур не ломается", async () => {
    const { listAgentDefinitions } = await loadRegistry(true);
    const mocks = listAgentDefinitions().filter((d) => d.kind === "MOCK");
    expect(mocks.length).toBeGreaterThan(0);
    for (const def of mocks) {
      expect(def.enabled).toBe(true);
    }
  });

  it("реальные агенты режимом mock не управляются", async () => {
    const real = (await loadRegistry(false)).listAgentDefinitions().filter((d) => d.kind !== "MOCK");
    expect(real.length).toBeGreaterThan(0);
    // Их доступность определяется ключами и флагами, а не этим переключателем;
    // здесь достаточно того, что список не опустел.
    expect(real.every((d) => typeof d.availability.status === "string")).toBe(true);
  });
});
