import { describe, expect, it } from "vitest";
import {
  createSelfCheckToken,
  selfCheckSecret,
  verifySelfCheckToken,
} from "@/modules/self-check/token";
import { signToken } from "@/modules/digital-profile/auth/signed-token";
import {
  createSessionToken,
  verifySessionToken,
} from "@/modules/digital-profile/auth/session";

/**
 * Токен посетителя открывает одну проверку и ничего больше.
 *
 * Подпись у токена посетителя и у сессии сотрудника одна (тот же секрет и тот
 * же примитив), поэтому различает их поле `kind`: без него токен посетителя,
 * в котором окажется `uid`, открыл бы админку, а сессия сотрудника — чужую
 * проверку.
 */

const SECRET = "self-check-test-secret-0123456789";

function thrown(fn: () => unknown): { status?: number; code?: string; details?: { reason?: string } } {
  try {
    fn();
  } catch (err) {
    return err as never;
  }
  throw new Error("ожидался отказ");
}

describe("токен посетителя", () => {
  it("читается своим секретом и несёт свою проверку", async () => {
    const token = await createSelfCheckToken("check-1", SECRET, { ttlSeconds: 3600 });
    const payload = await verifySelfCheckToken(token, SECRET);
    expect(payload).toMatchObject({ kind: "self-check", checkId: "check-1" });
    expect(payload!.exp - payload!.iat).toBe(3600);
  });

  it("чужой секрет — не токен", async () => {
    const token = await createSelfCheckToken("check-1", "another-secret-0123456789abcdef");
    expect(await verifySelfCheckToken(token, SECRET)).toBeNull();
  });

  it("подменённая проверка при старой подписи — не токен", async () => {
    const token = await createSelfCheckToken("check-1", SECRET);
    const [body, sig] = token.split(".");
    const payload = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    const forged = Buffer.from(JSON.stringify({ ...payload, checkId: "check-2" })).toString("base64url");
    expect(await verifySelfCheckToken(`${forged}.${sig}`, SECRET)).toBeNull();
  });

  it("истёкший — не токен", async () => {
    const issued = new Date("2026-09-14T10:00:00Z");
    const token = await createSelfCheckToken("check-1", SECRET, { ttlSeconds: 3600, now: issued });
    expect(await verifySelfCheckToken(token, SECRET, new Date("2026-09-14T10:59:00Z"))).not.toBeNull();
    expect(await verifySelfCheckToken(token, SECRET, new Date("2026-09-14T11:00:01Z"))).toBeNull();
  });

  it.each([
    ["пусто", ""],
    ["нет подписи", "abc"],
    ["отсутствует", null],
  ])("не токен по форме: %s", async (_label, token) => {
    expect(await verifySelfCheckToken(token, SECRET)).toBeNull();
  });
});

describe("токен посетителя и сессия сотрудника не взаимозаменяемы", () => {
  it("сессия сотрудника не открывает проверку", async () => {
    const session = await createSessionToken("user-1", SECRET);
    expect(await verifySelfCheckToken(session, SECRET)).toBeNull();
  });

  it("токен посетителя не открывает сессию", async () => {
    const token = await createSelfCheckToken("check-1", SECRET);
    expect(await verifySessionToken(token, SECRET)).toBeNull();
  });

  it("и не откроет, даже если в нём окажется uid", async () => {
    const now = Math.floor(Date.now() / 1000);
    const crafted = await signToken(
      { kind: "self-check", checkId: "check-1", uid: "user-1", iat: now, exp: now + 3600 },
      SECRET
    );
    expect(await verifySessionToken(crafted, SECRET)).toBeNull();
  });

  it("подписанное тело без kind проверку не открывает", async () => {
    const now = Math.floor(Date.now() / 1000);
    const crafted = await signToken({ checkId: "check-1", iat: now, exp: now + 3600 }, SECRET);
    expect(await verifySelfCheckToken(crafted, SECRET)).toBeNull();
  });
});

describe("секрет подписи", () => {
  it.each([
    ["секрета нет", { NODE_ENV: "production" }],
    ["секрет по умолчанию", { NODE_ENV: "production", DIGITAL_PROFILE_SESSION_SECRET: "change-me-in-production" }],
    ["секрет короткий", { RAILWAY_ENVIRONMENT: "production", DIGITAL_PROFILE_SESSION_SECRET: "short" }],
  ])("в deploy-like окружении слабый секрет — 503 с причиной: %s", (_label, env) => {
    const err = thrown(() => selfCheckSecret(env as NodeJS.ProcessEnv));
    expect(err).toMatchObject({
      status: 503,
      code: "MODULE_DISABLED",
      details: { reason: "SELF_CHECK_SECRET_NOT_CONFIGURED" },
    });
  });

  it("сильный секрет читается как есть", () => {
    const env = { NODE_ENV: "production", DIGITAL_PROFILE_SESSION_SECRET: ` ${SECRET} ` };
    expect(selfCheckSecret(env as NodeJS.ProcessEnv)).toBe(SECRET);
  });

  it("на локальном стенде без секрета проверка работает", () => {
    expect(selfCheckSecret({ NODE_ENV: "development" } as NodeJS.ProcessEnv).length).toBeGreaterThan(0);
  });
});
