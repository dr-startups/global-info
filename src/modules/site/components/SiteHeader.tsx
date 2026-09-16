"use client";

/**
 * Шапка сайта и меню узкого экрана.
 *
 * Меню телефона — модальный `<dialog>`, а не список в шапке: у панели шапки
 * `backdrop-filter`, и всё `position: fixed` внутри неё считалось бы от панели, а
 * не от окна. `showModal` даёт верхний слой, подложку, Escape и возврат фокуса на
 * бургер. Закрывается до перехода по ссылке — иначе закрытие вернуло бы фокус на
 * бургер уже после переноса фокуса на новый экран.
 *
 * Меню — нижний лист, как в мобильном приложении (замечание владельца 16.09.2026 к
 * боковой панели): выезжает снизу и закрывается кнопкой, Escape, касанием подложки
 * или потягиванием за шапку листа вниз. Потягивание слушает только шапка листа:
 * захват указателя на всём листе перехватывал бы клики по пунктам.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import { CONTACTS, HEADER_NAV, type NavItem } from "@/modules/site/content/contacts";
import { CHECK_FORM_TEXT } from "@/modules/site/content/landing";
import { ArrowIcon, LogoMark } from "./SiteIcons";
import { Value } from "./Value";

/** Сколько тянуть лист вниз, чтобы он закрылся, а не вернулся на место. */
const SWIPE_CLOSE_PX = 80;

/** Текущий пункт: точный адрес — "page", раздел (страница услуги, статья) — "true". */
function currentOf(item: NavItem, pathname: string, hash: string): "page" | "true" | undefined {
  const [path, anchor] = item.href.split("#");
  if (anchor !== undefined) {
    return (path === "" || path === pathname) && hash === `#${anchor}` ? "page" : undefined;
  }
  if (pathname === path) return "page";
  return pathname.startsWith(`${path}/`) ? "true" : undefined;
}

function NavLinks({ pathname, hash, onNavigate }: { pathname: string; hash: string; onNavigate?: () => void }) {
  return HEADER_NAV.map((item) => (
    <li key={item.href}>
      <Link href={item.href} aria-current={currentOf(item, pathname, hash)} onClick={onNavigate}>
        {item.label}
      </Link>
    </li>
  ));
}

export function SiteHeader() {
  const pathname = usePathname();
  const [hash, setHash] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  // Шапка мастера — только логотип: ничто не уводит со сценария проверки.
  const minimal = pathname.startsWith("/check");

  useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [pathname]);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let queued = false;
    const onScroll = () => {
      setScrolled(window.scrollY > 24);
      if (queued || reduced) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        // Сетка героя сдвигается медленнее страницы: глубина без отдельной картинки.
        document.documentElement.style.setProperty("--site-scroll", `${Math.min(window.scrollY, 900)}px`);
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const wide = window.matchMedia("(min-width: 900px)");
    const onWide = () => {
      if (wide.matches && drawer.current?.open) drawer.current.close();
    };
    wide.addEventListener("change", onWide);
    return () => wide.removeEventListener("change", onWide);
  }, []);

  const close = () => drawer.current?.close();

  // Потягивание листа: пока палец на шапке листа, лист идёт за ним; отпустили ниже
  // порога — закрылся, выше — вернулся переходом.
  const drag = useRef<{ from: number; dy: number } | null>(null);
  const onDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    drag.current = { from: event.clientY, dy: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const sheet = drawer.current;
    if (!drag.current || !sheet) return;
    drag.current.dy = Math.max(0, event.clientY - drag.current.from);
    sheet.style.transition = "none";
    sheet.style.translate = `0 ${drag.current.dy}px`;
  };
  const onDragEnd = () => {
    const sheet = drawer.current;
    if (!drag.current || !sheet) return;
    const { dy } = drag.current;
    drag.current = null;
    sheet.style.transition = "";
    sheet.style.translate = "";
    if (dy > SWIPE_CLOSE_PX) sheet.close();
  };
  // Переход к якорю ссылкой Next меняет адрес без события hashchange.
  const navigated = () => {
    close();
    requestAnimationFrame(() => setHash(window.location.hash));
  };

  return (
    <>
      <header className={`site-header${scrolled ? " is-scrolled" : ""}${minimal ? " is-minimal" : ""}`}>
        <div className="site-container">
          <div className="site-header__inner">
            <Link className="site-logo" href="/" aria-label="Global Info — на главную">
              <LogoMark />
              <span>Global Info</span>
            </Link>
            <nav aria-label="Основное меню">
              <ul className="site-nav">
                <NavLinks pathname={pathname} hash={hash} onNavigate={navigated} />
              </ul>
            </nav>
            <button
              className="site-burger"
              type="button"
              aria-label="Открыть меню"
              aria-controls="site-drawer"
              aria-expanded={open}
              onClick={() => {
                drawer.current?.showModal();
                setOpen(true);
              }}
            >
              <svg viewBox="0 0 20 14" aria-hidden="true">
                <path d="M1 1h18M1 7h18M1 13h11" />
              </svg>
            </button>
            <span className="site-header__progress" aria-hidden="true" />
          </div>
        </div>
      </header>

      <dialog
        className="site-drawer"
        id="site-drawer"
        aria-label="Меню"
        ref={drawer}
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target !== drawer.current) return;
          const r = drawer.current.getBoundingClientRect();
          const outside =
            event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
          if (outside) close();
        }}
      >
        <div
          className="site-drawer__head"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        >
          <span className="site-drawer__grip" aria-hidden="true" />
          <p className="site-drawer__title">Меню</p>
          <button className="site-drawer__close" type="button" aria-label="Закрыть меню" onClick={close}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 3l10 10M13 3 3 13" />
            </svg>
          </button>
        </div>
        <nav aria-label="Разделы сайта">
          <ul className="site-drawer__nav">
            <NavLinks pathname={pathname} hash={hash} onNavigate={navigated} />
          </ul>
        </nav>
        {/* Главное действие сайта — под большим пальцем, а не где-то вверху страницы за закрытым меню */}
        <Link className="site-btn site-btn--accent site-btn--lg site-btn--block" href="/#form" onClick={navigated}>
          {CHECK_FORM_TEXT.submit}
          <ArrowIcon />
        </Link>
        <div className="site-drawer__foot">
          <Value text={CONTACTS.phone} />
          <Value text={CONTACTS.email} />
        </div>
      </dialog>
    </>
  );
}
