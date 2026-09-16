import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { CreateRemoteBody, ListRemotesQuery, RemoteDetail, RemoteSummary } from './remote.schema';
import type * as schema from '@/db/schema';
import type { RemoteButton, RemoteRecord } from '@/db/schema';
import type { RequestAccess } from '@/modules/iam/access.service';
import { and, asc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { AUDIT_ENTITIES } from '@/constants/audit';
import { REMOTE_SOURCE } from '@/constants/remotes';
import { remotes } from '@/db/schema';
import { ERROR_CODES } from '@/errors';
import { badRequest, conflict, notFound } from '@/errors/domain-error';
import { isUniqueViolation } from '@/errors/postgres';
import { audit } from '@/modules/audit/audit.service';

type Db = NodePgDatabase<typeof schema>;

const MAX_PATTERN_DURATION_US = 2_000_000;

function assertTransmittable(buttons: readonly RemoteButton[]): void {
  const seen = new Set<string>();

  for (const button of buttons) {
    if (seen.has(button.key))
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, `Duplicate button key "${button.key}"`);
    seen.add(button.key);

    const { command } = button;

    if (command.protocol === 'sony-sirc' && command.data > 2 ** command.bits - 1) {
      throw badRequest(
        ERROR_CODES.VALIDATION_FAILED,
        `Button "${button.key}": data ${command.data} does not fit in ${command.bits} bits`,
      );
    }

    if (command.protocol === 'raw') {
      const duration = command.pattern.reduce((total, micros) => total + micros, 0);
      if (duration >= MAX_PATTERN_DURATION_US) {
        throw badRequest(
          ERROR_CODES.VALIDATION_FAILED,
          `Button "${button.key}": pattern lasts ${duration}µs, and the emitter refuses anything from 2s`,
        );
      }
    }
  }
}

function toSummary(row: Omit<RemoteRecord, 'buttons'> & { buttonCount: number }): RemoteSummary {
  return {
    id: row.id,
    deviceType: row.deviceType,
    brand: row.brand,
    model: row.model,
    source: row.source,
    verified: row.verified,
    notes: row.notes,
    isTenantOwned: row.tenantId !== null,
    buttonCount: row.buttonCount,
  };
}

export class RemotesService {
  constructor(private readonly db: Db) {}

  async list(access: RequestAccess, query: ListRemotesQuery): Promise<RemoteSummary[]> {
    const visible = or(isNull(remotes.tenantId), eq(remotes.tenantId, access.tenantId));
    const filters = [visible];

    if (query.deviceType !== undefined)
      filters.push(eq(remotes.deviceType, query.deviceType));

    if (query.brand !== undefined)
      filters.push(eq(remotes.brand, query.brand));

    if (query.search !== undefined) {
      const term = `%${query.search}%`;
      filters.push(or(ilike(remotes.brand, term), ilike(remotes.model, term)));
    }

    const rows = await this.db
      .select({
        id: remotes.id,
        tenantId: remotes.tenantId,
        deviceType: remotes.deviceType,
        brand: remotes.brand,
        model: remotes.model,
        source: remotes.source,
        verified: remotes.verified,
        notes: remotes.notes,
        createdAt: remotes.createdAt,
        updatedAt: remotes.updatedAt,
        buttonCount: sql<number>`jsonb_array_length(${remotes.buttons})::int`,
      })
      .from(remotes)
      .where(and(...filters))
      .orderBy(asc(remotes.deviceType), asc(remotes.brand), asc(remotes.model));

    return rows.map(toSummary);
  }

  async get(access: RequestAccess, id: string): Promise<RemoteDetail> {
    const [row] = await this.db
      .select()
      .from(remotes)
      .where(and(
        eq(remotes.id, id),
        or(isNull(remotes.tenantId), eq(remotes.tenantId, access.tenantId)),
      ))
      .limit(1);

    if (!row)
      throw notFound('Remote');

    return {
      id: row.id,
      deviceType: row.deviceType,
      brand: row.brand,
      model: row.model,
      source: row.source,
      verified: row.verified,
      notes: row.notes,
      isTenantOwned: row.tenantId !== null,
      buttons: row.buttons,
    };
  }

  async create(access: RequestAccess, input: CreateRemoteBody): Promise<RemoteDetail> {
    assertTransmittable(input.buttons);

    try {
      const [created] = await this.db
        .insert(remotes)
        .values({
          tenantId: access.tenantId,
          deviceType: input.deviceType,
          brand: input.brand.trim(),
          model: input.model.trim(),
          source: REMOTE_SOURCE.LEARNED,
          verified: input.verified ?? false,
          notes: input.notes ?? null,
          buttons: input.buttons,
        })
        .returning();

      await audit.created(this.db, access.audit, {
        entityType: AUDIT_ENTITIES.REMOTE,
        entityId: created!.id,
        after: created!,
      });

      return {
        id: created!.id,
        deviceType: created!.deviceType,
        brand: created!.brand,
        model: created!.model,
        source: created!.source,
        verified: created!.verified,
        notes: created!.notes,
        isTenantOwned: true,
        buttons: created!.buttons,
      };
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw conflict(`You already have a ${input.deviceType.toUpperCase()} remote for "${input.brand} ${input.model}"`);
      throw error;
    }
  }
}
