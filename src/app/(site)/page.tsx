import type { Metadata } from "next";
import Image from "next/image";
import { CheckForm } from "@/modules/site/components/CheckForm";
import { HeroSeek } from "@/modules/site/components/landing/HeroSeek";
import { ResultDemo } from "@/modules/site/components/landing/ResultDemo";
import { ArrowIcon } from "@/modules/site/components/SiteIcons";
import { vars } from "@/modules/site/components/css-vars";
import { JsonLd } from "@/modules/site/components/JsonLd";
import { EXAMPLE, FAQ, FINAL, HERO, HOW, SAFETY, SOURCES, TOPICS } from "@/modules/site/content/landing";
import { siteOrigin } from "@/modules/site/seo/indexing";
import { faqLd, websiteLd } from "@/modules/site/seo/json-ld";
import { pageMetadata } from "@/modules/site/seo/metadata";

export const metadata: Metadata = pageMetadata("/");

/** Делений шкалы у мини-макета третьего шага и примера: «средний» — второй из трёх. */
function MediumMeter({ fill }: { fill?: boolean }) {
  const seg = (on: boolean) => `site-meter__seg${on ? " is-on" : ""}${on && fill ? " site-steps__fill" : ""}`;
  return (
    <>
      <span className={seg(true)} />
      <span className={seg(true)} />
      <span className={seg(false)} />
    </>
  );
}

const TERM_TICKS = Array.from({ length: 31 }, (_, i) => i);

function TermRecord({ closed }: { closed?: boolean }) {
  return (
    <div className={`site-term__record${closed ? " site-term__record--closed" : ""} site-ticks`} aria-hidden="true">
      <p className="site-term__head">
        <span className="site-tag">{closed ? "Запись · день 30" : "Запись · день 0"}</span>
        {closed ? <span className="site-term__status">обезличена</span> : null}
      </p>
      <dl>
        <div>
          <dt>Имя</dt>
          <dd>
            <i style={vars({ "--w": "82%" })} />
          </dd>
        </div>
        <div>
          <dt>Дата рождения</dt>
          <dd>
            <i style={vars({ "--w": "48%" })} />
          </dd>
        </div>
        <div>
          <dt>Контакты</dt>
          <dd>
            <i style={vars({ "--w": "66%" })} />
          </dd>
        </div>
      </dl>
    </div>
  );
}

export default function LandingPage() {
  return (
    <main id="main">
      <section className="site-hero" id="form" data-anchor="form">
        <div className="site-hero__scan" aria-hidden="true" />
        <div className="site-container site-hero__grid">
          <div className="site-hero__copy site-stagger">
            <ul className="site-chips" aria-label="Условия проверки">
              {HERO.chips.map((chip) => (
                <li key={chip.label} className={`site-chip${"accent" in chip ? " site-chip--accent" : ""}`}>
                  {chip.label}
                </li>
              ))}
            </ul>
            <h1 className="site-display site-lines">{HERO.title}</h1>
            <p className="site-lead">{HERO.lead}</p>
          </div>

          <div className="site-formcase site-ticks">
            <CheckForm />
          </div>

          <HeroSeek words={HERO.seekWords} />
        </div>
      </section>

      {/* Лист 1: как проходит проверка, что получится на выходе и где мы смотрим */}
      <div className="site-sheet">
        <section className="site-section site-how" id="how" data-anchor="how" aria-labelledby="how-title">
          <div className="site-how__track">
            <div className="site-how__pin">
              <div className="site-container">
                <div className="site-section__head site-reveal">
                  <h2 className="site-h2 site-lines" id="how-title">
                    {HOW.title}
                  </h2>
                  <p className="site-lead">{HOW.lead}</p>
                </div>

                <ol className="site-steps">
                  {HOW.steps.map((step, index) => (
                    <li className="site-steps__item" key={step.num}>
                      <article className="site-steps__card">
                        <div className="site-steps__text">
                          <span className="site-step__num">
                            <span className="site-visually-hidden">Шаг </span>
                            {step.num}
                          </span>
                          <h3 className="site-h3">{step.title}</h3>
                          <p>{step.text}</p>
                        </div>
                        <div className="site-steps__visual" aria-hidden="true">
                          {index === 0 ? (
                            <div className="site-mini">
                              <div className="site-mini__field">
                                <i className="site-steps__fill" style={vars({ "--w": "58%" })} />
                              </div>
                              <div className="site-mini__grid">
                                <div className="site-mini__field">
                                  <i className="site-steps__fill" style={vars({ "--w": "62%" })} />
                                </div>
                                <div className="site-mini__field">
                                  <i className="site-steps__fill" style={vars({ "--w": "44%" })} />
                                </div>
                              </div>
                              <div className="site-mini__btn">Проверить бесплатно</div>
                            </div>
                          ) : index === 1 ? (
                            <div className="site-mini site-mini--cards">
                              <div className="site-mini__card is-on">
                                <span className="site-tag">Совпадение 01</span>
                                <i className="site-mini__bar" style={vars({ "--w": "76%" })} />
                                <i className="site-mini__bar site-mini__bar--thin" style={vars({ "--w": "54%" })} />
                                <span className="site-mini__pick site-steps__pop">Это я</span>
                              </div>
                              <div className="site-mini__card">
                                <span className="site-tag">Совпадение 02</span>
                                <i className="site-mini__bar" style={vars({ "--w": "62%" })} />
                                <i className="site-mini__bar site-mini__bar--thin" style={vars({ "--w": "40%" })} />
                              </div>
                            </div>
                          ) : (
                            <div className="site-mini site-mini--result">
                              <span className="site-tag">Уровень риска</span>
                              <div className="site-meter site-meter--medium">
                                <MediumMeter fill />
                              </div>
                              <p className="site-mini__level site-steps__pop">
                                <b>Средний</b>
                                <span>4 материала в 2 темах</span>
                              </p>
                              <ul className="site-mini__lines">
                                <li>
                                  <span className="site-mark" style={vars({ "--w": "15ch" })} />
                                </li>
                                <li>
                                  <span className="site-mark" style={vars({ "--w": "10ch" })} />
                                </li>
                                <li>
                                  <span className="site-mark" style={vars({ "--w": "17ch" })} />
                                </li>
                              </ul>
                            </div>
                          )}
                        </div>
                      </article>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
        </section>

        <section className="site-section" id="example" data-anchor="example" aria-labelledby="example-title">
          <div className="site-container site-example">
            <div className="site-section__head site-reveal" style={{ margin: 0 }}>
              <h2 className="site-h2 site-lines" id="example-title">
                {EXAMPLE.title}
              </h2>
              <p className="site-lead">{EXAMPLE.lead}</p>
              <ul className="site-facts">
                {EXAMPLE.facts.map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
            </div>

            <div className="site-example__panel site-reveal">
              <ResultDemo>
                <div className="site-verdict site-verdict--medium" style={{ padding: 0 }}>
                  <div className="site-verdict__scale">
                    <div
                      className="site-meter site-meter--medium"
                      role="img"
                      aria-label="Уровень риска: средний, второй из трёх"
                    >
                      <MediumMeter />
                    </div>
                    <span className="site-tag">Уровень риска</span>
                  </div>
                  <div className="site-verdict__row">
                    <span className="site-verdict__level">Средний</span>
                    <span className="site-verdict__count">
                      <b>4</b> материала с негативом
                    </span>
                  </div>
                </div>
                <div className="site-findings site-findings--compact">
                  {EXAMPLE.themes.map((theme) => (
                    <div className="site-finding" key={theme.label}>
                      <h3 className="site-finding__theme">
                        <span className="site-finding__label">
                          <span className="site-topics__name">{theme.label}</span>
                        </span>
                        <span className="site-finding__count">{theme.count}</span>
                      </h3>
                      <ul className="site-finding__list">
                        {theme.widths.map((width, i) => (
                          <li key={i}>
                            <span
                              className="site-mark"
                              style={vars({ "--w": width })}
                              role="img"
                              aria-label="Материал, заголовок скрыт"
                            />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </ResultDemo>
            </div>
          </div>
        </section>

        {/* Темы среднего уровня и выше: «Корпоративное владение» и «Семья и связи» — низкий уровень,
            на главной читались бы угрозой; в результате проверки они остаются */}
        <section className="site-section" id="topics" data-anchor="topics" aria-labelledby="topics-title">
          <div className="site-container site-split">
            <div className="site-section__head site-reveal" style={{ margin: 0 }}>
              <h2 className="site-h2 site-lines" id="topics-title">
                {TOPICS.title}
              </h2>
              <p className="site-lead">{TOPICS.lead}</p>
            </div>
            <dl className="site-topics site-reveal--stagger">
              {TOPICS.items.map((item) => (
                <div key={item.term}>
                  <dt>{item.term}</dt>
                  <dd>{item.text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="site-section" id="sources" data-anchor="sources" aria-labelledby="sources-title">
          <div className="site-container">
            <div className="site-section__head site-reveal">
              <h2 className="site-h2 site-lines" id="sources-title">
                {SOURCES.title}
              </h2>
              <p className="site-lead">{SOURCES.lead}</p>
            </div>
            <ul className="site-sources-grid site-reveal--stagger">
              {SOURCES.items.map((item) => (
                <li key={item.title}>
                  <svg viewBox="0 0 32 32" aria-hidden="true">
                    <use href={`#${item.icon}`} />
                  </svg>
                  <strong>{item.title}</strong>
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      {/* Лист 2: срок записи проверки — запись в день запуска и та же запись в день 30 */}
      <div className="site-sheet">
        <section className="site-section" id="safety" data-anchor="safety" aria-labelledby="safety-title">
          <div className="site-container">
            <div className="site-section__head site-reveal">
              <h2 className="site-h2 site-lines" id="safety-title">
                {SAFETY.title}
              </h2>
              <p className="site-lead">{SAFETY.lead}</p>
            </div>

            <ol className="site-term site-reveal--stagger">
              <li className="site-term__stage">
                <TermRecord />
                <div className="site-term__text">
                  <h3 className="site-h3">{SAFETY.stages[0].title}</h3>
                  <p>{SAFETY.stages[0].text}</p>
                </div>
              </li>
              <li className="site-term__stage">
                <div className="site-term__scale" aria-hidden="true">
                  <span className="site-term__fill" />
                  <span className="site-term__ticks">
                    {TERM_TICKS.map((i) => (
                      <i key={i} />
                    ))}
                  </span>
                  <span className="site-term__cursor" />
                  <span className="site-term__end">0</span>
                  <span className="site-term__end site-term__end--stop">30 дней</span>
                </div>
                <div className="site-term__text">
                  <h3 className="site-h3">{SAFETY.stages[1].title}</h3>
                  <p>{SAFETY.stages[1].text}</p>
                </div>
              </li>
              <li className="site-term__stage">
                <TermRecord closed />
                <div className="site-term__text">
                  <h3 className="site-h3">{SAFETY.stages[2].title}</h3>
                  <p>{SAFETY.stages[2].text}</p>
                </div>
              </li>
            </ol>
          </div>
        </section>
      </div>

      {/* Лист 3: вопросы */}
      <div className="site-sheet">
        <section className="site-section" id="faq" data-anchor="faq" aria-labelledby="faq-title">
          <div className="site-container site-split">
            <div className="site-section__head site-reveal" style={{ margin: 0 }}>
              <h2 className="site-h2 site-lines" id="faq-title">
                {FAQ.title}
              </h2>
              <p className="site-lead">{FAQ.lead}</p>
            </div>
            <div className="site-faq site-reveal">
              {FAQ.items.map((item) => (
                <details key={item.q}>
                  <summary>{item.q}</summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </div>

      {/* Закрывающий лист: кадр F1 серии «Бумажные предметы» — папка на стопке листов */}
      <section className="site-sheet site-final" aria-labelledby="final-title">
        <div className="site-container site-final__copy">
          <h2 className="site-final__title site-lines" id="final-title">
            {FINAL.title}
          </h2>
          <p className="site-final__lead">{FINAL.lead}</p>
          <a className="site-btn site-btn--accent site-btn--lg" href="#form">
            {FINAL.cta}
            <ArrowIcon />
          </a>
        </div>
        <div className="site-final__media" aria-hidden="true">
          {/* Из public, а не импортом: объявления типов картинок даёт next-env.d.ts, которого
              в CI на шаге «Типы» ещё нет */}
          <Image
            src="/site/final-paper.webp"
            width={1200}
            height={1490}
            sizes="(min-width: 1024px) 50vw, 100vw"
            alt=""
            loading="lazy"
          />
        </div>
      </section>
      <JsonLd data={[websiteLd(siteOrigin()), faqLd(FAQ.items)]} />
    </main>
  );
}
