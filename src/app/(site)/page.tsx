import type { Metadata } from "next";
import Link from "next/link";
import { CheckForm } from "@/modules/site/components/CheckForm";
import { Faq } from "@/modules/site/components/Faq";
import { Blurred } from "@/modules/site/components/Hidden";
import { CtaBand } from "@/modules/site/components/content/CtaBand";
import { Cover } from "@/modules/site/components/content/Cover";
import { HeroSeek } from "@/modules/site/components/landing/HeroSeek";
import { KeepScene } from "@/modules/site/components/landing/KeepScene";
import { ResultDemo } from "@/modules/site/components/landing/ResultDemo";
import { SourcesFlow } from "@/modules/site/components/landing/SourcesFlow";
import { MEDIUM_METER_LABEL, MediumMeter } from "@/modules/site/components/landing/parts";
import { vars } from "@/modules/site/components/css-vars";
import { JsonLd } from "@/modules/site/components/JsonLd";
import { ARTICLES, BLOG, BLOG_TOPICS, readingTimeText } from "@/modules/site/content/articles";
import { EXAMPLE, FAQ, FINAL, HERO, HOW, SAFETY, SOURCES, TOPICS, USEFUL } from "@/modules/site/content/landing";
import { siteOrigin } from "@/modules/site/seo/indexing";
import { faqLd, websiteLd } from "@/modules/site/seo/json-ld";
import { pageMetadata } from "@/modules/site/seo/metadata";

export const metadata: Metadata = pageMetadata("/");

/** Первые статьи блога — одним рядом на любой ширине; ниже 1024 ряд листается. */
const USEFUL_POSTS = ARTICLES.slice(0, USEFUL.count).map((article) => ({
  path: article.path,
  title: article.h1,
  topicLabel: BLOG_TOPICS.find((topic) => topic.id === article.topic)!.label,
  readingTime: readingTimeText(article),
  cover: article.cover,
}));

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

          {/* Строка поиска и список «Будет проверено»: сетка ставит их в свои ряды */}
          <HeroSeek words={HERO.seekWords} />
        </div>
      </section>

      {/* Один лист на всё содержимое: главы отбиты линейкой и воздухом, а не новой кромкой */}
      <div className="site-sheet">
        <section className="site-section site-how" aria-labelledby="how-title">
          <div className="site-how__track">
            {/* Якорь — метка в дорожке, а не секция: там, где ряд закреплён, переход по ссылке сажает
                страницу в конец хода, и человек видит три заполненные карточки, а не пустые места под
                них. Где стоит метка, решает site.css — рядом с диапазонами карточек */}
            <span className="site-how__anchor" id="how" data-anchor="how" />
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
                                {HOW.resultLines.map((line) => (
                                  <li key={line}>
                                    <Blurred text={line} />
                                  </li>
                                ))}
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
                    <div className="site-meter site-meter--medium" role="img" aria-label={MEDIUM_METER_LABEL}>
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
                        {/* Без выделителя под названием: сирень на сайте значит «найдено» и «выбрано»,
                            а здесь тема — заголовок группы, а не находка (владелец 18.09.2026) */}
                        <span className="site-finding__label">{theme.label}</span>
                        <span className="site-finding__count">{theme.count}</span>
                      </h3>
                      <ul className="site-finding__list">
                        {theme.items.map((item) => (
                          <li key={item}>
                            <Blurred text={item} label="Материал, заголовок скрыт" />
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
            <SourcesFlow />
          </div>
        </section>

        <section className="site-section" id="safety" data-anchor="safety" aria-labelledby="safety-title">
          <div className="site-container site-split">
            <div className="site-section__head site-reveal" style={{ margin: 0 }}>
              <h2 className="site-h2 site-lines" id="safety-title">
                {SAFETY.title}
              </h2>
              <p className="site-lead">{SAFETY.lead}</p>
              <dl className="site-keep__list">
                {SAFETY.promises.map((promise) => (
                  <div key={promise.title}>
                    <dt>{promise.title}</dt>
                    <dd>{promise.text}</dd>
                  </div>
                ))}
              </dl>
            </div>
            <KeepScene />
          </div>
        </section>

        <section className="site-section" id="faq" data-anchor="faq" aria-labelledby="faq-title">
          <div className="site-container site-split">
            <div className="site-section__head site-reveal" style={{ margin: 0 }}>
              <h2 className="site-h2 site-lines" id="faq-title">
                {FAQ.title}
              </h2>
              <p className="site-lead">{FAQ.lead}</p>
            </div>
            {/* Появление по одному — через observer: список меняет высоту при раскрытии ответа,
                и по scroll-таймлайну последний вопрос возвращался в свою анимацию размытым */}
            <Faq items={FAQ.items} className="site-reveal--stagger" />
          </div>
        </section>

        {/* Последняя глава листа — статьи, а не вопросы: вопросы раскрываются и двигают кромку
            листа, и закрывающий блок под ней открывался раньше, чем список дочитан
            (владелец 19.09.2026) */}
        <section className="site-section" id="blog" data-anchor="blog" aria-labelledby="blog-title">
          <div className="site-container">
            <div className="site-more__head site-reveal">
              <div className="site-section__head">
                <h2 className="site-h2" id="blog-title">
                  <Link className="site-more__link" href={BLOG.path} aria-label={USEFUL.label}>
                    {USEFUL.title}
                    <i aria-hidden="true">
                      <svg viewBox="0 0 16 16">
                        <use href="#ic-arrow" />
                      </svg>
                    </i>
                  </Link>
                </h2>
                <p className="site-lead">{USEFUL.lead}</p>
              </div>
            </div>

            <div className="site-more__pane">
              <div className="site-blog">
                {USEFUL_POSTS.map((post) => (
                  <article className="site-post" key={post.path}>
                    <Cover name={post.cover} sizes="(min-width: 1024px) 262px, (min-width: 640px) 42vw, 78vw" />
                    <div className="site-post__body">
                      <p className="site-post__meta">
                        <span>{post.topicLabel}</span>
                        <span>{post.readingTime}</span>
                      </p>
                      <h3 className="site-post__title">
                        <Link className="site-post__link" href={post.path}>
                          {post.title}
                        </Link>
                      </h3>
                      <span className="site-post__more" aria-hidden="true">
                        <i>
                          <svg viewBox="0 0 16 16">
                            <use href="#ic-arrow" />
                          </svg>
                        </i>
                        {USEFUL.more}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Закрывающий блок — последним: открывается из-под листа, дальше только подвал. Разбег держит
          его липким только на последнем экране листа. Это раскладка главной, поэтому обёртка здесь,
          а не в самом блоке */}
      <div className="site-final-wrap">
        <div className="site-final-wrap__runway" aria-hidden="true" />
        <CtaBand title={FINAL.title} text={FINAL.lead} self />
      </div>

      <JsonLd data={[websiteLd(siteOrigin()), faqLd(FAQ.items)]} />
    </main>
  );
}
