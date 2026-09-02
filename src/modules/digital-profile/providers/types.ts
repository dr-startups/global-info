/**
 * Shared types for the real-connector provider layer (Stage H).
 */

export type SearchProviderName = "GOOGLE" | "YANDEX" | "WIKIPEDIA";

export type AvailabilityStatus = "ENABLED" | "DISABLED" | "NOT_CONFIGURED";

export type ProviderRunStatus = "SUCCESS" | "FAILED" | "DISABLED" | "NOT_CONFIGURED";

export interface SearchProviderRequest {
  caseId: string;
  subjectFullName: string;
  aliases: string[];
  query: string;
  region?: string;
  language?: string;
  limit?: number;
  page?: number;
}

export interface SearchProviderResult {
  provider: SearchProviderName;
  query: string;
  region?: string;
  language?: string;
  rank: number;
  title: string;
  snippet: string;
  url: string;
  domain: string;
  publishedAt?: string;
  /** Raw, source-attributed metadata (evidence-first). */
  rawMetadata: unknown;
  capturedAt: string;
}

export type ProviderErrorCode =
  | "PROVIDER_DISABLED"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_REQUEST_FAILED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_INVALID_RESPONSE"
  /**
   * Ключ не принят (401/403). Отдельный код, а не оттенок «плохого ответа»:
   * до клиента доезжает код, а не текст ошибки, и на живом прогоне 401
   * «Invalid API key» печатался словами «источник не ответил в этом прогоне».
   */
  | "PROVIDER_UNAUTHORIZED"
  | "PROVIDER_BAD_RESPONSE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_NETWORK_ERROR";

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  provider: SearchProviderName;
}

/**
 * Учёт глубины: чем была оплачена собранная выдача.
 *
 * Заведён потому, что постраничный сбор нельзя проверить кодом возврата. Пустая
 * вторая страница даёт `SUCCESS` с десятью строками ровно так же, как страница,
 * которой не просили вовсе, а страница, повторившая первую, — так же, как
 * настоящая вторая: дедупликация схлопнет дубли, и трата станет невидимой.
 *
 * Числа «сколько страниц» и «сколько всего получено» читаются из `perPage` и
 * отдельными полями не дублируются: второе число той же величины рано или
 * поздно разойдётся с первым.
 */
export interface SerpDepthAudit {
  /** Сколько строк просили по этому запросу. */
  requested: number;
  /**
   * Сколько строк вернула каждая запрошенная страница, по порядку.
   *
   * Полная страница всегда влечёт запрос следующей, поэтому по этому массиву
   * читается и причина остановки: `[10]` при `requested: 20` — вторая страница
   * отказала, `[10, 0]` — глубже ничего нет, `[7]` — выдача кончилась.
   */
  perPage: number[];
  /**
   * Сколько адресов страниц со второй и дальше уже встречались на предыдущих.
   *
   * Совпадение всей страницы означает, что провайдер `page` проигнорировал и
   * деньги ушли впустую.
   */
  repeatedFromEarlierPages: number;
  /**
   * Код отказа страницы, оборвавшей сбор; пусто — цикл дошёл до конца сам.
   *
   * Без него отказ второй страницы не оставляет следа нигде: прогон зелёный,
   * оператор видит `COLLECTED`, а отчёт печатает десять строк там, где обещал
   * двадцать. Самая вероятная причина — `PROVIDER_RATE_LIMITED` на возросшем
   * числе запросов. Номер отказавшей страницы — `perPage.length + 1`, вторым
   * полем он не дублируется.
   */
  stoppedByError?: ProviderErrorCode;
}

export interface ProviderRunResult {
  status: ProviderRunStatus;
  provider: SearchProviderName;
  results: SearchProviderResult[];
  /** Raw response snapshot for evidence/debugging (never rendered directly). */
  rawSnapshot?: unknown;
  /** Учёт глубины; заполняет его только адаптер Serper — глубина платная там. */
  depthAudit?: SerpDepthAudit;
  error?: ProviderError;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
