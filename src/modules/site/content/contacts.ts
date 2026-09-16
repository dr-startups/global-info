/**
 * Контакты, реквизиты и меню сайта.
 *
 * Значений, которых заказчик ещё не дал, здесь нет — стоят плейсхолдеры, и
 * страница показывает их как есть (ТЗ §9): выдуманный телефон хуже видимой
 * заглушки.
 */

export const CONTACTS = {
  phone: "{{PHONE}}",
  email: "{{EMAIL}}",
  telegram: "{{TELEGRAM}}",
  legalEntity: "{{LEGAL_ENTITY}}",
  requisites: "{{REQUISITES}}",
} as const;

export function isPlaceholder(value: string): boolean {
  return /^\{\{.+\}\}$/u.test(value);
}

export interface NavItem {
  label: string;
  href: string;
}

/** Меню шапки — как в утверждённом макете: «Вопросы» и «Контакты» ведут к разделам главной и подвалу. */
export const HEADER_NAV: readonly NavItem[] = [
  { label: "Как это работает", href: "/#how" },
  { label: "Услуги", href: "/uslugi" },
  { label: "Вопросы", href: "/#faq" },
  { label: "Блог", href: "/blog" },
  { label: "Контакты", href: "#contacts" },
];

/**
 * Меню подвала ведёт на страницы: «Вопросы» — на `/voprosy`, где их больше, чем на
 * главной, «Контакты» — на `/kontakty` (решение владельца 16.09.2026). Шапка при этом
 * остаётся как в макете.
 */
export const FOOTER_NAV: readonly NavItem[] = [
  { label: "Как это работает", href: "/#how" },
  { label: "Услуги", href: "/uslugi" },
  { label: "Вопросы", href: "/voprosy" },
  { label: "Блог", href: "/blog" },
  { label: "О проекте", href: "/o-proekte" },
  { label: "Контакты", href: "/kontakty" },
];

export const LEGAL_NAV: readonly NavItem[] = [
  { label: "Политика конфиденциальности", href: "/legal/politika-konfidencialnosti" },
  { label: "Согласие на обработку данных", href: "/legal/soglasie" },
  { label: "Условия использования", href: "/legal/usloviya" },
];
