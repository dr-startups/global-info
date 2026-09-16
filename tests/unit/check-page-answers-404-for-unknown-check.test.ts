import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { selfCheckExists } from "@/modules/self-check/service";
import { fakeDb, selfCheckRow } from "../support/self-check-fakes";

/**
 * Страница несуществующей проверки отвечает кодом 404, а не экраном «не найдена»
 * с кодом 200 (ТЗ 5.2, п. 12): для робота и для ссылки с опечаткой это разные
 * вещи. Страница мастера спрашивает у сервиса проверки одно — есть ли запись.
 *
 * Сбой базы — не «проверки нет»: человек с живой ссылкой получил бы 404 на свою
 * проверку. При сбое страница рисует мастер, а тот скажет «нет связи». Обезличенная
 * запись существует — её экран «срок истёк» рисует мастер по ответу ручки (410).
 */

const PUBLIC_ID = "pUbL1c-iD-0123456789abcdef";
const root = process.cwd();

describe("есть ли проверка", () => {
  it("запись есть — да, в том числе обезличенная", async () => {
    const { db } = fakeDb({ selfChecks: [selfCheckRow({ publicId: PUBLIC_ID })] });
    expect(await selfCheckExists(PUBLIC_ID, { db: db as never })).toBe(true);

    const expired = fakeDb({
      selfChecks: [selfCheckRow({ publicId: PUBLIC_ID, status: "EXPIRED", anonymizedAt: new Date() })],
    });
    expect(await selfCheckExists(PUBLIC_ID, { db: expired.db as never })).toBe(true);
  });

  it("записи нет — нет", async () => {
    const { db } = fakeDb({ selfChecks: [selfCheckRow({ publicId: PUBLIC_ID })] });
    expect(await selfCheckExists("another-public-id-000000", { db: db as never })).toBe(false);
  });

  it("не наш идентификатор — нет, и в базу за ним не ходим", async () => {
    let reads = 0;
    const db = {
      selfCheck: {
        findUnique: async () => {
          reads += 1;
          return null;
        },
      },
    };
    expect(await selfCheckExists("x".repeat(65), { db: db as never })).toBe(false);
    expect(reads).toBe(0);
  });

  it("база не ответила — считаем, что есть: мастер скажет «нет связи», а не 404", async () => {
    const db = {
      selfCheck: {
        findUnique: async () => {
          throw new Error("connection refused");
        },
      },
    };
    expect(await selfCheckExists(PUBLIC_ID, { db: db as never })).toBe(true);
  });
});

describe("страница мастера", () => {
  const page = readFileSync(join(root, "src/app/(site)/check/[publicId]/page.tsx"), "utf8");

  it("неизвестную проверку отдаёт через notFound() — с кодом 404", () => {
    expect(page).toMatch(/import \{ notFound \} from "next\/navigation";/u);
    expect(page).toMatch(/if \(!\(await selfCheckExists\(publicId\)\)\) notFound\(\);/u);
  });

  it("404 мастера — экран «такой проверки нет» из текстов мастера", () => {
    const path = join(root, "src/app/(site)/check/[publicId]/not-found.tsx");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toMatch(/SERVICE_SCREENS\.notFound/u);
  });
});

describe("заголовки страниц 404", () => {
  it("общая 404 называет себя целиком: внутри layout сайта шаблон не повторяет «Global Info»", () => {
    // notFound() неизвестной статьи или услуги рисует эту страницу внутри layout сайта,
    // и строковый заголовок получал шаблон второй раз: «… — Global Info — Global Info».
    const text = readFileSync(join(root, "src/app/not-found.tsx"), "utf8");
    expect(text).toMatch(/title: \{ absolute: "Страница не найдена — Global Info" \}/u);
  });

  it("404 мастера называется «Проверка не найдена» и в поиск не попадает", () => {
    const text = readFileSync(join(root, "src/app/(site)/check/[publicId]/not-found.tsx"), "utf8");
    expect(text).toMatch(/title: SERVICE_SCREENS\.notFound\.status,/u);
    expect(text).toMatch(/robots: \{ index: false, follow: false \}/u);
  });
});
