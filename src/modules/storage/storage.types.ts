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

/**
 * The shelf an object is filed on, under the tenant.
 *
 * The BACKEND picks it, never the uploading client: an endpoint knows what it is
 * accepting, and a caller-supplied path is how objects end up scattered or
 * escaping their tenant's prefix. Adding a member here is what makes a new shelf
 * exist — it is not a free-text path.
 */
export const STORAGE_FOLDERS = ['logos', 'images', 'documents', 'files'] as const;

export type StorageFolder = (typeof STORAGE_FOLDERS)[number];

export interface RequestUploadInput {
  tenantId: string | null;
  uploadedBy: string | null;
  originalName: string;
  contentType: string;
  sizeBytes?: number;
  checksum?: string;
  /** Omit it and the content type decides — see `folderFor`. */
  folder?: StorageFolder;
  kind?: FileKind;
  visibility?: FileVisibility;
  metadata?: Record<string, unknown>;
}

export interface LocalStagedUploadInput {
  tenantId: string | null;
  uploadedBy: string | null;
  originalName: string;
  contentType: string;
  /** Omit it and the content type decides — see `folderFor`. */
  folder?: StorageFolder;
  kind?: FileKind;
  visibility?: FileVisibility;
  metadata?: Record<string, unknown>;
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
  gracePeriodMinutes?: number;
  verifyStorageIntegrity?: boolean;
}

export interface StorageCleanupReport {
  stalePendingCleaned: number;
  inFlightPendingPreserved: number;
  orphanedFilesCleaned: number;
  missingObjectsFlagged: number;
}

export interface StorageProvider {
  readonly name: string;
  readonly bucket: string;
  readonly configured: boolean;

  createUploadUrl: (key: string, contentType: string, expiresInSeconds: number) => Promise<SignedUrl>;
  createDownloadUrl: (key: string, expiresInSeconds: number) => Promise<SignedUrl>;
  head: (key: string) => Promise<ObjectHead | null>;
  put: (object: PutObject) => Promise<void>;
  remove: (key: string) => Promise<void>;
  ping?: () => Promise<void>;
}
