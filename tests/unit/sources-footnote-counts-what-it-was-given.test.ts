/**
 * «Источники — … и ещё N» называет настоящий остаток.
 *
 * Считает и печатает одна функция — `enumerateRu` внутри `sourcesSentence`, — и
 * остаток она берёт от того, что ей подали. Пока звавшие резали список до
 * печати (`.slice(0, 5)` у `pageSourceLine`, `.slice(0, 6)` у `sourceLine`),
 * сноска не могла сказать больше «и ещё 2» **никогда**: при 186 доменах отчёта
 * она обещала клиенту шесть площадок из ста восьмидесяти шести.
 */

import { describe, expect, it } from "vitest";
import {
  pageSourceLine,
  sourceLine,
  type PageEvidenceView,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

function view(domains: string[]): PageEvidenceView {
  return {
    refs: [],
    domains,
    findings: [],
    supportDomains: new Map(),
    supportRows: new Map(),
  };
}

const ELEVEN = [
  "forbes.ru",
  "tass.ru",
  "rbc.ru",
  "kommersant.ru",
  "vedomosti.ru",
  "lenta.ru",
  "ria.ru",
  "interfax.ru",
  "gazeta.ru",
  "iz.ru",
  "rg.ru",
];

describe("сноска источников считает то, что ей дали", () => {
  it("одиннадцать доменов — четыре имени и «и ещё 7»", () => {
    const line = pageSourceLine(view(ELEVEN));
    expect(line).toContain("и ещё 7");
  });

  it("пять доменов — «и ещё 1»", () => {
    expect(pageSourceLine(view(ELEVEN.slice(0, 5)))).toContain("и ещё 1");
  });

  it("четыре домена называются полностью, без остатка", () => {
    const line = pageSourceLine(view(ELEVEN.slice(0, 4)));
    expect(line).not.toContain("и ещё");
    expect(line).toContain("kommersant.ru");
  });

  it("подвал региона тоже называет настоящий остаток", () => {
    const evidenceIndex = Object.fromEntries(
      [...ELEVEN, "audit-it.ru"].map((domain, i) => [
        `ev-${i}`,
        { title: `Материал ${i}`, domain, region: "RU" },
      ])
    );
    const scoped = {
      findings: [],
      surfaceUnits: [],
      evidenceIndex,
      scope: { regions: ["RU"] },
      metricSnapshot: {},
    } as unknown as ScopedFragmentInput;
    expect(sourceLine(scoped)).toContain("и ещё 8");
  });

  it("домены-заглушки не считаются ни в именах, ни в остатке", () => {
    const withMocks = [...ELEVEN.slice(0, 6), "mock-serp.example", "demo.mock.ru"];
    const line = pageSourceLine(view(withMocks));
    expect(line).not.toContain("mock");
    // Шесть настоящих площадок: четыре названы, остаток — два, а не четыре.
    expect(line).toContain("и ещё 2");
  });
});
