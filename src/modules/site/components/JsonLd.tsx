import { serializeJsonLd } from "@/modules/site/seo/json-ld";

/** Структурированные данные страницы: по тегу на объект, `<` экранирован. */
export function JsonLd({ data }: { data: readonly Record<string, unknown>[] }) {
  return (
    <>
      {data.map((item, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(item) }} />
      ))}
    </>
  );
}
