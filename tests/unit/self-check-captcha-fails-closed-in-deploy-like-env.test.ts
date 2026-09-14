import { afterEach, describe, expect, it, vi } from "vitest";
import { SMARTCAPTCHA_VALIDATE_URL, verifyCaptcha } from "@/modules/self-check/captcha";
import { refusal } from "../support/self-check-fakes";

/**
 * Капча публичной формы: без ключа на площадке проверка закрыта.
 *
 * Каждая проверка стоит денег, и капча — первая мера расхода. Площадка без
 * серверного ключа не пропускает никого (fail-closed), локальный стенд
 * пропускает с предупреждением, чтобы разработка не требовала ключа. Ответ
 * сервиса с кодом не 200 Яндекс советует считать ответом «ok» — человека не
 * задерживают из-за чужой аварии, а расход в такие минуты держат лимиты.
 */

const KEY = { SMARTCAPTCHA_SERVER_KEY: "ysc2_server_key" };

const okResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("без серверного ключа", () => {
  it.each([
    ["NODE_ENV=production", { NODE_ENV: "production" }],
    ["DIGITAL_PROFILE_DEPLOY_LIKE=true", { DIGITAL_PROFILE_DEPLOY_LIKE: "true" }],
    ["RAILWAY_ENVIRONMENT=production", { RAILWAY_ENVIRONMENT: "production" }],
  ])("на площадке (%s) проверка не создаётся — 503 CAPTCHA_NOT_CONFIGURED", async (_l, env) => {
    const fetchImpl = vi.fn();
    const err = await refusal(verifyCaptcha({ token: "t", ip: "203.0.113.7", env: env as unknown as NodeJS.ProcessEnv, fetchImpl }));
    expect(err).toMatchObject({ status: 503, code: "MODULE_DISABLED", details: { reason: "CAPTCHA_NOT_CONFIGURED" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("на локальном стенде — пропуск без сети, и видно, что это пропуск", async () => {
    const fetchImpl = vi.fn();
    const out = await verifyCaptcha({
      token: undefined,
      ip: "127.0.0.1",
      env: { NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv,
      fetchImpl,
    });
    expect(out).toEqual({ verified: false, skipped: "NOT_CONFIGURED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("с серверным ключом", () => {
  it("токен уходит на проверку формой: секрет, токен и адрес", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ status: "ok", message: "", host: "example.ru" }));
    const out = await verifyCaptcha({ token: "tok-1", ip: "203.0.113.7", env: KEY as unknown as NodeJS.ProcessEnv, fetchImpl });
    expect(out).toEqual({ verified: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SMARTCAPTCHA_VALIDATE_URL);
    expect(url).toBe("https://smartcaptcha.cloud.yandex.ru/validate");
    expect(init.method).toBe("POST");
    const form = new URLSearchParams(String(init.body));
    expect(form.get("secret")).toBe("ysc2_server_key");
    expect(form.get("token")).toBe("tok-1");
    expect(form.get("ip")).toBe("203.0.113.7");
  });

  it.each([
    ["токена нет", undefined],
    ["токен пустой", "  "],
  ])("%s — 400 CAPTCHA_FAILED без сети", async (_l, token) => {
    const fetchImpl = vi.fn();
    const err = await refusal(verifyCaptcha({ token, ip: "203.0.113.7", env: KEY as unknown as NodeJS.ProcessEnv, fetchImpl }));
    expect(err).toMatchObject({ status: 400, code: "VALIDATION_ERROR", details: { reason: "CAPTCHA_FAILED" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("сервис ответил failed — 400 CAPTCHA_FAILED", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ status: "failed", message: "Invalid or expired Token." }));
    const err = await refusal(verifyCaptcha({ token: "tok", ip: "203.0.113.7", env: KEY as unknown as NodeJS.ProcessEnv, fetchImpl }));
    expect(err).toMatchObject({ status: 400, details: { reason: "CAPTCHA_FAILED" } });
  });

  it("сервис ответил не 200 — пропуск, как советует Яндекс", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ error: "internal" }, 500));
    const out = await verifyCaptcha({ token: "tok", ip: "203.0.113.7", env: KEY as unknown as NodeJS.ProcessEnv, fetchImpl });
    expect(out).toEqual({ verified: false, skipped: "SERVICE_UNAVAILABLE" });
  });

  it("сеть до сервиса упала — тот же пропуск", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const out = await verifyCaptcha({ token: "tok", ip: "203.0.113.7", env: KEY as unknown as NodeJS.ProcessEnv, fetchImpl });
    expect(out).toEqual({ verified: false, skipped: "SERVICE_UNAVAILABLE" });
  });

  it("на площадке с ключом проверка идёт как обычно", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ status: "ok", message: "", host: "example.ru" }));
    const env = { ...KEY, NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv;
    expect(await verifyCaptcha({ token: "tok", ip: "203.0.113.7", env, fetchImpl })).toEqual({ verified: true });
  });

  it("офлайн-контур без подменённого клиента в сеть не ходит и молча не пропускает", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const env = { ...KEY, NETWORK_CALLS: "0" } as unknown as NodeJS.ProcessEnv;
    const err = await refusal(verifyCaptcha({ token: "tok", ip: "203.0.113.7", env }));
    expect(err).toMatchObject({ status: 400, details: { reason: "CAPTCHA_FAILED" } });
    expect(globalFetch).not.toHaveBeenCalled();
  });
});
