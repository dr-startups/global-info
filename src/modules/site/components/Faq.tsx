import type { CSSProperties } from "react";
import { RichText } from "./content/RichText";

/**
 * Вопросы и ответы — раскрывающиеся `<details>`: без скриптов, с клавиатуры, и
 * поиск по странице находит текст закрытого ответа. Главная, `/voprosy` и статьи
 * рисуют вопросы отсюда (`site-buttons-fields-and-faq-are-drawn-by-one-component.test.ts`).
 *
 * `<details>` — прямые дети `.site-faq`: анимация появления на главной считает их
 * по `:nth-child`.
 */
export function Faq({
  items,
  className,
  style,
}: {
  items: readonly { q: string; a: string }[];
  /** Классы сверх блока вопросов — появление при прокрутке на главной. */
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={className ? `site-faq ${className}` : "site-faq"} style={style}>
      {items.map((item) => (
        <details key={item.q}>
          <summary>{item.q}</summary>
          <p>
            <RichText text={item.a} />
          </p>
        </details>
      ))}
    </div>
  );
}
