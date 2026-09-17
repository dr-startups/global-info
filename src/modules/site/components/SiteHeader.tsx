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
 * Меню выдвигается справа листом (владелец 16.09.2026) и закрывается кнопкой,
 * Escape, касанием подложки или смахиванием вправо по любой точке листа. Указатель
 * захватывается только после горизонтального сдвига: захват сразу при касании
 * перехватывал бы клики по пунктам. Клик, который браузер пришлёт после
 * смахивания, гасится в фазе захвата — иначе смахивание по пункту уводило бы на
 * его страницу.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type MouseEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { CONTACTS, HEADER_NAV, type NavItem } from "@/modules/site/content/contacts";
import { CHECK_FORM_TEXT } from "@/modules/site/content/landing";
import { ButtonLink } from "./Button";
import { LogoMark } from "./SiteIcons";
import { Value } from "./Value";

/** Сдвиг пальца, после которого это смахивание, а не касание пункта. */
const SWIPE_START_PX = 10;
/** Сколько сместить лист вправо, чтобы он закрылся, а не вернулся на место. */
const SWIPE_CLOSE_PX = 80;

type Drag = { x: number; y: number; dx: number; id: number; active: boolean; idle: boolean };

/** Текущий пункт: точный адрес — "page", раздел (страница услуги, статья) — "true". */
function currentOf(item: NavItem, pathname: string, hash: string): "page" | "true" | undefined {
  const [path, anchor] = item.href.split("#");
  if (anchor !== undefined) {
    return (path === "" || path === pathname) && hash === `#${anchor}` ? "page" : undefined;
  }
  if (pathname === path) return "page";
  return pathname.startsWith(`${path}/`) ? "true" : undefined;
}

function NavLinks({
  pathname,
  hash,
  onNavigate,
  labelClass,
}: {
  pathname: string;
  hash: string;
  onNavigate?: (href: string) => void;
  /** Обёртка подписи: под словом в меню телефона проводится штрих выделителя. */
  labelClass?: string;
}) {
  return HEADER_NAV.map((item) => (
    <li key={item.href}>
      <Link href={item.href} aria-current={currentOf(item, pathname, hash)} onClick={() => onNavigate?.(item.href)}>
        {labelClass ? <span className={labelClass}>{item.label}</span> : item.label}
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

  // Смахивание: лист идёт за пальцем вправо; отпустили дальше порога — закрылся,
  // ближе — вернулся переходом. Вертикальное движение отдаётся прокрутке листа.
  const drag = useRef<Drag | null>(null);
  const swallowClick = useRef(false);
  const onPointerDown = (event: PointerEvent<HTMLDialogElement>) => {
    const sheet = drawer.current;
    swallowClick.current = false;
    if (!sheet || event.button !== 0) return;
    const r = sheet.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) return;
    drag.current = { x: event.clientX, y: event.clientY, dx: 0, id: event.pointerId, active: false, idle: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLDialogElement>) => {
    const sheet = drawer.current;
    const d = drag.current;
    if (!sheet || !d || d.idle || event.pointerId !== d.id) return;
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.active) {
      if (Math.abs(dy) > SWIPE_START_PX && Math.abs(dy) > Math.abs(dx)) {
        d.idle = true;
        return;
      }
      if (dx < SWIPE_START_PX) return;
      d.active = true;
      sheet.setPointerCapture(event.pointerId);
      sheet.classList.add("is-dragging");
    }
    d.dx = Math.max(0, dx);
    sheet.style.translate = `${d.dx}px 0`;
  };
  const onPointerEnd = () => {
    const sheet = drawer.current;
    const d = drag.current;
    drag.current = null;
    if (!sheet || !d?.active) return;
    swallowClick.current = true;
    sheet.classList.remove("is-dragging");
    sheet.style.translate = "";
    if (d.dx > SWIPE_CLOSE_PX) sheet.close();
  };
  const onClickCapture = (event: MouseEvent<HTMLDialogElement>) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };
  // Переход к якорю ссылкой Next меняет адрес без события hashchange, и меняет его не сразу:
  // адрес, прочитанный в обработчике клика или в следующем кадре, ещё старый (текущий пункт не
  // отмечался вовсе). Поэтому якорь берётся из ссылки, по которой нажали, а не из адреса.
  const navigated = (href: string) => {
    close();
    const anchor = href.split("#")[1];
    setHash(anchor === undefined ? "" : `#${anchor}`);
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
                const sheet = drawer.current;
                if (!sheet) return;
                sheet.showModal();
                // showModal отдаёт фокус первой кнопке листа — крестику, и Safari на iPhone
                // рисует ему своё кольцо. Фокус берёт сам лист: Tab ведёт к пунктам, а
                // экранный диктор читает имя меню.
                sheet.focus({ preventScroll: true });
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
        tabIndex={-1}
        ref={drawer}
        onClose={() => setOpen(false)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={onClickCapture}
        // Ссылку браузер перетаскивает сам и отменяет указатель посреди смахивания
        onDragStart={(event) => event.preventDefault()}
        onClick={(event) => {
          if (event.target !== drawer.current) return;
          const r = drawer.current.getBoundingClientRect();
          const outside =
            event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
          if (outside) close();
        }}
      >
        <div className="site-drawer__head">
          <button className="site-drawer__close" type="button" aria-label="Закрыть меню" onClick={close}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 3l10 10M13 3 3 13" />
            </svg>
          </button>
        </div>
        <nav aria-label="Разделы сайта">
          <ul className="site-drawer__nav">
            <NavLinks pathname={pathname} hash={hash} onNavigate={navigated} labelClass="site-drawer__label" />
          </ul>
        </nav>
        {/* Главное действие сайта — под большим пальцем, а не где-то вверху страницы за закрытым меню */}
        <div className="site-drawer__bottom">
          <ButtonLink variant="accent" large block arrow href="/#form" onClick={() => navigated("/#form")}>
            {CHECK_FORM_TEXT.submit}
          </ButtonLink>
          <div className="site-drawer__foot">
            <Value text={CONTACTS.phone} />
            <Value text={CONTACTS.email} />
          </div>
        </div>
      </dialog>
    </>
  );
}
