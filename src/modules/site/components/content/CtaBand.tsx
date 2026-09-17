import { CHECK_FORM_TEXT } from "@/modules/site/content/landing";
import { ButtonLink } from "../Button";

/** Лента «проверьте бесплатно» в конце страницы: каждая страница ведёт на проверку. */
export function CtaBand({ title, text }: { title: string; text: string }) {
  return (
    <div className="site-cta-band" style={{ marginTop: "var(--site-s-7)" }}>
      <h2 className="site-h3" style={{ fontSize: "var(--site-text-xl)" }}>
        {title}
      </h2>
      <p>{text}</p>
      <ButtonLink variant="accent" large arrow href="/#form">
        {CHECK_FORM_TEXT.submit}
      </ButtonLink>
    </div>
  );
}
