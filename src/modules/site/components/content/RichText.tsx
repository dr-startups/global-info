import Link from "next/link";
import { inlineParts } from "@/modules/site/content/blocks";
import { Value } from "../Value";

/** Строчная разметка контента: `**жирный**`, `[текст](/адрес)`, видимые плейсхолдеры `{{…}}`. */
export function RichText({ text }: { text: string }) {
  return (
    <>
      {inlineParts(text).map((part, i) => {
        switch (part.kind) {
          case "text":
            return part.text;
          case "strong":
            return <strong key={i}>{part.text}</strong>;
          case "link":
            return (
              <Link key={i} href={part.href}>
                {part.text}
              </Link>
            );
          case "placeholder":
            return <Value key={i} text={part.text} />;
        }
      })}
    </>
  );
}
