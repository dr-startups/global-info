/**
 * Общие рисунки сайта: подключаются через `<use href="#ic-…">`, чтобы один и тот
 * же значок не дублировался в разметке каждого экрана.
 *
 * Знаки источников (`#sg-…`) — не значки, а малые предметы в рисовке серии 5:
 * ровный чернильный контур (`vector-effect` не даёт ему толстеть в крупном
 * размере), плоские заливки бумагой, тёплым серым и сиренью, жёсткая тень.
 * Цвета берутся из переменных `.site-sign`, поэтому знак одинаков и в строке
 * панели, и в схеме «Где мы ищем». Генерация картинкой отклонена владельцем
 * 19.09.2026: растр и разная толщина линий.
 */

const SIGN_STROKE = { strokeWidth: 1.5, vectorEffect: "non-scaling-stroke" } as const;
const INK = { fill: "var(--sg-ink)" };
const GREY = { fill: "var(--sg-grey)" };
const PAPER = { fill: "var(--sg-paper)", stroke: "var(--sg-ink)" };
const IVORY = { fill: "var(--sg-ivory)", stroke: "var(--sg-ink)" };
const LILAC = { fill: "var(--sg-lilac)", stroke: "var(--sg-ink)" };

export function SiteIcons() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        <g id="ic-serp" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="13" cy="13" r="8" />
          <path d="m19 19 7 7" />
          <path d="M9 11h8M9 15h5" />
        </g>
        <g id="ic-check" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="m3.5 8.5 2.8 2.8L12.5 5" />
        </g>
        {/* Закрытый глаз: почему заголовков находок не видно */}
        <g id="ic-hidden" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M1.8 8S4 3.9 8 3.9 14.2 8 14.2 8 12 12.1 8 12.1 1.8 8 1.8 8Z" />
          <circle cx="8" cy="8" r="1.9" />
          <path d="m2.8 13.2 10.4-10.4" />
        </g>
        <g id="ic-arrow" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8h10M9 4l4 4-4 4" />
        </g>
        <g id="ic-copy" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
          <path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
        </g>
        <g id="ic-ext" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" />
        </g>
        <g id="ic-warn" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 3 2.5 16h15L10 3Z" />
          <path d="M10 8v4M10 14h.01" />
        </g>
        <g id="ic-info" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="10" cy="10" r="7.25" />
          <path d="M10 9v5M10 6.2h.01" />
        </g>
        <g id="ic-chev" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 8 5 5 5-5" />
        </g>
        <g id="ic-search" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <circle cx="8" cy="8" r="5.25" />
          <path d="m12 12 4 4" />
        </g>

        {/* Открытые источники: три корешка — один сиреневый, один прислонён */}
        <symbol id="sg-open" viewBox="0 0 48 48">
          <g style={INK} transform="translate(3 3)">
            <rect x="6" y="9" width="10" height="30" rx="1.2" />
            <rect x="16" y="14" width="9.5" height="25" rx="1.2" />
            <rect x="32" y="10" width="9.5" height="29" rx="1.2" transform="rotate(-14 32 39)" />
          </g>
          <rect x="6" y="9" width="10" height="30" rx="1.2" style={PAPER} {...SIGN_STROKE} />
          <rect x="8.4" y="13.5" width="5.2" height="8" rx=".8" style={INK} />
          <rect x="6" y="32.5" width="10" height="2.2" style={GREY} />
          <rect x="16" y="14" width="9.5" height="25" rx="1.2" style={LILAC} {...SIGN_STROKE} />
          <rect x="16" y="18.4" width="9.5" height="1.8" style={INK} />
          <rect x="16" y="22" width="9.5" height="1.8" style={INK} />
          <g transform="rotate(-14 32 39)">
            <rect x="32" y="10" width="9.5" height="29" rx="1.2" style={IVORY} {...SIGN_STROKE} />
            <rect x="34.6" y="14.5" width="4.3" height="10" rx=".8" style={GREY} />
            <rect x="32" y="32" width="9.5" height="2.2" style={INK} />
          </g>
        </symbol>

        {/* Санкционные списки: лист со строками, перед ним печать с сиреневой ручкой */}
        <symbol id="sg-list" viewBox="0 0 48 48">
          <rect x="8" y="8" width="25" height="33" rx="2.5" style={INK} />
          <rect x="5" y="5" width="25" height="33" rx="2.5" style={PAPER} {...SIGN_STROKE} />
          <circle cx="10" cy="12.3" r="1.5" style={GREY} />
          <rect x="13.5" y="11" width="12" height="2.6" rx=".8" style={GREY} />
          <circle cx="10" cy="18.8" r="1.5" style={INK} />
          <rect x="13.5" y="17.5" width="13" height="2.6" rx=".8" style={INK} />
          <circle cx="10" cy="25.3" r="1.5" style={GREY} />
          <rect x="13.5" y="24" width="8" height="2.6" rx=".8" style={GREY} />
          <circle cx="10" cy="31.8" r="1.5" style={GREY} />
          <rect x="13.5" y="30.5" width="6" height="2.6" rx=".8" style={GREY} />
          <rect x="25" y="38.2" width="20" height="5.6" rx="1.6" style={INK} />
          <path d="M29.4 38.2 31.8 29.6H38.2L40.6 38.2Z" style={GREY} strokeLinejoin="round" {...SIGN_STROKE} />
          <circle cx="35" cy="24" r="6.2" style={LILAC} {...SIGN_STROKE} />
        </symbol>

        {/* Панель знаний: карточка с портретом и лупой */}
        <symbol id="sg-panel" viewBox="0 0 48 48">
          <rect x="8" y="10" width="30" height="27" rx="3" style={INK} />
          <rect x="5" y="7" width="30" height="27" rx="3" style={PAPER} {...SIGN_STROKE} />
          <circle cx="13" cy="16" r="4" style={GREY} {...SIGN_STROKE} />
          <rect x="20" y="12.4" width="11" height="2.8" rx=".8" style={INK} />
          <rect x="20" y="17.6" width="8" height="2.6" rx=".8" style={GREY} />
          <rect x="9" y="24.6" width="17" height="2.6" rx=".8" style={GREY} />
          <rect x="9" y="29.2" width="11" height="2.6" rx=".8" style={GREY} />
          <rect
            x="-1.9"
            y="0"
            width="3.8"
            height="9"
            rx="1.9"
            transform="translate(38.4 37.4) rotate(-45)"
            style={INK}
          />
          <circle cx="33" cy="32" r="8" style={LILAC} {...SIGN_STROKE} />
          <rect x="28.6" y="30" width="8.8" height="4" rx=".8" style={INK} />
        </symbol>

        {/* Поисковая выдача: строка запроса и страница результатов */}
        <symbol id="sg-serp" viewBox="0 0 48 48">
          <rect x="7" y="8" width="38" height="11" rx="5.5" style={INK} />
          <rect x="4" y="5" width="38" height="11" rx="5.5" style={PAPER} {...SIGN_STROKE} />
          <circle cx="10.5" cy="10.5" r="2.4" style={LILAC} {...SIGN_STROKE} />
          <rect x="16" y="9.2" width="15" height="2.6" rx=".8" style={INK} />
          <rect x="5" y="22.6" width="20" height="2.8" rx=".8" style={INK} />
          <rect x="5" y="27" width="32" height="2.2" rx=".8" style={GREY} />
          <rect x="3.5" y="32" width="18" height="5" rx="1" style={{ fill: "var(--sg-lilac)" }} />
          <rect x="5" y="33.1" width="14" height="2.8" rx=".8" style={INK} />
          <rect x="5" y="38.4" width="28" height="2.2" rx=".8" style={GREY} />
          <rect x="5" y="43.4" width="17" height="2.8" rx=".8" style={INK} />
        </symbol>

        {/* Картинки, видео и подсказки: кадр видео и снимок */}
        <symbol id="sg-media" viewBox="0 0 48 48">
          <rect x="16" y="5" width="28" height="21" rx="2.5" style={{ fill: "var(--sg-grey)", stroke: "var(--sg-ink)" }} {...SIGN_STROKE} />
          <path d="M33 10.5 40 15.5 33 20.5Z" style={PAPER} strokeLinejoin="round" {...SIGN_STROKE} />
          <rect x="7" y="20" width="29" height="23" rx="2.5" style={INK} />
          <rect x="4" y="17" width="29" height="23" rx="2.5" style={PAPER} {...SIGN_STROKE} />
          <circle cx="12" cy="24.5" r="3.2" style={LILAC} {...SIGN_STROKE} />
          <path d="M5 38.6 14.5 29 20.5 34.5 24.5 31 32 38.6Z" style={GREY} strokeLinejoin="round" {...SIGN_STROKE} />
        </symbol>
      </defs>
    </svg>
  );
}

/**
 * Знак источника. Размер задаёт вёрстка, кроме крупного знака карточки —
 * единственного места, где он стоит предметом, а не отметкой в строке.
 */
export function SourceSign({ id, large }: { id: string; large?: boolean }) {
  return (
    <svg className={large ? "site-sign site-sign--lg" : "site-sign"} viewBox="0 0 48 48" aria-hidden="true">
      <use href={`#${id}`} />
    </svg>
  );
}

/** Значок у текста ошибки поля. */
export function ErrorIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 5v3.5M8 11h.01" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Знак логотипа (решение владельца 20.09.2026): квадратная G с i внутри.
 *
 * Сетка 5 × 5, модуль 10 — он же толщина штриха, сиреневая плашка и оба просвета
 * вокруг неё; поле 50 × 50 без отступов, охранное поле добавляет вёрстка. Буква
 * — один залитый путь (`kit/geometry.json → markPath`), плашка красится
 * `currentColor`, поэтому на тёмном фоне достаточно сменить `color`.
 */
export function LogoMark() {
  return (
    <svg className="site-logo__mark" viewBox="0 0 50 50" aria-hidden="true">
      <path
        d="M27.8 0A2.2 2.2 0 0 1 30 2.2V7.8A2.2 2.2 0 0 1 27.8 10H18A8 8 0 0 0 10 18V32A8 8 0 0 0 18 40H32A8 8 0 0 0 40 32V30H32.2A2.2 2.2 0 0 1 30 27.8V22.2A2.2 2.2 0 0 1 32.2 20H47.8A2.2 2.2 0 0 1 50 22.2V32A18 18 0 0 1 32 50H18A18 18 0 0 1 0 32V18A18 18 0 0 1 18 0Z"
        style={{ fill: "var(--site-ink)" }}
      />
      <rect x="40" y="0" width="10" height="10" rx="2.8" fill="currentColor" />
    </svg>
  );
}
