import { CHECK_FORM_TEXT, FINAL } from "@/modules/site/content/landing";
import { ButtonLink } from "../Button";

/**
 * Закрывающий блок: последнее слово страницы — чернильная полоса с кадром серии 5
 * во всю ширину. Один вид на весь сайт (решение владельца 18.09.2026): до этого
 * главная закрывалась своей разметкой, а остальные страницы — светлой карточкой,
 * и два закрывающих блока расходились при каждой правке.
 *
 * Кадр лежит фоном под текстом: слева у него ровная темнота, и заголовок читается
 * поверх неё. Фон полосы — тон левого края кадра (#1B1C21 по замеру файла), чтобы
 * до загрузки картинки полоса была того же цвета.
 *
 * Кадра два — широкий и вертикальный: ниже 1200 px полоса становится узкой, и
 * широкий кадр показывал бы в ней обрезок луча. Это `<picture>`, а не `next/image`:
 * выбор кадра по ширине окна — художественное решение, а не подбор плотности, и
 * `next/image` такого не умеет. Ширины нарезаны заранее (`scripts` шага 0077).
 *
 * Главная ведёт к своим же секциям (`#form` ставит курсор в первое поле формы по
 * событию hashchange), остальные страницы — на главную.
 */
export function CtaBand({ title, text, self }: { title: string; text: string; self?: boolean }) {
  const to = (anchor: string) => (self ? anchor : `/${anchor}`);
  return (
    <section className="site-final" aria-labelledby="final-title">
      <div className="site-container site-final__copy">
        <h2 className="site-final__title" id="final-title">
          {title}
        </h2>
        <p className="site-final__lead">{text}</p>
        <div className="site-final__actions">
          <ButtonLink variant="accent" large arrow href={to("#form")}>
            {CHECK_FORM_TEXT.submit}
          </ButtonLink>
          <ButtonLink variant="secondary" large href={to("#how")}>
            {FINAL.secondary}
          </ButtonLink>
        </div>
      </div>
      <picture className="site-final__art" aria-hidden="true">
        <source
          media="(max-width: 1199.98px)"
          srcSet="/site/final-mobile-800.webp 800w, /site/final-mobile-1400.webp 1400w"
          sizes="100vw"
        />
        <source srcSet="/site/final-1600.webp 1600w, /site/final-2560.webp 2560w" sizes="100vw" />
        <img src="/site/final-2560.webp" width={2560} height={1429} alt="" decoding="async" loading="lazy" />
      </picture>
    </section>
  );
}
