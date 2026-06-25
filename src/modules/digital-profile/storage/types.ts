/**
 * Storage provider abstraction (Stage M2).
 *
 * Today only the local (private filesystem) driver is implemented. The interface
 * is deliberately S3/R2/Supabase-shaped so a remote driver can be added later
 * behind the same contract without touching call sites.
 *
 * All keys are validated/normalized (see `keys.ts`) before any I/O. No object is
 * ever served from a public path — reads go through signed download routes.
 */

export type StorageDriver = "local" | "s3" | "r2" | "supabase";

export interface PutObjectOptions {
  /** Best-effort content type stored as metadata where the driver supports it. */
  contentType?: string;
  /** Arbitrary small metadata (driver-dependent; ignored by the local driver). */
  metadata?: Record<string, string>;
}

export interface PutObjectResult {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
}

export interface StorageObjectInfo {
  storageKey: string;
  sizeBytes: number;
  /** Last-modified epoch ms when available. */
  updatedAt?: number;
}

export interface SignedReadUrlOptions {
  /** Override the default TTL (seconds). */
  ttlSeconds?: number;
  /**
   * Resource binding used to construct the correct download route + signature.
   * For the local driver the signature is bound to the storage key.
   */
  resource:
    | { kind: "report"; reportVersionId: string; type: "pptx" | "pdf" }
    | { kind: "screenshot"; screenshotId: string };
}

export interface SignedReadUrl {
  /** Relative download URL (signed). */
  url: string;
  /** Opaque signed token (also embedded in `url`). */
  token: string;
  /** Expiry epoch seconds. */
  expiresAt: number;
}

export interface StorageProvider {
  readonly driver: StorageDriver;

  putObject(
    key: string,
    buffer: Buffer,
    options?: PutObjectOptions
  ): Promise<PutObjectResult>;

  getObject(key: string): Promise<Buffer>;

  deleteObject(key: string): Promise<void>;

  exists(key: string): Promise<boolean>;

  createSignedReadUrl(
    key: string,
    options: SignedReadUrlOptions
  ): SignedReadUrl;

  /**
   * Absolute on-disk path for a key (local driver only). Remote drivers throw —
   * callers must use getObject/putObject instead of touching paths directly.
   */
  getPrivatePath(key: string): string;

  listObjects(prefix: string): Promise<StorageObjectInfo[]>;
}
