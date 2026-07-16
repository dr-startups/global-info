import { z } from "zod";
import { ContractEnvelopeSchema } from "./common";

export const ASSEMBLED_DECK_MODEL_SCHEMA_VERSION = "assembled-deck-model-v1" as const;

export const DeckSlideSlotSchema = z.object({
  slideId: z.string().min(1),
  pageNumber: z.number().int().positive(),
  role: z.enum(["base", "continuation", "appendix", "toc", "cover"]),
  fragmentIds: z.array(z.string()),
  findingIds: z.array(z.string()),
  assetRefs: z.array(z.string()),
  title: z.string().optional(),
});

export const AssembledDeckModelSchema = ContractEnvelopeSchema.extend({
  schemaVersion: z.literal(ASSEMBLED_DECK_MODEL_SCHEMA_VERSION),
  pageCount: z.number().int().nonnegative(),
  baseSlotCount: z.number().int().nonnegative(),
  continuationCount: z.number().int().nonnegative(),
  slides: z.array(DeckSlideSlotSchema),
  executiveSummaryRef: z.string().optional(),
  sectionPackRefs: z.array(z.string()),
});

export type AssembledDeckModel = z.infer<typeof AssembledDeckModelSchema>;
export type DeckSlideSlot = z.infer<typeof DeckSlideSlotSchema>;
