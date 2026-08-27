import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PERSONA_PANEL_ANCHOR,
  personaBlockKey,
  personaPanelView,
  personaSourceReason,
  personaWikipediaTail,
} from "@/modules/digital-profile/client/persona-panel-text";
import {
  DigitalProfileApiError,
  type PersonaSourceStateDTO,
} from "@/modules/digital-profile/client/api";
import { buildPersonaPanel } from "@/modules/digital-profile/services/subject-persona-check";
import { t } from "@/modules/digital-profile/i18n";
import { en } from "@/modules/digital-profile/i18n/dictionaries/en";
import { ru } from "@/modules/digital-profile/i18n/dictionaries/ru";

/**
 * Текст для человека живёт в словарях, а машинная причина — на сервере.
 *
 * Готовая русская фраза, собранная на сервере и положенная в снимок, печаталась
 * как есть в обоих кабинетах: в английском выходило
 * `Wikipedia: failed — Википедия не ответила: HTTP 429`. Снимок несёт код и
 * параметры, слова подставляет словарь.
 */

const read = (p: string): string =>
  readFileSync(join(process.cwd(), "src/modules/digital-profile", p), "utf8");

/** Ключ, которого нет в словаре, `t` возвращает самим ключом. */
function phrase(dict: typeof ru, key: string, vars?: Record<string, string | number>): string {
  const text = t(dict, key, vars);
  expect(text, key).not.toBe(key);
  return text;
}

describe("причину отказа источника называет словарь, а не сервер", () => {
  it("снимок несёт код и подробность, а готовой фразы в нём нет вовсе", async () => {
    const { snapshot } = await buildPersonaPanel({
      subject: {
        caseId: "case-persona-text",
        fullName: "Петров Иван Иванович",
        aliases: [],
        dateOfBirth: "1970-03-05",
      },
      deps: {
        budgetMs: 30,
        wikipedia: async () => {
          throw new Error("HTTP 429");
        },
        serper: async () => ({ status: "NOT_CONFIGURED", items: [], error: "no key" }),
        openSanctions: async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return { status: "SUCCESS", provider: "OPEN_SANCTIONS", hits: [] };
        },
      },
    });
    for (const source of snapshot.sources) {
      expect(Object.keys(source).sort(), source.source).toEqual(
        ["code", "detail", "source", "status", "waitedMs"].sort()
      );
    }
    const wikipedia = snapshot.sources.find((s) => s.source === "wikipedia");
    expect(wikipedia?.code).toBe("PROVIDER_REQUEST_FAILED");
    expect(wikipedia?.detail).toBe("HTTP 429");
    const serper = snapshot.sources.find((s) => s.source === "knowledge_graph");
    expect(serper?.code).toBe("PROVIDER_NOT_CONFIGURED");
    const sanctions = snapshot.sources.find((s) => s.source === "opensanctions");
    expect(sanctions?.status).toBe("TIMEOUT");
    expect(sanctions?.code).toBe("PERSONA_PANEL_BUDGET_EXCEEDED");
    expect(sanctions?.waitedMs).toBe(30);
  });

  it("каждый код причины переводится в обоих кабинетах", () => {
    const codes: Array<Pick<PersonaSourceStateDTO, "code" | "detail" | "waitedMs">> = [
      { code: "NETWORK_CALLS_DISABLED", detail: null, waitedMs: null },
      { code: "PERSONA_PANEL_BUDGET_EXCEEDED", detail: null, waitedMs: 20_000 },
      { code: "PROVIDER_NOT_CONFIGURED", detail: "no key", waitedMs: null },
      { code: "PROVIDER_REQUEST_FAILED", detail: "HTTP 429", waitedMs: null },
      { code: "PROVIDER_REQUEST_FAILED", detail: null, waitedMs: null },
    ];
    for (const state of codes) {
      const reason = personaSourceReason({ source: "wikipedia", status: "FAILED", ...state });
      expect(reason, String(state.code)).not.toBeNull();
      for (const dict of [ru, en]) phrase(dict, reason!.key, reason!.vars);
    }
  });

  it("бюджет ожидания печатается секундами, а не миллисекундами", () => {
    const reason = personaSourceReason({
      source: "wikipedia",
      status: "TIMEOUT",
      code: "PERSONA_PANEL_BUDGET_EXCEEDED",
      detail: null,
      waitedMs: 20_000,
    });
    const text = phrase(ru, reason!.key, reason!.vars);
    expect(text).toContain("20");
    expect(text).not.toContain("20000");
  });

  it("техническая подробность провайдера доезжает до оператора", () => {
    const reason = personaSourceReason({
      source: "wikipedia",
      status: "FAILED",
      code: "PROVIDER_REQUEST_FAILED",
      detail: "MediaWiki error: maxlag",
      waitedMs: null,
    });
    expect(phrase(ru, reason!.key, reason!.vars)).toContain("MediaWiki error: maxlag");
  });

  it("ответивший источник причины не несёт", () => {
    expect(
      personaSourceReason({
        source: "wikipedia",
        status: "SUCCESS",
        code: null,
        detail: null,
        waitedMs: null,
      })
    ).toBeNull();
  });
});

describe("карточка без лида не остаётся голым заголовком", () => {
  const card = (lead: string | null, leadRequested: boolean) => ({
    lead,
    leadRequested,
    snippet: "российский предприниматель",
  });

  it("лид есть — хвоста нет", () => {
    expect(personaWikipediaTail(card("Иван Петров (род. 1970) — предприниматель.", true))).toBeNull();
  });

  it("лид не запрашивали — сниппет со своей причиной", () => {
    const tail = personaWikipediaTail(card(null, false));
    expect(tail?.snippet).toBe("российский предприниматель");
    for (const dict of [ru, en]) phrase(dict, tail!.key);
  });

  it("лид спрашивали и не получили — тоже сниппет, и причина другая", () => {
    // 429 у Википедии на плотной серии — обычное дело, и карточка из одного
    // заголовка не говорит оператору ничего.
    const asked = personaWikipediaTail(card(null, true));
    const notAsked = personaWikipediaTail(card(null, false));
    expect(asked?.snippet).toBe("российский предприниматель");
    expect(asked?.key).not.toBe(notAsked?.key);
    for (const dict of [ru, en]) phrase(dict, asked!.key);
  });
});

describe("панель не выдумывает состояние, которого не знает", () => {
  const state = (check: unknown) => ({
    gate: { mode: "PENDING" as const, reason: "PERSONA_NOT_CONFIRMED" },
    check,
  });

  it("состояние не прочитано — так и сказано, а не «панель ещё не собиралась»", () => {
    expect(personaPanelView({ state: null, loadFailed: true })).toBe("LOAD_FAILED");
    for (const dict of [ru, en]) phrase(dict, "persona.loadFailed");
  });

  it("состояние ещё не пришло — ничего не утверждается", () => {
    expect(personaPanelView({ state: null, loadFailed: false })).toBe("LOADING");
  });

  it("состояние прочитано и снимка нет — панель не собиралась", () => {
    expect(personaPanelView({ state: state(null), loadFailed: false })).toBe("NOT_BUILT");
  });

  it("снимок есть — показываются карточки", () => {
    expect(personaPanelView({ state: state({ checkId: "check-1" }), loadFailed: false })).toBe(
      "BUILT"
    );
  });
});

describe("отказ старта по воротам ведёт в панель", () => {
  const conflict = (reason: string): DigitalProfileApiError =>
    new DigitalProfileApiError("CONFLICT", 409, "persona gate", { reason });

  it("каждая причина ворот переводится в обоих кабинетах", () => {
    for (const reason of [
      "PERSONA_NOT_CONFIRMED",
      "PERSONA_DECISION_STALE",
      "PERSONA_GATE_UNAVAILABLE",
    ]) {
      const key = personaBlockKey(conflict(reason));
      expect(key, reason).not.toBeNull();
      for (const dict of [ru, en]) phrase(dict, key!);
    }
  });

  it("чужой отказ панель не присваивает", () => {
    expect(personaBlockKey(new DigitalProfileApiError("CONFLICT", 409, "preserved stages"))).toBeNull();
    expect(personaBlockKey(new DigitalProfileApiError("NOT_FOUND", 404, "нет дела"))).toBeNull();
    expect(personaBlockKey(new Error("сеть"))).toBeNull();
  });

  it("страница дела прокручивает оператора к панели по тому же якорю", () => {
    const view = read("client/CaseDetailView.tsx");
    const panel = read("client/SubjectPersonaPanel.tsx");
    // Имя якоря — одно на обе стороны: разъехавшиеся строки не прокрутят никуда.
    expect(view).toMatch(/PERSONA_PANEL_ANCHOR/u);
    expect(view).toMatch(/scrollIntoView/u);
    expect(panel).toMatch(/id=\{PERSONA_PANEL_ANCHOR\}/u);
    expect(PERSONA_PANEL_ANCHOR).toBe("subject-persona-panel");
  });
});

describe("на вопрос «может ли этот пользователь решать» отвечают один раз", () => {
  it("панель права не пересчитывает: их проверил монтаж и сервер", () => {
    const panel = read("client/SubjectPersonaPanel.tsx");
    expect(panel).not.toMatch(/\bcan\(/u);
    expect(read("client/CaseDetailView.tsx")).toMatch(
      /can\("agents\.run"\) \? \(\s*<Card>\s*<SubjectPersonaPanel/u
    );
  });

  it("готовые фразы панель не печатает и отказ чтения не глотает", () => {
    const panel = read("client/SubjectPersonaPanel.tsx");
    expect(panel).toMatch(/personaSourceReason/u);
    expect(panel).not.toMatch(/s\.reason/u);
    expect(panel).not.toMatch(/catch\(\(\) => null\)/u);
  });
});
