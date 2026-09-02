import { describe, expect, it } from "vitest";
import { retryAfterMs } from "@/modules/digital-profile/providers/wikipedia-provider";

/**
 * Один ответ 429 ронял весь агент проверки Википедии
 * (`PROVIDER_REQUEST_FAILED: Wikipedia request failed: HTTP 429`), хотя сервис
 * прямо говорит, сколько ждать. Правило проекта здесь то же, что и для
 * Arsenkin: ожидание — не попытка.
 *
 * Проверяется разбор `Retry-After`: сервис присылает либо секунды, либо дату,
 * и верить надо ему, а не выдуманной задержке.
 */
const withHeader = (value: string | null): Response =>
  new Response(null, { status: 429, headers: value ? { "retry-after": value } : {} });

describe("пауза по требованию сервиса", () => {
  it("секунды из заголовка", () => {
    expect(retryAfterMs(withHeader("3"), 0)).toBe(3000);
  });

  it("дата из заголовка", () => {
    const at = new Date(Date.now() + 4000).toUTCString();
    const ms = retryAfterMs(withHeader(at), 0);
    expect(ms).toBeGreaterThan(2000);
    expect(ms).toBeLessThanOrEqual(8000);
  });

  it("без заголовка — растущая пауза, а не мгновенный повтор", () => {
    expect(retryAfterMs(withHeader(null), 0)).toBe(1000);
    expect(retryAfterMs(withHeader(null), 1)).toBe(2000);
    expect(retryAfterMs(withHeader(null), 2)).toBe(4000);
  });

  it("пауза ограничена сверху: одна цифра в ответе не останавливает шаг", () => {
    expect(retryAfterMs(withHeader("3600"), 0)).toBe(8000);
    expect(retryAfterMs(withHeader(null), 20)).toBe(8000);
  });

  it("бессмысленный заголовок не даёт нулевой или отрицательной паузы", () => {
    for (const raw of ["", "soon", "-5", "0"]) {
      expect(retryAfterMs(withHeader(raw), 0)).toBeGreaterThan(0);
    }
  });
});
