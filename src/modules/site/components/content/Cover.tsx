import Image from "next/image";
import type { CSSProperties } from "react";

/**
 * Обложка серии «Бумажные предметы». Кадр декоративный: `alt` пустой, рамка скрыта
 * от экранного диктора. Файл один, ширины под экран нарезает next/image — как у
 * кадра главной. Обложка страницы стоит в первом экране и грузится сразу, в
 * списках — лениво.
 */
export function Cover({
  name,
  sizes,
  page,
  style,
}: {
  name: string;
  sizes: string;
  page?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div className={`site-cover${page ? " site-cover--page" : ""}`} style={style} aria-hidden="true">
      <Image
        src={`/site/covers/${name}.webp`}
        width={1200}
        height={805}
        sizes={sizes}
        alt=""
        {...(page ? { priority: true } : { loading: "lazy" as const })}
      />
    </div>
  );
}
