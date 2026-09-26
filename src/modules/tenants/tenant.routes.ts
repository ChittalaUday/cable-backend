import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { PERMISSIONS } from '@/security/permissions';
import { ERRORS } from '@/types/typebox';
import {
  CreateUpiAccountBody,
  UpdateUpiAccountBody,
  UpiAccountIdParams,
  UpiAccountResponse,
} from './tenant.schema';

const routes: FastifyPluginAsyncTypebox = async (app) => {
  app.get('/tenants/me/upi-accounts', {
    config: { cache: { tag: 'tenant-settings' } },
    // Gated on collecting, not on `tenants.view`, because the caller who needs
    // this is the collector standing at the door: they have to show the QR the
    // money goes to. Field staff hold `payments.collect` and no tenant grant,
    // and widening `tenants.view` to reach them would hand them the whole
    // tenant record to read one handle.
    preHandler: app.requirePermission(PERMISSIONS.PAYMENTS_COLLECT),
    schema: {
      tags: ['tenants'],
      summary: 'The UPI handles this tenant collects into',
      description: [
        'Ordered with the default first, then oldest — the order a picker should show them in.',
        '',
        'Live handles only unless `includeInactive` is set, which needs nothing extra: an inactive handle is one the office stood down, and its QR at a door would send money nowhere anybody is watching.',
      ].join('\n'),
      querystring: Type.Object({ includeInactive: Type.Optional(Type.Boolean({ default: false })) }),
      response: { 200: Type.Array(UpiAccountResponse), ...ERRORS },
    },
  }, async (request) => {
    return request.server.tenants.listUpiAccounts(request.access, request.query.includeInactive === true);
  });

  app.post('/tenants/me/upi-accounts', {
    config: { invalidates: ['tenant-settings'] },
    preHandler: app.requirePermission(PERMISSIONS.TENANTS_UPDATE),
    schema: {
      tags: ['tenants'],
      summary: 'Add a UPI handle',
      description: 'The first handle added is the default whatever the body says — a list of one with nothing marked leaves the collector no QR to show.',
      body: CreateUpiAccountBody,
      response: { 201: UpiAccountResponse, ...ERRORS },
    },
  }, async (request, reply) => {
    const created = await request.server.tenants.addUpiAccount(request.access, request.body);

    return reply.status(201).send(created);
  });

  app.patch('/tenants/me/upi-accounts/:upiAccountId', {
    config: { invalidates: ['tenant-settings'] },
    preHandler: app.requirePermission(PERMISSIONS.TENANTS_UPDATE),
    schema: {
      tags: ['tenants'],
      summary: 'Edit a UPI handle, or make it the default',
      description: 'Standing the only live handle down is refused: it would empty the collector\'s picker.',
      params: UpiAccountIdParams,
      body: UpdateUpiAccountBody,
      response: { 200: UpiAccountResponse, ...ERRORS },
    },
  }, async (request) => {
    return request.server.tenants.updateUpiAccount(
      request.access,
      request.params.upiAccountId,
      request.body,
    );
  });

  app.delete('/tenants/me/upi-accounts/:upiAccountId', {
    config: { invalidates: ['tenant-settings'] },
    preHandler: app.requirePermission(PERMISSIONS.TENANTS_UPDATE),
    schema: {
      tags: ['tenants'],
      summary: 'Remove a UPI handle',
      description: 'Removing the default passes it to the oldest surviving handle, rather than leaving the tenant with handles but none chosen.',
      params: UpiAccountIdParams,
      response: { 204: Type.Null(), ...ERRORS },
    },
  }, async (request, reply) => {
    await request.server.tenants.removeUpiAccount(request.access, request.params.upiAccountId);

    return reply.status(204).send(null);
  });
};

export default routes;
