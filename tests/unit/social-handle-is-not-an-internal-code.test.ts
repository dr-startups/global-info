/**
 * Ник в соцсети не внутренний код и оплаченный отчёт не останавливает.
 *
 * Живой прогон 21.08 (кейс Кремлёв) встал на воротах качества текста:
 * «внутренние коды в клиентском тексте на 6 страницах … коды: umar_kremlev,
 * shara_bullet77». Так подписаны аккаунты, попавшие в заголовки страниц
 * выдачи. В корпусе прогона Ким такие же: `tangerina_kim`, `rbc_ru`, `aleko_n`.
 *
 * Правило нижнего регистра заводилось ради имён наборов OpenSanctions
 * (`ext_gb_coh_psc`, `ru_billionaires_2021`), печатавшихся клиенту как
 * «источники». Но по форме имя набора и ник неотличимы — и модуль это знал
 * заранее: в его же комментарии сказано, что на прогоне 73 сборку остановило бы
 * ложное срабатывание на адресе `leonid_mihelson`.
 *
 * Решение владельца 21.08: нижний регистр остаётся замечанием и сборку не
 * блокирует. Наши коды пишутся ЗАГЛАВНЫМИ и блокируют как раньше.
 */

import { describe, expect, it } from "vitest";
import {
  findInternalCodes,
  findLowercaseCodeLikeTokens,
  scanDeckForCodeLikeTokens,
  scanDeckForInternalCodes,
  type ClientVisibleSlide,
} from "@/modules/digital-profile/orion-golden/deck-sections/internal-code-scan";

const HANDLE_TITLE = "Умар Кремлев (@umar_kremlev) — интервью";
const OUR_CODE_TEXT = "Экспорт недоступен (VISUAL_ASSET_UNAVAILABLE); текст приведён ниже.";

function slide(key: string, text: string): ClientVisibleSlide {
  return { slideKey: key, bullets: [text] };
}

describe("ник и внутренний код — разные вопросы", () => {
  it("ник кодом не считается", () => {
    expect(findInternalCodes(HANDLE_TITLE)).toEqual([]);
    expect(findInternalCodes("aleko_n on June 7, 2026: «интервью»")).toEqual([]);
    expect(findInternalCodes("Источники: ru_billionaires_2021, eu_fsf.")).toEqual([]);
  });

  it("наш код по-прежнему код", () => {
    expect(findInternalCodes(OUR_CODE_TEXT)).toEqual(["VISUAL_ASSET_UNAVAILABLE"]);
    expect(findInternalCodes("PRE_RENDER_DATA_GATE_FAILED")).toEqual([
      "PRE_RENDER_DATA_GATE_FAILED",
    ]);
  });

  it("нижний регистр всё равно виден — отдельным вопросом", () => {
    expect(findLowercaseCodeLikeTokens(HANDLE_TITLE)).toEqual(["umar_kremlev"]);
    expect(findLowercaseCodeLikeTokens("Источники: ru_billionaires_2021, eu_fsf.")).toEqual([
      "ru_billionaires_2021",
      "eu_fsf",
    ]);
  });
});

describe("шесть страниц с ником сборку не останавливают", () => {
  const slides = [
    "p03_executive__cont2",
    "p07_ru_summary__cont2",
    "p09_ru_serp_table",
    "p09_ru_serp_table__cont2",
    "p10_ru_serp_visual__why3",
    "p26_uae_serp_table",
  ].map((k) => slide(k, `На странице iba.sport — ${HANDLE_TITLE}: «цитата».`));

  it("сторож блокирующих кодов молчит", () => {
    expect(scanDeckForInternalCodes(slides)).toEqual([]);
  });

  it("а замечание остаётся и называет ник", () => {
    const seen = scanDeckForCodeLikeTokens(slides);
    expect(seen).toHaveLength(6);
    expect(seen.map((f) => f.code)).toEqual(Array(6).fill("umar_kremlev"));
  });

  it("наш код на тех же страницах по-прежнему ловится", () => {
    const withOurCode = slides.map((s) => slide(String(s.slideKey), OUR_CODE_TEXT));
    expect(scanDeckForInternalCodes(withOurCode)).toHaveLength(6);
  });
});
