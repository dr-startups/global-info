/**
 * Форма проверки и форма заявки в браузере.
 *
 * Поля проверяются схемами ручек (`self-check/schemas.ts`), а не своей копией
 * правил: вторая проверка разошлась бы с сервером, и у поля до отправки стоял бы
 * один текст, а после — другой. Отсюда же — тело запроса, чтобы браузер
 * проверял ровно то, что уйдёт на сервер.
 */

import { isValidInn } from "@/modules/self-check/inn";
import {
  PREFERRED_TIME_VALUES,
  SelfCheckFormSchema,
  SelfCheckLeadSchema,
} from "@/modules/self-check/schemas";
import { BIRTH_DATE_INCOMPLETE_MESSAGE, birthDateToIso } from "./birth-date";
import { DEFAULT_PHONE_COUNTRY, phoneComplete, phoneCountry, phoneE164 } from "./phone";

/** Длины ИНН: у компании десять цифр, у человека и ИП — двенадцать. */
const INN_COMPANY = 10;
const INN_PERSON = 12;

/**
 * Что из набранного попадает в поле ИНН: только цифры и не больше двенадцати.
 *
 * Номер часто вставляют из письма или выписки — вместе с пробелами и словом
 * «ИНН». Раньше такая вставка отвергалась схемой, и человек видел отказ там,
 * где ошибки не делал.
 */
export function innInput(value: string): string {
  return value.replace(/\D/gu, "").slice(0, INN_PERSON);
}

/** Отказ поля ИНН словами о том, что именно не так; `null` — с номером всё хорошо. */
function innError(value: string): string | null {
  const digits = innInput(value);
  if (digits === "") return null;
  if (digits.length < INN_COMPANY) return "ИНН не дописан: у компании в нём 10 цифр, у человека — 12.";
  if (digits.length !== INN_COMPANY && digits.length !== INN_PERSON) return "В ИНН 10 или 12 цифр — проверьте номер.";
  return isValidInn(digits) ? null : "Проверьте ИНН: контрольная цифра не сходится.";
}

/** Поле → первый текст отказа. */
export type FieldErrors = Record<string, string>;

export interface CheckFormValues {
  fullName: string;
  /** Как в поле: «дд.мм.гггг». В тело запроса уходит «ГГГГ-ММ-ДД». */
  birthDate: string;
  city: string;
  /** Другие написания через запятую — так их вводят в одно поле. */
  aliases: string;
  inn: string;
  website: string;
  employer: string;
  position: string;
  consent: boolean;
  /** Ловушка: скрытое поле, человек его не видит. */
  company: string;
}

export const EMPTY_CHECK_FORM: CheckFormValues = {
  fullName: "",
  birthDate: "",
  city: "",
  aliases: "",
  inn: "",
  website: "",
  employer: "",
  position: "",
  consent: false,
  company: "",
};

export function checkFormPayload(values: CheckFormValues, captchaToken?: string) {
  return {
    fullName: values.fullName,
    // Неполная дата уходит в схему как есть: схема отказывает, а текст у поля
    // подменяет checkFormErrors. Пустая остаётся пустой — «укажите дату».
    birthDate: birthDateToIso(values.birthDate) ?? values.birthDate.trim(),
    city: values.city,
    aliases: values.aliases
      .split(",")
      .map((alias) => alias.trim())
      .filter((alias) => alias !== ""),
    inn: values.inn,
    website: values.website,
    employer: values.employer,
    position: values.position,
    consent: values.consent,
    company: values.company,
    ...(captchaToken ? { captchaToken } : {}),
  };
}

/** `details.fieldErrors` ответа `400` → первый текст на поле. */
export function serverFieldErrors(fieldErrors: Record<string, string[] | undefined> | null | undefined): FieldErrors {
  const out: FieldErrors = {};
  for (const [field, messages] of Object.entries(fieldErrors ?? {})) {
    if (messages && messages.length > 0) out[field] = messages[0]!;
  }
  return out;
}

export function checkFormErrors(values: CheckFormValues): FieldErrors {
  const parsed = SelfCheckFormSchema.safeParse(checkFormPayload(values));
  const errors = parsed.success ? {} : serverFieldErrors(parsed.error.flatten().fieldErrors);
  // Схема говорит «ГГГГ-ММ-ДД», а человек набирает по маске — про неполную дату говорим его форматом
  if (errors.birthDate && values.birthDate.trim() !== "" && birthDateToIso(values.birthDate) === null) {
    errors.birthDate = BIRTH_DATE_INCOMPLETE_MESSAGE;
  }
  // Схема на всякий неверный ИНН отвечает одной строкой — у поля говорим, что именно не так
  const inn = innError(values.inn);
  if (inn) errors.inn = inn;
  else delete errors.inn;
  return errors;
}

/**
 * Шкала заполнения по верхнему срезу панели: два обязательных поля и согласие —
 * три трети хода; счётчик «сколько из двух» — только поля.
 */
export function checkFormProgress(values: CheckFormValues): { filled: number; meter: number } {
  const filled = (values.fullName.trim() ? 1 : 0) + (birthDateToIso(values.birthDate) ? 1 : 0);
  return { filled, meter: Math.round(((filled + (values.consent ? 1 : 0)) / 3) * 100) };
}

export type LeadChannel = "phone" | "telegram" | "email";

export interface LeadFormValues {
  name: string;
  /** Способ связи переключателем: поле одно, остальные скрыты. */
  channel: LeadChannel;
  /** Страна номера: она задаёт код, маску и длину. */
  phoneCountry: string;
  /** Только цифры национального номера; по маске их печатает поле. */
  phone: string;
  telegram: string;
  email: string;
  preferredTime: (typeof PREFERRED_TIME_VALUES)[number];
  message: string;
}

export const EMPTY_LEAD_FORM: LeadFormValues = {
  name: "",
  channel: "phone",
  phoneCountry: DEFAULT_PHONE_COUNTRY,
  phone: "",
  telegram: "",
  email: "",
  preferredTime: "any",
  message: "",
};

/**
 * Уходит только контакт выбранного способа: переключённое и забытое поле не
 * должно стать вторым контактом, которого человек не оставлял.
 */
export function leadFormPayload(values: LeadFormValues): Record<string, string> {
  const body: Record<string, string> = {
    name: values.name,
    // Телефон уходит с кодом страны: в поле видно только национальную часть
    [values.channel]: values.channel === "phone" ? phoneE164(values.phoneCountry, values.phone) : values[values.channel],
    preferredTime: values.preferredTime,
  };
  if (values.message.trim()) body.message = values.message;
  return body;
}

export function leadFormErrors(values: LeadFormValues): FieldErrors {
  const parsed = SelfCheckLeadSchema.safeParse(leadFormPayload(values));
  const errors = parsed.success ? {} : serverFieldErrors(parsed.error.flatten().fieldErrors);
  // Недобранный номер схема пропускает (в нём хватает цифр), а страна — нет:
  // «+7 900 12345» это не телефон, и сказать об этом надо у поля, а не после отправки.
  if (values.channel === "phone" && values.phone.trim() !== "" && !phoneComplete(values.phoneCountry, values.phone)) {
    errors.phone = `Номер неполный. Для страны «${phoneCountry(values.phoneCountry).name}» — например, ${phoneCountry(values.phoneCountry).example}.`;
  }
  return errors;
}
