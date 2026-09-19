import { describe, expect, it } from "vitest";
import { SITE_PAGES } from "@/modules/site/content/pages";
import { SERVICES, SERVICES_HUB } from "@/modules/site/content/services";

/**
 * Хаб услуг называет услуги по роли, а не по условию (владелец 19.09.2026).
 *
 * Раньше страница говорила «сначала бесплатная проверка, а если негатив найден —
 * вот что мы с ним делаем»: список читался платным продолжением проверки. Теперь
 * поиск негатива — основная услуга, остальные — дополнительные.
 */
describe("Хаб услуг: основная услуга и дополнительные", () => {
  it("подводка называет поиск основной услугой, остальные — дополнительными", () => {
    expect(SERVICES_HUB.lead).toMatch(/Основная услуга/u);
    expect(SERVICES_HUB.lead).toMatch(/ополнительные/u);
  });

  it("условия «если негатив найден» на странице больше нет", () => {
    const hub = JSON.stringify(SERVICES_HUB);
    expect(hub).not.toMatch(/Если негатив найден/u);
    expect(hub).not.toMatch(/Если есть —/u);
    expect(SERVICES_HUB.hubTitle).toBe("Дополнительные услуги");
  });

  it("мета-описание говорит то же, что подводка, — одной строкой", () => {
    expect(SERVICES_HUB.description).toBe(SERVICES_HUB.lead);
    const page = SITE_PAGES.find((entry) => entry.path === SERVICES_HUB.path);
    expect(page?.description).toBe(SERVICES_HUB.lead);
  });

  it("первая услуга списка — поиск негатива: страница показывает её отдельным листом", () => {
    expect(SERVICES[0]!.slug).toBe("poisk-negativa");
  });
});

describe("Срок ответа поисковика назван числом дней, а не формулой", () => {
  it("«10 + 10» нет ни в одной услуге", () => {
    expect(JSON.stringify(SERVICES)).not.toMatch(/10\s*\+\s*10/u);
  });

  it("в фактах услуги — срок из ст. 10.3 149-ФЗ, в шапке и в карточке хаба одинаково", () => {
    const service = SERVICES.find((entry) => entry.slug === "udalenie-iz-poiskovoy-vydachi")!;
    const term = (facts: readonly (readonly [string, string])[]) => facts.find(([name]) => name === "Срок ответа")?.[1];
    expect(term(service.stats)).toBe("до 10 рабочих дней");
    expect(term(service.hub.facts)).toBe("до 10 рабочих дней");
  });
});
