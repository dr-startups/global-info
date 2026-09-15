"use client";

/**
 * Поисковая строка в герое: печатает запросы, которые человек задаёт про себя
 * сам. Имени в ней нет — ни настоящего, ни закрашенного. Без движения (reduced
 * motion) стоит первый запрос целиком.
 */

import { useEffect, useRef } from "react";

const TYPE_MS = 78;
const ERASE_MS = 38;
const HOLD_MS = 1900;

export function HeroSeek({ words }: { words: readonly string[] }) {
  const word = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = word.current;
    if (!el || words.length === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.textContent = words[0]!;
      return;
    }
    let i = 0;
    let pos = 0;
    let erasing = false;
    let timer = 0;
    const tick = () => {
      const current = words[i]!;
      if (!erasing) {
        pos += 1;
        el.textContent = current.slice(0, pos);
        if (pos >= current.length) {
          erasing = true;
          timer = window.setTimeout(tick, HOLD_MS);
          return;
        }
        timer = window.setTimeout(tick, TYPE_MS);
        return;
      }
      pos -= 1;
      el.textContent = pos > 0 ? current.slice(0, pos) : "";
      if (pos <= 0) {
        erasing = false;
        i = (i + 1) % words.length;
        timer = window.setTimeout(tick, 420);
        return;
      }
      timer = window.setTimeout(tick, ERASE_MS);
    };
    timer = window.setTimeout(tick, 900);
    return () => window.clearTimeout(timer);
  }, [words]);

  return (
    <div className="site-seek" aria-hidden="true">
      <div className="site-seek__bar">
        <svg
          className="site-seek__icon"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        >
          <circle cx="8.5" cy="8.5" r="5.75" />
          <path d="m12.8 12.8 4.2 4.2" />
        </svg>
        <span className="site-seek__query">
          <span className="site-seek__word" ref={word} />
          <span className="site-seek__caret" />
        </span>
      </div>
    </div>
  );
}
