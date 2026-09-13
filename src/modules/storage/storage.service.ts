import type { FileRecord, StorageProvider } from './storage.types';
import type { Database } from '@/plugins/database';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { files } from '@/db/schema';
import { ERROR_CODES } from '@/shared/errors';
import { DomainError, notFound } from '@/shared/errors/domain-error';

export interface RequestUploadInput {
  tenantId: string | null;
  uploadedBy: string | null;
  originalName: string;
  contentType: string;
  /** What the client says it will upload. Checked against the cap, then re-checked after. */
  sizeBytes?: number;
}

export interface StorageServiceOptions {
  provider: StorageProvider;
  uploadUrlTtlSeconds: number;
  downloadUrlTtlSeconds: number;
  maxUploadBytes: number;
  allowedContentTypes: string[];
}

/**
 * File metadata and presigned access (AGENTS.md §8.4).
 *
 * Bytes never pass through this process: the client PUTs to a presigned URL and
 * GETs from one. Proxying uploads would put a 20 MB request on the event loop of
 * a service whose job is CRUD.
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
   * Issues a presigned upload URL and records the file as `pending`.
   *
   * The row is not `ready` until `confirmUpload` verifies the object exists — a
   * client that abandons the upload must not leave a record pointing at nothing.
   */
  async requestUpload(input: RequestUploadInput): Promise<{ file: FileRecord; uploadUrl: string; expiresAt: Date }> {
    this.assertContentTypeAllowed(input.contentType);

    if (input.sizeBytes != null && input.sizeBytes > this.options.maxUploadBytes)
      throw this.tooLarge(input.sizeBytes);

    const storageKey = buildStorageKey(input.tenantId, input.originalName);

    const [file] = await this.db.insert(files).values({
      tenantId: input.tenantId,
      uploadedBy: input.uploadedBy,
      storageKey,
      bucket: this.options.provider.bucket,
      originalName: input.originalName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes ?? null,
      kind: 'upload',
      status: 'pending',
    }).returning();

    if (!file)
      throw new Error('File insert returned no row');

    const signed = await this.options.provider.createUploadUrl(
      storageKey,
      input.contentType,
      this.options.uploadUrlTtlSeconds,
    );

    return { file, uploadUrl: signed.url, expiresAt: signed.expiresAt };
  }

  /**
   * Verifies the object landed, then marks the row `ready`.
   *
   * Size and content type come from storage, never from the client — a client
   * that reports 1 KB and uploads 1 GB is exactly what the cap exists to stop.
   */
  async confirmUpload(id: string, tenantId: string | null): Promise<FileRecord> {
    const file = await this.findOwned(id, tenantId);
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

    const [ready] = await this.db.update(files)
      .set({
        status: 'ready',
        sizeBytes: head.sizeBytes,
        checksum: head.checksum,
        updatedAt: new Date(),
      })
      .where(eq(files.id, file.id))
      .returning();

    return ready ?? file;
  }

  /** Short-lived download URL for a private object. */
  async downloadUrl(id: string, tenantId: string | null): Promise<{ url: string; expiresAt: Date }> {
    const file = await this.findOwned(id, tenantId);

    if (file.status !== 'ready')
      throw notFound('File');

    const signed = await this.options.provider.createDownloadUrl(file.storageKey, this.options.downloadUrlTtlSeconds);
    return { url: signed.url, expiresAt: signed.expiresAt };
  }

  /**
   * Soft-deletes the row and removes the object.
   *
   * The row outlives the object on purpose: a dangling reference from a customer
   * or ticket then explains itself instead of returning nothing.
   */
  async remove(id: string, tenantId: string | null): Promise<void> {
    const file = await this.findOwned(id, tenantId);

    await this.options.provider.remove(file.storageKey);
    await this.db.update(files)
      .set({ status: 'deleted', deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(files.id, file.id));
  }

  /** Tenant-scoped lookup (§4.5): another tenant's file is indistinguishable from a missing one. */
  private async findOwned(id: string, tenantId: string | null): Promise<FileRecord> {
    const [file] = await this.db.select().from(files).where(and(
      eq(files.id, id),
      tenantId === null ? isNull(files.tenantId) : eq(files.tenantId, tenantId),
      isNull(files.deletedAt),
    ));

    if (!file)
      throw notFound('File');

    return file;
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
