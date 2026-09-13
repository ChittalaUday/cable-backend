import type { Readable } from 'node:stream';
import type {
  FileKind,
  FileRecord,
  FileStatus,
  FileVisibility,
  NewFileRecord,
  NewUserFileRecord,
  UserFileRecord,
} from '@/db/schema';

export type {
  FileKind,
  FileRecord,
  FileStatus,
  FileVisibility,
  NewFileRecord,
  NewUserFileRecord,
  UserFileRecord,
};

export interface PutObject {
  key: string;
  body: Uint8Array | string;
  contentType: string;
}

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

export interface ObjectHead {
  sizeBytes: number;
  contentType: string | null;
  checksum: string | null;
}

export interface RequestUploadInput {
  tenantId: string | null;
  uploadedBy: string | null;
  originalName: string;
  contentType: string;
  /** What the client says it will upload. Checked against the cap, then re-checked after. */
  sizeBytes?: number;
  /** sha-256 of the content, if computed upfront by the client for instant deduplication. */
  checksum?: string;
  kind?: FileKind;
  visibility?: FileVisibility;
  metadata?: Record<string, unknown>;
}

export interface LocalStagedUploadInput {
  tenantId: string | null;
  uploadedBy: string | null;
  originalName: string;
  contentType: string;
  kind?: FileKind;
  visibility?: FileVisibility;
  metadata?: Record<string, unknown>;
  /** The incoming stream of bytes (from multipart upload or request body). */
  stream: Readable;
}

export interface DirectUploadResult {
  deduplicated: boolean;
  userFile: UserFileRecord;
  file: FileRecord;
}

export type UploadResult
  = | {
    deduplicated: true;
    userFile: UserFileRecord;
    file: FileRecord;
  }
  | {
    deduplicated: false;
    userFile: UserFileRecord;
    file: FileRecord;
    uploadUrl: string;
    expiresAt: Date;
  };

export interface UserFileWithFile {
  userFile: UserFileRecord;
  file: FileRecord;
}

export interface StorageCleanupOptions {
  /**
   * Grace period in minutes for in-flight pending uploads.
   * Pending files created within this window are preserved and never cleaned up by the cron.
   * Default: 120 minutes (2 hours).
   */
  gracePeriodMinutes?: number;
  /**
   * If true, performs storage head verification for all active ready files.
   * Default: true.
   */
  verifyStorageIntegrity?: boolean;
}

export interface StorageCleanupReport {
  stalePendingCleaned: number;
  inFlightPendingPreserved: number;
  orphanedFilesCleaned: number;
  missingObjectsFlagged: number;
}

/**
 * Object storage, behind one interface (AGENTS.md §1 rule 1).
 *
 * Cloudflare R2 today. Because R2 speaks the S3 API, any S3-compatible bucket is
 * a config change rather than a code change — but nothing outside a provider
 * file knows that.
 */
export interface StorageProvider {
  readonly name: string;
  readonly bucket: string;
  readonly configured: boolean;

  /** Presigned PUT so bytes go client → storage, never through this process. */
  createUploadUrl: (key: string, contentType: string, expiresInSeconds: number) => Promise<SignedUrl>;
  /** Presigned GET for a private object. */
  createDownloadUrl: (key: string, expiresInSeconds: number) => Promise<SignedUrl>;
  /** Confirms an object exists and reports its real size — never trust the client's. */
  head: (key: string) => Promise<ObjectHead | null>;
  /** Direct write, for small artefacts the backend generates itself. */
  put: (object: PutObject) => Promise<void>;
  remove: (key: string) => Promise<void>;
  /** Probes connectivity and bucket access for health and preflight checks. */
  ping?: () => Promise<void>;
}
