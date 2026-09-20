"use client";

/**
 * Пример результата на главной: проигрывание проверки. Это не полоса загрузки, а
 * показ работы — какие запросы уходят, куда и сколько их. Данные вымышлены.
 *
 * Сервер отдаёт уже законченное состояние: без скрипта и при reduced motion
 * пример читается целиком. Проигрывание начинается заново каждый раз, когда
 * панель снова попадает в окно; флаг снимается, только когда она целиком ушла с
 * экрана, иначе дрожание прокрутки перезапускало бы её.
 */

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { EXAMPLE } from "@/modules/site/content/landing";

type FeedItem = (typeof EXAMPLE.feed)[number];

function FeedLine({ item }: { item: FeedItem }) {
  return (
    <li className={"hit" in item ? "is-hit" : undefined}>
      <b>{item.w}</b> · {item.s}
    </li>
  );
}

function feedNode(item: FeedItem): HTMLLIElement {
  const li = document.createElement("li");
  if ("hit" in item) li.className = "is-hit";
  const b = document.createElement("b");
  b.textContent = item.w;
  li.appendChild(b);
  li.appendChild(document.createTextNode(` · ${item.s}`));
  return li;
}

const FINAL_STAGE = EXAMPLE.stages[EXAMPLE.stages.length - 1]!.text;

export function ResultDemo({ children }: { children: ReactNode }) {
  const demo = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLSpanElement>(null);
  const feed = useRef<HTMLUListElement>(null);
  const timers = useRef<number[]>([]);
  const frame = useRef<number | null>(null);

  const clear = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  const run = useCallback(() => {
    const root = demo.current;
    if (!root || !bar.current || !stage.current || !feed.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    clear();
    root.classList.remove("is-done");
    const counters = Array.from(root.querySelectorAll<HTMLElement>("[data-count]"));
    const list = feed.current;
    const box = list.parentElement;
    list.textContent = "";
    list.style.transform = "none";
    counters.forEach((c) => (c.textContent = "0"));
    bar.current.style.transition = "none";
    bar.current.style.width = "0%";

    // Счётчики и полоса идут одним кадром: цифры растут ровно столько, сколько идёт разбор.
    let start: number | null = null;
    const tick = (ts: number) => {
      start ??= ts;
      const p = Math.min(1, (ts - start) / EXAMPLE.runMs);
      const eased = 1 - (1 - p) ** 2;
      if (bar.current) {
        bar.current.style.transition = "";
        bar.current.style.width = `${(p * 100).toFixed(1)}%`;
      }
      counters.forEach((c) => (c.textContent = String(Math.round(Number(c.dataset.count) * eased))));
      frame.current = p < 1 ? window.requestAnimationFrame(tick) : null;
    };
    frame.current = window.requestAnimationFrame(tick);

    for (const s of EXAMPLE.stages) {
      timers.current.push(
        window.setTimeout(() => {
          if (stage.current) stage.current.textContent = s.text;
        }, s.at)
      );
    }

    // Лог разбора: строки добавляются и уезжают вверх, как в консоли сбора.
    const step = Math.round((EXAMPLE.runMs - 900) / EXAMPLE.feed.length);
    EXAMPLE.feed.forEach((item, i) => {
      timers.current.push(
        window.setTimeout(() => {
          if (!box) return;
          list.appendChild(feedNode(item));
          const over = list.offsetHeight - (box.clientHeight - 24);
          list.style.transform = over > 0 ? `translateY(${-over}px)` : "none";
        }, 700 + i * step)
      );
    });

    timers.current.push(
      window.setTimeout(() => {
        root.classList.add("is-done");
        counters.forEach((c) => (c.textContent = c.dataset.count ?? ""));
      }, EXAMPLE.runMs)
    );
  }, [clear]);

  useEffect(() => {
    const root = demo.current;
    if (!root || !("IntersectionObserver" in window)) return;
    let visible = false;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.intersectionRatio >= 0.35 && !visible) {
            visible = true;
            run();
          } else if (entry.intersectionRatio < 0.1) {
            // Пролистал мимо — при следующем возвращении проигрывание начнётся заново.
            // Порог именно 0.1, а не «ушла целиком»: высокая панель на большом экране
            // полностью не уходит, и кнопка «показать ещё раз» была единственным способом.
            visible = false;
          }
        }
      },
      { threshold: [0, 0.1, 0.35] }
    );
    observer.observe(root);
    return () => {
      observer.disconnect();
      clear();
    };
  }, [run, clear]);

  return (
    <div className="site-demo site-ticks is-done" id="demo" ref={demo} aria-label="Пример результата проверки">
      <div className="site-demo__bar">
        <div className="site-demo__row">
          <span className="site-demo__stage" ref={stage} aria-live="polite">
            {FINAL_STAGE}
          </span>
        </div>
        <div
          className="site-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={100}
          aria-label="Ход проверки"
        >
          <div className="site-progress__bar" ref={bar} style={{ width: "100%" }} />
        </div>
      </div>

      <div className="site-demo__stats">
        {EXAMPLE.stats.map((stat) => (
          <div className="site-demo__stat" key={stat.label}>
            <b data-count={stat.count}>{stat.count}</b>
            <span className="site-tag">{stat.label}</span>
          </div>
        ))}
      </div>

      <div className="site-demo__feed" aria-hidden="true">
        <ul ref={feed}>
          {EXAMPLE.feed.slice(-4).map((item) => (
            <FeedLine key={item.w} item={item} />
          ))}
        </ul>
      </div>

      <div className="site-demo__result site-demo__reveal">
        {children}
        {/* Почему заголовки закрыты, сказано словами: иначе размытая строка читается как недогрузка */}
        <p className="site-demo__hint">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <use href="#ic-hidden" />
          </svg>
          {EXAMPLE.hiddenNote}
        </p>
      </div>
    </div>
  );
}
