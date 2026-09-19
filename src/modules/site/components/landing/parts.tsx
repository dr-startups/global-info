/**
 * Мелочи, общие у блоков главной.
 *
 * Шкала «средний» стоит в трёх местах страницы (макет третьего шага, пример
 * результата, узел результата в схеме) и везде значит одно: второе деление из
 * трёх. Собрана из полных имён классов, а не из значения, — чтобы правило шкалы
 * не выглядело мёртвым (`site-css-declares-only-classes-the-site-uses`).
 */
export function MediumMeter({ fill }: { fill?: boolean }) {
  const seg = (on: boolean) => `site-meter__seg${on ? " is-on" : ""}${on && fill ? " site-steps__fill" : ""}`;
  return (
    <>
      <span className={seg(true)} />
      <span className={seg(true)} />
      <span className={seg(false)} />
    </>
  );
}

export const MEDIUM_METER_LABEL = "Уровень риска: средний, второй из трёх";
