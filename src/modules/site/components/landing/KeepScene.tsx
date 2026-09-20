"use client";

/**
 * «Проверка остаётся вашим делом»: одна запись проверки от дня 0 до дня 30.
 *
 * До шага 0077 срок показывали три узкие колонки — запись в день 0, шкала, запись
 * в день 30: один и тот же бланк был нарисован дважды, и читать его приходилось
 * слева направо, догадываясь, что это одна и та же запись. Теперь запись одна и
 * она меняется: день идёт по шкале, на тридцатый графы гаснут одна за другой и
 * запись получает отметку «обезличена».
 *
 * Сцена играет по таймеру при входе в окно, а не по прокрутке: прокруткой её можно
 * проскочить, поэтому она начинается заново каждый раз, когда блок возвращается в
 * окно, — кнопка «показать ещё раз» для этого больше не нужна (владелец 20.09.2026).
 * Состояние покоя — день 30: без скрипта и при выключенном движении блок говорит
 * то же самое.
 */

import { useCallback, useEffect, useRef } from "react";
import { SAFETY } from "@/modules/site/content/landing";
import { Masked } from "../Hidden";

/** 31 деление: по одному на день срока. */
const TICKS = Array.from({ length: 31 }, (_, i) => i);
const RUN_MS = 1900;

export function KeepScene() {
  const scene = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  const timers = useRef<number[]>([]);

  const clear = useCallback(() => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    frame.current = null;
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }, []);

  const play = useCallback(() => {
    const root = scene.current;
    if (!root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    clear();
    const rows = Array.from(root.querySelectorAll<HTMLElement>(".site-keep__rows > div"));
    root.classList.remove("is-closed");
    rows.forEach((row) => row.classList.remove("is-closed"));
    const set = (p: number) => {
      root.style.setProperty("--site-term-p", p.toFixed(4));
      root.style.setProperty("--site-term-day", String(Math.round(p * 30)));
    };
    set(0);
    let from: number | null = null;
    const tick = (ts: number) => {
      from ??= ts;
      const p = Math.min(1, (ts - from) / RUN_MS);
      const eased = p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2;
      set(eased);
      if (p < 1) {
        frame.current = window.requestAnimationFrame(tick);
        return;
      }
      frame.current = null;
      rows.forEach((row, i) => {
        timers.current.push(window.setTimeout(() => row.classList.add("is-closed"), 120 + i * 110));
      });
      timers.current.push(window.setTimeout(() => root.classList.add("is-closed"), 120 + rows.length * 110 + 90));
    };
    frame.current = window.requestAnimationFrame(tick);
  }, [clear]);

  useEffect(() => {
    const root = scene.current;
    if (!root || !("IntersectionObserver" in window)) return;
    let visible = false;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.intersectionRatio >= 0.5 && !visible) {
            visible = true;
            play();
          } else if (entry.intersectionRatio < 0.1) {
            visible = false;
          }
        }
      },
      { threshold: [0, 0.1, 0.5] }
    );
    observer.observe(root);
    return () => {
      observer.disconnect();
      clear();
    };
  }, [play, clear]);

  return (
    <div className="site-keep__panel site-reveal">
      <div className="site-keep__scene site-ticks is-closed" ref={scene} role="img" aria-label={SAFETY.record.label}>
        <div className="site-keep__head">
          <p className="site-keep__title">
            <span className="site-tag">{SAFETY.record.title}</span>
            <span className="site-term__status">{SAFETY.record.status}</span>
          </p>
          <span className="site-keep__day" aria-hidden="true" />
        </div>

        <dl className="site-keep__rows" aria-hidden="true">
          {SAFETY.record.rows.map((row) => (
            <div className="is-closed" key={row.term}>
              <dt>{row.term}</dt>
              <dd>
                <span className="site-keep__val">
                  <Masked text={row.value} />
                </span>
                <span className="site-keep__gone">{SAFETY.record.gone}</span>
              </dd>
            </div>
          ))}
        </dl>

        <div className="site-keep__foot">
          <div className="site-term__scale" aria-hidden="true">
            <span className="site-term__fill" />
            <span className="site-term__ticks">
              {TICKS.map((i) => (
                <i key={i} />
              ))}
            </span>
            <span className="site-term__cursor" />
            <span className="site-term__end">0</span>
            <span className="site-term__end site-term__end--stop">{SAFETY.record.days}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
