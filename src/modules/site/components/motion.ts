/**
 * Появление блоков при прокрутке и заголовки, выезжающие из-под маски построчно.
 *
 * Класс `js` на `<html>` ставится здесь, после гидрации, а не скриптом в разметке:
 * иначе всё под `.js .site-reveal` было бы спрятано, пока грузится бандл, — на
 * медленном телефоне это секунды пустого первого экрана. Что к этому моменту уже
 * на экране, сразу получает `is-in` и не режется на строки: видимый текст не
 * исчезает и не выезжает заново. Появление героя при загрузке — CSS
 * (`.site-stagger`), ему скрипт не нужен.
 */

/** Строки режутся по фактическим переносам — после смены ширины или шрифта их надо пересобрать. */
export function splitLines(el: HTMLElement): void {
  let source = el.getAttribute("data-text");
  if (source === null) {
    source = (el.textContent ?? "").replace(/\s+/gu, " ").trim();
    el.setAttribute("data-text", source);
  }
  el.textContent = "";
  const words = source.split(" ");
  const probes = words.map((word, i) => {
    const span = document.createElement("span");
    span.textContent = word + (i < words.length - 1 ? " " : "");
    el.appendChild(span);
    return span;
  });
  const lines: string[][] = [];
  let lastTop: number | null = null;
  for (const probe of probes) {
    if (lastTop === null || Math.abs(probe.offsetTop - lastTop) > 2) {
      lines.push([]);
      lastTop = probe.offsetTop;
    }
    lines[lines.length - 1]!.push(probe.textContent ?? "");
  }
  el.textContent = "";
  lines.forEach((line, i) => {
    const outer = document.createElement("span");
    outer.className = "site-lines__line";
    const inner = document.createElement("span");
    inner.className = "site-lines__inner";
    inner.style.setProperty("--line-delay", `${i * 70}ms`);
    inner.textContent = line.join("");
    outer.appendChild(inner);
    el.appendChild(outer);
  });
}

function inView(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return el.offsetParent !== null && r.top < window.innerHeight * 0.9 && r.bottom > 0;
}

/** Взводит появление на текущей странице; возвращает уборку. */
export function armMotion(): () => void {
  document.documentElement.classList.add("js");
  const items = Array.from(
    document.querySelectorAll<HTMLElement>(".site-reveal, .site-reveal--stagger, .site-lines")
  ).filter((el) => !el.classList.contains("is-in"));

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || !("IntersectionObserver" in window)) {
    for (const el of items) el.classList.add("is-in");
    return () => undefined;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        observer.unobserve(entry.target);
      }
    },
    // Нижняя граница −22 %: блок появляется, когда вошёл в окно заметно, а не краем.
    { threshold: 0.12, rootMargin: "0px 0px -22% 0px" }
  );

  const split: HTMLElement[] = [];
  for (const el of items) {
    if (inView(el)) {
      el.classList.add("is-in");
      continue;
    }
    if (el.classList.contains("site-lines")) {
      splitLines(el);
      split.push(el);
    }
    observer.observe(el);
  }

  const resplit = () => {
    for (const el of split) {
      if (el.offsetParent === null) continue;
      const wasIn = el.classList.contains("is-in");
      splitLines(el);
      if (wasIn) el.classList.add("is-in");
    }
  };
  let timer: number | undefined;
  const onResize = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(resplit, 180);
  };
  window.addEventListener("resize", onResize);
  // Переносы, измеренные запасным шрифтом, после загрузки Golos Text уже не те.
  let alive = true;
  void document.fonts?.ready.then(() => {
    if (alive) resplit();
  });

  return () => {
    alive = false;
    observer.disconnect();
    window.removeEventListener("resize", onResize);
    window.clearTimeout(timer);
  };
}
