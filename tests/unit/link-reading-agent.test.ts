import { describe, expect, it } from "vitest";
import {
  readLinks,
  summarizeReads,
} from "@/modules/digital-profile/orion-golden/analytics/link-reading-agent";
import type { LinkPageRead } from "@/modules/digital-profile/services/link-page-reader";

const AT = "2026-08-14T10:00:00.000Z";
const ok = (url: string): LinkPageRead => ({ ok: true, url, text: "Текст страницы.", readAt: AT });
const fail = (url: string, failure: string, message = ""): LinkPageRead =>
  ({ ok: false, url, failure, message, readAt: AT }) as LinkPageRead;

const noPause = async () => {};

describe("повторы", () => {
  it("срыв связи повторяется и со второй попытки читается", async () => {
    let calls = 0;
    const { outcomes, report } = await readLinks(["https://a.ru/1"], {
      pause: noPause,
      read: async (url) => {
        calls += 1;
        return calls === 1 ? fail(url, "not_fetched", "ECONNRESET") : ok(url);
      },
    });
    expect(outcomes[0]!.page.ok).toBe(true);
    expect(outcomes[0]!.attempts).toBe(2);
    expect(report.read).toBe(1);
    expect(report.retried).toBe(1);
  });

  it("отказ сайта не повторяется: это ответ, а не помеха", async () => {
    let calls = 0;
    await readLinks(["https://a.ru/1", "https://a.ru/2"], {
      pause: noPause,
      read: async (url) => {
        calls += 1;
        return fail(url, url.endsWith("1") ? "blocked" : "not_found");
      },
    });
    expect(calls).toBe(2);
  });

  it("страница без текста тоже не перечитывается", async () => {
    let calls = 0;
    await readLinks(["https://a.ru/1"], {
      pause: noPause,
      read: async (url) => {
        calls += 1;
        return fail(url, "empty_text");
      },
    });
    expect(calls).toBe(1);
  });
});

describe("порядок и статус", () => {
  it("результаты возвращаются в порядке ссылок, несмотря на очередь", async () => {
    const urls = Array.from({ length: 9 }, (_, i) => `https://a.ru/${i}`);
    const { outcomes } = await readLinks(urls, {
      pause: noPause,
      concurrency: 4,
      read: async (url) => {
        await new Promise((r) => setTimeout(r, url.endsWith("0") ? 5 : 0));
        return ok(url);
      },
    });
    expect(outcomes.map((o) => o.url)).toEqual(urls);
  });

  it("ни одной прочитанной — статус поломки", () => {
    const report = summarizeReads([
      { url: "a", attempts: 2, page: fail("a", "not_fetched", "ByteString") },
      { url: "b", attempts: 2, page: fail("b", "not_fetched", "ByteString") },
    ]);
    expect(report.status).toBe("BROKEN");
    expect(report.firstFailureDetail).toBe("ByteString");
  });

  it("часть прочитана — статус частичный, причины посчитаны", () => {
    const report = summarizeReads([
      { url: "a", attempts: 1, page: ok("a") },
      { url: "b", attempts: 1, page: fail("b", "blocked", "HTTP 403") },
      { url: "c", attempts: 1, page: fail("c", "blocked", "HTTP 401") },
    ]);
    expect(report.status).toBe("PARTIAL");
    expect(report.read).toBe(1);
    expect(report.byReason.blocked).toBe(2);
  });

  it("всё прочитано — статус в порядке", () => {
    expect(summarizeReads([{ url: "a", attempts: 1, page: ok("a") }]).status).toBe("OK");
  });
});
