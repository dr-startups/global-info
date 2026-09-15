/**
 * Форма проверки и форма заявки в браузере.
 *
 * Поля проверяются схемами ручек (`self-check/schemas.ts`), а не своей копией
 * правил: вторая проверка разошлась бы с сервером, и у поля до отправки стоял бы
 * один текст, а после — другой. Отсюда же — тело запроса, чтобы браузер
 * проверял ровно то, что уйдёт на сервер.
 */

import {
  PREFERRED_TIME_VALUES,
  SelfCheckFormSchema,
  SelfCheckLeadSchema,
} from "@/modules/self-check/schemas";

/** Поле → первый текст отказа. */
export type FieldErrors = Record<string, string>;

export interface CheckFormValues {
  fullName: string;
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
    birthDate: values.birthDate,
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
  return parsed.success ? {} : serverFieldErrors(parsed.error.flatten().fieldErrors);
}

/**
 * Шкала заполнения по верхнему срезу панели: два обязательных поля и согласие —
 * три трети хода; счётчик «сколько из двух» — только поля.
 */
export function checkFormProgress(values: CheckFormValues): { filled: number; meter: number } {
  const filled = (values.fullName.trim() ? 1 : 0) + (values.birthDate.trim() ? 1 : 0);
  return { filled, meter: Math.round(((filled + (values.consent ? 1 : 0)) / 3) * 100) };
}

export type LeadChannel = "phone" | "telegram" | "email";

export interface LeadFormValues {
  name: string;
  /** Способ связи переключателем: поле одно, остальные скрыты. */
  channel: LeadChannel;
  phone: string;
  telegram: string;
  email: string;
  preferredTime: (typeof PREFERRED_TIME_VALUES)[number];
  message: string;
}

export const EMPTY_LEAD_FORM: LeadFormValues = {
  name: "",
  channel: "phone",
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
    [values.channel]: values[values.channel],
    preferredTime: values.preferredTime,
  };
  if (values.message.trim()) body.message = values.message;
  return body;
}

export function leadFormErrors(values: LeadFormValues): FieldErrors {
  const parsed = SelfCheckLeadSchema.safeParse(leadFormPayload(values));
  return parsed.success ? {} : serverFieldErrors(parsed.error.flatten().fieldErrors);
}
