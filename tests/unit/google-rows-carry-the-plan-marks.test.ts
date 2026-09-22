/**
 * Строка Google несёт пометки плана: назначение запроса и «это само имя» (шаг 0146).
 *
 * `googleAuditSearchSpecs` (шаг 0137) переносил из плана только текст запроса,
 * регион, язык и глубину, а `taggedSearchRows` (шаг 0138) — только запрос и
 * контур. В бандле Мельниченко 22.09.2026 пометку «это само имя» несут 20 строк
 * Яндекса и ни одной строки Google, и таблица Google выбрала запрос счётом
 * материалов: «Мельниченко Андрей» (10) вместо полного имени (9). Склейка
 * читает `rawMetadata.queryPurpose` и `rawMetadata.subjectNameQuery` — их просто
 * никто не писал.
 */

import { describe, expect, it } from "vitest";
import { googleAuditSearchSpecs } from "@/modules/digital-profile/agents/real/real-google-search-agent";
import { taggedSearchRows } from "@/modules/digital-profile/agents/real/real-search-agent-base";
import type { SearchProviderResult } from "@/modules/digital-profile/providers/types";

const SUBJECT = {
  fullName: "Мельниченко Андрей Игоревич",
  aliases: ["А. Мельниченко", "Andrey Melnichenko", "Andrei Melnichenko"],
  targetRegions: ["RU", "UAE"],
  location: null,
};

const result = { provider: "GOOGLE", url: "https://example.org/a", rank: 1, rawMetadata: { source: "serper" } } as unknown as SearchProviderResult;

describe("пометки плана доезжают до строки Google", () => {
  it("М1: спека основного запроса каждого контура помечена «это само имя»", () => {
    const specs = googleAuditSearchSpecs(SUBJECT as never)!;
    const named = specs.filter((s) => s.subjectNameQuery === true).map((s) => `${s.contour}:${s.query}`);
    expect(named).toEqual(["RU:Мельниченко Андрей Игоревич", "UAE:Andrey Melnichenko"]);
  });

  it("М2: спека несёт назначение запроса из плана", () => {
    const specs = googleAuditSearchSpecs(SUBJECT as never)!;
    const purposeOf = (q: string) => specs.find((s) => s.query === q)?.purpose;
    expect(purposeOf("Мельниченко Андрей Игоревич")).toBe("subject_lookup");
    expect(purposeOf("Мельниченко Андрей Игоревич инн")).toBe("business_lookup");
  });

  it("М3: строка, найденная помеченным запросом, несёт queryPurpose и subjectNameQuery", () => {
    const spec = googleAuditSearchSpecs(SUBJECT as never)!.find((s) => s.subjectNameQuery)!;
    const [row] = taggedSearchRows([result], spec);
    const rm = row!.rawMetadata as Record<string, unknown>;
    expect(rm.queryPurpose).toBe("subject_lookup");
    expect(rm.subjectNameQuery).toBe(true);
    expect(rm.query).toBe("Мельниченко Андрей Игоревич");
    expect(rm.orionRegion).toBe("RU");
  });

  it("М4: у строки непомеченного запроса ключа пометки нет вовсе", () => {
    const spec = googleAuditSearchSpecs(SUBJECT as never)!.find((s) => s.query === "Мельниченко Андрей")!;
    const [row] = taggedSearchRows([result], spec);
    const rm = row!.rawMetadata as Record<string, unknown>;
    expect(rm).not.toHaveProperty("subjectNameQuery");
    expect(rm.queryPurpose).toBe("subject_lookup");
  });
});
