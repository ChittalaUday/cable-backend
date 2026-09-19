import type { RemoteSummaryRow } from './remote.repository';
import type { CreateRemoteBody, ListRemotesQuery, RemoteCapture, RemoteDetail, RemoteSummary } from './remote.schema';
import type { Database } from '@/db/client';
import type { RemoteButton, RemoteRecord } from '@/db/schema';
import type { RequestAccess } from '@/modules/iam/access.service';
import { AUDIT_ENTITIES } from '@/constants/audit';
import { REMOTE_SOURCE } from '@/constants/remotes';
import { ERROR_CODES } from '@/errors';
import { badRequest, conflict, notFound } from '@/errors/domain-error';
import { isUniqueViolation } from '@/errors/postgres';
import { audit } from '@/modules/audit/audit.service';
import { RemoteRepository } from './remote.repository';

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

function toSummary(row: RemoteSummaryRow): RemoteSummary {
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
  private readonly repo: RemoteRepository;

  constructor(repoOrDb: RemoteRepository | Database) {
    this.repo = repoOrDb instanceof RemoteRepository ? repoOrDb : new RemoteRepository(repoOrDb);
  }

  async list(access: RequestAccess, query: ListRemotesQuery): Promise<RemoteSummary[]> {
    const rows = await this.repo.listRemotes(access.tenantId, query);
    return rows.map(toSummary);
  }

  async get(access: RequestAccess, id: string): Promise<RemoteDetail> {
    const row = await this.repo.findRemoteById(access.tenantId, id);

    if (row === null)
      throw notFound('Remote');

    const captures = await this.repo.findCaptures(id);

    return {
      ...this.toDetail(row),
      captures: captures.map(c => ({
        id: c.id,
        remoteId: c.remoteId,
        buttonName: c.buttonName,
        buttonKey: c.buttonKey,
        protocol: c.protocol,
        address: c.address,
        command: c.command,
        commandNumber: c.commandNumber,
        rawData: c.rawData,
        bits: c.bits,
        bitOrder: c.bitOrder,
        repeat: c.repeat,
        rawTimings: c.rawTimings,
        capturedAt: c.capturedAt ? c.capturedAt.toISOString() : null,
      })),
    };
  }

  async getCaptures(access: RequestAccess, id: string): Promise<RemoteCapture[]> {
    const detail = await this.get(access, id);
    return detail.captures ?? [];
  }

  async create(access: RequestAccess, input: CreateRemoteBody): Promise<RemoteDetail> {
    assertTransmittable(input.buttons);

    try {
      const created = await this.repo.createRemote({
        tenantId: access.tenantId,
        deviceType: input.deviceType,
        brand: input.brand.trim(),
        model: input.model.trim(),
        source: REMOTE_SOURCE.LEARNED,
        verified: input.verified ?? false,
        notes: input.notes ?? null,
        buttons: input.buttons,
      });

      await audit.created(this.repo.database, access.audit, {
        entityType: AUDIT_ENTITIES.REMOTE,
        entityId: created.id,
        after: created,
      });

      return this.toDetail(created);
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw conflict(`You already have a ${input.deviceType.toUpperCase()} remote for "${input.brand} ${input.model}"`);
      throw error;
    }
  }

  private toDetail(row: RemoteRecord): RemoteDetail {
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
}
