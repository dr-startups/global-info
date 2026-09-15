import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Рисковые запросы включает режим прогона, а не глобальная настройка.
 *
 * Решение заказчика 11.09: «ФИО + суд / банкротство / санкции» спрашиваются
 * только для прогонов сайта; `ORION_INCLUDE_RISK_PROBES` не меняется, и админка
 * получает прежнее поведение. Ответ на вопрос «включены ли пробы для этого
 * прогона» один — `riskProbesEnabled`, — и он доезжает до агента данными
 * контекста. Основание обработки при этом по-прежнему спрашивается: режим не
 * открывает негативных запросов по делу, где их открывать нельзя.
 *
 * Там же — зарубежный контур: у проверки с сайта регион один, а агент
 * зарубежной выдачи передаёт регионы явно и спросил бы UAE по делу из России.
 */

const rig = vi.hoisted(() => ({ calls: [] as Array<[string, Record<string, unknown> | undefined]> }));

/*
 * Подмена — без `importOriginal`. Настоящий сервис по цепочке импортов доходит до
 * реестра агентов, реестр — до агента профиля поиска, а агент — до подменяемого
 * сервиса. Круг, замкнутый во время подмены, отдавал агенту неподменённую
 * функцию, и проверка «проба доходит до агента» не проверяла ничего. Чистую
 * функцию сервиса тест берёт у настоящего модуля отдельно.
 */
vi.mock("@/modules/digital-profile/services/orion-search-profile-service", () => ({
  runOrionSearchProfile: async (caseId: string, options?: Record<string, unknown>) => {
    rig.calls.push([caseId, options]);
    return { plan: [], organicInserted: 0, surfacesInserted: 0, regions: [] };
  },
}));

const { riskProbesEnabled } = await import("@/modules/digital-profile/providers/config");
const { resolveIncludeRiskProbes } = await vi.importActual<
  typeof import("@/modules/digital-profile/services/orion-search-profile-service")
>("@/modules/digital-profile/services/orion-search-profile-service");
const { buildOrionQueryPlanDetailed } = await import(
  "@/modules/digital-profile/search-surfaces/orion-query-plan"
);
const agents = await import("@/modules/digital-profile/agents/real/real-orion-search-profile-agent");
const { agentContextFor, planFullAuditSteps } = await import(
  "@/modules/digital-profile/services/agent-run-service"
);

beforeEach(() => {
  rig.calls.length = 0;
});

const LEGIT = { lawfulBasis: "LEGITIMATE_INTEREST", consentStatus: "OBTAINED" };
const CONSENT_PENDING = { lawfulBasis: "CONSENT", consentStatus: "PENDING" };

describe("режим решает, включены ли пробы", () => {
  it.each([
    ["light", false, true],
    ["light", true, true],
    ["full", false, false],
    ["full", true, true],
  ] as const)("режим %s при настройке %s → %s", (mode, configured, expected) => {
    expect(riskProbesEnabled(mode, configured)).toBe(expected);
  });
});

describe("основание обработки спрашивается и при включённых пробах", () => {
  it.each([
    ["проба режима при законном интересе", true, LEGIT, false, true],
    ["проба режима при неполученном согласии", true, CONSENT_PENDING, false, false],
    ["без опции — настройка выключена", undefined, LEGIT, false, false],
    ["без опции — настройка включена", undefined, LEGIT, true, true],
    ["опция «нет» сильнее настройки", false, LEGIT, true, false],
  ] as const)("%s", (_label, option, subject, configured, expected) => {
    expect(resolveIncludeRiskProbes(option, subject, configured)).toBe(expected);
  });
});

describe("план запросов", () => {
  const subject = { fullName: "Иванов Иван Иванович", aliases: [], targetRegions: ["RU"] };

  it("рисковые строки появляются только с пробами, и ключ кэша плана различает режимы", () => {
    const withProbes = buildOrionQueryPlanDetailed(subject, { includeRiskProbes: true });
    const without = buildOrionQueryPlanDetailed(subject, { includeRiskProbes: false });
    expect(withProbes.plan.some((q) => q.priority === "risk_probe")).toBe(true);
    expect(without.plan.some((q) => q.priority === "risk_probe")).toBe(false);
    expect(withProbes.queryPlanId).not.toBe(without.queryPlanId);
  });
});

describe("проба доходит до агентов профиля поиска", () => {
  const ctx = { caseId: "case-1", actorId: "self-check:check-1", mock: false, includeRiskProbes: true };

  it("профиль поиска", async () => {
    await new agents.RealOrionSearchProfileAgent().run(ctx);
    expect(rig.calls).toEqual([["case-1", expect.objectContaining({ includeRiskProbes: true })]]);
  });

  it("поверхности Google", async () => {
    await new agents.RealOrionGoogleSurfacesAgent().run(ctx);
    expect(rig.calls[0]![1]).toMatchObject({ surfacesOnlyMode: true, includeRiskProbes: true });
  });

  it("контекст агента несёт пробу из опций полного аудита", () => {
    expect(agentContextFor("case-1", { kind: "REAL" }, { actorId: "u1" }, { includeRiskProbes: true })).toEqual({
      caseId: "case-1",
      actorId: "u1",
      mock: false,
      includeRiskProbes: true,
    });
    expect(agentContextFor("case-1", { kind: "MOCK" }, {}, {})).toEqual({
      caseId: "case-1",
      actorId: "system",
      mock: true,
    });
  });
});

describe("зарубежный контур", () => {
  const steps = [
    { providerId: "yandex", phase: "collection", primaryAgent: "REAL_YANDEX_SEARCH", primaryRuntime: "real" },
    {
      providerId: "orion_uae_international",
      phase: "collection",
      primaryAgent: "REAL_ORION_UAE_INTERNATIONAL",
      primaryRuntime: "real",
    },
    { providerId: "risk", phase: "enrichment", primaryAgent: "RISK_CLASSIFIER_V1", primaryRuntime: "real" },
  ] as const;

  it("пропущенный провайдер из шагов аудита уходит, остальные остаются по порядку", () => {
    expect(planFullAuditSteps([...steps], ["orion_uae_international"]).map((s) => s.providerId)).toEqual([
      "yandex",
      "risk",
    ]);
  });

  it("без пропусков — шаги как есть", () => {
    expect(planFullAuditSteps([...steps], []).map((s) => s.providerId)).toEqual([
      "yandex",
      "orion_uae_international",
      "risk",
    ]);
  });
});
