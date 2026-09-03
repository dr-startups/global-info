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

const SECRETS = { apiKey: "4268a9385c407ffd4a0a3ba4b1bcd643", userId: "512963" };

describe("вычистка секретов Topvisor", () => {
  it("затирает идентификатор аккаунта в имени поля", () => {
    const cleaned = redactSecrets({ pricesByUsers: { "512963": { price: 0.9 } } }, SECRETS);

    expect(JSON.stringify(cleaned)).not.toContain("512963");
    expect(Object.keys(cleaned.pricesByUsers)).toEqual(["***"]);
  });

  it("затирает секрет в значении, где бы оно ни лежало", () => {
    const cleaned = redactSecrets(
      { echo: { headers: ["bearer 4268a9385c407ffd4a0a3ba4b1bcd643"] } },
      SECRETS
    );

    expect(JSON.stringify(cleaned)).not.toContain("4268a9385c407ffd4a0a3ba4b1bcd643");
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

  it.each(files)("%s не несёт ни ключа, ни идентификатора аккаунта", (file) => {
    const text = readFileSync(join(dir, file), "utf8");

    // Ключ API — по значению: оно уникально и в ответах появляться не должно.
    expect(text).not.toContain(SECRETS.apiKey);
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
