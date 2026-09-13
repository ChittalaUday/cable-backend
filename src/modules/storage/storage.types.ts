export type { FileKind, FileRecord, FileStatus, FileVisibility } from '@/db/schema';

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
