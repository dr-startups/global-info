/**
 * Шрифт сайта — свой файл, без внешних CDN (лицензия SIL OFL 1.1, текст рядом).
 *
 * Golos Text — одним вариативным файлом 400–700 с кириллицей и латиницей: у
 * `next/font/local` нет диапазонов символов на файл, а два подмножества одного
 * начертания стали бы двумя семействами. Второго шрифта у сайта нет: словоблок
 * логотипа с 20.09.2026 набран тем же Golos в 600 (решение владельца), и
 * Literata ушла вместе с файлом и переменной `--site-font-display`.
 */

import localFont from "next/font/local";

export const golosText = localFont({
  src: "./golos-text.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  variable: "--site-font-golos",
  fallback: ["Segoe UI", "Arial", "sans-serif"],
  adjustFontFallback: "Arial",
});
