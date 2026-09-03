/**
 * Вычистка секретов Topvisor из всего, что уходит на диск.
 *
 * Фикстуры пилота — сырые ответы API, и они коммитятся. Ключ и идентификатор
 * аккаунта в них попасть не должны ни разу: однажды `.env.backup-<дата>`,
 * сделанная перед правкой конфигурации, уже унесла ключи в коммит, и
 * остановила её защита GitHub, а не мы.
 *
 * Чистится не только известное имя поля: сервис возвращает эхо запроса в
 * разных формах, поэтому значения секретов ищутся **по содержимому** — где бы
 * они ни лежали, включая строки внутри вложенных объектов **и имена полей**.
 *
 * Имена полей — не педантизм: `get/keywords_2/collect/price` отвечает объектом
 * `pricesByUsers: { "<идентификатор аккаунта>": … }`, и вычистка, смотревшая
 * только на значения, пропускала секрет в готовую к коммиту фикстуру. Нашлось
 * это уже на собранных файлах.
 */

/** Что вычищать: значения секретов и поля, которые их обычно несут. */
export type RedactionSecrets = {
  apiKey?: string | null;
  userId?: string | null;
};

const SECRET_FIELD_RE = /^(authorization|api[_-]?key|user[_-]?id|token|password)$/i;

/** Значение секрета, длиннее порога, чтобы не вычищать «1» из чисел. */
function secretValues(secrets: RedactionSecrets): string[] {
  return [secrets.apiKey, secrets.userId]
    .map((v) => String(v ?? "").trim())
    .filter((v) => v.length >= 6);
}

/**
 * Секреты целиком — для сравнения с именем поля.
 *
 * Порог длины защищает содержимое строк; имя поля либо равно секрету целиком,
 * либо нет, и пятизначный идентификатор аккаунта иначе уходил бы в фикстуру.
 */
function exactSecrets(secrets: RedactionSecrets): string[] {
  return [secrets.apiKey, secrets.userId]
    .map((v) => String(v ?? "").trim())
    .filter((v) => v.length > 0);
}

function redactString(value: string, secrets: string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (secret && out.includes(secret)) out = out.split(secret).join("***");
  }
  return out;
}

/**
 * Копия значения без секретов.
 *
 * Поля с говорящими именами затираются целиком — в них секрет лежит по
 * определению, даже если значение отличается от нашего (эхо чужого запроса,
 * другой аккаунт). Остальное чистится по содержимому — и ключи тоже.
 */
export function redactSecrets<T>(value: T, secrets: RedactionSecrets): T {
  const needles = secretValues(secrets);
  const exact = exactSecrets(secrets);

  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return redactString(node, needles);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        // Ключ чистится и целиком, и как строка: секрет бывает именем поля.
        const safeKey = exact.includes(key) ? "***" : redactString(key, needles);
        out[safeKey] = SECRET_FIELD_RE.test(key) ? "***" : walk(item);
      }
      return out;
    }
    return node;
  };

  return walk(value) as T;
}
