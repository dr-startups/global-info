"use client";

/**
 * Поисковая строка в герое и список «Будет проверено» под ней.
 *
 * Строка печатает запросы, которые человек задаёт про себя сам. Имени в ней нет —
 * ни настоящего, ни закрашенного. За строкой — ровное свечение по её форме: цвет
 * медленно идёт по кругу и усиливается, пока набирается запрос.
 *
 * Список источников — второй элемент того же компонента, а не соседний: отметки
 * идут за набором запроса, и отдельному компоненту пришлось бы сообщать прогресс
 * состоянием — то есть перерисовывать React на каждую букву. Фрагмент не заводит
 * узла в DOM, поэтому строка и список остаются прямыми детьми сетки первого
 * экрана: сетка ставит их в свои ряды.
 *
 * Отметки на узком экране не идут: там список стоит после формы, строки рядом нет
 * — и он просто отмечен целиком. Без скрипта и при выключенном движении — тоже:
 * в разметке все пять отмечены, скрипт только снимает и возвращает отметки.
 */

import { useEffect, useRef } from "react";
import { HERO } from "@/modules/site/content/landing";

const TYPE_MS = 78;
const ERASE_MS = 34;
const HOLD_MS = 2200;

export function HeroSeek({ words }: { words: readonly string[] }) {
  const seek = useRef<HTMLDivElement>(null);
  const word = useRef<HTMLSpanElement>(null);
  const checks = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const el = word.current;
    const box = seek.current;
    const list = checks.current;
    if (!el || !box || !list || words.length === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.textContent = words[0]!;
      return;
    }
    const items = Array.from(list.children);
    const wide = window.matchMedia("(min-width: 1024px)");
    const mark = (share: number) => {
      const n = wide.matches ? Math.ceil(share * items.length) : items.length;
      items.forEach((li, k) => li.classList.toggle("is-on", k < n));
    };

    // Вне окна печать стоит: таймер не дёргает разметку, пока строки не видно.
    let visible = true;
    const observer = "IntersectionObserver" in window ? new IntersectionObserver(
      (entries) => {
        visible = entries[0]!.isIntersecting;
      }
    ) : null;
    observer?.observe(box);

    let i = 0;
    let pos = 0;
    let erasing = false;
    let timer = 0;
    const tick = () => {
      if (!visible || document.hidden) {
        timer = window.setTimeout(tick, 500);
        return;
      }
      const current = words[i]!;
      if (!erasing) {
        box.classList.add("is-typing"); // свечение усиливается, пока набирается запрос
        pos += 1;
        el.textContent = current.slice(0, pos);
        mark(pos / current.length);
        if (pos >= current.length) {
          erasing = true;
          box.classList.remove("is-typing");
          timer = window.setTimeout(tick, HOLD_MS);
          return;
        }
        timer = window.setTimeout(tick, TYPE_MS);
        return;
      }
      pos -= 1;
      el.textContent = pos > 0 ? current.slice(0, pos) : "";
      mark(pos / current.length);
      if (pos <= 0) {
        erasing = false;
        i = (i + 1) % words.length;
        timer = window.setTimeout(tick, 520);
        return;
      }
      timer = window.setTimeout(tick, ERASE_MS);
    };
    mark(0);
    timer = window.setTimeout(tick, 900);
    return () => {
      window.clearTimeout(timer);
      observer?.disconnect();
    };
  }, [words]);

  return (
    <>
      <div className="site-seek" aria-hidden="true" ref={seek}>
        <div className="site-seek__field">
          <span className="site-seek__aura">
            <i />
          </span>
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
      </div>

      {/* Строка скрыта от экранного диктора, список — нет: это и есть ответ на вопрос «что проверят» */}
      <div className="site-checks">
        <p className="site-tag" id="checks-title">
          {HERO.checksTitle}
        </p>
        <ul className="site-checks__list" aria-labelledby="checks-title" ref={checks}>
          {HERO.checks.map((item) => (
            <li className="is-on" key={item}>
              <i aria-hidden="true">
                <svg viewBox="0 0 16 16">
                  <use href="#ic-check" />
                </svg>
              </i>
              {item}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
