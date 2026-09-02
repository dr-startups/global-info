/**
 * Pure helpers for the official Yandex Cloud Search API v2 GenSearch method.
 *
 * Endpoint: POST https://searchapi.api.cloud.yandex.net/v2/gen/search
 * Auth:     Authorization: Api-Key <key>   (header — never in the URL/logs)
 *
 * The contract below is taken from the official proto
 * (`yandex/cloud/searchapi/v2/gen_search_service.proto`): `messages[]`,
 * `folder_id`, `search_type`, and a streamed response carrying `message`,
 * `sources[]`, `is_answer_rejected`.
 *
 * ВАЖНО: форма REST-стрима живым ответом не подтверждена. Документация
 * описывает поток JSON Lines, где каждый следующий объект содержит предыдущий
 * текст с дописанным продолжением; обёртка `{"result": …}` и регистр полей
 * (camel против snake) не проверены, а архивная версия документа описывает
 * старый эндпойнт с `links[]`/`titles[]` вместо `sources[]`. Проект уже
 * обжигался на выдуманных из документации фикстурах Arsenkin, поэтому разбор
 * терпим намеренно: **сузить его можно только по сохранённому сырому ответу**
 * первого живого прогона (он ложится в `rawMetadata` строки-тела).
 *
 * This module is intentionally pure (no network, no secrets).
 */

import { MAX_PROVIDER_RESPONSE_BYTES } from "./http";
import type { YandexSearchType } from "./yandex-v2";

export const YANDEX_GEN_SEARCH_ENDPOINT =
  "https://searchapi.api.cloud.yandex.net/v2/gen/search";

/**
 * Потолок разбираемого тела. Тот же, что у транспорта
 * (`MAX_PROVIDER_RESPONSE_BYTES`): два предела на один вопрос «сколько мы
 * готовы прочитать» разошлись бы, и меньший делал бы больший недостижимым.
 */
export const MAX_YANDEX_GEN_RESPONSE_BYTES = MAX_PROVIDER_RESPONSE_BYTES;

/**
 * Схема синтетического адреса строки-тела нейро-ответа.
 *
 * Ответ поисковика — не публикация, адреса у него нет; строке он нужен для
 * дедупликации и для того, чтобы слои ниже могли отличить тело ответа от
 * названного источника (у источника адрес настоящий). `publicDomainOf`
 * отбрасывает всё, что не `http(s)`, поэтому клиенту эта схема не течёт.
 */
export const YANDEX_GEN_ANSWER_URL_SCHEME = "yandex-gen://";

export type YandexGenSearchSource = {
  url: string;
  title: string | null;
  /** Пометка Яндекса «источник использован в ответе». */
  used: boolean;
};

export type YandexGenSearchAnswer = {
  answerText: string;
  sources: YandexGenSearchSource[];
  isAnswerRejected: boolean;
  isBulletAnswer: boolean;
  fixedMisspellQuery: string | null;
  searchQueries: string[];
  /** Последний разобранный объект — по нему форма пере-закрепляется после живого прогона. */
  raw: unknown;
};

export class YandexGenSearchParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YandexGenSearchParseError";
  }
}

export interface YandexGenSearchBodyInput {
  query: string;
  folderId: string;
  searchType?: YandexSearchType;
}

/**
 * Тело запроса GenSearch — ровно контракт и ничего сверх него.
 *
 * `fixMisspell` намеренно не включается (в proto3 умолчание — false):
 * «исправленное» ФИО — это другой субъект, и ответ был бы о другом человеке.
 * `site/host/url` не задаются: продуктовый вопрос — «что поисковик отвечает о
 * субъекте», то есть спрашиваем весь индекс.
 */
export function buildYandexGenSearchBody(
  input: YandexGenSearchBodyInput
): Record<string, unknown> {
  return {
    messages: [{ role: "ROLE_USER", content: input.query }],
    folderId: input.folderId,
    searchType: input.searchType ?? "SEARCH_TYPE_RU",
  };
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Все объекты, которые удалось прочитать из тела: единый JSON, массив или JSON Lines. */
function parsedObjects(body: string): Record<string, unknown>[] {
  const trimmed = body.trim();
  const collect = (value: unknown): Record<string, unknown>[] => {
    if (Array.isArray(value)) return value.flatMap(collect);
    const obj = asObj(value);
    return obj ? [obj] : [];
  };
  try {
    return collect(JSON.parse(trimmed));
  } catch {
    // Не единый документ — значит, поток JSON Lines.
  }
  const out: Record<string, unknown>[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    try {
      out.push(...collect(JSON.parse(l)));
    } catch {
      // Строка не разобралась — поток мог быть перемешан со служебными строками.
    }
  }
  return out;
}

/** Источники ответа: новая форма `sources[]` и старая — параллельные `links`/`titles`. */
function readSources(obj: Record<string, unknown>): YandexGenSearchSource[] {
  const raw = obj.sources;
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => {
        const o = asObj(entry) ?? {};
        return {
          url: str(o.url).trim(),
          title: str(o.title).trim() || null,
          used: o.used === true,
        };
      })
      .filter((s) => s.url.length > 0);
  }
  const links = Array.isArray(obj.links) ? obj.links : null;
  if (!links) return [];
  const titles = Array.isArray(obj.titles) ? obj.titles : [];
  return links
    .map((link, i) => ({
      url: str(link).trim(),
      title: str(titles[i]).trim() || null,
      used: true,
    }))
    .filter((s) => s.url.length > 0);
}

function readSearchQueries(obj: Record<string, unknown>): string[] {
  const raw = obj.searchQueries ?? obj.search_queries;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === "string") return entry.trim();
      const o = asObj(entry) ?? {};
      return (str(o.text) || str(o.searchQuery) || str(o.query)).trim();
    })
    .filter(Boolean);
}

/** Текст ответа в объекте потока — пустая строка, если объект его не несёт. */
function answerTextOf(payload: Record<string, unknown>): string {
  const message = asObj(payload.message);
  return (
    str(message?.content) ||
    str(message?.text) ||
    str(payload.text) ||
    str(payload.answer)
  ).trim();
}

/** Несёт ли объект содержательный исход: текст либо явный отказ модели. */
function carriesOutcome(payload: Record<string, unknown>): boolean {
  return (
    answerTextOf(payload).length > 0 ||
    payload.isAnswerRejected === true ||
    payload.is_answer_rejected === true
  );
}

/** Сообщение об ошибке провайдера, если объект — ошибка, а не ответ. */
function providerErrorOf(payload: Record<string, unknown>): string | null {
  const err = asObj(payload.error);
  if (err) {
    const message = str(err.message).trim();
    const code = err.code == null ? "" : String(err.code);
    return message || code ? `Yandex GenSearch error ${code}: ${message}`.trim() : "Yandex GenSearch returned an error.";
  }
  return typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : null;
}

/**
 * Разобрать ответ GenSearch.
 *
 * Из потока берётся **последний объект, несущий исход**: текст либо отказ
 * модели. Безусловный «последний объект» брать нельзя — поток закрывается
 * служебной строкой (трейлер grpc-gateway), и тогда полный ответ выбрасывается,
 * а исход читается как «спросили — ответа нет». Отчёт получал бы измеренную
 * пустоту вместо собранного ответа, и следа бы не осталось.
 *
 * Ошибка в любом объекте потока — сбой разбора, а не пустота: сорванный поток
 * обязан выглядеть сбоем и на странице, и в записи о попытке.
 */
export function parseYandexGenSearchResponse(body: string): YandexGenSearchAnswer {
  const raw = String(body ?? "");
  if (!raw.trim()) {
    throw new YandexGenSearchParseError("Empty response from Yandex GenSearch.");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_YANDEX_GEN_RESPONSE_BYTES) {
    throw new YandexGenSearchParseError("Yandex GenSearch response too large.");
  }
  const objects = parsedObjects(raw).map((o) => asObj(o.result) ?? o);
  if (objects.length === 0) {
    throw new YandexGenSearchParseError("Yandex GenSearch response is not JSON.");
  }
  // Ошибка где угодно в потоке — сбой: и вместо ответа, и после него (там она
  // означает оборванный поток, а неполный ответ выдавать за целый нельзя).
  const failure = objects.map(providerErrorOf).find(Boolean);
  if (failure) throw new YandexGenSearchParseError(failure);

  const withOutcome = objects.filter(carriesOutcome);
  // Исхода нет вовсе — законная пустота: спросили, ответа нет.
  const payload = withOutcome[withOutcome.length - 1] ?? objects[objects.length - 1]!;
  const answerText = answerTextOf(payload);

  return {
    answerText,
    sources: readSources(payload),
    isAnswerRejected: payload.isAnswerRejected === true || payload.is_answer_rejected === true,
    isBulletAnswer: payload.isBulletAnswer === true || payload.is_bullet_answer === true,
    fixedMisspellQuery:
      (str(payload.fixedMisspellQuery) || str(payload.fixed_misspell_query)).trim() || null,
    searchQueries: readSearchQueries(payload),
    raw: payload,
  };
}
