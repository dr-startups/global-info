/**
 * Лимиты расхода и возврат к своей проверке — по строкам таблицы проверок.
 *
 * Счётчиков в памяти процесса нет: деплой или второй процесс обнулили бы их,
 * а строки таблицы переживают и то и другое. Адрес и субъект хранятся HMAC с
 * секретом подписи: лимит работает и после обезличивания записи, а по хешу
 * нельзя подобрать ни адрес, ни ФИО с датой рождения.
 */

import type { Prisma, SelfCheck } from "@prisma/client";
import { hmacHex } from "@/modules/digital-profile/auth/signed-token";
import { numberSetting } from "@/modules/digital-profile/config/defaults";
import { subjectInputHash } from "@/modules/digital-profile/services/subject-persona-check";

type Env = Record<string, string | undefined>;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export async function ipHashOf(ip: string, secret: string): Promise<string> {
  return hmacHex(secret, `ip:${ip}`);
}

/**
 * Нормализация имени — та же, что у ворот персоны (`subjectInputHash`):
 * регистр, «ё» и пробелы не делают из человека другого. Алиасы не входят —
 * они уточняют поиск, а не меняют, о ком проверка.
 */
export async function subjectHashOf(
  subject: { fullName: string; birthDate: string },
  secret: string
): Promise<string> {
  const normalized = subjectInputHash({
    fullName: subject.fullName,
    aliases: [],
    dateOfBirth: subject.birthDate,
  });
  return hmacHex(secret, `subject:${normalized}`);
}

export interface IpCounts {
  lastHour: number;
  lastDay: number;
}

/** Строк достаточно, чтобы следующей проверки с этого адреса не было. */
export function ipLimitReached(counts: IpCounts, env: Env = process.env): boolean {
  return (
    counts.lastHour >= numberSetting("SELF_CHECK_IP_HOURLY_LIMIT", env) ||
    counts.lastDay >= numberSetting("SELF_CHECK_IP_DAILY_LIMIT", env)
  );
}

export interface QuotaDb {
  selfCheck: { count(args: { where: Prisma.SelfCheckWhereInput }): Promise<number> };
}

/** Все строки адреса, включая пойманные ловушкой: бот тоже тратит свой лимит. */
export async function countRecentChecksByIp(db: QuotaDb, ipHash: string, now: Date): Promise<IpCounts> {
  const since = (ms: number) => new Date(now.getTime() - ms);
  const [lastHour, lastDay] = await Promise.all([
    db.selfCheck.count({ where: { ipHash, createdAt: { gte: since(HOUR_MS) } } }),
    db.selfCheck.count({ where: { ipHash, createdAt: { gte: since(DAY_MS) } } }),
  ]);
  return { lastHour, lastDay };
}

/**
 * Можно ли вернуть посетителя к этой проверке вместо новой: те же данные, в
 * окне дедупликации, запись жива и не поймана ловушкой. Какую запись
 * спрашивать, решает cookie — по одним ФИО и дате чужую проверку не открыть.
 */
export function isReusableCheck(
  row: Pick<SelfCheck, "subjectHash" | "createdAt" | "anonymizedAt" | "honeypotTripped"> | null,
  subjectHash: string,
  now: Date,
  env: Env = process.env
): boolean {
  if (!row || row.anonymizedAt || row.honeypotTripped) return false;
  if (row.subjectHash !== subjectHash) return false;
  const windowMs = numberSetting("SELF_CHECK_DEDUPE_DAYS", env) * DAY_MS;
  return row.createdAt.getTime() >= now.getTime() - windowMs;
}
