import type { FileRecord, StoredObject, UserFileRecord, UserFileWithFile } from './storage.types';
import type { Database } from '@/db/client';
import { and, count, eq, inArray, isNotNull, isNull, lte, ne } from 'drizzle-orm';
import { FILE_STATUS } from '@/constants/media';
import { files, userFiles } from '@/db/schema';

export class StorageRepository {
  constructor(private readonly db: Database) {}

  /** The audit trail is written by the service but must land on this same executor. */
  get database(): Database {
    return this.db;
  }

  /** A ready object with this checksum is the same bytes — reuse it instead of storing twice. */
  async findReadyByChecksum(checksum: string, excludeFileId?: string): Promise<FileRecord | null> {
    const [row] = await this.db
      .select()
      .from(files)
      .where(and(
        eq(files.checksum, checksum),
        eq(files.status, FILE_STATUS.READY),
        isNull(files.deletedAt),
        ...(excludeFileId === undefined ? [] : [ne(files.id, excludeFileId)]),
      ))
      .limit(1);

    return row ?? null;
  }

  async insertFile(values: typeof files.$inferInsert): Promise<FileRecord> {
    const [row] = await this.db.insert(files).values(values).returning();

    if (!row)
      throw new Error('File insert returned no row');

    return row;
  }

  async insertUserFile(values: typeof userFiles.$inferInsert): Promise<UserFileRecord> {
    const [row] = await this.db.insert(userFiles).values(values).returning();

    if (!row)
      throw new Error('UserFile insert returned no row');

    return row;
  }

  async updateFile(id: string, values: Partial<typeof files.$inferInsert>): Promise<FileRecord | null> {
    const [row] = await this.db
      .update(files)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(files.id, id))
      .returning();

    return row ?? null;
  }

  async repointUserFile(userFileId: string, fileId: string): Promise<UserFileRecord | null> {
    const [row] = await this.db
      .update(userFiles)
      .set({ fileId, updatedAt: new Date() })
      .where(eq(userFiles.id, userFileId))
      .returning();

    return row ?? null;
  }

  async softDeleteUserFile(userFileId: string): Promise<void> {
    await this.db
      .update(userFiles)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(userFiles.id, userFileId));
  }

  async findOwned(userFileId: string, tenantId: string | null): Promise<UserFileWithFile | null> {
    const [row] = await this.db
      .select({ userFile: userFiles, file: files })
      .from(userFiles)
      .innerJoin(files, eq(userFiles.fileId, files.id))
      .where(and(
        eq(userFiles.id, userFileId),
        tenantId === null ? isNull(userFiles.tenantId) : eq(userFiles.tenantId, tenantId),
        isNull(userFiles.deletedAt),
      ))
      .limit(1);

    return row ?? null;
  }

  // Both lookups stay inside the caller's tenant: the answer becomes an error
  // message, and "no such id here" must not turn into "it belongs to someone else".
  async wasDeleted(userFileId: string, tenantId: string | null): Promise<boolean> {
    const [row] = await this.db
      .select({ id: userFiles.id })
      .from(userFiles)
      .where(and(
        eq(userFiles.id, userFileId),
        tenantId === null ? isNull(userFiles.tenantId) : eq(userFiles.tenantId, tenantId),
        isNotNull(userFiles.deletedAt),
      ))
      .limit(1);

    return row !== undefined;
  }

  async userFileIdOfFile(fileId: string, tenantId: string | null): Promise<string | null> {
    const [row] = await this.db
      .select({ userFileId: userFiles.id })
      .from(userFiles)
      .where(and(
        eq(userFiles.fileId, fileId),
        tenantId === null ? isNull(userFiles.tenantId) : eq(userFiles.tenantId, tenantId),
      ))
      .limit(1);

    return row?.userFileId ?? null;
  }

  async knownStorageKeys(objects: readonly StoredObject[]): Promise<Set<string | null>> {
    const rows = await this.db
      .select({ storageKey: files.storageKey })
      .from(files)
      .where(inArray(files.storageKey, objects.map(object => object.key)));

    return new Set(rows.map(row => row.storageKey));
  }

  async livePendingFiles(): Promise<FileRecord[]> {
    return this.db
      .select()
      .from(files)
      .where(and(eq(files.status, FILE_STATUS.PENDING), isNull(files.deletedAt)));
  }

  async readyFilesOlderThan(cutoff: Date): Promise<FileRecord[]> {
    return this.db
      .select()
      .from(files)
      .where(and(
        eq(files.status, FILE_STATUS.READY),
        isNull(files.deletedAt),
        lte(files.createdAt, cutoff),
      ));
  }

  async countLiveReferences(fileId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(userFiles)
      .where(and(eq(userFiles.fileId, fileId), isNull(userFiles.deletedAt)));

    return Number(row?.total ?? 0);
  }
}
