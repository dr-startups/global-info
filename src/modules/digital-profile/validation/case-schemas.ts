/**
 * Zod validation schemas for Digital Profile case endpoints.
 *
 * Enum values are kept in sync with prisma/schema.prisma. They are duplicated as
 * string literals (instead of importing Prisma enums) so these schemas stay
 * framework-agnostic and safe to reuse on the client later.
 */

import { z } from "zod";

export const LAWFUL_BASIS_VALUES = [
  "CONSENT",
  "CONTRACT",
  "LEGAL_OBLIGATION",
  "LEGITIMATE_INTEREST",
  "PUBLIC_INTEREST",
  "VITAL_INTEREST",
] as const;

export const CONSENT_STATUS_VALUES = [
  "NOT_REQUIRED",
  "PENDING",
  "OBTAINED",
  "REFUSED",
] as const;

export const CASE_STATUS_VALUES = [
  "DRAFT",
  "COLLECTING",
  "REVIEW",
  "REPORT_READY",
  "CLOSED",
  "ARCHIVED",
] as const;

const trimmedString = (max = 500) => z.string().trim().min(1).max(max);

/**
 * Дата рождения субъекта — обязательное поле дела; ISO-дата или дата-время.
 *
 * Дата уже работает как признак субъекта: уходит в запрос санкционного
 * скрининга и отличает санкционную карточку проверяемого лица от карточки
 * полного тёзки на панели персоны. Дело, заведённое без неё, теряет этот
 * признак молча. Сайт самопроверки спрашивает дату обязательно, и админка
 * отвечает на тот же вопрос так же.
 *
 * Отказ говорит, зачем дата нужна, а не «поле обязательно»; непонятная дата
 * остаётся непонятной датой.
 */
const requiredBirthDate = z
  .union([z.string(), z.date()])
  // `.nullish()` здесь не «поле необязательно», а «пустое значение доходит до
  // разбора»: иначе union отвергает его своей фразой про типы, и оператор
  // читает `invalid_union` вместо причины.
  .nullish()
  .transform((v, ctx) => {
    if (v == null || v === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Укажите дату рождения субъекта: без неё санкционную карточку полного тёзки не отличить от карточки проверяемого лица",
      });
      return z.NEVER;
    }
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid date",
      });
      return z.NEVER;
    }
    return d;
  });

export const CreateDigitalProfileCaseSchema = z.object({
  // Subject
  fullName: trimmedString(200),
  aliases: z.array(trimmedString(200)).max(50).optional(),
  birthDate: requiredBirthDate,
  // Case scope / compliance
  targetRegions: z.array(trimmedString(120)).max(50).optional(),
  lawfulBasis: z.enum(LAWFUL_BASIS_VALUES),
  consentStatus: z.enum(CONSENT_STATUS_VALUES),
  notes: z.string().trim().max(5000).optional(),
});

export const UpdateDigitalProfileCaseSchema = z
  .object({
    title: trimmedString(300).optional(),
    status: z.enum(CASE_STATUS_VALUES).optional(),
    lawfulBasis: z.enum(LAWFUL_BASIS_VALUES).optional(),
    consentStatus: z.enum(CONSENT_STATUS_VALUES).optional(),
    targetRegions: z.array(trimmedString(120)).max(50).optional(),
    notes: z.string().trim().max(5000).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export const ListDigitalProfileCasesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(CASE_STATUS_VALUES).optional(),
  q: z.string().trim().max(200).optional(),
  /** Происхождение дела; `site` — заведено проверкой с сайта. */
  origin: z.enum(["site"]).optional(),
  includeDeleted: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === "true" || v === "1"),
});

export type CreateDigitalProfileCaseInput = z.infer<
  typeof CreateDigitalProfileCaseSchema
>;
export type UpdateDigitalProfileCaseInput = z.infer<
  typeof UpdateDigitalProfileCaseSchema
>;
export type ListDigitalProfileCasesQuery = z.infer<
  typeof ListDigitalProfileCasesQuerySchema
>;
