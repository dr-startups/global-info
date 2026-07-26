import { z } from "zod";
import { ContractEnvelopeSchema } from "./common";

export const SECTION_PACK_SCHEMA_VERSION = "section-pack-v1" as const;

export const SectionPackSchema = ContractEnvelopeSchema.extend({
  schemaVersion: z.literal(SECTION_PACK_SCHEMA_VERSION),
  sectionKey: z.string().min(1),
  title: z.string().min(1),
  findingIds: z.array(z.string()),
  narrativeBullets: z.array(z.string()),
  dataSufficiency: z.enum(["SUFFICIENT", "PARTIAL", "INSUFFICIENT"]),
  warnings: z.array(z.string()),
});

export type SectionPack = z.infer<typeof SectionPackSchema>;
