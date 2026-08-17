/**
 * Что подготовка отчёта читает из базы — записано в одном месте, и без базы
 * она отказывает, а не собирает отчёт из пустоты.
 *
 * Перечисление делегатов руками в вызывающем уже стоило проекта: забытый
 * `complianceScreeningRun` не был ошибкой типов (входы `Partial`), поэтому на
 * каждом живом прогоне страницы баз печатали «проверка не выполнялась» после
 * настоящего скрининга. Тихая деградация здесь хуже отказа: артефакты прежнего
 * прогона целы, отказ ретраится, а отчёт, отрицающий выполненный скрининг, —
 * ложное утверждение банку.
 */

import { describe, expect, it, vi } from "vitest";
import { CanonicalPrepareBlockedError } from "@/modules/digital-profile/services/canonical-report-prepare";
import {
  PREPARE_PRISMA_DELEGATES,
  buildPreparePrismaBundle,
  resolvePreparePrismaBundle,
} from "@/modules/digital-profile/services/prepare-prisma-bundle";

const server = vi.hoisted(() => {
  const delegate = (name: string) => ({
    name,
    findMany: async () => [],
    count: async () => 0,
  });
  return {
    available: true,
    client: {
      searchResult: delegate("searchResult"),
      searchSurfaceItem: delegate("searchSurfaceItem"),
      databaseProfile: delegate("databaseProfile"),
      complianceScreeningRun: delegate("complianceScreeningRun"),
      riskFinding: delegate("riskFinding"),
      wikipediaCheck: delegate("wikipediaCheck"),
      serpCapture: delegate("serpCapture"),
      // Делегат, к подготовке отчёта отношения не имеющий.
      auditLog: delegate("auditLog"),
    },
  };
});

vi.mock("@/server/prisma/client", () => ({
  get prisma() {
    if (!server.available) throw new Error("prisma client unavailable");
    return server.client;
  },
}));

describe("бандл prisma для подготовки отчёта", () => {
  it("собирает ровно семь делегатов и ничего лишнего", () => {
    const bundle = buildPreparePrismaBundle(server.client as never);

    expect([...PREPARE_PRISMA_DELEGATES]).toEqual([
      "searchResult",
      "searchSurfaceItem",
      "databaseProfile",
      "complianceScreeningRun",
      "riskFinding",
      "wikipediaCheck",
      "serpCapture",
    ]);
    expect(Object.keys(bundle).sort()).toEqual([...PREPARE_PRISMA_DELEGATES].sort());
    for (const name of PREPARE_PRISMA_DELEGATES) {
      expect(bundle[name]).toBe(server.client[name]);
    }
  });

  it("переданный клиент сильнее серверного", async () => {
    const injected = { ...server.client, riskFinding: { findMany: async () => [] } };

    const bundle = await resolvePreparePrismaBundle(injected as never);

    expect(bundle.riskFinding).toBe(injected.riskFinding);
  });

  it("без переданного клиента берётся серверный", async () => {
    server.available = true;

    const bundle = await resolvePreparePrismaBundle();

    expect(bundle.complianceScreeningRun).toBe(server.client.complianceScreeningRun);
  });

  it("клиент без нужного делегата — тоже отказ, а не половина бандла", async () => {
    // Устаревший сгенерированный клиент или переименованная модель дают
    // `undefined` вместо делегата: тип весь `Partial`, и подготовка ушла бы в
    // ветку «данных нет» — ровно ту, ради закрытия которой модуль и заведён.
    const { wikipediaCheck: _missing, ...withoutWikipedia } = server.client;

    await expect(resolvePreparePrismaBundle(withoutWikipedia as never)).rejects.toMatchObject({
      code: "PREPARE_DB_UNAVAILABLE",
    });
    await expect(resolvePreparePrismaBundle(withoutWikipedia as never)).rejects.toThrow(
      /wikipediaCheck/
    );
  });

  it("недоступная база — именованный отказ, а не тихий null", async () => {
    server.available = false;
    try {
      await expect(resolvePreparePrismaBundle()).rejects.toBeInstanceOf(
        CanonicalPrepareBlockedError
      );
      await expect(resolvePreparePrismaBundle()).rejects.toMatchObject({
        code: "PREPARE_DB_UNAVAILABLE",
      });
    } finally {
      server.available = true;
    }
  });
});
