import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import type { SendBody } from './notification.schema';
import type { NotificationDelivery } from '@/constants/notify';
import type { Audience } from '@/services/notifications/notifications.types';
import { TENANT_HEADER } from '@/config/constants';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/constants/audit';
import { ERROR_CODES } from '@/errors';
import { badRequest, forbidden } from '@/errors/domain-error';
import { audit } from '@/modules/audit/audit.service';
import { PERMISSIONS } from '@/security/permissions';
import { ERRORS } from '@/types/typebox';
import {
  IdParams,
  InboxQuery,
  InboxResponse,
  MarkAllReadBody,
  MarkAllReadResponse,
  Notification,
  RegisterTokenBody,
  RegisterTokenHeaders,
  RegisterTokenResponse,
  SendBody as SendBodySchema,
  SendResponse,
  UnreadCountResponse,
} from './notification.schema';

function tenantOf(request: FastifyRequest): string {
  if (request.tenantId === undefined) {
    throw badRequest(
      ERROR_CODES.TENANT_HEADER_MISSING,
      `${TENANT_HEADER} is required — you are a member of more than one tenant`,
    );
  }

  return request.tenantId;
}

function audienceOf(body: SendBody): Audience {
  if (body.audience === 'user') {
    if (body.userIds === undefined || body.userIds.length === 0)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'audience "user" needs userIds');

    return { kind: 'user', userIds: body.userIds };
  }

  if (body.audience === 'role') {
    if (body.roleId === undefined)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'audience "role" needs roleId');

    return { kind: 'role', roleId: body.roleId };
  }

  return { kind: 'tenant' };
}

const routes: FastifyPluginAsyncTypebox = async (app) => {
  app.get('/notifications', {
    schema: {
      tags: ['notifications'],
      summary: 'Your inbox — every notification addressed to you, newest first',
      description: 'Filter by `category` for one bucket, or `delivery=in_app` with `unreadOnly` to pull the in-app messages waiting to be shown.',
      querystring: InboxQuery,
      response: { 200: InboxResponse, ...ERRORS },
    },
  }, async (request) => {
    const { page, limit, unreadOnly, category, delivery } = request.query;

    return request.server.notifications.inbox({
      tenantId: tenantOf(request),
      userId: request.session.sub,
      page,
      limit,
      ...(unreadOnly === undefined ? {} : { unreadOnly }),
      ...(category === undefined ? {} : { category }),
      ...(delivery === undefined ? {} : { delivery: delivery.split(',') as NotificationDelivery[] }),
    });
  });

  app.get('/notifications/unread-count', {
    schema: {
      tags: ['notifications'],
      summary: 'Unread totals for the bell badge, broken down by category',
      response: { 200: UnreadCountResponse, ...ERRORS },
    },
  }, async (request) => {
    return request.server.notifications.unreadCount(tenantOf(request), request.session.sub);
  });

  app.patch('/notifications/:id/read', {
    schema: {
      tags: ['notifications'],
      summary: 'Mark one notification read',
      description: 'For an in-app message this doubles as "shown" — it is how the app stops re-presenting it.',
      params: IdParams,
      response: { 200: Notification, ...ERRORS },
    },
  }, async (request) => {
    return request.server.notifications.markRead(request.params.id, tenantOf(request), request.session.sub);
  });

  app.patch('/notifications/read-all', {
    schema: {
      tags: ['notifications'],
      summary: 'Mark everything read, or just one category',
      body: MarkAllReadBody,
      response: { 200: MarkAllReadResponse, ...ERRORS },
    },
  }, async (request) => {
    const updated = await request.server.notifications.markAllRead(
      tenantOf(request),
      request.session.sub,
      request.body.category,
    );

    return { updated };
  });

  app.post('/notifications/token', {
    config: { public: true, rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      tags: ['notifications'],
      summary: 'Record this device and its push token',
      description: 'Unauthenticated on purpose: the app registers on first launch and keeps registering through sign-out, so a signed-out phone still receives promotional pushes. Send a Bearer token when you have one and the device is filed against your tenant. `token: null` clears it.',
      headers: RegisterTokenHeaders,
      body: RegisterTokenBody,
      response: { 200: RegisterTokenResponse, 400: ERRORS[400], 403: ERRORS[403] },
      security: [],
    },
  }, async (request) => {
    const headers = request.headers as unknown as RegisterTokenHeaders;

    const ramMb = Number(headers['x-device-ram-mb']);

    const device = await request.server.sessions.upsertDevice({
      clientDeviceId: headers['x-device-id'],
      platform: headers['x-platform'],
      appVersion: headers['x-app-version'] ?? null,
      osVersion: headers['x-os-version'] ?? null,
      manufacturer: headers['x-device-manufacturer'] ?? null,
      model: headers['x-device-model'] ?? null,
      ramMb: Number.isFinite(ramMb) && ramMb > 0 ? ramMb : null,
      screenResolution: headers['x-screen-resolution'] ?? null,
    });

    await request.server.notifications.registerToken({
      clientDeviceId: headers['x-device-id'],
      platform: headers['x-platform'],
      token: request.body.token,
      tenantId: await softTenant(request),
    }, device.id);

    return { status: 'registered' as const };
  });

  app.post('/notifications/send', {
    preHandler: app.requirePermission(PERMISSIONS.NOTIFICATIONS_SEND),
    schema: {
      tags: ['notifications'],
      summary: 'Send a notification now',
      description: 'Covers every direction: staff → admin is `audience: "role", roleId: "admin"`, admin → everybody is `audience: "tenant"`, admin → one person is `audience: "user"`. Staff may only address admins. A signed-out device is only ever reached by `category: "promotional"`.',
      body: SendBodySchema,
      response: { 200: SendResponse, ...ERRORS },
    },
  }, async (request) => {
    const audience = audienceOf(request.body);

    const isAdmin = request.access.permissions.has(PERMISSIONS.STAFF_CREATE);
    if (!isAdmin && !(audience.kind === 'role' && audience.roleId === 'admin')) {
      throw forbidden(
        ERROR_CODES.PERM_DENIED,
        'You can only send notifications to admins',
      );
    }

    const result = await request.server.notifications.broadcast({
      tenantId: request.access.tenantId,
      audience,
      category: request.body.category,
      ...(request.body.delivery === undefined ? {} : { delivery: request.body.delivery }),
      type: request.body.type,
      title: request.body.title,
      body: request.body.body,
      data: request.body.data ?? null,
      imageUrl: request.body.imageUrl ?? null,
    });

    await audit.log(request.server.db, request.access.audit, {
      action: AUDIT_ACTIONS.NOTIFICATION_SENT,
      entityType: AUDIT_ENTITIES.NOTIFICATION,
      entityId: 'broadcast',
      metadata: {
        audience: request.body.audience,
        roleId: request.body.roleId ?? null,
        recipients: request.body.userIds?.length ?? null,
        category: request.body.category,
        delivery: request.body.delivery ?? null,
        type: request.body.type,
        imageUrl: request.body.imageUrl ?? null,
        ...result,
      },
    });

    return result;
  });
};

async function softTenant(request: FastifyRequest): Promise<string | null> {
  if (request.headers.authorization === undefined)
    return null;

  try {
    await request.server.authenticate(request);
  }
  catch {
    return null;
  }

  const memberships = request.session.memberships;
  const header = request.headers[TENANT_HEADER];
  const asked = Array.isArray(header) ? header[0] : header;

  if (asked !== undefined && asked !== '')
    return memberships.some(m => m.t === asked) ? asked : null;

  return memberships.length === 1 ? memberships[0]!.t : null;
}

export default routes;
