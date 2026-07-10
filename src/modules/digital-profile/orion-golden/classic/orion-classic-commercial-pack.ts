/**
 * R10.12 — Static commercial pack (after audit). Dense, capped — ORION boundary ~offer onward.
 */

import { sanitizeOrionGoldenClientText } from "../client/client-text-sanitizer";
import type { SectionBlock } from "../report-spec/orion-report-spec";
import { chunkItems, truncateAtWordBoundary } from "./orion-classic-text-utils";

const BULLETS_PER_COMMERCIAL_SLIDE = 4;
/** Hard cap commercial pages so audit remains the majority of the deck. */
const MAX_SLIDES_PER_BLOCK = 2;

function staticSlides(
  sectionKey: string,
  title: string,
  template: string,
  bullets: string[]
): SectionBlock["slideSpecs"] {
  const chunks = chunkItems(
    bullets.map((b) => truncateAtWordBoundary(b, 280)),
    BULLETS_PER_COMMERCIAL_SLIDE
  ).slice(0, MAX_SLIDES_PER_BLOCK);
  if (chunks.length === 0) {
    return [
      {
        slideKey: `${sectionKey}-1`,
        template,
        title: sanitizeOrionGoldenClientText(title),
        bullets: [],
      },
    ];
  }
  return chunks.map((chunk, idx) => ({
    slideKey: `${sectionKey}-${idx + 1}`,
    template,
    title:
      chunks.length > 1
        ? sanitizeOrionGoldenClientText(`${title} (${idx + 1}/${chunks.length})`)
        : sanitizeOrionGoldenClientText(title),
    bullets: chunk,
  }));
}

function commercialBlock(
  sectionKey: string,
  title: string,
  template: string,
  bullets: string[]
): SectionBlock {
  const slideSpecs = staticSlides(sectionKey, title, template, bullets);
  return {
    sectionTitle: title,
    metrics: { slides: slideSpecs.length, kind: "commercial_static" },
    narrative: truncateAtWordBoundary(bullets[0] ?? "", 320),
    tables: [],
    evidenceCards: [],
    visualAssets: [],
    slideSpecs,
    sourceRefs: [],
    qaMetadata: { sectionKey },
  };
}

export function buildOrionClassicCommercialPack(): {
  offer: SectionBlock;
  productOverview: SectionBlock;
  solutionDigitalProfile: SectionBlock;
  solutionComplianceDatabases: SectionBlock;
  solutionWikipedia: SectionBlock;
  about: SectionBlock;
} {
  return {
    offer: commercialBlock("offer", "Наше предложение", "orion_golden_offer", [
      "По итогам аудита цифрового профиля готовы предложить программу снижения комплаенс-рисков и формирования целевого цифрового образа.",
      "Нежелательные публикации в TOP выдачи могут блокировать KYC, счета и резидентство — нужна стратегия вытеснения и контекстной коррекции.",
      "Работаем с Dow Jones, World-Check и LexisNexis: актуализация профилей и снижение ложных срабатываний.",
      "Следующий шаг — согласовать цели клиента и выбрать пакет работ.",
    ]),
    productOverview: commercialBlock(
      "product_overview",
      "Цифровой профиль: обзор продукта",
      "orion_golden_product_overview",
      [
        "Цифровой профиль ORION — проверка открытых источников, поисковых поверхностей и комплаенс-баз.",
        "Отчёт показывает TOP выдачи, подсказки, медиа, Wikipedia и международные базы как единый сюжет риска.",
        "Публичная выдача Google/Яндекс — основной источник для банков и compliance-систем.",
      ]
    ),
    solutionDigitalProfile: commercialBlock(
      "solution_digital_profile",
      "Решение 1: Цифровой профиль",
      "orion_golden_solution",
      [
        "Сбор и контроль TOP-20 / подсказок / медиа по ключевым рынкам.",
        "Программа вытеснения нежелательных ссылок и формирования нейтрального следа.",
        "Регулярный мониторинг изменений выдачи с алертами.",
      ]
    ),
    solutionComplianceDatabases: commercialBlock(
      "solution_compliance_databases",
      "Решение 2: World-Check, LexisNexis и Dow Jones",
      "orion_golden_solution",
      [
        "Разбор статусов RCA/PEP, связей и Media-Check.",
        "Сопровождение коммуникации с банками на основе первоисточников.",
        "Закрытие ложных совпадений и документирование идентификаторов.",
      ]
    ),
    solutionWikipedia: commercialBlock(
      "solution_wikipedia",
      "Решение 3: Википедия",
      "orion_golden_solution",
      [
        "Проверка заметности и подготовка нейтральной энциклопедической базы.",
        "Сопровождение публикации только при устойчивой источниковой опоре.",
      ]
    ),
    about: commercialBlock("about", "О нас", "orion_golden_about", [
      "ORION — due diligence и управление цифровым профилем для частных клиентов и compliance-команд.",
      "Сочетаем OSINT, комплаенс-базы и практику управления репутацией в поиске.",
    ]),
  };
}
