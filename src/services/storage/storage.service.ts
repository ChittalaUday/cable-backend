import type { Buffer } from 'node:buffer';
import type {
  DirectUploadResult,
  FileRecord,
  LocalStagedUploadInput,
  ObjectPage,
  OrphanSweepOptions,
  OrphanSweepReport,
  RequestUploadInput,
  StorageCleanupOptions,
  StorageCleanupReport,
  StorageFolder,
  StorageProvider,
  StoredObject,
  UploadResult,
  UserFileRecord,
  UserFileWithFile,
} from './storage.types';
import type { Database } from '@/db/client';
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { and, count, eq, inArray, isNotNull, isNull, lte, ne } from 'drizzle-orm';
import { csv, env } from '@/config/env';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/constants/audit';
import { FILE_STATUS } from '@/constants/media';
import { files, userFiles } from '@/db/schema';
import { ERROR_CODES } from '@/errors';
import { DomainError, notFound } from '@/errors/domain-error';
import { audit } from '@/modules/audit/audit.service';
import { systemAuditContext } from '@/modules/audit/audit.types';
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
        status: FILE_STATUS.READY,
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
      status: FILE_STATUS.PENDING,
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

    if (file.status === FILE_STATUS.READY)
      return { userFile, file };

    const head = await this.options.provider.head(file.storageKey);

    if (!head) {
      await this.db.update(files)
        .set({ status: FILE_STATUS.FAILED, updatedAt: new Date() })
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
        .set({ status: FILE_STATUS.FAILED, updatedAt: new Date() })
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
          .set({ status: FILE_STATUS.DELETED, deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(files.id, file.id));

        return { userFile: updatedUserFile ?? userFile, file: existingReadyFile };
      }
    }

    const [ready] = await this.db.update(files)
      .set({
        status: FILE_STATUS.READY,
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

    if (file.status !== FILE_STATUS.READY)
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
      throw await this.explainMissing(userFileId);

    return row;
  }

  /**
   * Says which kind of "not found" this is.
   *
   * Two uuids exist for every upload — the `files` row that owns the bytes and
   * the `user_files` row that is somebody's reference to them — and the API
   * takes the second. Handing it the first is an easy mistake that a bare
   * "File not found" gives no way to spot, and the answer differs again when
   * the reference is simply deleted.
   */
  private async explainMissing(id: string): Promise<DomainError> {
    const [deleted] = await this.db.select({ id: userFiles.id })
      .from(userFiles)
      .where(and(eq(userFiles.id, id), isNotNull(userFiles.deletedAt)));

    if (deleted) {
      return new DomainError({
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
        statusCode: 404,
        message: 'That file was deleted.',
      });
    }

    const [byFileId] = await this.db.select({ userFileId: userFiles.id })
      .from(userFiles)
      .where(eq(userFiles.fileId, id));

    if (byFileId) {
      return new DomainError({
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
        statusCode: 404,
        message: `That is a stored-file id, not a file id. Use the \`id\` from the upload response — for this object it is ${byFileId.userFileId}.`,
      });
    }

    return notFound('File');
  }

  /**
   * Finds objects in the bucket that no `files` row points at, and optionally
   * removes them.
   *
   * The scheduled cleanup works the other way round — from a row outwards — so
   * it can never see an object the database has no record of at all. Those
   * accumulate from interrupted uploads and from rows deleted before the
   * object was.
   *
   * Destructive and not reversible, so it reports by default and only deletes
   * when asked. `minimumAgeMinutes` is the other guard: an upload writes its
   * object and its row a moment apart, and sweeping in between would delete a
   * file somebody is still uploading.
   */
  async sweepOrphanedObjects(options: OrphanSweepOptions = {}): Promise<OrphanSweepReport> {
    const dryRun = options.dryRun ?? true;
    const minimumAgeMinutes = options.minimumAgeMinutes ?? 120;
    const cutoff = new Date(Date.now() - minimumAgeMinutes * 60 * 1000);

    const report: OrphanSweepReport = { scanned: 0, orphans: [], removed: 0, skippedTooRecent: 0, dryRun };
    let token: string | null = null;

    do {
      const page: ObjectPage = await this.options.provider.list(token ?? undefined);
      token = page.nextToken;
      report.scanned += page.objects.length;

      const { orphans, tooRecent } = await this.orphansIn(page.objects, cutoff);
      report.orphans.push(...orphans);
      report.skippedTooRecent += tooRecent;
    } while (token !== null);

    if (dryRun || report.orphans.length === 0)
      return report;

    for (const orphan of report.orphans) {
      await this.options.provider.remove(orphan.key);
      report.removed++;
    }

    await audit.log(this.db, systemAuditContext('job:orphan-sweep'), {
      action: AUDIT_ACTIONS.STORAGE_CLEANED,
      entityType: AUDIT_ENTITIES.STORAGE,
      entityId: 'orphan-sweep',
      after: { removed: report.removed, scanned: report.scanned, minimumAgeMinutes },
    });

    return report;
  }

  /** Which of these objects no `files` row claims, and which are too new to judge. */
  private async orphansIn(
    objects: StoredObject[],
    cutoff: Date,
  ): Promise<{ orphans: StoredObject[]; tooRecent: number }> {
    if (objects.length === 0)
      return { orphans: [], tooRecent: 0 };

    const rows = await this.db.select({ storageKey: files.storageKey })
      .from(files)
      .where(inArray(files.storageKey, objects.map(object => object.key)));

    const known = new Set(rows.map(row => row.storageKey));
    const unknown = objects.filter(object => !known.has(object.key));
    const orphans = unknown.filter(object => object.lastModified === null || object.lastModified <= cutoff);

    return { orphans, tooRecent: unknown.length - orphans.length };
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
        .set({ status: FILE_STATUS.FAILED, deletedAt: new Date(), updatedAt: new Date() })
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
          .set({ status: FILE_STATUS.DELETED, deletedAt: new Date(), updatedAt: new Date() })
          .where(eq(files.id, readyFile.id));

        orphanedFilesCleaned++;
      }
      else if (verifyStorageIntegrity && this.options.provider.configured) {
        const head = await this.options.provider.head(readyFile.storageKey);
        if (head === null) {
          await this.db.update(files)
            .set({ status: FILE_STATUS.FAILED, updatedAt: new Date() })
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

export function folderFor(contentType: string): StorageFolder {
  if (contentType.startsWith('image/'))
    return 'images';

  if (contentType === 'application/pdf' || contentType.startsWith('text/'))
    return 'documents';

  return 'files';
}

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

export function publicUrlFor(storageKey: string): string | null {
  if (env.R2_PUBLIC_BASE_URL === '')
    return null;

  return `${env.R2_PUBLIC_BASE_URL.replace(/\/+$/, '')}/${storageKey}`;
}
