import { isPlaceholder } from "@/modules/site/content/contacts";

/** Значение из контента; не данный заказчиком плейсхолдер отмечен на странице. */
export function Value({ text }: { text: string }) {
  return isPlaceholder(text) ? <span className="site-placeholder">{text}</span> : <>{text}</>;
}
