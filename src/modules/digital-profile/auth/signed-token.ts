/**
 * Подписанные токены: HMAC-SHA256 через Web Crypto.
 *
 * Токен = base64url(JSON тела) + "." + base64url(HMAC-SHA256 тела). Одним
 * примитивом подписываются сессия сотрудника (`session.ts`) и токен посетителя
 * сайта (`self-check/token.ts`): вторая реализация подписи разошлась бы с
 * первой в первой же мелочи — кодировке, сравнении, разборе.
 *
 * Модуль работает и в обработчиках Node, и в edge-middleware, поэтому не
 * импортирует ничего из Node. Что тело значит — срок, кому выдан токен —
 * решает его владелец; здесь только подпись и разбор.
 */

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

/** HMAC строкой в hex — для хешей с солью, которые хранятся в базе. */
export async function hmacHex(secret: string, data: string): Promise<string> {
  const bytes = await hmacSha256(secret, data);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Подписать тело. Порядок полей — порядок в объекте: он часть байтов токена. */
export async function signToken(payload: object, secret: string): Promise<string> {
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = b64urlEncode(await hmacSha256(secret, body));
  return `${body}.${sig}`;
}

/**
 * Проверить подпись и разобрать тело. `null` — не токен: нет подписи, чужая
 * подпись или тело не объект. Срок и назначение не проверяются — это вопрос
 * владельца токена.
 */
export async function readSignedToken(
  token: string | undefined | null,
  secret: string
): Promise<Record<string, unknown> | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let expectedSig: string;
  try {
    expectedSig = b64urlEncode(await hmacSha256(secret, body));
  } catch {
    return null;
  }
  if (!timingSafeEqualStr(sig, expectedSig)) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
