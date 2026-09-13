import type { Buffer } from 'node:buffer';
import type {
  DirectUploadResult,
  FileRecord,
  LocalStagedUploadInput,
  RequestUploadInput,
  StorageCleanupOptions,
  StorageCleanupReport,
  StorageProvider,
  UploadResult,
  UserFileRecord,
  UserFileWithFile,
} from './storage.types';
import type { Database } from '@/plugins/database';
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { and, count, eq, isNull, lte, ne } from 'drizzle-orm';
import { files, userFiles } from '@/db/schema';
import { ERROR_CODES } from '@/shared/errors';
import { DomainError, notFound } from '@/shared/errors/domain-error';

export interface StorageServiceOptions {
  provider: StorageProvider;
  uploadUrlTtlSeconds: number;
  downloadUrlTtlSeconds: number;
  maxUploadBytes: number;
  allowedContentTypes: string[];
}

/**
 * File metadata, presigned access, and content deduplication (AGENTS.md §8.4).
 *
 * Bytes can be:
 * 1. Streamed directly to API, staged locally to verify content hash, deduplicated, and unlinked.
 * 2. Uploaded directly to R2 via presigned URLs.
 *
 * Content deduplication:
 * - `media.files` tracks unique physical objects keyed by content checksum (SHA-256).
 * - `media.user_files` tracks tenant/user attachments pointing to a `files(id)`.
 * - If an uploaded file's checksum already exists in storage, duplicate bytes are not stored.
 */
export class StorageService {
  constructor(
    private readonly db: Database,
    private readonly options: StorageServiceOptions,
  ) {}

  get configured(): boolean {
    return this.options.provider.configured;
  }

  get bucket(): string {
    return this.options.provider.bucket;
  }

  async ping(): Promise<void> {
    if (!this.options.provider.configured)
      throw new Error('Object storage is not configured');
    if (this.options.provider.ping)
      await this.options.provider.ping();
  }

  /**
   * Upload flow with local staging and content hash verification:
   * 1. Takes the incoming file stream and pipes it temporarily to a local temp file.
   * 2. Computes the SHA-256 hash and exact byte size while streaming.
   * 3. Checks if a physical file with this hash already exists with status 'ready':
   *    - If exists: creates `media.user_files` linked to existing file (skips storage upload).
   *    - If new: uploads file from local temp to cloud storage, marks 'ready', creates `media.user_files`.
   * 4. In `finally`: unconditionally removes the temporary local file.
   */
  async uploadWithLocalStaging(input: LocalStagedUploadInput): Promise<DirectUploadResult> {
    this.assertContentTypeAllowed(input.contentType);

    const tempDir = path.join(os.tmpdir(), 'cable_uploads');
    await fs.promises.mkdir(tempDir, { recursive: true });
    const tempFilePath = path.join(tempDir, `${randomUUID()}.tmp`);

    try {
      const { checksum, sizeBytes } = await this.stageStreamToDisk(input, tempFilePath);

      // Deduplication check: does a ready physical file with this checksum already exist?
      const [existingReadyFile] = await this.db.select().from(files).where(and(
        eq(files.checksum, checksum),
        eq(files.status, 'ready'),
        isNull(files.deletedAt),
      )).limit(1);

      if (existingReadyFile) {
        const [userFile] = await this.db.insert(userFiles).values({
          tenantId: input.tenantId,
          uploadedBy: input.uploadedBy,
          fileId: existingReadyFile.id,
          originalName: input.originalName,
          kind: input.kind ?? 'upload',
          visibility: input.visibility ?? 'private',
          metadata: input.metadata,
        }).returning();

        if (!userFile)
          throw new Error('UserFile insert returned no row');

        return { deduplicated: true, userFile, file: existingReadyFile };
      }

      // New file: upload from local temp file to storage provider
      const storageKey = buildStorageKey(input.tenantId, input.originalName);
      const fileBuffer = await fs.promises.readFile(tempFilePath);

      await this.options.provider.put({
        key: storageKey,
        body: fileBuffer,
        contentType: input.contentType,
      });

      const [newFile] = await this.db.insert(files).values({
        storageKey,
        bucket: this.options.provider.bucket,
        contentType: input.contentType,
        sizeBytes,
        checksum,
        status: 'ready',
      }).returning();

      if (!newFile)
        throw new Error('File insert returned no row');

      const [userFile] = await this.db.insert(userFiles).values({
        tenantId: input.tenantId,
        uploadedBy: input.uploadedBy,
        fileId: newFile.id,
        originalName: input.originalName,
        kind: input.kind ?? 'upload',
        visibility: input.visibility ?? 'private',
        metadata: input.metadata,
      }).returning();

      if (!userFile)
        throw new Error('UserFile insert returned no row');

      return { deduplicated: false, userFile, file: newFile };
    }
    finally {
      // Unconditionally remove the temporary local file
      try {
        await fs.promises.unlink(tempFilePath);
      }
      catch {
        // Ignore if file doesn't exist
      }
    }
  }

  private async stageStreamToDisk(
    input: LocalStagedUploadInput,
    tempFilePath: string,
  ): Promise<{ checksum: string; sizeBytes: number }> {
    const writeStream = fs.createWriteStream(tempFilePath);
    const hash = crypto.createHash('sha256');
    let sizeBytes = 0;

    input.stream.on('data', (chunk: Buffer) => {
      sizeBytes += chunk.length;
      if (sizeBytes > this.options.maxUploadBytes) {
        input.stream.destroy(this.tooLarge(sizeBytes));
      }
      hash.update(chunk);
    });

    await pipeline(input.stream, writeStream);
    const checksum = hash.digest('hex');
    return { checksum, sizeBytes };
  }

  /**
   * Requests an upload via presigned URL.
   *
   * If `input.checksum` matches an existing physical file with `status: 'ready'`,
   * returns `{ deduplicated: true }` and creates a new `media.user_files` record
   * immediately without requiring a storage upload.
   *
   * Otherwise, creates a `pending` row in `files` + `user_files` and returns
   * a presigned PUT upload URL.
   */
  async requestUpload(input: RequestUploadInput): Promise<UploadResult> {
    this.assertContentTypeAllowed(input.contentType);

    if (input.sizeBytes != null && input.sizeBytes > this.options.maxUploadBytes)
      throw this.tooLarge(input.sizeBytes);

    const match = await this.tryDeduplicate(input);
    if (match !== null)
      return { deduplicated: true, userFile: match.userFile, file: match.file };

    const storageKey = buildStorageKey(input.tenantId, input.originalName);

    const [file] = await this.db.insert(files).values({
      storageKey,
      bucket: this.options.provider.bucket,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes ?? null,
      checksum: input.checksum ?? null,
      status: 'pending',
    }).returning();

    if (!file)
      throw new Error('File insert returned no row');

    const [userFile] = await this.db.insert(userFiles).values({
      tenantId: input.tenantId,
      uploadedBy: input.uploadedBy,
      fileId: file.id,
      originalName: input.originalName,
      kind: input.kind ?? 'upload',
      visibility: input.visibility ?? 'private',
      metadata: input.metadata,
    }).returning();

    if (!userFile)
      throw new Error('UserFile insert returned no row');

    const signed = await this.options.provider.createUploadUrl(
      storageKey,
      input.contentType,
      this.options.uploadUrlTtlSeconds,
    );

    return {
      deduplicated: false,
      userFile,
      file,
      uploadUrl: signed.url,
      expiresAt: signed.expiresAt,
    };
  }

  private async tryDeduplicate(input: RequestUploadInput): Promise<{ userFile: UserFileRecord; file: FileRecord } | null> {
    if (input.checksum == null || input.checksum === '')
      return null;

    const [existingFile] = await this.db.select().from(files).where(and(
      eq(files.checksum, input.checksum),
      eq(files.status, 'ready'),
      isNull(files.deletedAt),
    )).limit(1);

    if (!existingFile)
      return null;

    const [userFile] = await this.db.insert(userFiles).values({
      tenantId: input.tenantId,
      uploadedBy: input.uploadedBy,
      fileId: existingFile.id,
      originalName: input.originalName,
      kind: input.kind ?? 'upload',
      visibility: input.visibility ?? 'private',
      metadata: input.metadata,
    }).returning();

    if (!userFile)
      throw new Error('UserFile insert returned no row');

    return { userFile, file: existingFile };
  }

  /**
   * Verifies the object landed in storage, then marks the physical file `ready`.
   */
  async confirmUpload(userFileId: string, tenantId: string | null): Promise<UserFileWithFile> {
    const { userFile, file } = await this.findOwned(userFileId, tenantId);

    if (file.status === 'ready')
      return { userFile, file };

    const head = await this.options.provider.head(file.storageKey);

    if (!head) {
      await this.db.update(files)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(files.id, file.id));

      throw new DomainError({
        code: ERROR_CODES.STORAGE_OBJECT_MISSING,
        statusCode: 409,
        message: 'No object was uploaded for this file',
      });
    }

    if (head.sizeBytes > this.options.maxUploadBytes) {
      await this.options.provider.remove(file.storageKey);
      await this.db.update(files)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(files.id, file.id));

      throw this.tooLarge(head.sizeBytes);
    }

    const resolvedChecksum = head.checksum ?? file.checksum;

    if (resolvedChecksum != null && resolvedChecksum !== '') {
      const [existingReadyFile] = await this.db.select().from(files).where(and(
        eq(files.checksum, resolvedChecksum),
        eq(files.status, 'ready'),
        ne(files.id, file.id),
      )).limit(1);

      if (existingReadyFile) {
        const [updatedUserFile] = await this.db.update(userFiles)
          .set({ fileId: existingReadyFile.id, updatedAt: new Date() })
          .where(eq(userFiles.id, userFile.id))
          .returning();

        if (this.options.provider.configured) {
          await this.options.provider.remove(file.storageKey);
        }

        // Soft-delete the duplicate pending file record
        await this.db.update(files)
          .set({ status: 'deleted', deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(files.id, file.id));

        return { userFile: updatedUserFile ?? userFile, file: existingReadyFile };
      }
    }

    const [ready] = await this.db.update(files)
      .set({
        status: 'ready',
        sizeBytes: head.sizeBytes,
        checksum: resolvedChecksum,
        updatedAt: new Date(),
      })
      .where(eq(files.id, file.id))
      .returning();

    return { userFile, file: ready ?? file };
  }

  /** Short-lived download URL for a private object. */
  async downloadUrl(userFileId: string, tenantId: string | null): Promise<{ url: string; expiresAt: Date }> {
    const { file } = await this.findOwned(userFileId, tenantId);

    if (file.status !== 'ready')
      throw notFound('File');

    const signed = await this.options.provider.createDownloadUrl(file.storageKey, this.options.downloadUrlTtlSeconds);
    return { url: signed.url, expiresAt: signed.expiresAt };
  }

  /**
   * Soft-deletes the user's file reference.
   *
   * Physical cloud object deletion and orphaned file pruning are deferred to
   * the nightly cleanup cron (never on the request path of a write, AGENTS.md §1).
   */
  async remove(userFileId: string, tenantId: string | null): Promise<void> {
    const { userFile } = await this.findOwned(userFileId, tenantId);

    // Soft-delete the user file reference
    await this.db.update(userFiles)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(userFiles.id, userFile.id));
  }

  /** Tenant-scoped lookup (§4.5): returns UserFile joined with File. */
  async findOwned(userFileId: string, tenantId: string | null): Promise<UserFileWithFile> {
    const [row] = await this.db.select({
      userFile: userFiles,
      file: files,
    })
      .from(userFiles)
      .innerJoin(files, eq(userFiles.fileId, files.id))
      .where(and(
        eq(userFiles.id, userFileId),
        tenantId === null ? isNull(userFiles.tenantId) : eq(userFiles.tenantId, tenantId),
        isNull(userFiles.deletedAt),
      ));

    if (!row)
      throw notFound('File');

    return row;
  }

  /**
   * Nightly verification and cleanup cron:
   * 1. Stale pending uploads: cleans up abandoned uploads where `expiresAt < now()` or older
   *    than the grace period. Preserves in-flight pending uploads created recently.
   * 2. Orphaned physical files: prunes physical objects where all user_files references were deleted.
   * 3. Deleted physical files: prunes physical objects for files with status = 'deleted'.
   * 4. Integrity verification: checks object existence in cloud storage for all active ready files.
   */
  async verifyAndCleanupStorage(options: StorageCleanupOptions = {}): Promise<StorageCleanupReport> {
    const gracePeriodMinutes = options.gracePeriodMinutes ?? 120;
    const verifyStorageIntegrity = options.verifyStorageIntegrity ?? true;
    const cutoffTime = new Date(Date.now() - gracePeriodMinutes * 60 * 1000);
    const now = new Date();

    const pendingStats = await this.cleanupPendingFiles(cutoffTime, now);
    const readyStats = await this.cleanupAndVerifyReadyFiles(cutoffTime, verifyStorageIntegrity);

    return {
      ...pendingStats,
      ...readyStats,
    };
  }

  private async cleanupPendingFiles(
    cutoffTime: Date,
    now: Date,
  ): Promise<{ stalePendingCleaned: number; inFlightPendingPreserved: number }> {
    let stalePendingCleaned = 0;
    let inFlightPendingPreserved = 0;

    const pendingFiles = await this.db.select().from(files).where(and(
      eq(files.status, 'pending'),
      isNull(files.deletedAt),
    ));

    for (const pendingFile of pendingFiles) {
      const isExpired = pendingFile.expiresAt !== null && pendingFile.expiresAt < now;
      const isPastGracePeriod = pendingFile.createdAt < cutoffTime;

      if (!isExpired && !isPastGracePeriod) {
        inFlightPendingPreserved++;
        continue;
      }

      if (this.options.provider.configured) {
        const head = await this.options.provider.head(pendingFile.storageKey);
        if (head !== null) {
          await this.options.provider.remove(pendingFile.storageKey);
        }
      }

      await this.db.update(files)
        .set({ status: 'failed', deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(files.id, pendingFile.id));

      stalePendingCleaned++;
    }

    return { stalePendingCleaned, inFlightPendingPreserved };
  }

  private async cleanupAndVerifyReadyFiles(
    cutoffTime: Date,
    verifyStorageIntegrity: boolean,
  ): Promise<{ orphanedFilesCleaned: number; missingObjectsFlagged: number }> {
    let orphanedFilesCleaned = 0;
    let missingObjectsFlagged = 0;

    const readyFiles = await this.db.select().from(files).where(and(
      eq(files.status, 'ready'),
      isNull(files.deletedAt),
      lte(files.createdAt, cutoffTime),
    ));

    for (const readyFile of readyFiles) {
      const [activeRefs] = await this.db.select({ total: count() })
        .from(userFiles)
        .where(and(
          eq(userFiles.fileId, readyFile.id),
          isNull(userFiles.deletedAt),
        ));

      const totalActive = Number(activeRefs?.total ?? 0);
      if (totalActive === 0) {
        if (this.options.provider.configured) {
          await this.options.provider.remove(readyFile.storageKey);
        }
        await this.db.update(files)
          .set({ status: 'deleted', deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(files.id, readyFile.id));

        orphanedFilesCleaned++;
      }
      else if (verifyStorageIntegrity && this.options.provider.configured) {
        const head = await this.options.provider.head(readyFile.storageKey);
        if (head === null) {
          await this.db.update(files)
            .set({ status: 'failed', updatedAt: new Date() })
            .where(eq(files.id, readyFile.id));

          missingObjectsFlagged++;
        }
      }
    }

    return { orphanedFilesCleaned, missingObjectsFlagged };
  }

  private assertContentTypeAllowed(contentType: string): void {
    if (this.options.allowedContentTypes.length === 0)
      return;

    if (!this.options.allowedContentTypes.includes(contentType)) {
      throw new DomainError({
        code: ERROR_CODES.STORAGE_TYPE_NOT_ALLOWED,
        statusCode: 400,
        message: `Content type "${contentType}" is not allowed`,
      });
    }
  }

  private tooLarge(sizeBytes: number): DomainError {
    return new DomainError({
      code: ERROR_CODES.STORAGE_FILE_TOO_LARGE,
      statusCode: 400,
      message: `File is ${sizeBytes} bytes; the limit is ${this.options.maxUploadBytes}`,
    });
  }
}

/**
 * Server-generated object key. The client's filename never shapes the path —
 * that is how `../` traversal and collisions get in.
 */
export function buildStorageKey(tenantId: string | null, originalName: string): string {
  const extension = path.extname(originalName).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12);
  const now = new Date();
  const yyyymm = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${tenantId ?? 'platform'}/${yyyymm}/${randomUUID()}${extension}`;
}
