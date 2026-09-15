import type { CSSProperties } from "react";

/** Переменные CSS в `style`: `vars({ "--w": "3ch" })` — макет задаёт ширины плашек так. */
export function vars(values: Record<`--${string}`, string | number>): CSSProperties {
  return values as CSSProperties;
}
