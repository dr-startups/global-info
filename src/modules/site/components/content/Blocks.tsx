import { Fragment, type CSSProperties, type ReactNode } from "react";
import type { Block, Phase } from "@/modules/site/content/blocks";
import { HOW, SOURCES, TOPICS } from "@/modules/site/content/landing";
import { Faq } from "../Faq";
import { SourceSign } from "../SiteIcons";
import { RichText } from "./RichText";

/**
 * Блоки текста страницы. Разделы, абзацы и списки, идущие подряд, — один
 * `.site-prose`, как в макете; сетки, этапы и вопросы стоят между ними со своими
 * отступами. Блоки главной (источники, темы, шаги) рисуются из констант главной.
 */

type Prose = { kind: "prose"; node: ReactNode };
type Wide = { kind: "wide"; node: ReactNode };
type Item = Prose | Wide;

const gap = (step: 4 | 5 | 7): CSSProperties => ({ marginTop: `var(--site-s-${step})` });

/** Якорь раздела статьи для содержания: `razdel-1`, `razdel-2`… по порядку разделов с `toc`. */
export function tocAnchors(blocks: readonly Block[]): { id: string; label: string }[] {
  return blocks
    .filter((b): b is Extract<Block, { type: "h2" }> => b.type === "h2" && Boolean(b.toc))
    .map((b, i) => ({ id: `razdel-${i + 1}`, label: b.toc! }));
}

function PhaseList({ items, rows }: { items: readonly Phase[]; rows?: boolean }) {
  return (
    <ol className={`site-phases${rows ? " site-phases--rows" : ""}`} style={rows ? gap(5) : undefined}>
      {items.map((phase) => (
        <li key={phase.tag}>
          <span className="site-tag">{phase.tag}</span>
          <h3 className="site-h3">{phase.title}</h3>
          <p>{phase.text}</p>
        </li>
      ))}
    </ol>
  );
}

function expand(blocks: readonly Block[]): Item[] {
  let tocIndex = 0;
  return blocks.flatMap((block, i): Item[] => {
    switch (block.type) {
      case "h2": {
        const id = block.toc ? `razdel-${++tocIndex}` : undefined;
        // data-anchor — правило site.css с отступом под плавающую шапку: без него переход из
        // содержания ставил заголовок раздела под шапку.
        return [
          {
            kind: "prose",
            node: (
              <h2 key={i} id={id} data-anchor={id}>
                <RichText text={block.text} />
              </h2>
            ),
          },
        ];
      }
      case "p":
        return [{ kind: "prose", node: <p key={i}><RichText text={block.text} /></p> }];
      case "ul":
        return [
          {
            kind: "prose",
            node: (
              <ul key={i}>
                {block.items.map((item) => (
                  <li key={item}>
                    <RichText text={item} />
                  </li>
                ))}
              </ul>
            ),
          },
        ];
      case "risks":
        return [
          {
            kind: "wide",
            node: (
              <ul key={i} className="site-risks" style={gap(4)}>
                {block.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ),
          },
        ];
      case "phases":
        return [
          {
            kind: "wide",
            node: block.title ? (
              <div key={i} className="site-stack" style={{ gap: "var(--site-s-4)", ...gap(7) }}>
                <h2 className="site-h2">{block.title}</h2>
                <PhaseList items={block.items} />
              </div>
            ) : (
              <div key={i}>
                <PhaseList items={block.items} rows={block.rows} />
              </div>
            ),
          },
        ];
      case "faq":
        return [
          {
            kind: "wide",
            node: (
              <Faq key={i} items={block.items} style={gap(4)} />
            ),
          },
        ];
      case "sources":
        return [
          { kind: "prose", node: <h2 key={`${i}-h`}>{SOURCES.title}</h2> },
          { kind: "prose", node: <p key={`${i}-p`}>{SOURCES.lead}</p> },
          {
            kind: "wide",
            node: (
              <ul key={i} className="site-sources-grid site-sources-grid--2" style={gap(5)}>
                {SOURCES.items.map((item) => (
                  <li key={item.title}>
                    <SourceSign id={item.icon} />
                    <strong>{item.title}</strong>
                    <span>{item.text}</span>
                  </li>
                ))}
              </ul>
            ),
          },
        ];
      case "topics":
        return [
          { kind: "prose", node: <h2 key={`${i}-h`}>{TOPICS.title}</h2> },
          { kind: "prose", node: <p key={`${i}-p`}>{TOPICS.lead}</p> },
          {
            kind: "wide",
            node: (
              <dl key={i} className="site-topics" style={gap(5)}>
                {TOPICS.items.map((item) => (
                  <div key={item.term}>
                    <dt>{item.term}</dt>
                    <dd>{item.text}</dd>
                  </div>
                ))}
              </dl>
            ),
          },
        ];
      case "steps":
        return [
          { kind: "prose", node: <h2 key={`${i}-h`}>{HOW.title}</h2> },
          {
            kind: "wide",
            node: (
              <div key={i}>
                <PhaseList
                  rows
                  items={HOW.steps.map((step) => ({ tag: `Шаг ${step.num}`, title: step.title, text: step.text }))}
                />
              </div>
            ),
          },
        ];
    }
  });
}

/** `firstProseStyle` — отступ первого текстового блока (у статьи — после содержания). */
export function Blocks({ blocks, firstProseStyle }: { blocks: readonly Block[]; firstProseStyle?: CSSProperties }) {
  const groups: { kind: Item["kind"]; nodes: ReactNode[] }[] = [];
  for (const item of expand(blocks)) {
    const last = groups.at(-1);
    if (item.kind === "prose" && last?.kind === "prose") last.nodes.push(item.node);
    else groups.push({ kind: item.kind, nodes: [item.node] });
  }
  let proseSeen = false;
  return (
    <>
      {groups.map((group, i) => {
        if (group.kind === "wide") return <Fragment key={i}>{group.nodes}</Fragment>;
        const style = proseSeen ? undefined : firstProseStyle;
        proseSeen = true;
        return (
          <div key={i} className="site-prose" style={style}>
            {group.nodes}
          </div>
        );
      })}
    </>
  );
}
