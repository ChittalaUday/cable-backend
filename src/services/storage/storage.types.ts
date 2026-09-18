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

export interface StoredObject {
  key: string;
  sizeBytes: number;
  lastModified: Date | null;
}

export interface ObjectPage {
  objects: StoredObject[];
  nextToken: string | null;
}

export interface OrphanSweepOptions {
  dryRun?: boolean;
  minimumAgeMinutes?: number;
}

export interface OrphanSweepReport {
  scanned: number;
  orphans: StoredObject[];
  removed: number;
  skippedTooRecent: number;
  dryRun: boolean;
}

export interface ObjectHead {
  sizeBytes: number;
  contentType: string | null;
  checksum: string | null;
}

export const STORAGE_FOLDERS = ['logos', 'images', 'documents', 'files'] as const;

export type StorageFolder = (typeof STORAGE_FOLDERS)[number];

export interface RequestUploadInput {
  tenantId: string | null;
  uploadedBy: string | null;
  originalName: string;
  contentType: string;
  sizeBytes?: number;
  checksum?: string;
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
  list: (continuationToken?: string) => Promise<ObjectPage>;
  put: (object: PutObject) => Promise<void>;
  remove: (key: string) => Promise<void>;
  ping?: () => Promise<void>;
}
