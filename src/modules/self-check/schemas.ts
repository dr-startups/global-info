/**
 * Схемы публичных ручек проверки: форма, решение по персоне, заявка.
 *
 * Схема формы общая для сервера и формы в браузере, поэтому модуль без
 * серверных зависимостей, а тексты отказов — те, что посетитель увидит у поля.
 * Необязательные поля приходят из формы пустыми строками, и пустая строка
 * значением не считается.
 */

import { z } from "zod";

const FULL_NAME_MESSAGE = "Укажите фамилию, имя и отчество.";
const BIRTH_DATE_MESSAGE = "Укажите дату рождения.";
const CONSENT_MESSAGE = "Для запуска проверки требуется согласие.";
const INN_MESSAGE = "В ИНН 10 или 12 цифр — проверьте номер.";
const WEBSITE_MESSAGE = "Укажите адрес сайта, например example.ru.";
const LEAD_NAME_MESSAGE = "Укажите, как к вам обращаться.";
const LEAD_CONTACT_MESSAGE = "Укажите контакт выбранным способом.";

/** Моложе и старше этого — почти наверняка опечатка в годе. */
const MIN_AGE_YEARS = 14;
const MAX_AGE_YEARS = 110;

const blankToUndefined = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const optionalText = (max: number) =>
  z.preprocess(blankToUndefined, z.string().trim().max(max, `Не длиннее ${max} знаков.`).optional());

const fullName = z.preprocess(
  (v) => (typeof v === "string" ? v.replace(/\s+/gu, " ").trim() : v),
  z
    .string({ required_error: FULL_NAME_MESSAGE, invalid_type_error: FULL_NAME_MESSAGE })
    .min(1, FULL_NAME_MESSAGE)
    .max(200, "Не длиннее 200 знаков.")
    // Отчество не требуется жёстко — его бывает нет, — но одно слово поиск
    // превращает в выдачу про всех однофамильцев сразу.
    .refine((v) => v.length === 0 || v.split(" ").length >= 2, {
      message: "Укажите фамилию и имя, а если есть — отчество.",
    })
);

/** Полных лет на сегодня по календарю UTC. */
function fullYears(year: number, month: number, day: number, today: Date): number {
  const ty = today.getUTCFullYear();
  const tm = today.getUTCMonth() + 1;
  const td = today.getUTCDate();
  return ty - year - (tm < month || (tm === month && td < day) ? 1 : 0);
}

const birthDate = z.preprocess(
  (v) => (typeof v === "string" ? v.trim() : v),
  z
    .string({ required_error: BIRTH_DATE_MESSAGE, invalid_type_error: BIRTH_DATE_MESSAGE })
    // Одна проверка на всё, а не цепочка: отказы цепочки копятся, и у пустого
    // поля рядом с «укажите дату» стояло бы ещё «неверный формат».
    .superRefine((value, ctx) => {
      const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
      if (value === "") return fail(BIRTH_DATE_MESSAGE);
      const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
      if (!m) return fail("Укажите дату рождения в формате ГГГГ-ММ-ДД.");
      const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const date = new Date(Date.UTC(year, month - 1, day));
      if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
      ) {
        return fail("Такой даты нет в календаре.");
      }
      const today = new Date();
      if (date.getTime() > today.getTime()) return fail("Дата рождения не может быть в будущем.");
      const age = fullYears(year, month, day, today);
      if (age < MIN_AGE_YEARS) return fail(`Проверка доступна с ${MIN_AGE_YEARS} лет.`);
      if (age > MAX_AGE_YEARS) return fail("Проверьте год рождения.");
    })
);

/**
 * Сайт сводится к домену: без схемы, `www.`, порта и пути. `null` — не домен.
 * Кириллические домены (`пример.рф`) — домены.
 */
export function normalizeWebsite(raw: string): string | null {
  const host = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//u, "")
    .replace(/^www\./u, "")
    .split(/[/?#]/u)[0]!
    .replace(/:\d+$/u, "")
    .replace(/\.$/u, "");
  const label = "[a-z0-9а-яё](?:[a-z0-9а-яё-]{0,61}[a-z0-9а-яё])?";
  const domain = new RegExp(`^(?:${label}\\.)+(?:[a-zа-яё]{2,63}|xn--[a-z0-9-]{2,59})$`, "u");
  return host.length <= 253 && domain.test(host) ? host : null;
}

export const SelfCheckFormSchema = z.object({
  fullName,
  birthDate,
  city: optionalText(120),
  aliases: z.preprocess(
    (v) =>
      Array.isArray(v)
        ? v.map((a) => (typeof a === "string" ? a.trim() : a)).filter((a) => a !== "")
        : v ?? [],
    z.array(z.string().max(200, "Не длиннее 200 знаков.")).max(10, "Не больше десяти написаний.")
  ),
  inn: z.preprocess(
    blankToUndefined,
    // Только длина и цифры. Контрольная сумма не проверяется (решение владельца
    // 20.09.2026): она отвергала бы номер, выданный не по общему алгоритму, а цену
    // — опечатка попадает в сильные признаки субъекта — владелец принял осознанно.
    z.string().trim().regex(/^(\d{10}|\d{12})$/u, INN_MESSAGE).optional()
  ),
  employer: optionalText(160),
  position: optionalText(160),
  website: z.preprocess(
    blankToUndefined,
    z
      .string()
      .transform((v, ctx) => {
        const host = normalizeWebsite(v);
        if (!host) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: WEBSITE_MESSAGE });
          return z.NEVER;
        }
        return host;
      })
      .optional()
  ),
  consent: z.literal(true, { errorMap: () => ({ message: CONSENT_MESSAGE }) }),
  captchaToken: z.preprocess(blankToUndefined, z.string().max(4096).optional()),
  /** Ловушка: скрытое поле. Схема его не отвергает — решение принимает сервер. */
  company: z.preprocess(blankToUndefined, z.string().max(500).optional()),
});

export type SelfCheckForm = z.output<typeof SelfCheckFormSchema>;

export const PERSONA_DECISION_VALUES = ["PERSONA_SELECTED", "APPROVED_WITHOUT_PERSONA"] as const;

export const SelfCheckPersonaDecisionSchema = z
  .object({
    decision: z.enum(PERSONA_DECISION_VALUES),
    selectedCardId: z.preprocess(blankToUndefined, z.string().max(1000).optional()),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "PERSONA_SELECTED" && !v.selectedCardId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectedCardId"],
        message: "Отметьте карточку, которая про вас.",
      });
    }
  });

/** Варианты удобного времени — те, что в форме заявки. */
export const PREFERRED_TIME_VALUES = ["any", "morning", "day", "evening"] as const;

const phone = z
  .string()
  .trim()
  .max(40)
  .refine((v) => {
    const digits = v.replace(/\D/gu, "").length;
    return /^[\d\s()+-]+$/u.test(v) && digits >= 10 && digits <= 15;
  }, "Укажите телефон цифрами, например +7 900 000-00-00.");

const telegram = z
  .string()
  .trim()
  .transform((v) => v.replace(/^@/u, ""))
  .refine(
    (v) => /^[A-Za-z0-9_]{5,32}$/u.test(v),
    "Имя в Telegram — от 5 до 32 латинских букв, цифр и «_»."
  )
  .transform((v) => `@${v}`);

export const SelfCheckLeadSchema = z
  .object({
    name: z.preprocess(
      (v) => (typeof v === "string" ? v.trim() : v),
      z
        .string({ required_error: LEAD_NAME_MESSAGE, invalid_type_error: LEAD_NAME_MESSAGE })
        .min(1, LEAD_NAME_MESSAGE)
        .max(120, "Не длиннее 120 знаков.")
    ),
    phone: z.preprocess(blankToUndefined, phone.optional()),
    email: z.preprocess(
      blankToUndefined,
      z.string().trim().max(200).email("Проверьте адрес почты.").optional()
    ),
    telegram: z.preprocess(blankToUndefined, telegram.optional()),
    preferredTime: z.preprocess(blankToUndefined, z.enum(PREFERRED_TIME_VALUES).optional()),
    message: optionalText(2000),
  })
  .superRefine((v, ctx) => {
    if (!v.phone && !v.email && !v.telegram) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contact"], message: LEAD_CONTACT_MESSAGE });
    }
  });

export type SelfCheckLead = z.output<typeof SelfCheckLeadSchema>;
