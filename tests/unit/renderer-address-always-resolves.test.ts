import { describe, expect, it } from "vitest";
import {
  createCanonicalDeckRenderAdapter,
  isLocalPythonRenderAllowed,
} from "../../src/modules/digital-profile/services/render-deck-artifacts";

/**
 * Отчёт не должен падать из-за незаданного адреса рендерера.
 *
 * Заказчик получил «render failed: Renderer not configured: set
 * DIGITAL_PROFILE_RENDERER_URL (or RENDERER_URL)…» при полностью рабочей
 * связке. Адрес рендерера к тому моменту уже переехал в значения по умолчанию
 * — на Railway это внутреннее имя сервиса, локально соседний порт, — но выбор
 * пути отрисовки спрашивал не адрес, а «задана ли переменная явно». Один
 * вопрос, два разных ответа в двух местах.
 *
 * Здесь проверяется свойство, а не текст: без единой переменной окружения
 * сборка идёт в сервис по HTTP, а не отказывается стартовать.
 */

/** Подменяет обращение к сервису, чтобы тест не ходил в сеть. */
function httpProbe() {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        throw new Error("сеть в тесте недоступна");
      }) as unknown as typeof fetch,
    },
  };
}

const INPUT = { deck: { slides: [] }, caseId: "case-1", runId: "run-1" } as never;

describe("адрес рендерера разрешается всегда", () => {
  it("без переменных окружения сборка идёт по HTTP, а не отказывает", async () => {
    const prev = { r: process.env.RENDERER_URL, d: process.env.DIGITAL_PROFILE_RENDERER_URL };
    delete process.env.RENDERER_URL;
    delete process.env.DIGITAL_PROFILE_RENDERER_URL;
    try {
      const probe = httpProbe();
      const render = createCanonicalDeckRenderAdapter(probe.deps);
      const error = await render(INPUT).then(
        () => null,
        (e: unknown) => String((e as Error).message)
      );
      // Отказ по сети допустим — отказ «не настроено» нет.
      expect(error).not.toMatch(/Renderer not configured/i);
      expect(error).not.toMatch(/ORION_CANONICAL_ALLOW_LOCAL_RENDER/i);
    } finally {
      if (prev.r != null) process.env.RENDERER_URL = prev.r;
      if (prev.d != null) process.env.DIGITAL_PROFILE_RENDERER_URL = prev.d;
    }
  });

  it("пустая переменная означает «не задано», а не пустой адрес", async () => {
    // Оператор, оставивший поле пустым, ожидает поведения по умолчанию.
    // `??` пропускает пустую строку дальше, и адрес обнулялся.
    const prev = process.env.RENDERER_URL;
    process.env.RENDERER_URL = "   ";
    try {
      const { digitalProfileConfig } = await import(
        "../../src/modules/digital-profile/config"
      );
      expect(digitalProfileConfig.rendererUrl.trim().length).toBeGreaterThan(0);
    } finally {
      if (prev != null) process.env.RENDERER_URL = prev;
      else delete process.env.RENDERER_URL;
    }
  });

  it("локальный python остаётся сугубо по явному требованию", () => {
    const prev = {
      r: process.env.RENDERER_URL,
      a: process.env.ORION_CANONICAL_ALLOW_LOCAL_RENDER,
    };
    delete process.env.RENDERER_URL;
    delete process.env.ORION_CANONICAL_ALLOW_LOCAL_RENDER;
    try {
      // Значение по умолчанию само по себе python не включает.
      expect(isLocalPythonRenderAllowed()).toBe(false);
      process.env.ORION_CANONICAL_ALLOW_LOCAL_RENDER = "1";
      expect(isLocalPythonRenderAllowed()).toBe(true);
      // Явно заданный адрес сервиса перекрывает требование: молчаливого
      // отступления с HTTP на локальный python быть не должно.
      process.env.RENDERER_URL = "http://renderer:8080";
      expect(isLocalPythonRenderAllowed()).toBe(false);
    } finally {
      if (prev.r != null) process.env.RENDERER_URL = prev.r;
      else delete process.env.RENDERER_URL;
      if (prev.a != null) process.env.ORION_CANONICAL_ALLOW_LOCAL_RENDER = prev.a;
      else delete process.env.ORION_CANONICAL_ALLOW_LOCAL_RENDER;
    }
  });
});
