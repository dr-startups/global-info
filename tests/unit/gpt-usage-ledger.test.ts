/**
 * Расход модели считается по стадиям (шаг 0119).
 *
 * Ответ API несёт `usage`, но клиент читал из него только `output_tokens` и
 * только чтобы понять, не обрезан ли ответ. Поэтому на вопрос «сколько стоит
 * дело» отвечал счёт из кабинета, а не отчёт: какая стадия сколько съела —
 * неизвестно, и экономию от смены модели нечем измерить.
 *
 * Стоимость — оценка по таблице цен на названную дату, и считается она так же,
 * как берёт деньги провайдер: обычный вход, кэшированный вход по своей цене,
 * запись кэша с наценкой, выход (рассуждение провайдер уже включил в выход).
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  consumeGptUsage,
  recordGptUsage,
  resetGptUsage,
  runWithGptUsage,
} from "@/modules/digital-profile/orion-golden/gpt/gpt-usage";
import { GPT_PRICE_TABLE_DATE, modelForStage } from "@/modules/digital-profile/config/defaults";
import { callOpenAiStrictJsonOnce } from "@/modules/digital-profile/orion-golden/gpt/openai-json-client";

/** Ответы провайдера по очереди: счёт токенов и признак обрезки. */
function fakeFetch(
  usages: Array<Record<string, number>>,
  statuses: string[] = ["completed"]
): typeof fetch {
  let n = 0;
  return (async () => {
    const usage = usages[Math.min(n, usages.length - 1)]!;
    const status = statuses[Math.min(n, statuses.length - 1)]!;
    n += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status,
        ...(status === "incomplete"
          ? { incomplete_details: { reason: "max_output_tokens" } }
          : {}),
        usage,
        output: [{ content: [{ type: "output_text", text: '{"ok":true}' }] }],
      }),
    };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  resetGptUsage();
});

describe("счёт расхода по стадиям", () => {
  it("У1: два вызова разных стадий дают две строки, сумму и стоимость", () => {
    recordGptUsage({
      stage: "link_verdict",
      model: "gpt-5.6-terra",
      usage: { input_tokens: 10_000, output_tokens: 500 },
    });
    recordGptUsage({
      stage: "slide_copy",
      model: "gpt-5.6-sol",
      usage: { input_tokens: 5_000, output_tokens: 1_000 },
    });
    const ledger = consumeGptUsage();

    expect(ledger.priceTableDate).toBe(GPT_PRICE_TABLE_DATE);
    expect(ledger.calls).toBe(2);
    expect(ledger.inputTokens).toBe(15_000);
    expect(ledger.outputTokens).toBe(1_500);

    const read = ledger.byStage.find((s) => s.stage === "link_verdict")!;
    expect(read.model).toBe("gpt-5.6-terra");
    expect(read.calls).toBe(1);
    // Terra: $2 за 1 млн входа, $12 за 1 млн выхода.
    expect(read.costUsd).not.toBeNull();
    expect(read.costUsd!).toBeCloseTo(10_000 / 1e6 * 2 + 500 / 1e6 * 12, 8);

    const copy = ledger.byStage.find((s) => s.stage === "slide_copy")!;
    // Sol: $4 вход, $20 выход.
    expect(copy.costUsd!).toBeCloseTo(5_000 / 1e6 * 4 + 1_000 / 1e6 * 20, 8);
    expect(ledger.costUsd).toBeCloseTo(read.costUsd! + copy.costUsd!, 8);
  });

  it("У2: снятый счёт обнуляется — следующее дело не наследует чужие числа", () => {
    recordGptUsage({
      stage: "link_verdict",
      model: "gpt-5.6-terra",
      usage: { input_tokens: 1_000, output_tokens: 10 },
    });
    expect(consumeGptUsage().calls).toBe(1);
    const second = consumeGptUsage();
    expect(second.calls).toBe(0);
    expect(second.byStage).toEqual([]);
    expect(second.costUsd).toBe(0);
  });

  it("У3: ответ без счёта токенов — это вызов с нулём, а не пропущенный вызов", () => {
    recordGptUsage({ stage: "wikipedia_review", model: "gpt-5.6-terra" });
    const ledger = consumeGptUsage();
    expect(ledger.calls).toBe(1);
    expect(ledger.inputTokens).toBe(0);
    expect(ledger.outputTokens).toBe(0);
    expect(ledger.byStage[0]!.callsWithoutUsage).toBe(1);
  });

  it("У4: кэшированный вход и запись кэша считаются по своим ценам", () => {
    recordGptUsage({
      stage: "link_verdict",
      model: "gpt-5.6-terra",
      usage: {
        input_tokens: 10_000,
        output_tokens: 0,
        input_tokens_details: { cached_tokens: 8_000 },
      },
    });
    const cached = consumeGptUsage();
    expect(cached.cachedInputTokens).toBe(8_000);
    // 2 000 обычных по $2 и 8 000 кэшированных по $0.2 за 1 млн.
    expect(cached.costUsd).toBeCloseTo(2_000 / 1e6 * 2 + 8_000 / 1e6 * 0.2, 8);

    resetGptUsage();
    recordGptUsage({
      stage: "link_verdict",
      model: "gpt-5.6-terra",
      usage: {
        input_tokens: 10_000,
        output_tokens: 0,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 10_000 },
      },
    });
    const written = consumeGptUsage();
    expect(written.cacheWriteTokens).toBe(10_000);
    // Запись кэша дороже обычного входа в 1,25 раза.
    expect(written.costUsd).toBeCloseTo(10_000 / 1e6 * 2 * 1.25, 8);
  });

  it("У6: вызов клиента попадает в счёт сам — стадией и моделью своей таблицы", async () => {
    // Без этой проверки удаление записи из клиента оставило бы все остальные
    // зелёными, а учёт молча перестал бы работать (написана после кода и
    // подтверждена мутацией, а не красным логом).
    await callOpenAiStrictJsonOnce({
      stage: "link_verdict",
      systemPrompt: "s",
      userPayload: {},
      fetchImpl: fakeFetch([{ input_tokens: 7_000, output_tokens: 300 }]),
    });
    const ledger = consumeGptUsage();
    expect(ledger.calls).toBe(1);
    expect(ledger.byStage[0]!.stage).toBe("link_verdict");
    // Модель берётся из таблицы, а не переписывается здесь: после переезда
    // чтения на Sol (шаг 0120) приколоченное имя сделало бы тест ложным.
    expect(ledger.byStage[0]!.model).toBe(modelForStage("link_verdict"));
    expect(ledger.inputTokens).toBe(7_000);
    expect(ledger.outputTokens).toBe(300);
  });

  it("У7: повтор при обрезанном ответе — второй оплаченный вызов, и он в счёте", async () => {
    await callOpenAiStrictJsonOnce({
      stage: "slide_copy",
      systemPrompt: "s",
      userPayload: {},
      fetchImpl: fakeFetch(
        [
          { input_tokens: 1_000, output_tokens: 900 },
          { input_tokens: 1_000, output_tokens: 1_500 },
        ],
        ["incomplete", "completed"]
      ),
    });
    const ledger = consumeGptUsage();
    expect(ledger.calls).toBe(2);
    expect(ledger.outputTokens).toBe(2_400);
  });

  it("У8: два прогона, идущие одновременно, не смешивают счёт", async () => {
    // Три прогона 20.09.2026 шли в одном процессе, и артефакты вышли такими:
    // у первого 259 вызовов всех трёх дел, у второго 6, у третьего 0.
    const started: Array<() => void> = [];
    const hold = () => new Promise<void>((resolve) => started.push(resolve));

    const runA = runWithGptUsage(async () => {
      recordGptUsage({
        stage: "link_verdict",
        model: "gpt-5.6-sol",
        usage: { input_tokens: 1_000, output_tokens: 100 },
      });
      await hold();
      recordGptUsage({
        stage: "link_verdict",
        model: "gpt-5.6-sol",
        usage: { input_tokens: 1_000, output_tokens: 100 },
      });
    });
    const runB = runWithGptUsage(async () => {
      recordGptUsage({
        stage: "slide_copy",
        model: "gpt-5.6-sol",
        usage: { input_tokens: 5_000, output_tokens: 500 },
      });
      await hold();
    });
    // Оба прогона начались и ждут; отпускаем их вперемешку.
    await new Promise((r) => setTimeout(r, 10));
    for (const resume of started) resume();

    const a = await runA;
    const b = await runB;
    expect(a.usage.calls).toBe(2);
    expect(a.usage.byStage.map((s) => s.stage)).toEqual(["link_verdict"]);
    expect(a.usage.inputTokens).toBe(2_000);
    expect(b.usage.calls).toBe(1);
    expect(b.usage.byStage.map((s) => s.stage)).toEqual(["slide_copy"]);
    expect(b.usage.inputTokens).toBe(5_000);
  });

  it("У9: вызов вне области прогона в его счёт не попадает", async () => {
    // Авто-аналитик очереди идёт другим входом; его вызовы не должны оседать
    // в счёте дела, которое готовится в это же время.
    recordGptUsage({
      stage: "auto_analyst",
      model: "gpt-5.6-terra",
      usage: { input_tokens: 9_000, output_tokens: 900 },
    });
    const { usage } = await runWithGptUsage(async () => {
      recordGptUsage({
        stage: "case_analysis",
        model: "gpt-5.6-sol",
        usage: { input_tokens: 1_000, output_tokens: 100 },
      });
    });
    expect(usage.calls).toBe(1);
    expect(usage.byStage[0]!.stage).toBe("case_analysis");
  });

  it("У10: админская проверка очереди пишет свой счёт, а не общий", async () => {
    // Авто-аналитик идёт другим входом, и его вызовы прежде оседали в запасном
    // счёте процесса, который никто не снимает.
    const { usage } = await runWithGptUsage(async () => {
      recordGptUsage({
        stage: "auto_analyst",
        model: "gpt-5.6-terra",
        usage: { input_tokens: 4_000, output_tokens: 400 },
      });
    });
    expect(usage.calls).toBe(1);
    expect(usage.byStage[0]!.stage).toBe("auto_analyst");
    expect(usage.costUsd).toBeGreaterThan(0);
  });

  it("У11: счёт знает тариф — медленный стоит вдвое дешевле и назван в строке", () => {
    // Без этого артефакт показывал бы полную цену там, где заплачено
    // половина, и проверить, сработал ли медленный тариф, было бы нечем.
    recordGptUsage({
      stage: "link_verdict",
      model: "gpt-5.6-sol",
      tier: "flex",
      usage: { input_tokens: 10_000, output_tokens: 1_000 },
    });
    recordGptUsage({
      stage: "slide_copy",
      model: "gpt-5.6-sol",
      usage: { input_tokens: 10_000, output_tokens: 1_000 },
    });
    const ledger = consumeGptUsage();
    const flex = ledger.byStage.find((x) => x.stage === "link_verdict")!;
    const plain = ledger.byStage.find((x) => x.stage === "slide_copy")!;
    expect(flex.tier).toBe("flex");
    expect(plain.tier).toBeUndefined();
    expect(flex.costUsd!).toBeCloseTo(plain.costUsd! / 2, 8);
  });

  it("У5: неизвестная модель не роняет счёт и называется в артефакте", () => {
    // Модель могли сменить в таблице и забыть цену: числа токенов остаются,
    // стоимость честно неизвестна, а не молча ноль.
    recordGptUsage({
      stage: "identity",
      model: "gpt-неизвестная",
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    const ledger = consumeGptUsage();
    expect(ledger.byStage[0]!.inputTokens).toBe(100);
    expect(ledger.byStage[0]!.costUsd).toBeNull();
    expect(ledger.modelsWithoutPrice).toEqual(["gpt-неизвестная"]);
  });
});
