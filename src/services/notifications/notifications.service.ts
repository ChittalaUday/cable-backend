import type {
  Audience,
  BroadcastInput,
  BroadcastResult,
  InboxQuery,
  Notification,
  NotifyInput,
  PushTarget,
  RegisterTokenInput,
} from './notifications.types';
import type { NotificationCategory, NotificationDelivery } from '@/constants/notify';
import type { Database } from '@/db/client';
import type { NewNotification } from '@/db/schema';
import type { MessagingService } from '@/services/messaging/messaging.service';
import type { Page } from '@/utils/pagination';
import {
  DEFAULT_DELIVERY,
  NOTIFICATION_STATUS,
  sendsPush,
  SIGNED_OUT_CATEGORY,
} from '@/constants/notify';
import { notFound } from '@/errors/domain-error';
import { NotificationRepository } from './notifications.repository';
import { REDACTED_BODY } from './notifications.types';

export class NotificationService {
  private readonly repo: NotificationRepository;

  constructor(
    repoOrDb: NotificationRepository | Database,
    private readonly messaging: MessagingService,
  ) {
    this.repo = repoOrDb instanceof NotificationRepository ? repoOrDb : new NotificationRepository(repoOrDb);
  }

  async notify(input: NotifyInput): Promise<Notification> {
    const isTransport = input.channel === 'whatsapp' || input.channel === 'sms';

    if (isTransport && (input.destination == null || input.destination === ''))
      throw new Error(`A ${input.channel} notification needs a destination`);

    const row = await this.repo.insertNotification(rowFor(input, isTransport));

    if (isTransport)
      return this.deliver(row, input.body);

    if (row.channel === 'push' && sendsPush(row.delivery) && row.userId != null && row.tenantId != null) {
      const targets = await this.resolveTargets(
        row.tenantId,
        { kind: 'user', userIds: [row.userId] },
        row.category,
      );
      await this.pushTo(targets, row);
    }

    return row;
  }

  private async deliver(row: Notification, body: string): Promise<Notification> {
    try {
      const result = await this.messaging.send({
        to: row.destination ?? '',
        text: body,
        channel: row.channel === 'sms' ? 'sms' : 'whatsapp',
      });

      return await this.repo.markSent(row.id, result.providerMessageId) ?? row;
    }
    catch (error) {
      await this.repo.markFailed(row.id, error instanceof Error ? error.message : String(error));

      throw error;
    }
  }

  async broadcast(input: BroadcastInput): Promise<BroadcastResult> {
    const delivery = input.delivery ?? DEFAULT_DELIVERY[input.category];

    const [userIds, targets] = await Promise.all([
      this.repo.recipientsFor(input.tenantId, input.audience),
      this.resolveTargets(input.tenantId, input.audience, input.category),
    ]);

    await this.repo.insertMany(userIds.map(userId => ({
      tenantId: input.tenantId,
      userId,
      channel: sendsPush(delivery) ? ('push' as const) : ('in_app' as const),
      category: input.category,
      delivery,
      type: input.type,
      title: input.title,
      body: input.body,
      data: input.data ?? null,
      imageUrl: input.imageUrl ?? null,
      status: NOTIFICATION_STATUS.SENT,
      sentAt: new Date(),
    })));

    if (!sendsPush(delivery))
      return { notified: userIds.length, pushed: 0, failed: 0 };

    const { pushed, failed } = await this.pushTo(targets, {
      title: input.title,
      body: input.body,
      category: input.category,
      delivery,
      type: input.type,
      data: input.data ?? null,
      imageUrl: input.imageUrl ?? null,
    });

    return { notified: userIds.length, pushed, failed };
  }

  async signal(
    tenantId: string,
    audiences: readonly Audience[],
    data: Record<string, unknown>,
  ): Promise<{ pushed: number; failed: number }> {
    const resolved = await Promise.all(audiences.map(async audience => this.repo.signedInTargets(tenantId, audience)));

    const byToken = new Map<string, PushTarget>();
    for (const target of resolved.flat())
      byToken.set(target.token, target);

    return this.pushSilently([...byToken.values()], data);
  }

  async alertAdmins(input: { type: string; title: string; body: string }): Promise<BroadcastResult> {
    const tenants = await this.repo.tenantsWithAdmins();

    const totals: BroadcastResult = { notified: 0, pushed: 0, failed: 0 };

    for (const tenantId of tenants) {
      const result = await this.broadcast({
        tenantId,
        audience: { kind: 'role', roleId: 'admin' },
        category: 'alert',
        delivery: 'both',
        type: input.type,
        title: input.title,
        body: input.body,
      });

      totals.notified += result.notified;
      totals.pushed += result.pushed;
      totals.failed += result.failed;
    }

    return totals;
  }

  async resolveTargets(
    tenantId: string,
    audience: Audience,
    category: NotificationCategory,
  ): Promise<PushTarget[]> {
    const signedIn = await this.repo.signedInTargets(tenantId, audience);

    if (category !== SIGNED_OUT_CATEGORY || audience.kind === 'user')
      return signedIn;

    return [...signedIn, ...await this.repo.signedOutTargets(tenantId)];
  }

  private async pushTo(
    targets: readonly PushTarget[],
    message: { title: string | null; body: string; category: NotificationCategory; delivery: NotificationDelivery; type: string; data: Record<string, unknown> | null; imageUrl: string | null },
  ): Promise<{ pushed: number; failed: number }> {
    if (targets.length === 0)
      return { pushed: 0, failed: 0 };

    const results = await Promise.allSettled(targets.map(async target => this.messaging.send({
      to: target.token,
      text: message.body,
      ...(message.title != null ? { subject: message.title } : {}),
      channel: 'push',
      category: message.category,
      data: { ...message.data, category: message.category, delivery: message.delivery, type: message.type },
      ...(message.imageUrl != null ? { imageUrl: message.imageUrl } : {}),
    })));

    const failed = results.filter(r => r.status === 'rejected');

    await this.dropDeadTokens(targets, results);

    return { pushed: results.length - failed.length, failed: failed.length };
  }

  private async pushSilently(
    targets: readonly PushTarget[],
    data: Record<string, unknown>,
  ): Promise<{ pushed: number; failed: number }> {
    if (targets.length === 0)
      return { pushed: 0, failed: 0 };

    const results = await Promise.allSettled(targets.map(async target => this.messaging.send({
      to: target.token,
      text: `sync:${String(data.sync ?? 'unknown')}`,
      channel: 'push',
      silent: true,
      data,
    })));

    const failed = results.filter(result => result.status === 'rejected');

    await this.dropDeadTokens(targets, results);

    return { pushed: results.length - failed.length, failed: failed.length };
  }

  private async dropDeadTokens(
    targets: readonly PushTarget[],
    results: readonly PromiseSettledResult<unknown>[],
  ): Promise<void> {
    const dead = targets
      .filter((_, i) => {
        const result = results[i];
        return result?.status === 'rejected' && isUnregistered(result.reason);
      })
      .map(t => t.token);

    await this.repo.clearPushTokens(dead);
  }

  async registerToken(input: RegisterTokenInput, deviceId: string): Promise<void> {
    await this.repo.setPushToken(deviceId, input.token, input.tenantId);
  }

  async inbox(query: InboxQuery): Promise<Page<Notification>> {
    const { items, total } = await this.repo.inbox(query);

    return { items, total, page: query.page, limit: query.limit };
  }

  async unreadCount(tenantId: string, userId: string): Promise<{ total: number; byCategory: Record<string, number> }> {
    const rows = await this.repo.unreadByCategory(tenantId, userId);

    return {
      total: rows.reduce((sum, row) => sum + row.value, 0),
      byCategory: Object.fromEntries(rows.map(row => [row.category, row.value])),
    };
  }

  async markRead(id: string, tenantId: string, userId: string): Promise<Notification> {
    const row = await this.repo.markRead(id, tenantId, userId);

    if (row === null)
      throw notFound('Notification');

    return row;
  }

  async markAllRead(tenantId: string, userId: string, category?: NotificationCategory): Promise<number> {
    return this.repo.markAllRead(tenantId, userId, category);
  }
}

function rowFor(input: NotifyInput, isTransport: boolean): NewNotification {
  const category = input.category ?? 'general';
  const delivery: NotificationDelivery = input.delivery ?? DEFAULT_DELIVERY[category];

  return {
    tenantId: input.tenantId ?? null,
    userId: input.userId ?? null,
    channel: input.channel,
    category,
    delivery,
    type: input.type,
    title: input.title ?? null,
    body: input.sensitive === true ? REDACTED_BODY : input.body,
    data: input.data ?? null,
    destination: input.destination ?? null,
    imageUrl: input.imageUrl ?? null,
    status: isTransport ? 'queued' : 'sent',
    sentAt: isTransport ? null : new Date(),
  };
}

const DEAD_TOKEN = /registration-token-not-registered|invalid-registration-token|invalid-argument/i;

function isUnregistered(reason: unknown): boolean {
  return DEAD_TOKEN.test(reason instanceof Error ? reason.message : String(reason));
}
