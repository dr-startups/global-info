import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSessionToken,
  verifySessionToken,
} from "@/modules/digital-profile/auth/session";

/**
 * Формат токена сессии сотрудника не меняется.
 *
 * Подпись сессии вынесена в общий помощник, которым пользуется и токен
 * посетителя сайта. Сессии, выданные до выноса, обязаны читаться после него:
 * иначе выкладка молча разлогинит всех сотрудников, а middleware отправит их
 * на вход посреди работы.
 *
 * Ожидаемый токен считается здесь независимо — `node:crypto`, а не Web Crypto
 * кода: `base64url(JSON тела) + "." + base64url(HMAC-SHA256 тела)`.
 */

const SECRET = "session-format-control-secret";
const IAT = 1_789_400_000;
const payload = { uid: "user-1", iat: IAT, exp: IAT + 8 * 60 * 60 };
const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
const expected = `${body}.${createHmac("sha256", SECRET).update(body).digest("base64url")}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(IAT * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("токен сессии", () => {
  it("выдаётся байт в байт в прежнем формате", async () => {
    expect(await createSessionToken("user-1", SECRET)).toBe(expected);
  });

  it("токен прежнего формата читается", async () => {
    expect(await verifySessionToken(expected, SECRET)).toEqual(payload);
  });

  it("чужой секрет, обрезанная подпись и истёкший срок — не сессия", async () => {
    expect(await verifySessionToken(expected, "another-secret")).toBeNull();
    expect(await verifySessionToken(expected.slice(0, -2), SECRET)).toBeNull();
    vi.setSystemTime((payload.exp + 1) * 1000);
    expect(await verifySessionToken(expected, SECRET)).toBeNull();
  });
});
