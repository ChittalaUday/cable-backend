import type { MessagingService } from './messaging.service';
import type { InboxQuery, Notification, NotifyInput } from './notifications.types';
import type { NewNotification } from '@/db/schema';
import type { Database } from '@/plugins/database';
import type { Page } from '@/shared/pagination';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';
import { notifications } from '@/db/schema';
import { notFound } from '@/shared/errors/domain-error';
import { REDACTED_BODY } from './notifications.types';

/**
 * Owns notification records and their delivery (AGENTS.md §1).
 *
 * `in_app` is delivered by being readable — the row IS the notification.
 * `whatsapp` and `sms` go out through `MessagingService`, which picks the
 * provider; nothing here names a vendor.
 */
export class NotificationService {
  constructor(
    private readonly db: Database,
    private readonly messaging: MessagingService,
  ) {}

  /**
   * Records the notification, then delivers it.
   *
   * Throws when a transport fails, after marking the row `failed`. A caller that
   * must not fail because a message did not go out should not be calling this on
   * its request path — see the note below.
   *
   * ponytail: delivery is awaited inline because there is no queue yet. When
   * BullMQ lands (§1), `in_app` stays inline and transports become an enqueue,
   * so a CRUD write stops waiting on WhatsApp.
   */
  async notify(input: NotifyInput): Promise<Notification> {
    const isTransport = input.channel !== 'in_app';

    if (isTransport && (input.destination == null || input.destination === ''))
      throw new Error(`A ${input.channel} notification needs a destination`);

    const [row] = await this.db.insert(notifications).values(rowFor(input, isTransport)).returning();

    if (!row)
      throw new Error('Notification insert returned no row');

    return isTransport ? this.deliver(row, input.body) : row;
  }

  /** Sends a recorded notification and writes the outcome back to its row. */
  private async deliver(row: Notification, body: string): Promise<Notification> {
    try {
      const result = await this.messaging.send({
        to: row.destination ?? '',
        text: body,
        channel: row.channel === 'sms' ? 'sms' : 'whatsapp',
      });

      const [sent] = await this.db.update(notifications)
        .set({ status: 'sent', sentAt: new Date(), providerMessageId: result.providerMessageId })
        .where(eq(notifications.id, row.id))
        .returning();

      return sent ?? row;
    }
    catch (error) {
      // The failure is recorded AND rethrown: a message nobody received must
      // never read as success (§1 rule 3).
      await this.db.update(notifications)
        .set({
          status: 'failed',
          failedAt: new Date(),
          error: error instanceof Error ? error.message : String(error),
        })
        .where(eq(notifications.id, row.id));

      throw error;
    }
  }

  /** One user's in-app inbox, newest first. Tenant-scoped (§4.5). */
  async inbox(query: InboxQuery): Promise<Page<Notification>> {
    const where = and(
      eq(notifications.tenantId, query.tenantId),
      eq(notifications.userId, query.userId),
      eq(notifications.channel, 'in_app'),
      ...(query.unreadOnly ? [isNull(notifications.readAt)] : []),
    );

    const [items, [total]] = await Promise.all([
      this.db.select().from(notifications).where(where).orderBy(desc(notifications.createdAt)).limit(query.limit).offset((query.page - 1) * query.limit),
      this.db.select({ value: count() }).from(notifications).where(where),
    ]);

    return { items, total: total?.value ?? 0, page: query.page, limit: query.limit };
  }

  async unreadCount(tenantId: string, userId: string): Promise<number> {
    const [row] = await this.db.select({ value: count() }).from(notifications).where(and(
      eq(notifications.tenantId, tenantId),
      eq(notifications.userId, userId),
      eq(notifications.channel, 'in_app'),
      isNull(notifications.readAt),
    ));

    return row?.value ?? 0;
  }

  /**
   * Marks one notification read.
   *
   * Scoped by `userId` as well as `id`: a notification belonging to someone else
   * must be indistinguishable from one that does not exist (§4.5).
   */
  async markRead(id: string, tenantId: string, userId: string): Promise<Notification> {
    const [row] = await this.db.update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(and(
        eq(notifications.id, id),
        eq(notifications.tenantId, tenantId),
        eq(notifications.userId, userId),
      ))
      .returning();

    if (!row)
      throw notFound('Notification');

    return row;
  }

  async markAllRead(tenantId: string, userId: string): Promise<number> {
    const rows = await this.db.update(notifications)
      .set({ readAt: new Date() })
      .where(and(
        eq(notifications.tenantId, tenantId),
        eq(notifications.userId, userId),
        eq(notifications.channel, 'in_app'),
        isNull(notifications.readAt),
      ))
      .returning({ id: notifications.id });

    return rows.length;
  }
}

/**
 * The row a notification starts as.
 *
 * `in_app` is `sent` on insert — the row IS the delivery. A transport channel
 * starts `queued` and only becomes `sent` once a provider accepts it.
 */
function rowFor(input: NotifyInput, isTransport: boolean): NewNotification {
  return {
    tenantId: input.tenantId ?? null,
    userId: input.userId ?? null,
    channel: input.channel,
    type: input.type,
    title: input.title ?? null,
    // The real body goes to the transport; only the stored copy is redacted.
    body: input.sensitive === true ? REDACTED_BODY : input.body,
    data: input.data ?? null,
    destination: input.destination ?? null,
    status: isTransport ? 'queued' : 'sent',
    sentAt: isTransport ? null : new Date(),
  };
}
