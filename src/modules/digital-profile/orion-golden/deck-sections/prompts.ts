/**
 * Independent, versioned LLM prompts — one prompt per surface fragment.
 *
 * A single "generate the whole presentation" prompt is forbidden. Each prompt:
 * - versioned (promptVersion participates in the cache key);
 * - schema constrained (LLM returns only the SlideBody content contract);
 * - evidence grounded (only scoped findings/claims are passed);
 * - independently retryable and cacheable (inputHash + promptVersion).
 *
 * The model never receives: element coordinates, textbox sizes, global page
 * numbers, or content of unrelated sections.
 */

import type { FragmentKey } from "./contracts";

export type FragmentPromptDef = {
  promptKey: string;
  promptVersion: string;
  /** True when the fragment is deterministic (no LLM copywriting needed). */
  deterministic: boolean;
  systemPrompt: string;
};

/**
 * Кто пишет и по каким правилам.
 *
 * Персона была «старший аналитик due diligence», и модель добросовестно писала
 * протоколом — тем самым канцеляритом, из-за которого отчёт нельзя прочитать
 * как статью. Читатель отчёта — руководитель, а не следователь, поэтому пишет
 * деловой журналист.
 *
 * Отсюда же убрана нижняя граница длины («не короче ~40% бюджета поля»). Это
 * было прямое указание разводить воду там, где сказать нечего: заполнить поле
 * важнее, чем сообщить факт. Ограничение осталось только сверху. Пустое
 * состояние честнее выдуманного — это правило продукта, и оно сильнее
 * требования плотности.
 *
 * Запреты (не добавлять фактов, не приписывать субъекту чужие материалы) —
 * требования продукта, а не стиль, и сохранены дословно.
 */
const ANALYST_BASE = [
  "Ты — деловой журналист: пишешь для руководителя, который примет по тексту решение.",
  "Пиши связным текстом, а не пунктами анкеты: короткие предложения, активный залог, конкретика вместо канцелярита.",
  "Используй только переданные scoped findings и claims; не добавляй фактов.",
  "Каждый существенный тезис опирается на переданный findingId.",
  "Не используй внутренние технические термины (audit, reportRunId, pipeline, dataset).",
  "Не называй материалы другого субъекта нейтральными данными проверяемого лица.",
  "Не пересказывай тему заголовка в первом предложении — читатель уже прочитал заголовок.",
  "Пиши ровно столько, сколько есть материала: нет фактов — короче, а не водянистее.",
  "Верни только JSON по схеме SlideBody (narrative, bullets, whatWasFound, whyItMatters, whatToCheck, sourceNote).",
].join(" ");

function llmPrompt(promptKey: string, topic: string): FragmentPromptDef {
  return {
    promptKey,
    // v4: персона делового журналиста вместо аналитика, снята нижняя граница
    // длины. Версия обязана расти вместе с текстом промпта — она входит в ключ
    // кеша, и без подъёма переиспользовался бы текст, написанный по прежним
    // правилам.
    promptVersion: `${promptKey}-v4`,
    deterministic: false,
    systemPrompt: `${ANALYST_BASE} Тема фрагмента: ${topic}.`,
  };
}

function deterministicPrompt(promptKey: string): FragmentPromptDef {
  return {
    promptKey,
    promptVersion: `${promptKey}-deterministic-v1`,
    deterministic: true,
    systemPrompt: "",
  };
}

export const FRAGMENT_PROMPTS: Record<FragmentKey, FragmentPromptDef> = {
  FRONT_MATTER_MAIN: deterministicPrompt("front-matter"),
  // v3: §7.3 structure + §7.5 density (fill-all + length floors).
  EXECUTIVE_SUMMARY: llmPrompt(
    "executive-summary",
    "итоговое резюме по проверяемому лицу на основе VerifiedFindingBundle"
  ),
  // v2: reserve first-page slot for LIKELY «Требует подтверждения» (§2.1).
  RISK_MATRIX: {
    ...deterministicPrompt("risk-matrix"),
    promptVersion: "risk-matrix-deterministic-v2",
  },
  DIGITAL_PROFILE_OVERVIEW: deterministicPrompt("digital-profile-overview"),
  RU_SUMMARY: llmPrompt("ru-regional-summary", "региональный обзор RU-поверхностей"),
  // v3: §7.1 page composition + §7.5 density.
  RU_SERP: llmPrompt("ru-serp-analysis", "анализ органической выдачи RU"),
  RU_SERP_SCREENSHOT: llmPrompt("ru-serp-screenshot-analysis", "анализ скриншота выдачи RU"),
  RU_SUGGESTIONS: llmPrompt("ru-suggestions-analysis", "анализ поисковых подсказок RU"),
  RU_IMAGES: llmPrompt("ru-images-analysis", "анализ изображений в выдаче RU"),
  /*
   * Страницы фактических проверок модель не переписывает.
   *
   * Стадия копирайта переписывает ровно те поля, в которых у страницы
   * Википедии лежат факты проверки, — и однажды выбросила из нарратива метод,
   * дату и URL найденной статьи, хотя URL был в данных. Ценность этой страницы
   * в дословности, а не в интонации; так же после шага F устроен комплаенс.
   * Альтернатива «гвард, требующий от модели сохранить факты» отвергнута: это
   * второе место, решающее, что обязано быть в тексте.
   */
  RU_IDENTITY_WIKIPEDIA: deterministicPrompt("ru-identity-analysis"),
  RU_KNOWLEDGE_AI: llmPrompt("ru-ai-analysis", "анализ AI-ответов поисковых систем RU"),
  RU_RELATED: llmPrompt("ru-related-analysis", "анализ связанных запросов RU"),
  UAE_SUMMARY: llmPrompt("uae-regional-summary", "региональный обзор UAE-поверхностей"),
  // v3: §7.1 page composition + §7.5 density.
  UAE_SERP: llmPrompt("uae-serp-analysis", "анализ органической выдачи UAE"),
  UAE_SERP_SCREENSHOT: llmPrompt("uae-serp-screenshot-analysis", "анализ скриншота выдачи UAE"),
  UAE_SUGGESTIONS: llmPrompt("uae-suggestions-analysis", "анализ поисковых подсказок UAE"),
  UAE_IMAGES: llmPrompt("uae-images-analysis", "анализ изображений в выдаче UAE"),
  UAE_IDENTITY_WIKIPEDIA: deterministicPrompt("uae-identity-analysis"),
  UAE_KNOWLEDGE_AI: llmPrompt("uae-ai-analysis", "анализ AI-ответов поисковых систем UAE"),
  UAE_RELATED: llmPrompt("uae-related-analysis", "анализ связанных запросов UAE"),
  COMPLIANCE_MAIN: deterministicPrompt("compliance-existing-content"),
  APPENDIX_MAIN: deterministicPrompt("appendix"),
};

export function getFragmentPrompt(key: FragmentKey): FragmentPromptDef {
  return FRAGMENT_PROMPTS[key];
}
