/**
 * Превью изображений запрашиваются как положено, а отказ называет причину.
 *
 * В отчёте 72 из шести плиток на странице изображений три были пустыми:
 * Википедия, ТАСС, МГИМО. Запрос за картинкой уходил вовсе без `User-Agent`, а
 * крупные площадки такие запросы отклоняют — Викимедиа отвечает 403 без
 * описательного агента. Пустая плитка при этом говорила «источник не отдал
 * изображение», и отличить запрет площадки от нашей ошибки было нельзя.
 */

import { describe, expect, it, vi } from "vitest";
import {
  PREVIEW_USER_AGENT,
  tryFetchImagePreview,
  type PreviewFailureReason,
} from "@/modules/digital-profile/orion-golden/assets/media-asset-svg";

function response(init: {
  ok?: boolean;
  status?: number;
  type?: string;
  body?: Uint8Array;
}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? init.type ?? null : null) },
    arrayBuffer: async () => (init.body ?? new Uint8Array()).buffer,
  } as unknown as Response;
}

describe("запрос за превью", () => {
  it("представляется честным именем в буквах ASCII", async () => {
    const fetchImpl = vi.fn(async () => response({ type: "image/png" }));
    await tryFetchImagePreview("https://upload.wikimedia.org/a.jpg", {
      fetchImpl: fetchImpl as never,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["user-agent"]).toBe(PREVIEW_USER_AGENT);
    expect(headers.accept).toBe("image/*");
    // Кириллица в значении заголовка роняет запрос до отправки.
    expect(PREVIEW_USER_AGENT).toMatch(/^[\x20-\x7E]+$/u);
  });

  it("запрет площадки называется кодом ответа", async () => {
    const reasons: PreviewFailureReason[] = [];
    const fetchImpl = vi.fn(async () => response({ ok: false, status: 403 }));
    const out = await tryFetchImagePreview("https://upload.wikimedia.org/a.jpg", {
      fetchImpl: fetchImpl as never,
      onFailure: (_u, r) => reasons.push(r),
    });
    expect(out).toBeUndefined();
    expect(reasons).toEqual(["http_403"]);
  });

  it("страница вместо картинки не декодируется, а называется", async () => {
    const reasons: PreviewFailureReason[] = [];
    const fetchImpl = vi.fn(async () => response({ type: "text/html; charset=utf-8" }));
    const out = await tryFetchImagePreview("https://example.org/page", {
      fetchImpl: fetchImpl as never,
      onFailure: (_u, r) => reasons.push(r),
    });
    expect(out).toBeUndefined();
    expect(reasons).toEqual(["not_an_image"]);
  });

  it("без сети причина — «offline», а не молчание", async () => {
    const prev = process.env.NETWORK_CALLS;
    process.env.NETWORK_CALLS = "0";
    try {
      const reasons: PreviewFailureReason[] = [];
      const out = await tryFetchImagePreview("https://example.org/a.png", {
        onFailure: (_u, r) => reasons.push(r),
      });
      expect(out).toBeUndefined();
      expect(reasons).toEqual(["offline"]);
    } finally {
      if (prev === undefined) delete process.env.NETWORK_CALLS;
      else process.env.NETWORK_CALLS = prev;
    }
  });

  it("не адрес — не запрос", async () => {
    const fetchImpl = vi.fn();
    expect(await tryFetchImagePreview(undefined, { fetchImpl: fetchImpl as never })).toBeUndefined();
    expect(await tryFetchImagePreview("не ссылка", { fetchImpl: fetchImpl as never })).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
