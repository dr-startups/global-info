/**
 * Шрифты сайта — свои файлы, без внешних CDN (лицензия SIL OFL 1.1, тексты лицензий
 * рядом).
 *
 * Golos Text — одним вариативным файлом 400–700 с кириллицей и латиницей: у
 * `next/font/local` нет диапазонов символов на файл, а два подмножества одного
 * начертания стали бы двумя семействами. Literata нужна только словоблоку
 * логотипа «Global Info», поэтому — латиница в 600.
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

export const literata = localFont({
  src: "./literata-latin-600.woff2",
  weight: "600",
  style: "normal",
  display: "swap",
  variable: "--site-font-literata",
  fallback: ["Georgia", "Times New Roman", "serif"],
  adjustFontFallback: "Times New Roman",
});
