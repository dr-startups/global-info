/**
 * Тонкий клиент сайта к публичным ручкам.
 *
 * Не `client/api.ts` админки: тот при `401` уводит на страницу входа сотрудника.
 * Здесь отказ — не исключение, а значение: код ответа, машинная причина из
 * `details.reason` и поля отказа схемы. Экран сам решает, что показать.
 */

import type { PersonaPanelJson, PublicStatusJson, SitePublicConfig } from "./check/types";

export interface ApiRefusal {
  ok: false;
  /** Код ответа; 0 — запрос не дошёл (сеть). */
  status: number;
  code: string;
  reason: string | null;
  fieldErrors: Record<string, string[] | undefined>;
}

export type ApiResult<T> = { ok: true; status: number; data: T } | ApiRefusal;

type Envelope = {
  ok?: boolean;
  data?: unknown;
  error?: { code?: string; details?: { reason?: unknown; fieldErrors?: Record<string, string[]> } };
} | null;

export function readEnvelope<T>(status: number, body: unknown): ApiResult<T> {
  const envelope = body as Envelope;
  if (envelope?.ok === true && status < 400) return { ok: true, status, data: envelope.data as T };
  const details = envelope?.error?.details;
  return {
    ok: false,
    status,
    code: envelope?.error?.code ?? "INTERNAL_ERROR",
    reason: typeof details?.reason === "string" ? details.reason : null,
    fieldErrors: details?.fieldErrors ?? {},
  };
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, status: 0, code: "NETWORK_ERROR", reason: "NETWORK_ERROR", fieldErrors: {} };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return readEnvelope<T>(res.status, json);
}

const checkPath = (publicId: string) => `/api/self-check/${encodeURIComponent(publicId)}`;

let config: Promise<ApiResult<SitePublicConfig>> | null = null;

export const siteApi = {
  /** Один запрос на показ страницы: форма и счётчик спрашивают одно и то же. */
  config(): Promise<ApiResult<SitePublicConfig>> {
    config ??= call<SitePublicConfig>("GET", "/api/site/config").then((res) => {
      if (!res.ok) config = null;
      return res;
    });
    return config;
  },
  create: (body: unknown) =>
    call<{ publicId: string; status: string } | { existingPublicId: string }>("POST", "/api/self-check", body),
  status: (publicId: string) => call<PublicStatusJson>("GET", checkPath(publicId)),
  persona: (publicId: string) => call<PersonaPanelJson>("POST", `${checkPath(publicId)}/persona`),
  decide: (publicId: string, body: { decision: string; selectedCardIds?: string[] }) =>
    call<{ decision: string; decidedAt: string }>("POST", `${checkPath(publicId)}/persona/decision`, body),
  run: (publicId: string) => call<{ status: string; nextPollMs: number }>("POST", `${checkPath(publicId)}/run`),
  lead: (publicId: string, body: Record<string, string>) =>
    call<{ leadAt: string }>("POST", `${checkPath(publicId)}/lead`, body),
};
