import type { Buffer } from 'node:buffer';
import type {
  DirectUploadResult,
  FileRecord,
  LocalStagedUploadInput,
  RequestUploadInput,
  StorageCleanupOptions,
  StorageCleanupReport,
  StorageFolder,
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
import { csv, env } from '@/config/env';
import { files, userFiles } from '@/db/schema';
import { audit } from '@/modules/audit/audit.service';
import { systemAuditContext } from '@/modules/audit/audit.types';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/shared/constants/audit';
import { ERROR_CODES } from '@/shared/errors';
import { DomainError, notFound } from '@/shared/errors/domain-error';
import { createR2Provider } from './providers/r2.provider';
import { createUnconfiguredStorage } from './providers/unconfigured.provider';

export interface StorageServiceOptions {
  provider: StorageProvider;
  uploadUrlTtlSeconds: number;
  downloadUrlTtlSeconds: number;
  maxUploadBytes: number;
  allowedContentTypes: string[];
}

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

  async uploadWithLocalStaging(input: LocalStagedUploadInput): Promise<DirectUploadResult> {
    this.assertContentTypeAllowed(input.contentType);

    const tempDir = path.join(os.tmpdir(), 'cable_uploads');
    await fs.promises.mkdir(tempDir, { recursive: true });
    const tempFilePath = path.join(tempDir, `${randomUUID()}.tmp`);

    try {
      const { checksum, sizeBytes } = await this.stageStreamToDisk(input, tempFilePath);

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

      const storageKey = buildStorageKey(input);
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
      try {
        await fs.promises.unlink(tempFilePath);
      }
      catch {
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

  async requestUpload(input: RequestUploadInput): Promise<UploadResult> {
    this.assertContentTypeAllowed(input.contentType);

    if (input.sizeBytes != null && input.sizeBytes > this.options.maxUploadBytes)
      throw this.tooLarge(input.sizeBytes);

    const match = await this.tryDeduplicate(input);
    if (match !== null)
      return { deduplicated: true, userFile: match.userFile, file: match.file };

    const storageKey = buildStorageKey(input);

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

  async downloadUrl(userFileId: string, tenantId: string | null): Promise<{ url: string; expiresAt: Date }> {
    const { file } = await this.findOwned(userFileId, tenantId);

    if (file.status !== 'ready')
      throw notFound('File');

    const signed = await this.options.provider.createDownloadUrl(file.storageKey, this.options.downloadUrlTtlSeconds);
    return { url: signed.url, expiresAt: signed.expiresAt };
  }

  async remove(userFileId: string, tenantId: string | null): Promise<void> {
    const { userFile } = await this.findOwned(userFileId, tenantId);

    await this.db.update(userFiles)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(userFiles.id, userFile.id));
  }

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

  async verifyAndCleanupStorage(options: StorageCleanupOptions = {}): Promise<StorageCleanupReport> {
    const gracePeriodMinutes = options.gracePeriodMinutes ?? 120;
    const verifyStorageIntegrity = options.verifyStorageIntegrity ?? true;
    const cutoffTime = new Date(Date.now() - gracePeriodMinutes * 60 * 1000);
    const now = new Date();

    const pendingStats = await this.cleanupPendingFiles(cutoffTime, now);
    const readyStats = await this.cleanupAndVerifyReadyFiles(cutoffTime, verifyStorageIntegrity);

    const report = { ...pendingStats, ...readyStats };
    const changed = report.stalePendingCleaned + report.orphanedFilesCleaned + report.missingObjectsFlagged;

    // Only when it actually did something. A nightly no-op would otherwise add
    // 365 empty rows a year to the one table people read to find real events.
    if (changed > 0) {
      await audit.log(this.db, systemAuditContext('job:storage-cleanup'), {
        action: AUDIT_ACTIONS.STORAGE_CLEANED,
        entityType: AUDIT_ENTITIES.STORAGE,
        entityId: 'storage-cleanup',
        after: { ...report, gracePeriodMinutes, verifyStorageIntegrity },
      });
    }

    return report;
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
 * The shelf an upload belongs on when nobody said.
 *
 * Sorting by content type means every endpoint files things correctly without
 * having to remember to — the default is right, rather than everything landing
 * in one heap because a caller left the field out. A caller that knows the
 * PURPOSE of a file, rather than just its type, passes `folder` and wins: a
 * channel logo is an image, but it belongs with the logos.
 */
export function folderFor(contentType: string): StorageFolder {
  if (contentType.startsWith('image/'))
    return 'images';

  if (contentType === 'application/pdf' || contentType.startsWith('text/'))
    return 'documents';

  return 'files';
}

/**
 * Where an object lives in the bucket: `<tenant>/<folder>/<yyyy>/<mm>/<uuid><ext>`.
 *
 * Tenant first so one operator's objects can be listed, or removed, without
 * touching another's. Folder next so logos are not mixed in with everything else
 * — it comes from `STORAGE_FOLDERS`, decided in the backend, so there is no path
 * a caller can supply and no `..` to escape the tenant prefix with.
 */
export function buildStorageKey(input: {
  tenantId: string | null;
  originalName: string;
  contentType: string;
  folder?: StorageFolder;
}): string {
  const extension = path.extname(input.originalName).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12);
  const now = new Date();
  const yyyymm = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const folder = input.folder ?? folderFor(input.contentType);

  return `${input.tenantId ?? 'platform'}/${folder}/${yyyymm}/${randomUUID()}${extension}`;
}

/**
 * The object store this deployment is configured for.
 *
 * It lives beside the service rather than in `plugins/storage.ts` because the
 * API is not the only thing that uploads — seeders do too, and a second copy of
 * this wiring is how a seeder ends up writing to a different bucket than the one
 * the app serves from.
 */
export function createStorageProvider(): StorageProvider {
  const hasR2 = env.R2_ACCOUNT_ID !== ''
    && env.R2_ACCESS_KEY_ID !== ''
    && env.R2_SECRET_ACCESS_KEY !== ''
    && env.R2_BUCKET !== '';

  if (!hasR2)
    return createUnconfiguredStorage();

  return createR2Provider({
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    ...(env.R2_ENDPOINT === '' ? {} : { endpoint: env.R2_ENDPOINT }),
    ...(env.R2_JURISDICTION === '' ? {} : { jurisdiction: env.R2_JURISDICTION }),
    ...(env.R2_PUBLIC_BASE_URL === '' ? {} : { publicBaseUrl: env.R2_PUBLIC_BASE_URL }),
  });
}

export function createStorageService(
  db: Database,
  provider: StorageProvider = createStorageProvider(),
): StorageService {
  return new StorageService(db, {
    provider,
    uploadUrlTtlSeconds: env.UPLOAD_URL_TTL_SECONDS,
    downloadUrlTtlSeconds: env.DOWNLOAD_URL_TTL_SECONDS,
    maxUploadBytes: env.MAX_UPLOAD_BYTES,
    allowedContentTypes: csv(env.ALLOWED_UPLOAD_TYPES),
  });
}

/**
 * The address a browser or phone can fetch an object at directly.
 *
 * Signed download URLs expire in minutes, so one cannot be written into a row —
 * a channel logo has to still resolve next month. That needs the bucket's public
 * base, and without it there is no durable URL to store at all.
 */
export function publicUrlFor(storageKey: string): string | null {
  if (env.R2_PUBLIC_BASE_URL === '')
    return null;

  return `${env.R2_PUBLIC_BASE_URL.replace(/\/+$/, '')}/${storageKey}`;
}
