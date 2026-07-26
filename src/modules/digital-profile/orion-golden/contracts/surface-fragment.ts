import { z } from "zod";
import { ContractEnvelopeSchema, SurfaceKindSchema } from "./common";

export const SURFACE_FRAGMENT_SCHEMA_VERSION = "surface-fragment-v1" as const;

export const SurfaceFragmentSchema = ContractEnvelopeSchema.extend({
  schemaVersion: z.literal(SURFACE_FRAGMENT_SCHEMA_VERSION),
  fragmentId: z.string().min(1),
  surface: SurfaceKindSchema,
  region: z.string().min(1),
  slotHint: z.string().min(1),
  assetRefs: z.array(z.string()),
  findingIds: z.array(z.string()),
  continuationOf: z.string().nullable(),
});

export type SurfaceFragment = z.infer<typeof SurfaceFragmentSchema>;
