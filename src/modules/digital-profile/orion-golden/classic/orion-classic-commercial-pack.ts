/**
 * R10.11 — Static commercial content pack (full ORION offer + solutions + about).
 * Dense slides: multiple bullets per page (not one-bullet padding).
 */

import { sanitizeOrionGoldenClientText } from "../client/client-text-sanitizer";
import type { SectionBlock } from "../report-spec/orion-report-spec";
import { chunkItems, truncateAtWordBoundary } from "./orion-classic-text-utils";

const BULLETS_PER_COMMERCIAL_SLIDE = 3;

function staticSlides(
  sectionKey: string,
  title: string,
  template: string,
  bullets: string[]
): SectionBlock["slideSpecs"] {
  const chunks = chunkItems(
    bullets.map((b) => truncateAtWordBoundary(b, 280)),
    BULLETS_PER_COMMERCIAL_SLIDE
  );
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
    narrative: truncateAtWordBoundary(bullets[0] ?? "", 400),
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
      "По итогам аудита цифрового профиля мы готовы предложить комплекс работ по снижению комплаенс-рисков и формированию целевого цифрового образа.",
      "Нежелательные публикации в поисковой выдаче могут блокировать KYC, открытие счетов и получение резидентства — требуется стратегия вытеснения и контекстная коррекция.",
      "Мы работаем с международными базами Dow Jones, World-Check и LexisNexis: помогаем актуализировать профили и снизить ложные срабатывания.",
      "Цифровой профиль ORION — это не только мониторинг, но и управляемая программа по формированию нейтрального и подтверждаемого публичного следа.",
      "До/после: примеры вытеснения нежелательных ссылок из TOP-20 Google и Яндекса по ключевым запросам субъекта.",
      "Примеры биографий и справочных материалов, которые формируют устойчивый нейтральный контекст для банков и комплаенс-команд.",
      "Эффективный цифровой профиль сочетает контролируемые источники, медийную повестку и корректную структуру поисковых ассоциаций.",
      "Wikipedia: отсутствие или некорректная статья — отдельный риск; мы готовим обоснованные материалы и сопровождаем публикацию.",
    ]),
    productOverview: commercialBlock(
      "product_overview",
      "Цифровой профиль: обзор продукта",
      "orion_golden_product_overview",
      [
        "Цифровой профиль ORION — комплексная проверка открытых источников, поисковых поверхностей и комплаенс-баз.",
        "Отчёт включает TOP-20 выдачи, подсказки, похожие запросы, медиа-поверхности, Wikipedia и международные базы.",
        "Публичная информация в Google и Яндексе — основной источник для банков, партнёров и международных комплаенс-систем.",
        "Мы показываем не только факты, но и интерпретацию рисков с разделением подтверждённых сигналов и материалов на проверке.",
      ]
    ),
    solutionDigitalProfile: commercialBlock(
      "solution_digital_profile",
      "Решение 1: Цифровой профиль",
      "orion_golden_solution",
      [
        "Автоматизированный сбор данных из поисковых систем, Wikipedia и открытых источников по РФ, ОАЭ и международным зеркалам.",
        "Структурированный клиентский отчёт с визуальными доказательствами, таблицами позиций и тематическими кластерами риска.",
        "Программа вытеснения нежелательных ссылок и формирования целевого цифрового профиля под задачи клиента.",
        "Регулярный мониторинг изменений выдачи, подсказок и комплаенс-сигналов с оперативными алертами.",
      ]
    ),
    solutionComplianceDatabases: commercialBlock(
      "solution_compliance_databases",
      "Решение 2: World-Check, LexisNexis и Dow Jones",
      "orion_golden_solution",
      [
        "Подключение профессиональных комплаенс-баз для предварительной и углублённой проверки субъекта.",
        "Аналитическая сводка по статусам RCA/PEP, связям, Media-Check и рекомендациям по актуализации профиля.",
        "Сопровождение коммуникации с банками и комплаенс-командами на основе верифицированных первоисточников.",
        "Workflow по закрытию ложных совпадений и документированию идентификационных признаков субъекта.",
      ]
    ),
    solutionWikipedia: commercialBlock(
      "solution_wikipedia",
      "Решение 3: Википедия",
      "orion_golden_solution",
      [
        "Проверка публичного профиля и связанных статей Wikipedia по регионам аудита.",
        "Подготовка нейтральной биографической справки с опорой на подтверждаемые источники.",
        "Сопровождение публикации и актуализации статьи с учётом правил сообщества и рисков редактирования.",
      ]
    ),
    about: commercialBlock("about", "О нас", "orion_golden_about", [
      "ORION — решение для due diligence и цифрового профилирования субъектов проверки.",
      "Мы сочетаем аналитику открытых источников, комплаенс-базы и практику управления репутацией в цифровой среде.",
      "Команда ORION работает с частными клиентами, family office и корпоративными комплаенс-подразделениями.",
      "orion-solutions.ru — цифровой профиль как управляемый актив, а не случайный набор поисковых совпадений.",
    ]),
  };
}
