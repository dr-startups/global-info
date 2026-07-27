/**
 * Deterministic ~300-row composite corpus for the golden-case report harness.
 * SUBJECT: Anders Holmström / Nordkap Capital (+ hockey namesake noise).
 */

import type { CompositeObservation } from "../../src/modules/digital-profile/services/composite-serp-merge";

const SUBJECT = "Anders Holmström";
const COMPANY = "Nordkap Capital";

/*
 * Домены и заголовки золотого кейса.
 *
 * Раньше вся выдача жила на `ru.example` / `uae.example`, а заголовки-набивку
 * различал суффикс «— source 42». Из-за этого эталон не мог подтверждать
 * качество текста, ради которого заведён:
 *
 * - `.example` опознаётся продуктом как демо-домен (`isMockClientDomain`) и
 *   вычищается из клиентского текста. Строки источников всегда падали в
 *   запасную формулировку «Источники — поисковая выдача», и настоящий путь
 *   «Источники — a, b и c» не проверялся ни разу;
 * - один домен на всю выдачу означает, что перечисление источников, отбор
 *   опорных доменов и склейка материалов по паре «домен + заголовок» работали
 *   на вырожденных данных;
 * - «— source 42» в заголовке — это не то, что бывает в выдаче, и такой текст
 *   нельзя оценивать как клиентский.
 *
 * Домены вымышленные и намеренно не совпадают с настоящими изданиями: субъект
 * тоже вымышлен, а фикстура не ходит в сеть. Зато они выглядят как домены, и
 * конвейер обращается с ними как с настоящими.
 */
const RU_SOURCE_HOSTS = [
  "affarsposten.se",
  "stockholm-kuriren.se",
  "nordmarket-watch.se",
  "finansbladet.se",
  "granskaren.se",
  "kapitalnytt.se",
  "delovoy-vestnik.ru",
  "rynok-segodnya.ru",
  "pravo-obzor.ru",
  "bizdaily-nordic.se",
  "reestr-novosti.ru",
  "svenskt-naringsliv-nytt.se",
];

const UAE_SOURCE_HOSTS = [
  "gulf-business-review.ae",
  "emirates-ledger.ae",
  "dubai-market-daily.ae",
  "khaleej-finance-post.ae",
  "difc-briefing.ae",
  "abudhabi-capital-news.ae",
];

/** Как издания по-разному подают один и тот же сюжет. */
const COVERAGE_ANGLES = ["Обзор", "Комментарий", "Подробности", "Хроника", "Разбор", "Контекст"];

/** Детерминированный выбор хоста: индекс наблюдения → домен из пула. */
function host(pool: string[], i: number): string {
  return pool[i % pool.length]!;
}

const ORGANIC_RU_TITLES = [
  `${SUBJECT}, founder of ${COMPANY}, faces tax-fraud probe in Stockholm`,
  `${SUBJECT} flagged during sanctions screening watchlist review`,
  `${SUBJECT} linked to Malta holding structure and offshore beneficial ownership`,
  `${SUBJECT}, CEO of ${COMPANY} AB — fintech investor profile`,
  `${COMPANY} raises Series B; ${SUBJECT} remains controlling shareholder`,
  `Stockholm court schedules hearing involving ${SUBJECT} of ${COMPANY}`,
  `${SUBJECT} interviewed on Nordic fintech regulation and compliance`,
  `Beneficial ownership disclosure lists ${SUBJECT} for ${COMPANY}`,
  `${SUBJECT} expands ${COMPANY} into private credit markets`,
  `Swedish media: ${SUBJECT} denies wrongdoing in tax inquiry`,
  `${COMPANY} board appoints independent compliance advisor after ${SUBJECT} probe`,
  `Registry extract: ${SUBJECT} listed as director of ${COMPANY}`,
  `${SUBJECT} real-estate purchases in Stockholm linked to ${COMPANY} vehicle`,
  `Analyst note: reputation risk around ${SUBJECT} and ${COMPANY}`,
  `${SUBJECT} speaks at fintech summit about AML controls`,
  `Whistleblower portal mentions ${SUBJECT} in connection with ${COMPANY}`,
  `${COMPANY} annual report signed by ${SUBJECT}`,
  `Prosecutors request documents from ${SUBJECT} regarding Malta SPV`,
  `${SUBJECT} philanthropy foundation tied to ${COMPANY} dividends`,
  `Credit bureau soft-hit references ${SUBJECT}, ${COMPANY}`,
];

const ORGANIC_UAE_TITLES = [
  `${SUBJECT} expands ${COMPANY} into Dubai real-estate investment`,
  `${SUBJECT} referenced in UAE PEP/RCA compliance screening`,
  `Dubai Free Zone filing lists ${SUBJECT} as UBO of ${COMPANY} affiliate`,
  `${COMPANY} opens DIFC representative office under ${SUBJECT}`,
  `Gulf press: ${SUBJECT} courts Gulf family offices for ${COMPANY}`,
  `UAE company registry: ${SUBJECT} director of ${COMPANY} MENA Ltd`,
  `${SUBJECT} attends Abu Dhabi finance forum for ${COMPANY}`,
  `Sanctions screening vendor flags ${SUBJECT} for secondary review`,
  `${COMPANY} Dubai entity leases office in DIFC; ${SUBJECT} signatory`,
  `Arabic-language profile of ${SUBJECT}, founder of ${COMPANY}`,
];

const SUGGESTIONS_RU = [
  `${SUBJECT} ${COMPANY} fraud`,
  `${SUBJECT} налоговая проверка`,
  `${SUBJECT} Malta offshore`,
  `${SUBJECT} санкции`,
  `${COMPANY} владелец`,
  `${SUBJECT} Stockholm court`,
  `${SUBJECT} комплаенс`,
  `${SUBJECT} биография`,
  `${COMPANY} Series B`,
  `${SUBJECT} арест`,
  `${SUBJECT} финансы`,
  `${SUBJECT} дело`,
];

const SUGGESTIONS_UAE = [
  `${SUBJECT} Dubai ${COMPANY}`,
  `${SUBJECT} DIFC`,
  `${SUBJECT} UAE PEP`,
  `${SUBJECT} Abu Dhabi`,
  `${COMPANY} Dubai office`,
  `${SUBJECT} Gulf investment`,
];

const PAA_RU = [
  `Who is ${SUBJECT} of ${COMPANY}?`,
  `Is ${SUBJECT} under investigation?`,
  `What does ${COMPANY} do?`,
  `Where is ${SUBJECT} based?`,
  `Is ${SUBJECT} a PEP?`,
  `How is ${SUBJECT} connected to Malta?`,
  `What are the risks of dealing with ${COMPANY}?`,
  `Has ${SUBJECT} been sanctioned?`,
];

const PAA_UAE = [
  `Is ${SUBJECT} expanding to Dubai?`,
  `Does ${COMPANY} operate in the UAE?`,
  `Is ${SUBJECT} listed in UAE compliance databases?`,
  `What is ${SUBJECT}'s role at ${COMPANY} MENA?`,
];

const NAMESAKE_TITLES = [
  `Holmström, ice-hockey goaltender, signs with NHL club`,
  `Anders Holmström stops 32 shots in playoff hockey win`,
  `Goaltender Holmström joins the NHL after a strong hockey season`,
  `Хоккей: вратарь Хольмстрём переходит в новый клуб`,
  `NHL prospect Andersson Holmström named goaltender of the week`,
];

function base(
  partial: Partial<CompositeObservation> & Pick<CompositeObservation, "kind" | "key">
): CompositeObservation {
  return {
    region: "RU",
    engine: "YANDEX",
    query: SUBJECT,
    providers: ["yandex"],
    primaryProvider: "yandex",
    evidenceRefs: [],
    ...partial,
  };
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

/** Build the golden-case composite corpus (~300 rows). Deterministic. */
export function buildGoldenCaseObservations(): CompositeObservation[] {
  const rows: CompositeObservation[] = [];
  let n = 0;
  const id = () => {
    n += 1;
    return String(n).padStart(3, "0");
  };

  // --- Organic RU (Yandex + Google) — seed + padded variants ---
  for (let i = 0; i < ORGANIC_RU_TITLES.length; i++) {
    const title = ORGANIC_RU_TITLES[i]!;
    const engine = i % 3 === 0 ? "GOOGLE" : "YANDEX";
    const providers = engine === "GOOGLE" ? (["serper"] as string[]) : (["yandex"] as string[]);
    rows.push(
      base({
        key: `organic|ru|${engine.toLowerCase()}|q|https://${host(RU_SOURCE_HOSTS, i)}/o-${id()}`,
        kind: "organic",
        surface: "organic",
        region: "RU",
        engine,
        providers,
        primaryProvider: providers[0]!,
        url: `https://${host(RU_SOURCE_HOSTS, i)}/${slug(title)}-${i}`,
        title,
        snippet: `${title}. Context: ${COMPANY}, Stockholm fintech, identity anchors for subject resolution.`,
        evidenceRefs: [`searchResult:sr-ru-o-${i}`],
        baseSearchResultId: `sr-ru-o-${i}`,
        riskLabel: /tax|sanction|offshore|whistle|prosecut|probe|hearing/i.test(title)
          ? "adverse"
          : null,
      })
    );
  }
  // Pad organic RU to ~120 with unique URLs but shared themes
  for (let i = ORGANIC_RU_TITLES.length; i < 120; i++) {
    const theme = ORGANIC_RU_TITLES[i % ORGANIC_RU_TITLES.length]!;
    const engine = i % 2 === 0 ? "YANDEX" : "GOOGLE";
    const providers = engine === "GOOGLE" ? (["serper"] as string[]) : (["yandex"] as string[]);
    rows.push(
      base({
        key: `organic|ru|${engine.toLowerCase()}|q|https://${host(RU_SOURCE_HOSTS, i)}/pad-${id()}`,
        kind: "organic",
        surface: "organic",
        region: "RU",
        engine,
        providers,
        primaryProvider: providers[0]!,
        url: `https://${host(RU_SOURCE_HOSTS, i)}/${slug(theme)}-${i}`,
        title: `${COVERAGE_ANGLES[i % COVERAGE_ANGLES.length]}: ${theme}`,
        snippet: `${theme}. Материал издания ${host(RU_SOURCE_HOSTS, i)} о ${SUBJECT} и ${COMPANY}.`,
        evidenceRefs: [`searchResult:sr-ru-pad-${i}`],
        baseSearchResultId: `sr-ru-pad-${i}`,
      })
    );
  }

  // --- Organic UAE ---
  for (let i = 0; i < ORGANIC_UAE_TITLES.length; i++) {
    const title = ORGANIC_UAE_TITLES[i]!;
    rows.push(
      base({
        key: `organic|uae|google|q|https://${host(UAE_SOURCE_HOSTS, i)}/o-${id()}`,
        kind: "organic",
        surface: "organic",
        region: "UAE",
        engine: "GOOGLE",
        providers: ["serper"],
        primaryProvider: "serper",
        url: `https://${host(UAE_SOURCE_HOSTS, i)}/${slug(title)}-${i}`,
        title,
        snippet: `${title}. UAE market context for ${SUBJECT}.`,
        evidenceRefs: [`searchResult:sr-uae-o-${i}`],
        baseSearchResultId: `sr-uae-o-${i}`,
        riskLabel: /PEP|sanction|compliance/i.test(title) ? "adverse" : null,
      })
    );
  }
  for (let i = ORGANIC_UAE_TITLES.length; i < 40; i++) {
    const theme = ORGANIC_UAE_TITLES[i % ORGANIC_UAE_TITLES.length]!;
    rows.push(
      base({
        key: `organic|uae|google|q|https://${host(UAE_SOURCE_HOSTS, i)}/pad-${id()}`,
        kind: "organic",
        surface: "organic",
        region: "UAE",
        engine: "GOOGLE",
        providers: ["serper"],
        primaryProvider: "serper",
        url: `https://${host(UAE_SOURCE_HOSTS, i)}/${slug(theme)}-${i}`,
        title: `${COVERAGE_ANGLES[i % COVERAGE_ANGLES.length]}: ${theme}`,
        snippet: `${theme}. Материал издания ${host(UAE_SOURCE_HOSTS, i)} о ${SUBJECT}.`,
        evidenceRefs: [`searchResult:sr-uae-pad-${i}`],
        baseSearchResultId: `sr-uae-pad-${i}`,
      })
    );
  }

  // --- Namesake (OTHER_SUBJECT) ---
  for (let i = 0; i < NAMESAKE_TITLES.length; i++) {
    rows.push(
      base({
        key: `organic|ru|google|q|https://nordic-hockey-report.se/ns-${id()}`,
        kind: "organic",
        surface: "organic",
        region: "RU",
        engine: "GOOGLE",
        providers: ["serper"],
        primaryProvider: "serper",
        url: `https://nordic-hockey-report.se/holmstrom-${i}`,
        title: NAMESAKE_TITLES[i]!,
        snippet: `${NAMESAKE_TITLES[i]!}. Hockey goaltender — not the fintech founder.`,
        evidenceRefs: [`searchResult:sr-ns-${i}`],
        baseSearchResultId: `sr-ns-${i}`,
      })
    );
  }

  // --- LIKELY_SUBJECT (§2.1): surname + context / shared SUBJECT_MATCH domain ---
  // No given name → never SUBJECT_MATCH; visible as «вероятно», KPI unchanged.
  const LIKELY_ROWS: Array<{ title: string; url: string; snippet: string }> = [
    {
      title: "Holmström of Nordkap Capital mentioned in Stockholm market brief",
      url: "https://bizdaily-nordic.se/likely-nordkap-brief",
      snippet: "Surname + Nordkap Capital / Stockholm context without given name.",
    },
    {
      title: "Holmstrom fintech outlook for Nordic credit markets",
      url: "https://bizdaily-nordic.se/likely-fintech-outlook",
      snippet: "Surname + fintech context; identity not fully confirmed.",
    },
    {
      title: "Holmström: company registry notice",
      url: "https://reestr-novosti.ru/likely-registry-notice",
      snippet: "Surname-only on a domain that already hosts confirmed subject matches.",
    },
  ];
  for (let i = 0; i < LIKELY_ROWS.length; i++) {
    const row = LIKELY_ROWS[i]!;
    rows.push(
      base({
        key: `organic|ru|google|q|${row.url}`,
        kind: "organic",
        surface: "organic",
        region: "RU",
        engine: "GOOGLE",
        providers: ["serper"],
        primaryProvider: "serper",
        url: row.url,
        title: row.title,
        snippet: row.snippet,
        evidenceRefs: [`searchResult:sr-likely-${i}`],
        baseSearchResultId: `sr-likely-${i}`,
      })
    );
  }

  // --- Suggestions ---
  for (let i = 0; i < SUGGESTIONS_RU.length; i++) {
    const s = SUGGESTIONS_RU[i]!;
    rows.push(
      base({
        key: `suggestion|ru|yandex|q|${slug(s)}`,
        kind: "suggestion",
        surface: "autocomplete",
        region: "RU",
        engine: "YANDEX",
        suggestion: s,
        title: s,
        evidenceRefs: [`surface:ss-ru-sg-${i}`],
        baseSearchSurfaceItemId: `ss-ru-sg-${i}`,
      })
    );
  }
  // pad suggestions RU
  for (let i = SUGGESTIONS_RU.length; i < 36; i++) {
    const s = `${SUBJECT} query ${i}`;
    rows.push(
      base({
        key: `suggestion|ru|yandex|q|pad-${i}`,
        kind: "suggestion",
        surface: "autocomplete",
        region: "RU",
        engine: "YANDEX",
        suggestion: s,
        title: s,
        evidenceRefs: [`surface:ss-ru-sg-pad-${i}`],
        baseSearchSurfaceItemId: `ss-ru-sg-pad-${i}`,
      })
    );
  }
  for (let i = 0; i < SUGGESTIONS_UAE.length; i++) {
    const s = SUGGESTIONS_UAE[i]!;
    rows.push(
      base({
        key: `suggestion|uae|google|q|${slug(s)}`,
        kind: "suggestion",
        surface: "autocomplete",
        region: "UAE",
        engine: "GOOGLE",
        providers: ["serper"],
        primaryProvider: "serper",
        suggestion: s,
        title: s,
        evidenceRefs: [`surface:ss-uae-sg-${i}`],
        baseSearchSurfaceItemId: `ss-uae-sg-${i}`,
      })
    );
  }
  for (let i = SUGGESTIONS_UAE.length; i < 18; i++) {
    const s = `${SUBJECT} Dubai query ${i}`;
    rows.push(
      base({
        key: `suggestion|uae|google|q|pad-${i}`,
        kind: "suggestion",
        surface: "autocomplete",
        region: "UAE",
        engine: "GOOGLE",
        providers: ["serper"],
        primaryProvider: "serper",
        suggestion: s,
        title: s,
        evidenceRefs: [`surface:ss-uae-sg-pad-${i}`],
        baseSearchSurfaceItemId: `ss-uae-sg-pad-${i}`,
      })
    );
  }

  // --- PAA ---
  for (let i = 0; i < PAA_RU.length; i++) {
    const q = PAA_RU[i]!;
    rows.push(
      base({
        key: `paa|ru|google|q|${slug(q)}`,
        kind: "paa",
        surface: "related",
        region: "RU",
        engine: "GOOGLE",
        providers: ["serper"],
        primaryProvider: "serper",
        question: q,
        title: q,
        evidenceRefs: [`surface:ss-ru-paa-${i}`],
        baseSearchSurfaceItemId: `ss-ru-paa-${i}`,
      })
    );
  }
  for (let i = PAA_RU.length; i < 24; i++) {
    const q = `Related question ${i} about ${SUBJECT}?`;
    rows.push(
      base({
        key: `paa|ru|google|q|pad-${i}`,
        kind: "paa",
        surface: "related",
        region: "RU",
        engine: "GOOGLE",
        providers: ["serper"],
        primaryProvider: "serper",
        question: q,
        title: q,
        evidenceRefs: [`surface:ss-ru-paa-pad-${i}`],
        baseSearchSurfaceItemId: `ss-ru-paa-pad-${i}`,
      })
    );
  }
  for (let i = 0; i < PAA_UAE.length; i++) {
    const q = PAA_UAE[i]!;
    rows.push(
      base({
        key: `paa|uae|google|q|${slug(q)}`,
        kind: "paa",
        surface: "related",
        region: "UAE",
        engine: "GOOGLE",
        providers: ["serper"],
        primaryProvider: "serper",
        question: q,
        title: q,
        evidenceRefs: [`surface:ss-uae-paa-${i}`],
        baseSearchSurfaceItemId: `ss-uae-paa-${i}`,
      })
    );
  }
  for (let i = PAA_UAE.length; i < 12; i++) {
    const q = `UAE related question ${i} about ${SUBJECT}?`;
    rows.push(
      base({
        key: `paa|uae|google|q|pad-${i}`,
        kind: "paa",
        surface: "related",
        region: "UAE",
        engine: "GOOGLE",
        providers: ["serper"],
        primaryProvider: "serper",
        question: q,
        title: q,
        evidenceRefs: [`surface:ss-uae-paa-pad-${i}`],
        baseSearchSurfaceItemId: `ss-uae-paa-pad-${i}`,
      })
    );
  }

  // --- Images ---
  for (let i = 0; i < 24; i++) {
    const region = i < 16 ? "RU" : "UAE";
    const engine = region === "RU" ? "YANDEX" : "GOOGLE";
    const providers = engine === "GOOGLE" ? (["serper"] as string[]) : (["yandex"] as string[]);
    rows.push(
      base({
        key: `other|${region.toLowerCase()}|${engine.toLowerCase()}|images|${id()}`,
        kind: "other",
        surface: "images",
        region,
        engine,
        providers,
        primaryProvider: providers[0]!,
        url: `https://bildarkiv-nordic.se/${region.toLowerCase()}/page-${i}`,
        imageUrl: `https://cdn.bildarkiv-nordic.se/img/${region.toLowerCase()}-${i}.jpg`,
        title: `Photo of ${SUBJECT} at ${COMPANY} event ${i}`,
        snippet: `Image result ${i} for ${SUBJECT}.`,
        evidenceRefs: [`surface:ss-img-${i}`],
        baseSearchSurfaceItemId: `ss-img-${i}`,
      })
    );
  }

  // --- AI answers ---
  for (let i = 0; i < 12; i++) {
    const region = i < 8 ? "RU" : "UAE";
    rows.push(
      base({
        key: `other|${region.toLowerCase()}|arsenkin|ai|${id()}`,
        kind: "other",
        surface: "ai_answer",
        region,
        engine: region === "RU" ? "YANDEX" : "GOOGLE",
        providers: ["arsenkin"],
        primaryProvider: "arsenkin",
        title: `AI overview: ${SUBJECT} and ${COMPANY} (${region}) #${i}`,
        snippet: `AI summary ${i}: ${SUBJECT} is associated with ${COMPANY}; mentions tax inquiry and Dubai expansion.`,
        evidenceRefs: [`arsenkin:ai-${i}`],
        arsenkinTaskId: `task-ai-${i}`,
      })
    );
  }

  // --- Wikipedia / knowledge ---
  for (let i = 0; i < 6; i++) {
    rows.push(
      base({
        key: `other|ru|yandex|wikipedia|${id()}`,
        kind: "other",
        surface: "wikipedia",
        region: "RU",
        engine: "YANDEX",
        url: `https://ru.wikipedia.org/wiki/Holmstrom_${i}`,
        title: `${SUBJECT} — Wikipedia stub ${i}`,
        snippet: `Encyclopedia entry mentioning ${SUBJECT}, entrepreneur, ${COMPANY}.`,
        evidenceRefs: [`surface:ss-wiki-${i}`],
        baseSearchSurfaceItemId: `ss-wiki-${i}`,
      })
    );
  }
  for (let i = 0; i < 4; i++) {
    rows.push(
      base({
        key: `other|ru|yandex|knowledge|${id()}`,
        kind: "other",
        surface: "knowledge_block",
        region: "RU",
        engine: "YANDEX",
        title: `Knowledge panel: ${SUBJECT}`,
        snippet: `${SUBJECT}, founder of ${COMPANY}, Stockholm. Panel variant ${i}.`,
        evidenceRefs: [`surface:ss-kb-${i}`],
        baseSearchSurfaceItemId: `ss-kb-${i}`,
      })
    );
  }

  // --- Exactly 2 compliance hits ---
  rows.push(
    base({
      key: `organic|ru|google|q|https://worldcompliance-screening.ae/lexis-${id()}`,
      kind: "organic",
      surface: "organic",
      region: "RU",
      engine: "GOOGLE",
      providers: ["serper"],
      primaryProvider: "serper",
      url: "https://worldcompliance-screening.ae/lexisnexis/holmstrom-1",
      title: `${SUBJECT} — LexisNexis WorldCompliance adverse media hit`,
      snippet: `Compliance database hit: adverse media and watchlist reference for ${SUBJECT} of ${COMPANY}; requires analyst verification.`,
      evidenceRefs: ["searchResult:sr-compliance-1"],
      baseSearchResultId: "sr-compliance-1",
      riskLabel: "adverse",
    })
  );
  rows.push(
    base({
      key: `organic|uae|google|q|https://worldcompliance-screening.ae/dowjones-${id()}`,
      kind: "organic",
      surface: "organic",
      region: "UAE",
      engine: "GOOGLE",
      providers: ["serper"],
      primaryProvider: "serper",
      url: "https://worldcompliance-screening.ae/dowjones/holmstrom-2",
      title: `${SUBJECT} — Dow Jones Risk & Compliance PEP/RCA match`,
      snippet: `Dow Jones screening returned a potential PEP/RCA match for ${SUBJECT}; identity confirmation required.`,
      evidenceRefs: ["searchResult:sr-compliance-2"],
      baseSearchResultId: "sr-compliance-2",
      riskLabel: "adverse",
    })
  );

  // --- SERP screenshot metadata ---
  for (let i = 0; i < 8; i++) {
    const region = i < 5 ? "RU" : "UAE";
    rows.push(
      base({
        key: `other|${region.toLowerCase()}|yandex|screenshot|${id()}`,
        kind: "other",
        surface: "serp_screenshot",
        region,
        engine: region === "RU" ? "YANDEX" : "GOOGLE",
        providers: region === "RU" ? ["yandex"] : ["serper"],
        primaryProvider: region === "RU" ? "yandex" : "serper",
        url: `https://serp-capture-archive.se/serp/${region.toLowerCase()}-${i}.png`,
        imageUrl: `https://serp-capture-archive.se/serp/${region.toLowerCase()}-${i}.png`,
        title: `SERP screenshot ${region} #${i} for ${SUBJECT}`,
        snippet: `Metadata for captured SERP page ${i}.`,
        evidenceRefs: [`surface:ss-shot-${i}`],
        baseSearchSurfaceItemId: `ss-shot-${i}`,
      })
    );
  }

  if (rows.length < 280 || rows.length > 340) {
    throw new Error(`golden-case observation count out of band: ${rows.length}`);
  }
  return rows;
}

export function goldenCaseObservationStats(rows: CompositeObservation[]): Record<string, number> {
  const stats: Record<string, number> = { total: rows.length };
  for (const r of rows) {
    const k = `${r.kind}:${r.surface ?? "none"}:${r.region ?? "?"}`;
    stats[k] = (stats[k] ?? 0) + 1;
  }
  return stats;
}
