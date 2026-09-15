/**
 * Общие рисунки сайта: подключаются через `<use href="#ic-…">`, чтобы один и тот
 * же значок не дублировался в разметке каждого экрана.
 */
export function SiteIcons() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        <g id="ic-serp" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="13" cy="13" r="8" />
          <path d="m19 19 7 7" />
          <path d="M9 11h8M9 15h5" />
        </g>
        <g id="ic-media" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="6" width="26" height="19" rx="3" />
          <path d="m3 20 6-6 5 5 4-4 11 10" />
          <circle cx="21" cy="12" r="2" />
        </g>
        <g id="ic-open" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 8.5C13.8 6.8 11.2 6 8 6H4v18h4c3.2 0 5.8.8 8 2.5 2.2-1.7 4.8-2.5 8-2.5h4V6h-4c-3.2 0-5.8.8-8 2.5Z" />
          <path d="M16 8.5V26.5" />
        </g>
        <g id="ic-list" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 3.5 27 8v8c0 6.4-4.4 11.4-11 13.5C9.4 27.4 5 22.4 5 16V8Z" />
          <path d="M11.5 15.5h9M11.5 19.5h6" />
        </g>
        <g id="ic-check" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="m3.5 8.5 2.8 2.8L12.5 5" />
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
      </defs>
    </svg>
  );
}

/** Стрелка решающей кнопки. */
export function ArrowIcon() {
  return (
    <svg className="site-btn__arrow" viewBox="0 0 16 16" aria-hidden="true">
      <use href="#ic-arrow" />
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

/** Знак логотипа: верхняя плашка — маркер, нижняя — чернила. */
export function LogoMark() {
  return (
    <svg className="site-logo__mark" viewBox="0 0 22 16" aria-hidden="true">
      <rect x="0" y="0" width="22" height="6" rx="1.5" fill="currentColor" />
      <rect x="0" y="10" width="14" height="6" rx="1.5" style={{ fill: "var(--site-ink)" }} />
    </svg>
  );
}
