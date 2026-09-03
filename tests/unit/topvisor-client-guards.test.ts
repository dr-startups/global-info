/**
 * Клиент Topvisor: заголовки, тело, сторож офлайна и предел одновременных.
 *
 * Офлайн-контур обязан обходиться без сети: при `NETWORK_CALLS=0` клиент без
 * подставленного транспорта падает **до** вызова `fetch`. Предел аккаунта —
 * пять одновременных обращений; шестое ждёт, а не получает отказ сервиса.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TOPVISOR_MAX_CONCURRENT,
  topvisorCall,
  topvisorConcurrencySnapshot,
} from "@/modules/digital-profile/providers/topvisor/client";

const ENV = { TOPVISOR_API_KEY: "key-123456", TOPVISOR_USER_ID: "100001", NETWORK_CALLS: "1" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("клиент Topvisor", () => {
  it("шлёт User-Id и bearer-ключ POST-ом на адрес действия и службы", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return response({ result: [] });
    }) as unknown as typeof fetch;

    const res = await topvisorCall(
      { action: "get", service: "projects_2", method: "projects", payload: { id: 1 } },
      { fetchImpl, env: ENV }
    );

    expect(res.ok).toBe(true);
    expect(seen[0]!.url).toBe("https://api.topvisor.com/v2/json/get/projects_2/projects");
    expect(seen[0]!.init.method).toBe("POST");
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["User-Id"]).toBe("100001");
    expect(headers.Authorization).toBe("bearer key-123456");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ id: 1 });
  });

  it("ошибка сервиса приходит кодом 200 и читается как отказ", async () => {
    const fetchImpl = (async () =>
      response({ result: null, errors: [{ code: 2001, string: "В запросе отсутствует обязательный параметр: 'fields'" }] })) as unknown as typeof fetch;

    const res = await topvisorCall({ action: "get", service: "bank_2", method: "history" }, { fetchImpl, env: ENV });

    expect(res.ok).toBe(false);
    expect(res.errors[0]).toMatch(/fields/);
  });

  it("NETWORK_CALLS=0 без подставленного транспорта — отказ до сети", async () => {
    const globalFetch = vi.fn(async () => response({ result: [] }));
    vi.stubGlobal("fetch", globalFetch);

    await expect(
      topvisorCall({ action: "get", service: "projects_2", method: "projects" }, { env: { ...ENV, NETWORK_CALLS: "0" } })
    ).rejects.toThrow(/NETWORK_CALLS=0/);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("одновременных обращений не больше пяти: шестое ждёт", async () => {
    const releases: Array<() => void> = [];
    const fetchImpl = (async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return response({ result: [] });
    }) as unknown as typeof fetch;

    const calls = Array.from({ length: TOPVISOR_MAX_CONCURRENT + 2 }, () =>
      topvisorCall({ action: "get", service: "projects_2", method: "projects" }, { fetchImpl, env: ENV })
    );
    await new Promise((r) => setTimeout(r, 10));

    expect(topvisorConcurrencySnapshot()).toEqual({ active: TOPVISOR_MAX_CONCURRENT, waiting: 2 });
    expect(releases).toHaveLength(TOPVISOR_MAX_CONCURRENT);

    releases.splice(0).forEach((r) => r());
    await new Promise((r) => setTimeout(r, 10));
    releases.splice(0).forEach((r) => r());
    const results = await Promise.all(calls);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(topvisorConcurrencySnapshot()).toEqual({ active: 0, waiting: 0 });
  });
});
