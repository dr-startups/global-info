import Link from "next/link";
import { CONTACTS, FOOTER_NAV, LEGAL_NAV } from "@/modules/site/content/contacts";
import { LogoMark } from "./SiteIcons";
import { Value } from "./Value";

export function SiteFooter() {
  return (
    <footer className="site-footer" id="contacts" data-anchor="contacts">
      <div className="site-container site-stack" style={{ gap: "var(--site-s-5)" }}>
        <div className="site-footer__row">
          <Link className="site-logo" href="/" aria-label="Global Info — на главную">
            <LogoMark />
            <span>Global Info</span>
          </Link>
          <ul className="site-footer__links">
            {FOOTER_NAV.map((item) => (
              <li key={item.href}>
                <Link href={item.href}>{item.label}</Link>
              </li>
            ))}
          </ul>
        </div>
        <div className="site-footer__row">
          <p>
            Контакты: <Value text={CONTACTS.phone} />, <Value text={CONTACTS.email} />
          </p>
          <ul className="site-footer__links">
            {LEGAL_NAV.map((item) => (
              <li key={item.href}>
                <Link href={item.href}>{item.label}</Link>
              </li>
            ))}
          </ul>
        </div>
        <p className="site-footer__legal">
          <Value text={CONTACTS.legalEntity} />, реквизиты <Value text={CONTACTS.requisites} />. Результат проверки
          строится автоматически по открытым источникам и не является юридическим заключением. © 2026 Global Info
        </p>
      </div>
    </footer>
  );
}
