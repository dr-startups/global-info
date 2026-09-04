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

/** Accepts an ISO date or date-time string; coerces to a Date. */
const optionalDate = z
  .union([z.string(), z.date()])
  .optional()
  .transform((v, ctx) => {
    if (v == null || v === "") return undefined;
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

/**
 * Дата рождения субъекта — обязательное поле дела.
 *
 * Это самый сильный признак субъекта и единственный, работающий в обе стороны:
 * подтверждает свой материал и опровергает чужой. Без неё ворота персоны
 * закрыты (`SUBJECT_ANCHORS_MISSING`) и платный сбор всё равно не начнётся —
 * узнавать об этом на кнопке «Собрать» поздно, дело уже заведено с неполными
 * данными. Прогон DPA-2026-0049, названный заказчиком «мешаниной», был заведён
 * без неё.
 */
const requiredBirthDate = z
  .union([z.string(), z.date()])
  // `.optional()` здесь не «поле необязательно», а «пустое значение доходит до
  // разбора»: иначе union отвергает его своей фразой про типы, и оператор
  // читает `invalid_union` вместо причины.
  .optional()
  .transform((v, ctx) => {
    if (v == null || v === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Укажите дату рождения субъекта: без неё материалы полного тёзки не отличить от материалов проверяемого лица",
      });
      return z.NEVER;
    }
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid date" });
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
