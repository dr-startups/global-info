/**
 * Позиции и адреса Google берёт Serper, а не Topvisor (шаг 0136).
 *
 * Владелец 20.09.2026: «в графе „ссылка“ должна быть именно ссылка, чтобы
 * клиент убедился, что мы не туфту ему загоняем, а пруфанули ссылкой».
 *
 * Topvisor адреса страницы для Google не отдаёт — проверено живым запросом к
 * снимку проекта 33429073 за 2026-09-20: у Яндекса в поле `url` стоит
 * «https://ru.wikipedia.org/wiki/Мордашов,_Алексей_Александрович», у Google —
 * «https://en.wikipedia.org». Другие имена полей сервис отвергает:
 * `code 2002: Expected value: url, domain, snippet_title, snippet_body,
 * snippet_ext`.
 *
 * Serper при этом органику Google не собирал вовсе: базовый сбор пропускал
 * провайдеров выдачи одинаково для обоих движков. Теперь источник позиций
 * объявлен один раз (`POSITIONAL_SERP_SOURCE`), и его читают оба места,
 * которые иначе ответили бы порознь.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POSITIONAL_SERP_SOURCE } from "@/modules/digital-profile/config/defaults";
import { resolveRuntimeStrategy } from "@/modules/digital-profile/agents/runtime-strategy";
import { topvisorPositionRegions } from "@/modules/digital-profile/services/topvisor-positions-tick";
import { TOPVISOR_AUDIT_REGIONS } from "@/modules/digital-profile/providers/topvisor/regions";

describe("источник позиций объявлен один раз", () => {
  it("И1: Яндекс — Topvisor, Google — Serper", () => {
    expect(POSITIONAL_SERP_SOURCE.YANDEX).toBe("topvisor");
    expect(POSITIONAL_SERP_SOURCE.GOOGLE).toBe("serper");
  });
});

describe("стратегия сбора читает этот источник", () => {
  // Режим сбора стратегия читает из окружения процесса; тест задаёт его сам,
  // иначе его ответ зависел бы от того, как запущен прогон.
  const saved = process.env.SERP_COLLECTION_PROVIDER;
  beforeEach(() => {
    process.env.SERP_COLLECTION_PROVIDER = "topvisor";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SERP_COLLECTION_PROVIDER;
    else process.env.SERP_COLLECTION_PROVIDER = saved;
  });

  const decisionsOf = () => {
    const s = resolveRuntimeStrategy({ mode: "real_only" });
    return s.decisions.filter((x) => x.phase === "collection");
  };

  it("И2: Яндекс делегирован Topvisor, Google — нет", () => {
    const decisions = decisionsOf();
    const yandex = decisions.find((x) => x.providerId === "yandex");
    const google = decisions.find((x) => x.providerId === "google");
    expect(yandex?.reason ?? "").toMatch(/Topvisor/u);
    expect(google?.reason ?? "").not.toMatch(/органическую выдачу собирает Topvisor/u);
  });
});

describe("позициями работает только движок Topvisor", () => {
  it("И3: органика берётся у Яндекса; Google в этот список не входит", () => {
    const planned = topvisorPositionRegions();
    expect(planned.map((r) => r.key)).toEqual(["yandex-moscow"]);
  });

  it("И4: каталог регионов не тронут — по Google живут подсказки и ИИ-ответы", () => {
    expect(TOPVISOR_AUDIT_REGIONS.map((r) => r.key)).toEqual([
      "yandex-moscow",
      "google-moscow",
      "google-dubai",
    ]);
  });
});
