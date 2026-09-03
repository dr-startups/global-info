/**
 * Фикстуры Topvisor коммитятся — секрета в них быть не может ни разу.
 *
 * Однажды `.env.backup-<дата>` уже унесла ключи в коммит, и остановила её
 * защита GitHub, а не мы. Здесь закрыт второй способ: секрет приезжает не
 * значением, а **именем поля**. `get/keywords_2/collect/price` отвечает
 * `pricesByUsers: { "<идентификатор аккаунта>": … }`, и вычистка, смотревшая
 * только на значения, клала идентификатор в файл, готовый к коммиту.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { redactSecrets } from "@/modules/digital-profile/providers/topvisor/redact";

/*
 * Значения — вымышленные. Настоящий ключ в этом файле однажды уже побывал:
 * тест сканировал фикстуры по нему и сам стал местом утечки (коммит
 * `befdf4c8` на feature/topvisor; ключ подлежит отзыву). Сканирование по
 * содержимому идёт по секретам из окружения, когда они есть, и по форме
 * ответа — всегда.
 */
const SECRETS = { apiKey: "test-api-key-0123456789abcdef", userId: "100001" };

describe("вычистка секретов Topvisor", () => {
  it("затирает идентификатор аккаунта в имени поля", () => {
    const cleaned = redactSecrets({ pricesByUsers: { "100001": { price: 0.9 } } }, SECRETS);

    expect(JSON.stringify(cleaned)).not.toContain("100001");
    expect(Object.keys(cleaned.pricesByUsers)).toEqual(["***"]);
  });

  it("затирает секрет в значении, где бы оно ни лежало", () => {
    const cleaned = redactSecrets(
      { echo: { headers: ["bearer test-api-key-0123456789abcdef"] } },
      SECRETS
    );

    expect(JSON.stringify(cleaned)).not.toContain("test-api-key-0123456789abcdef");
  });

  it("поля с говорящими именами затираются целиком, даже с чужим значением", () => {
    const cleaned = redactSecrets({ Authorization: "bearer чужой", user_id: 777 }, SECRETS);

    expect(cleaned).toEqual({ Authorization: "***", user_id: "***" });
  });

  it("короткий идентификатор в имени поля затирается по точному совпадению", () => {
    /*
     * Порог длины защищает содержимое строк от вычистки «1» из чисел. Для
     * имени поля он лишний: ключ либо равен секрету целиком, либо нет, и
     * пятизначный идентификатор аккаунта иначе уходил бы в фикстуру как есть.
     */
    const cleaned = redactSecrets({ pricesByUsers: { "12345": { price: 0.9 } } }, {
      userId: "12345",
      apiKey: null,
    });

    expect(Object.keys(cleaned.pricesByUsers)).toEqual(["***"]);
  });

  it("короткое значение не вычищается: иначе из чисел пропадут единицы", () => {
    const cleaned = redactSecrets({ region: "213", depth: "1" }, { userId: "1", apiKey: null });

    expect(cleaned).toEqual({ region: "213", depth: "1" });
  });
});

describe("собранные фикстуры", () => {
  const dir = join(process.cwd(), "src/modules/digital-profile/providers/topvisor/fixtures");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

  it("есть и читаются", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  // Настоящие секреты — только из окружения машины, где они есть; в репозиторий
  // они не попадают ни в каком виде. Без них проверяется форма ответа.
  const live = [process.env.TOPVISOR_API_KEY, process.env.TOPVISOR_USER_ID]
    .map((v) => String(v ?? "").trim())
    .filter((v) => v.length >= 6);

  it.each(files)("%s не несёт ни ключа, ни идентификатора аккаунта", (file) => {
    const text = readFileSync(join(dir, file), "utf8");

    for (const secret of live) expect(text).not.toContain(secret);
    // Заголовок авторизации не должен встречаться в ответах ни в каком виде.
    expect(text).not.toMatch(/bearer\s+[0-9a-f]{16,}/i);
    // Идентификатор аккаунта — по месту, где сервис его возвращает именем поля.
    const parsed = JSON.parse(text) as unknown;
    for (const owner of collectPricesByUsers(parsed)) {
      expect(Object.keys(owner)).toEqual(Object.keys(owner).map(() => "***"));
    }
  });
});

/** Все объекты `pricesByUsers`, найденные на любой глубине ответа. */
function collectPricesByUsers(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap(collectPricesByUsers);
  if (!node || typeof node !== "object") return [];
  const found: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "pricesByUsers" && value && typeof value === "object") {
      found.push(value as Record<string, unknown>);
    }
    found.push(...collectPricesByUsers(value));
  }
  return found;
}
