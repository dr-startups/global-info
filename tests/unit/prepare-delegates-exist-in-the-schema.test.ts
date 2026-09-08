/**
 * Каждый делегат, который требует подготовка, существует в схеме Prisma под тем
 * же именем.
 *
 * Список `PREPARE_PRISMA_DELEGATES` проверяет **переданный** клиент, а имя
 * делегата у сгенерированного клиента задаёт имя модели: модель
 * `DpReviewDecision` даёт `prisma.dpReviewDecision`, и подготовка на живом
 * прогоне DPA-2026-0002 отказала с `PREPARE_DB_UNAVAILABLE: клиент базы без
 * делегатов: reviewDecision`, хотя таблица и миграция были на месте. Офлайн
 * контур этого не видел: в нём Prisma подменена заглушкой, где делегат назван
 * руками. Схема — единственное место, где имя видно без базы, поэтому сверка
 * идёт по ней.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PREPARE_PRISMA_DELEGATES } from "@/modules/digital-profile/services/prepare-prisma-bundle";

const SCHEMA = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");

/** Имя модели по имени делегата: `reviewDecision` → `ReviewDecision`. */
function modelNameOf(delegate: string): string {
  return delegate.charAt(0).toUpperCase() + delegate.slice(1);
}

describe("делегаты подготовки и схема Prisma", () => {
  it("у каждого делегата есть модель с тем же именем", () => {
    const missing = PREPARE_PRISMA_DELEGATES.filter(
      (delegate) => !new RegExp(`^model ${modelNameOf(delegate)}\\s*\\{`, "mu").test(SCHEMA)
    );
    expect(missing, "делегаты без модели в schema.prisma").toEqual([]);
  });

  it("решения проверки лежат в dp_review_decisions", () => {
    const model = SCHEMA.match(/^model ReviewDecision\s*\{[\s\S]*?^\}/mu)?.[0] ?? "";
    expect(model).toContain('@@map("dp_review_decisions")');
  });
});
