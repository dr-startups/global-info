import { digitalProfileConfig } from "@/modules/digital-profile/config";
import { OrionFilePipelineStore } from "./file-store";
import { OrionPrismaPipelineStore } from "./prisma-store";
import type { OrionPipelineStore, OrionStoreMode } from "./types";

function resolveStoreMode(explicit?: OrionStoreMode): OrionStoreMode {
  if (explicit) return explicit;
  const env = String(process.env.DIGITAL_PROFILE_ORION_PIPELINE_STORE ?? "").trim().toLowerCase();
  if (env === "db") return "db";
  if (digitalProfileConfig.orionPipelineStore === "db") return "db";
  return "file";
}

export function createOrionPipelineStore(input?: { mode?: OrionStoreMode }): OrionPipelineStore {
  const fileStore = new OrionFilePipelineStore();
  const mode = resolveStoreMode(input?.mode);
  if (mode === "db") {
    return new OrionPrismaPipelineStore(fileStore);
  }
  return fileStore;
}

export * from "./types";
export * from "./file-store";
export * from "./prisma-store";
export * from "./sanitize-for-storage";
