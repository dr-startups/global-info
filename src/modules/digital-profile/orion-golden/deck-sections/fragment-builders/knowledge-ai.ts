/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { FragmentKey, SectionType, SlideContentContract } from "../contracts";
import { clientNamedSearchEngine, type ScopedEvidenceIndex, type ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import { DECK_TEMPLATE_REGISTRY } from "../template-registry";
import { packSentencesNoTruncate } from "../semantic-summary-pagination";
import { NOT_FOUND_PATTERNS } from "../../analytics/surface-analyzers";
import { isPublicUrl, publicDomainOf } from "../../analytics/public-domain";
import type { FragmentBuildOutput, FragmentExtras } from "./shared";
import {
  buildPageEvidenceView,
  coverageContent,
  emptyStatusForReason,
  otherSubjectBulletText,
  pageFindingBlocks,
  visualSlide,
  withContinuations,
} from "./shared";

/** Строки списка без дословных повторов, порядок сохраняется. */
function uniqueByText(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    const key = text.toLowerCase().replace(/\s+/gu, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

type AiEvidence = ScopedEvidenceIndex[string];

/**
 * Строка-тело ответа — это наблюдение, а не ссылка на публикацию.
 *
 * Признак выводится из данных, а не из имени: у названного источника адрес
 * публичный, у строки-маркера заголовок под `NOT_FOUND_PATTERNS`, а у тела
 * ответа — служебный адрес и собственный текст.
 */
function isAnswerBody(e: AiEvidence | undefined): boolean {
  if (!e || e.kind !== "ai_answer") return false;
  if (isPublicUrl(e.url)) return false;
  if (NOT_FOUND_PATTERNS.test(String(e.title ?? ""))) return false;
  return Boolean(String(e.snippet ?? "").trim());
}

/**
 * Подпись под ответом.
 *
 * Ответ поискового ИИ проходит в отчёте только как «вот что поисковик отвечает
 * о субъекте» — **каждый**, а не только собранный официальным API: без подписи
 * текст читается как утверждение отчёта о человеке. Способ получения выводится
 * из данных наблюдения (провайдер и движок), а не из схемы адреса: схема — это
 * деталь хранения, и подпись за ней ехать не должна.
 *
 * Нейро-ответ, полученный официальным API, — это не дословный блок «Алисы» на
 * странице выдачи, и выдавать одно за другое нельзя.
 */
function answerCaption(e: AiEvidence): string {
  const engine = clientNamedSearchEngine(e.engine);
  const official = String(e.provider ?? "").toLowerCase() === "yandex" && engine === "YANDEX";
  // Движок называется, только когда он известен: «UNKNOWN» приходит из данных
  // (`mapEngineBucket` при пустом движке), и приписать такой ответ Яндексу —
  // ложное утверждение о происхождении в клиентском тексте.
  const engineName = engine === "GOOGLE" ? "Google" : engine === "YANDEX" ? "Яндекса" : null;
  const source = official
    ? "Ответ генеративного поиска Яндекса, получен официальным Yandex Search API; " +
      "это не дословный блок «Алисы» на странице выдачи."
    : engineName
      ? `Ответ поискового ИИ ${engineName}, зафиксированный в выдаче.`
      : "Ответ поискового ИИ, зафиксированный в выдаче; поисковая система в наблюдении не названа.";
  const query = String(e.query ?? "").trim();
  return query ? `${source} Запрос: «${query}».` : source;
}

/** Названный источник ответа — «заголовок — домен»; адрес живёт в приложении. */
function sourceLine(e: AiEvidence): string {
  const domain = publicDomainOf(e.url);
  const title = String(e.title ?? "").trim() || domain;
  return domain ? `Источник: ${title} — ${domain}` : `Источник: ${title}`;
}

export function buildKnowledgeAiFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const slots = slotsForFragment(key);
  const aiUnits = scoped.surfaceUnits.filter((u) => u.surface === "ai_answers");
  const aiRefs = aiUnits.flatMap((u) => u.evidenceRefs);
  // Ответы печатаются целиком: длинный текст разъезжается продолжениями по
  // границам предложений, а не режется. Обещание методики («приводятся
  // полностью, без сокращений») держится данными, а не декларацией — до этого
  // страница печатала заголовок наблюдения, срезанный до 300 знаков.
  const answerBudget = DECK_TEMPLATE_REGISTRY["ai-overview"].layout.itemCharBudget;
  const isSourceRef = (e: AiEvidence | undefined): boolean =>
    Boolean(e && e.kind === "ai_answer" && isPublicUrl(e.url));
  const aiLines = uniqueByText(
    aiRefs.flatMap((r) => {
      const e = scoped.evidenceIndex[r];
      if (!e) return [];
      // Материал о другом лице остаётся помеченным и здесь: без метки чужой
      // ответ работает на профиль субъекта.
      const mark = (text: string): string => otherSubjectBulletText(text, e.subjectDecision);
      if (isAnswerBody(e)) {
        // Подпись идёт первым предложением того же блока, а не отдельной
        // строкой: разбивка по страницам иначе оставляет её на одном листе, а
        // ответ начинается на следующем — и текст читается как утверждение
        // отчёта, без указания, чей это ответ.
        const body = `${answerCaption(e)} ${String(e.snippet ?? "").trim()}`.trim();
        // Метка ставится **после** укладки: на продолжениях её иначе нет, и со
        // второй страницы чужой материал читается как материал о субъекте.
        return packSentencesNoTruncate(body, answerBudget).map(mark);
      }
      if (isSourceRef(e)) return [mark(sourceLine(e))];
      return e.title ? [mark(e.title)] : [];
    })
  );
  const slides: SlideContentContract[] = [];

  const panelSlot = slots.find((s) => s.templateId === "wikipedia-knowledge");
  const aiSlot = slots.find((s) => s.templateId === "ai-overview") ?? slots[0];

  if (panelSlot) {
    const knowledgeRefs = Object.entries(scoped.evidenceIndex)
      .filter(([, e]) => e.kind === "knowledge_block")
      .map(([ref]) => ref);
    // Sidebar strictly scoped to this surface's own observations.
    const panelView = buildPageEvidenceView(scoped, knowledgeRefs);
    slides.push(
      visualSlide({
        slot: panelSlot,
        sectionId,
        extras,
        scoped,
        content: {
          narrative:
            "Панель знаний и структурированные блоки поисковых систем по проверяемому субъекту.",
          ...pageFindingBlocks(scoped, panelView),
        },
        evidenceRefs: knowledgeRefs,
        findingIds: panelView.findings.map((f) => f.findingId),
        metrics: { knowledgeBlocks: knowledgeRefs.length },
        noUnderlyingData: false,
      })
    );
  }

  const aiView = buildPageEvidenceView(scoped, aiRefs);
  const aiBase = visualSlide({
    slot: aiSlot,
    sectionId,
    extras,
    scoped,
    content: {
      bullets: aiLines,
      ...pageFindingBlocks(scoped, aiView),
    },
    evidenceRefs: aiRefs,
    findingIds: aiView.findings.map((f) => f.findingId),
    // Ответов столько, сколько строк-ответов: названный источник — это ссылка
    // ответа, маркер — измеренная пустота, а неизвестная деке ссылка не ответ
    // и подавно.
    metrics: { answers: aiRefs.filter((r) => isAnswerBody(scoped.evidenceIndex[r])).length },
    noUnderlyingData: aiUnits.length === 0,
    noDataReason: "no-ai-answers",
  });
  slides.push(...withContinuations(aiBase, "ai-overview"));

  return { slides, status: "READY" };
}

// ---------------------------------------------------------------------------
// RELATED (RU p20..p22; UAE p32)
// ---------------------------------------------------------------------------
