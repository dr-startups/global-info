"use client";

/**
 * «Где мы ищем» — схема: ваши данные → четыре группы источников → результат.
 *
 * До шага 0077 здесь была сетка одинаковых карточек: она отвечала «вот четыре
 * источника», но не отвечала на вопрос блока — что с ними происходит. Узлы те же
 * карточки, только связанные проводами: по проводам идут импульсы, у источника
 * появляется отметка «проверено», в узле результата наливается шкала. Раз за вход
 * в окно, как у примера результата.
 *
 * Провода рисуются по замерам узлов, а не заданы в разметке: у схемы две
 * раскладки (широкая — три колонки, узкая — три этапа на одной оси), и в каждой
 * узлы стоят по-своему. Пересчёт идёт по ResizeObserver, а не по resize окна: у
 * блока меняется ширина и без смены размера окна — например, когда появляется
 * полоса прокрутки.
 *
 * Состояние покоя — законченное: без скрипта и при выключенном движении схема
 * стоит с отметками и налитой шкалой, только без проводов.
 */

import { useEffect, useRef } from "react";
import { SOURCES } from "@/modules/site/content/landing";
import { Dial } from "../Dial";
import { Masked } from "../Hidden";
import { SourceSign } from "../SiteIcons";
import { MEDIUM_METER_LABEL } from "./parts";

const NS = "http://www.w3.org/2000/svg";

type Box = { x: number; y: number; w: number; h: number };

export function SourcesFlow() {
  const flow = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = flow.current;
    if (!root) return;
    const svg = root.querySelector<SVGSVGElement>(".site-flow__wires");
    const start = root.querySelector<HTMLElement>(".site-flow__root");
    const result = root.querySelector<HTMLElement>(".site-flow__result");
    const list = root.querySelector<HTMLElement>(".site-flow__sources");
    if (!svg || !start || !result || !list) return;
    const sources = Array.from(root.querySelectorAll<HTMLElement>(".site-flow__source"));
    // Дуги показания наливаются по очереди, когда пришёл последний источник
    const arcs = Array.from(result.querySelectorAll<SVGPathElement>(".site-dial__on"));
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wide = () => window.matchMedia("(min-width: 1024px)").matches;

    let wires: SVGPathElement[] = [];
    let pulses: { in: SVGPathElement[]; out: SVGPathElement[]; dots: SVGCircleElement[] } | null = null;
    let timers: number[] = [];
    let frames: number[] = [];

    const rect = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      const f = root.getBoundingClientRect();
      return { x: r.left - f.left, y: r.top - f.top, w: r.width, h: r.height };
    };
    const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const k = Math.max(40, (b.x - a.x) * 0.5);
      return `M ${a.x} ${a.y} C ${a.x + k} ${a.y}, ${b.x - k} ${b.y}, ${b.x} ${b.y}`;
    };
    const node = <K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>) => {
      const el = document.createElementNS(NS, name);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
      return el;
    };

    /**
     * Пути импульсов: in[i] — от данных к источнику i, out[i] — от источника i к
     * результату. На широком экране это и есть нарисованные провода; на узком
     * соединителей два (данные → панель источников → результат), и импульсы всех
     * четырёх идут по ним друг за другом.
     */
    const draw = () => {
      svg.textContent = "";
      const f = root.getBoundingClientRect();
      svg.setAttribute("viewBox", `0 0 ${f.width} ${f.height}`);
      const R = rect(start);
      const Q = rect(result);
      const S = sources.map(rect);
      const paths: { in: string[]; out: string[]; drawn: string[]; joints: [number, number][] } = {
        in: [],
        out: [],
        drawn: [],
        joints: [],
      };
      if (wide()) {
        for (const s of S) {
          paths.in.push(curve({ x: R.x + R.w, y: R.y + R.h / 2 }, { x: s.x, y: s.y + s.h / 2 }));
          paths.out.push(curve({ x: s.x + s.w, y: s.y + s.h / 2 }, { x: Q.x, y: Q.y + Q.h / 2 }));
        }
        paths.drawn = [...paths.in, ...paths.out];
      } else {
        const L = rect(list);
        const cx = Math.round(R.x + R.w / 2);
        const down = `M ${cx} ${R.y + R.h} L ${cx} ${L.y}`;
        const out = `M ${cx} ${L.y + L.h} L ${cx} ${Q.y}`;
        for (let k = 0; k < S.length; k += 1) {
          paths.in.push(down);
          paths.out.push(out);
        }
        paths.drawn = [down, out];
        // Стыки-кружки: иначе линия упирается в карточку и читается как хвост, а не как соединение
        paths.joints = [
          [cx, R.y + R.h],
          [cx, L.y],
          [cx, L.y + L.h],
          [cx, Q.y],
        ];
      }
      wires = paths.drawn.map((d) => {
        const path = node("path", { d });
        svg.appendChild(path);
        return path;
      });
      for (const [jx, jy] of paths.joints) {
        svg.appendChild(node("circle", { r: 3.5, cx: jx, cy: jy, class: "site-flow__joint" }));
      }
      const hidden = (d: string) => {
        const path = node("path", { d, style: "stroke:none" });
        svg.appendChild(path);
        return path;
      };
      pulses = {
        in: paths.in.map(hidden),
        out: paths.out.map(hidden),
        dots: S.map(() => {
          const dot = node("circle", { r: 4 });
          svg.appendChild(dot);
          return dot;
        }),
      };
    };

    const clear = () => {
      timers.forEach((t) => window.clearTimeout(t));
      frames.forEach((f) => window.cancelAnimationFrame(f));
      timers = [];
      frames = [];
    };
    const finalState = () => {
      wires.forEach((w) => (w.style.strokeDasharray = ""));
      sources.forEach((s) => s.classList.add("is-done"));
      arcs.forEach((arc) => arc.classList.add("is-on"));
      root.classList.remove("is-playing");
      root.classList.add("is-done");
    };
    const travel = (path: SVGPathElement, dot: SVGCircleElement, ms: number, done?: () => void) => {
      const len = path.getTotalLength();
      let from: number | null = null;
      const tick = (ts: number) => {
        from ??= ts;
        const p = Math.min(1, (ts - from) / ms);
        const eased = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
        const point = path.getPointAtLength(eased * len);
        dot.setAttribute("cx", String(point.x));
        dot.setAttribute("cy", String(point.y));
        dot.style.opacity = p < 1 ? "1" : "0";
        if (p < 1) frames.push(window.requestAnimationFrame(tick));
        else done?.();
      };
      frames.push(window.requestAnimationFrame(tick));
    };
    const drawWire = (wire: SVGPathElement, delay: number, ms: number) => {
      const len = wire.getTotalLength();
      wire.style.strokeDasharray = `${len}`;
      wire.style.strokeDashoffset = `${len}`;
      wire.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], {
        duration: ms,
        delay,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
        fill: "forwards",
      });
    };
    const play = () => {
      if (reduced || !pulses) return finalState();
      clear();
      root.classList.add("is-playing");
      root.classList.remove("is-done");
      sources.forEach((s) => s.classList.remove("is-done"));
      arcs.forEach((arc) => arc.classList.remove("is-on"));
      pulses.dots.forEach((d) => (d.style.opacity = "0"));
      const n = sources.length;
      wires.forEach((w, i) => drawWire(w, wide() ? (i < n ? i * 80 : 700 + (i - n) * 80) : i * 900, 420));
      sources.forEach((source, i) => {
        const dot = pulses!.dots[i]!;
        timers.push(
          window.setTimeout(() => travel(pulses!.in[i]!, dot, 620, () => source.classList.add("is-done")), 350 + i * 90)
        );
        timers.push(
          window.setTimeout(() => {
            travel(pulses!.out[i]!, dot, 620, () => {
              if (i !== n - 1) return;
              arcs.forEach((arc, j) => {
                timers.push(window.setTimeout(() => arc.classList.add("is-on"), j * 140));
              });
              timers.push(
                window.setTimeout(() => {
                  root.classList.add("is-done");
                  root.classList.remove("is-playing");
                }, 260)
              );
            });
          }, 1300 + i * 90)
        );
      });
    };

    draw();
    finalState();

    let resize: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(resize);
      resize = window.setTimeout(() => {
        clear();
        draw();
        finalState();
      }, 120);
    });
    observer.observe(root);

    // Схема играет, когда вошла в окно на 40 %; флаг снимается, когда ушла целиком
    let visible = false;
    const enter = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.intersectionRatio >= 0.4 && !visible) {
            visible = true;
            play();
          } else if (entry.intersectionRatio === 0) {
            visible = false;
          }
        }
      },
      { threshold: [0, 0.4] }
    );
    enter.observe(root);

    return () => {
      clear();
      observer.disconnect();
      enter.disconnect();
      window.clearTimeout(resize);
    };
  }, []);

  return (
    <div
      className="site-flow site-reveal"
      id="flow"
      ref={flow}
      role="group"
      aria-label="Схема проверки: ваши данные, четыре группы источников, результат"
    >
      <svg className="site-flow__wires" aria-hidden="true" />

      <div className="site-flow__node site-flow__root">
        <strong>{SOURCES.root.title}</strong>
        <dl aria-hidden="true">
          {SOURCES.root.fields.map((field) => (
            <div key={field.term}>
              <dt>{field.term}</dt>
              <dd>
                <Masked text={field.value} />
              </dd>
            </div>
          ))}
        </dl>
        <span>{SOURCES.root.note}</span>
      </div>

      <ol className="site-flow__sources" aria-label="Группы источников">
        {SOURCES.items.map((item) => (
          <li className="site-flow__node site-flow__source" key={item.title}>
            <SourceSign id={item.icon} />
            <strong>{item.title}</strong>
            <span>{item.text}</span>
            <span className="site-flow__badge">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <use href="#ic-check" />
              </svg>
              {SOURCES.checked}
            </span>
          </li>
        ))}
      </ol>

      <div className="site-flow__node site-flow__result site-verdict--medium">
        <strong>{SOURCES.result.title}</strong>
        <Dial filled={2} ariaLabel={MEDIUM_METER_LABEL} />
        <div className="site-verdict">
          <div className="site-verdict__row">
            <span className="site-verdict__level">{SOURCES.result.level}</span>
            <span className="site-verdict__count">
              <b>{SOURCES.result.count}</b> {SOURCES.result.countLabel}
            </span>
          </div>
        </div>
        <ul className="site-flow__themes" aria-label="Темы">
          {SOURCES.result.themes.map((theme) => (
            <li key={theme}>{theme}</li>
          ))}
        </ul>
        <span>{SOURCES.result.note}</span>
      </div>
    </div>
  );
}
